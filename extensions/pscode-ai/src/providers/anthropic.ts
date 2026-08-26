/*---------------------------------------------------------------------------------------------
 *  PSCode AI - Anthropic provider
 *
 *  Optional, and never the default: PSCode is local-first, so this exists for the case where
 *  a 7B model on a CPU is not good enough for the task at hand. Its wire format differs enough
 *  from OpenAI's that it warrants its own implementation rather than a shim.
 *--------------------------------------------------------------------------------------------*/

import { streamLines } from './http';
import { ChatMessage, CompletionRequest, LLMProvider, ProviderError, StreamEvent, ToolSchema } from './types';

const ANTHROPIC_VERSION = '2023-06-01';

/** Suggested ids for the model picker; the user may type any other id. */
const KNOWN_MODELS = [
	'claude-opus-5',
	'claude-sonnet-5',
	'claude-fable-5',
	'claude-haiku-4-5-20251001',
];

interface StreamFrame {
	type?: string;
	index?: number;
	content_block?: { type?: string; id?: string; name?: string };
	delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
	message?: { usage?: { input_tokens?: number } };
	usage?: { output_tokens?: number };
	error?: { message?: string };
}

export class AnthropicProvider implements LLMProvider {
	readonly id = 'anthropic';
	readonly label = 'Anthropic';
	readonly supportsTools = true;

	constructor(
		private readonly endpoint: string,
		private readonly model: string,
		private readonly apiKey: string,
		private readonly timeoutMs: number
	) { }

	async listModels(_signal: AbortSignal): Promise<string[]> {
		return KNOWN_MODELS;
	}

	async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		if (!this.apiKey) {
			throw new ProviderError(
				'Anthropic requires an API key.',
				'Set "pscode.ai.apiKey", or switch "pscode.ai.provider" back to "ollama" to stay local.'
			);
		}

		// Anthropic takes the system prompt as a top-level field rather than a message.
		const system = request.messages
			.filter(m => m.role === 'system')
			.map(m => m.content)
			.join('\n\n');

		const body: Record<string, unknown> = {
			model: this.model,
			max_tokens: request.maxTokens ?? 4096,
			temperature: request.temperature ?? 0.2,
			stream: true,
			messages: toAnthropicMessages(request.messages),
		};
		if (system) {
			body['system'] = system;
		}
		if (request.tools?.length) {
			body['tools'] = request.tools.map(toAnthropicTool);
		}

		// tool_use blocks stream their input as incremental JSON text keyed by block index.
		const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
		let stopReason: string | undefined;
		let inputTokens: number | undefined;
		let outputTokens: number | undefined;

		for await (const line of streamLines({
			url: `${this.endpoint.replace(/\/+$/, '')}/v1/messages`,
			body,
			headers: {
				'x-api-key': this.apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
			},
			timeoutMs: this.timeoutMs,
			signal,
		})) {
			if (!line.startsWith('data:')) {
				continue;
			}
			let frame: StreamFrame;
			try {
				frame = JSON.parse(line.slice(5).trim()) as StreamFrame;
			} catch {
				continue;
			}

			if (frame.type === 'error') {
				throw new ProviderError(frame.error?.message ?? 'Anthropic returned an error.');
			}

			if (frame.type === 'message_start') {
				inputTokens = frame.message?.usage?.input_tokens;
			} else if (frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use') {
				toolBlocks.set(frame.index ?? 0, {
					id: frame.content_block.id ?? `tool-${frame.index ?? 0}`,
					name: frame.content_block.name ?? '',
					json: '',
				});
			} else if (frame.type === 'content_block_delta') {
				if (frame.delta?.type === 'text_delta' && frame.delta.text) {
					yield { type: 'text', text: frame.delta.text };
				} else if (frame.delta?.type === 'input_json_delta') {
					const block = toolBlocks.get(frame.index ?? 0);
					if (block) {
						block.json += frame.delta.partial_json ?? '';
					}
				}
			} else if (frame.type === 'message_delta') {
				stopReason = frame.delta?.stop_reason;
				outputTokens = frame.usage?.output_tokens;
			} else if (frame.type === 'message_stop') {
				break;
			}
		}

		for (const [, block] of [...toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
			if (block.name) {
				yield { type: 'toolCall', call: { id: block.id, name: block.name, args: block.json || '{}' } };
			}
		}

		if (inputTokens !== undefined || outputTokens !== undefined) {
			yield { type: 'usage', promptTokens: inputTokens, completionTokens: outputTokens };
		}

		yield {
			type: 'done',
			reason: stopReason === 'tool_use' ? 'toolCalls' : stopReason === 'max_tokens' ? 'length' : 'stop',
		};
	}
}

/**
 * Anthropic has no `tool` role: a tool result is a `tool_result` block inside a user
 * message, and consecutive results must be merged into one message.
 */
function toAnthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];

	for (const message of messages) {
		if (message.role === 'system') {
			continue; // Hoisted to the top-level `system` field.
		}

		if (message.role === 'tool') {
			const block = {
				type: 'tool_result',
				tool_use_id: message.toolCallId ?? '',
				content: message.content,
			};
			const previous = result[result.length - 1];
			if (previous && previous['role'] === 'user' && Array.isArray(previous['content'])) {
				(previous['content'] as unknown[]).push(block);
			} else {
				result.push({ role: 'user', content: [block] });
			}
			continue;
		}

		if (message.role === 'assistant' && message.toolCalls?.length) {
			const content: unknown[] = [];
			if (message.content) {
				content.push({ type: 'text', text: message.content });
			}
			for (const call of message.toolCalls) {
				content.push({
					type: 'tool_use',
					id: call.id,
					name: call.name,
					input: safeParse(call.args),
				});
			}
			result.push({ role: 'assistant', content });
			continue;
		}

		result.push({ role: message.role, content: message.content });
	}

	return result;
}

function toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	};
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}
