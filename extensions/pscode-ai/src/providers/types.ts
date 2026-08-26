/*---------------------------------------------------------------------------------------------
 *  PSCode AI - provider contracts
 *
 *  Every backend (Ollama, any OpenAI-compatible server, Anthropic) is reduced to one
 *  interface: `LLMProvider`. Chat, inline edit and the agent loop are written against
 *  this interface only, so adding a backend never touches feature code.
 *--------------------------------------------------------------------------------------------*/

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A tool invocation requested by the model. `args` is raw JSON text, parsed at the call site. */
export interface ToolCall {
	id: string;
	name: string;
	args: string;
}

export interface ChatMessage {
	role: Role;
	content: string;
	/** Present on assistant messages that requested tools. */
	toolCalls?: ToolCall[];
	/** Present on `tool` messages, linking the result back to the request. */
	toolCallId?: string;
	/** Tool name, echoed back on `tool` messages for providers that require it. */
	name?: string;
}

/** JSON-Schema description of a tool the model may call. */
export interface ToolSchema {
	name: string;
	description: string;
	parameters: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface CompletionRequest {
	messages: ChatMessage[];
	tools?: ToolSchema[];
	temperature?: number;
	maxTokens?: number;
}

/**
 * Providers emit a flat event stream rather than returning a whole response, so the UI
 * can render the first token immediately. On CPU-only inference that difference is the
 * gap between "feels broken" and "feels alive".
 */
export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'toolCall'; call: ToolCall }
	| { type: 'usage'; promptTokens?: number; completionTokens?: number }
	| { type: 'done'; reason: 'stop' | 'length' | 'toolCalls' | 'cancelled' };

export interface LLMProvider {
	readonly id: string;
	readonly label: string;
	/** True when the provider can execute tool calls; the agent loop refuses to start otherwise. */
	readonly supportsTools: boolean;

	/** Model ids available on the server, for the model picker. Empty array if unknown. */
	listModels(signal: AbortSignal): Promise<string[]>;

	/** Streams a completion. Must terminate with exactly one `done` event unless it throws. */
	stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

/** Thrown for problems the user can actually act on (server down, model missing, bad key). */
export class ProviderError extends Error {
	constructor(message: string, readonly hint?: string) {
		super(message);
		this.name = 'ProviderError';
	}
}
