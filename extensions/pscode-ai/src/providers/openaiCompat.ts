/*---------------------------------------------------------------------------------------------
 *  PSCode AI - OpenAI-compatible provider
 *
 *  One implementation covers llama.cpp's server, LM Studio, vLLM, OpenRouter, Together and
 *  OpenAI itself, because they all expose /v1/chat/completions. This is the escape hatch that
 *  keeps PSCode from being locked to Ollama.
 *--------------------------------------------------------------------------------------------*/

import { requestJson, streamLines } from './http';
import { ChatMessage, CompletionRequest, LLMProvider, StreamEvent, ToolCall, ToolSchema } from './types';

interface DeltaToolCall {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface CompletionChunk {
	choices?: {
		delta?: { content?: string | null; tool_calls?: DeltaToolCall[] };
		finish_reason?: string | null;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ModelsResponse {
	data?: { id?: string }[];
}

export class OpenAICompatibleProvider implements LLMProvider {
	readonly id = 'openai-compatible';
	readonly label = 'OpenAI-compatible';
	readonly supportsTools = true;

	constructor(
		private readonly endpoint: string,
		private readonly model: string,
		private readonly apiKey: string,
		private readonly timeoutMs: number
	) { }

	private get base(): string {
		// Accept both "http://host:port" and "http://host:port/v1" in settings.
		const trimmed = this.endpoint.replace(/\/+$/, '');
		return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
	}

	private headers(): Record<string, string> {
		return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
	}

	async listModels(signal: AbortSignal): Promise<string[]> {
		const response = await requestJson<ModelsResponse>({
			url: `${this.base}/models`,
			method: 'GET',
			headers: this.headers(),
			timeoutMs: 15000,
			signal,
		});
		return (response.data ?? [])
			.map(m => m.id)
			.filter((id): id is string => typeof id === 'string')
			.sort();
	}

	async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const body: Record<string, unknown> = {
			model: this.model,
			messages: request.messages.map(toOpenAIMessage),
			stream: true,
			stream_options: { include_usage: true },
			temperature: request.temperature ?? 0.2,
			max_tokens: request.maxTokens ?? 4096,
		};
		if (request.tools?.length) {
			body['tools'] = request.tools.map(toOpenAITool);
			body['tool_choice'] = 'auto';
		}

		// Tool calls arrive as fragments spread across many chunks and keyed only by
		// index, so they have to be reassembled before any of them can be executed.
		const pending = new Map<number, { id: string; name: string; args: string }>();
		let finishReason: string | undefined;
		let usage: { promptTokens?: number; completionTokens?: number } | undefined;

		for await (const line of streamLines({
			url: `${this.base}/chat/completions`,
			body,
			headers: this.headers(),
			timeoutMs: this.timeoutMs,
			signal,
		})) {
			if (!line.startsWith('data:')) {
				continue; // SSE comments and event: lines carry nothing we need.
			}
			const payload = line.slice(5).trim();
			if (payload === '[DONE]') {
				break;
			}

			let chunk: CompletionChunk;
			try {
				chunk = JSON.parse(payload) as CompletionChunk;
			} catch {
				continue;
			}

			if (chunk.usage) {
				usage = {
					promptTokens: chunk.usage.prompt_tokens,
					completionTokens: chunk.usage.completion_tokens,
				};
			}

			const choice = chunk.choices?.[0];
			if (!choice) {
				continue;
			}

			const text = choice.delta?.content;
			if (text) {
				yield { type: 'text', text };
			}

			for (const fragment of choice.delta?.tool_calls ?? []) {
				const index = fragment.index ?? 0;
				const existing = pending.get(index) ?? { id: '', name: '', args: '' };
				if (fragment.id) {
					existing.id = fragment.id;
				}
				if (fragment.function?.name) {
					existing.name += fragment.function.name;
				}
				if (fragment.function?.arguments) {
					existing.args += fragment.function.arguments;
				}
				pending.set(index, existing);
			}

			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}
		}

		for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
			if (!call.name) {
				continue;
			}
			const toolCall: ToolCall = {
				id: call.id || `call-${index}`,
				name: call.name,
				args: call.args || '{}',
			};
			yield { type: 'toolCall', call: toolCall };
		}

		if (usage) {
			yield { type: 'usage', ...usage };
		}

		yield {
			type: 'done',
			reason: pending.size > 0 ? 'toolCalls' : finishReason === 'length' ? 'length' : 'stop',
		};
	}
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
	if (message.role === 'tool') {
		return {
			role: 'tool',
			content: message.content,
			tool_call_id: message.toolCallId ?? '',
		};
	}
	const result: Record<string, unknown> = { role: message.role, content: message.content };
	if (message.toolCalls?.length) {
		result['tool_calls'] = message.toolCalls.map(call => ({
			id: call.id,
			type: 'function',
			function: { name: call.name, arguments: call.args },
		}));
	}
	return result;
}

function toOpenAITool(tool: ToolSchema): Record<string, unknown> {
	return {
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}
