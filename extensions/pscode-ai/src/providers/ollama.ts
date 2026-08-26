/*---------------------------------------------------------------------------------------------
 *  PSCode AI - Ollama provider (the default: fully local, no API key, no network egress)
 *
 *  Uses Ollama's native /api/chat rather than its OpenAI-compatibility shim, because the
 *  native endpoint reports load/eval counters and handles tool calls more reliably on the
 *  small models that are realistic to run on a CPU.
 *--------------------------------------------------------------------------------------------*/

import { requestJson, streamLines } from './http';
import { ChatMessage, CompletionRequest, LLMProvider, ProviderError, StreamEvent, ToolSchema } from './types';

interface OllamaToolCall {
	function?: { name?: string; arguments?: unknown };
}

interface OllamaChunk {
	message?: { content?: string; tool_calls?: OllamaToolCall[] };
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
}

interface OllamaTagsResponse {
	models?: { name?: string }[];
}

export class OllamaProvider implements LLMProvider {
	readonly id = 'ollama';
	readonly label = 'Ollama (local)';
	readonly supportsTools = true;

	constructor(
		private readonly endpoint: string,
		private readonly model: string,
		private readonly timeoutMs: number
	) { }

	async listModels(signal: AbortSignal): Promise<string[]> {
		const response = await requestJson<OllamaTagsResponse>({
			url: `${this.endpoint.replace(/\/+$/, '')}/api/tags`,
			method: 'GET',
			timeoutMs: 15000,
			signal,
		});
		return (response.models ?? [])
			.map(m => m.name)
			.filter((n): n is string => typeof n === 'string')
			.sort();
	}

	async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const body: Record<string, unknown> = {
			model: this.model,
			messages: request.messages.map(toOllamaMessage),
			stream: true,
			options: {
				temperature: request.temperature ?? 0.2,
				num_predict: request.maxTokens ?? 4096,
			},
		};
		if (request.tools?.length) {
			body['tools'] = request.tools.map(toOllamaTool);
		}

		let emittedDone = false;
		let toolCallSeq = 0;

		for await (const line of streamLines({
			url: `${this.endpoint.replace(/\/+$/, '')}/api/chat`,
			body,
			timeoutMs: this.timeoutMs,
			signal,
		})) {
			let chunk: OllamaChunk;
			try {
				chunk = JSON.parse(line) as OllamaChunk;
			} catch {
				continue; // Ignore keep-alive or malformed lines rather than killing the stream.
			}

			if (chunk.error) {
				throw new ProviderError(
					chunk.error,
					/not found/i.test(chunk.error)
						? `Pull it first: "ollama pull ${this.model}"`
						: undefined
				);
			}

			const content = chunk.message?.content;
			if (content) {
				yield { type: 'text', text: content };
			}

			for (const call of chunk.message?.tool_calls ?? []) {
				const name = call.function?.name;
				if (!name) {
					continue;
				}
				// Ollama returns arguments as a decoded object; the rest of PSCode
				// works with raw JSON text, so normalise here.
				const rawArgs = call.function?.arguments;
				yield {
					type: 'toolCall',
					call: {
						id: `ollama-${Date.now()}-${toolCallSeq++}`,
						name,
						args: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
					},
				};
			}

			if (chunk.done) {
				if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
					yield {
						type: 'usage',
						promptTokens: chunk.prompt_eval_count,
						completionTokens: chunk.eval_count,
					};
				}
				emittedDone = true;
				yield { type: 'done', reason: chunk.done_reason === 'length' ? 'length' : 'stop' };
			}
		}

		if (!emittedDone) {
			// Stream ended without Ollama's terminal frame (server restart, killed model).
			yield { type: 'done', reason: 'stop' };
		}
	}
}

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
	if (message.role === 'tool') {
		return { role: 'tool', content: message.content };
	}
	const result: Record<string, unknown> = { role: message.role, content: message.content };
	if (message.toolCalls?.length) {
		result['tool_calls'] = message.toolCalls.map(call => ({
			function: { name: call.name, arguments: safeParse(call.args) },
		}));
	}
	return result;
}

function toOllamaTool(tool: ToolSchema): Record<string, unknown> {
	return {
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}
