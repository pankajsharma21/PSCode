/*---------------------------------------------------------------------------------------------
 *  PSCode AI - embeddings
 *
 *  Kept out of `LLMProvider` on purpose. That interface is about streaming a conversation and
 *  is implemented three times; embeddings are a single request/response, only two of the three
 *  backends offer them, and the semantic index is the only caller. Bolting an `embed()` onto
 *  the chat interface would force two providers to implement a method that throws.
 *
 *  The model here is a *different, much smaller* model than the chat model - a 7B chat model
 *  is both wasteful and worse at this. nomic-embed-text is ~274MB and embeds a batch of code
 *  chunks in well under a second on CPU, which is what makes indexing viable without a GPU.
 *--------------------------------------------------------------------------------------------*/

import { bundledRuntime } from '../runtime/bundledRuntime';
import { requestJson } from './http';
// `import type` on purpose: registry.ts imports vscode, and erasing this at compile time is
// what keeps this module loadable in plain Node - same property the chat providers rely on
// for test/provider-smoke.js.
import type { AISettings } from './registry';
import { ProviderError } from './types';

/** Ollama's native shape: `embeddings` is an array parallel to the `input` array. */
interface OllamaEmbedResponse {
	embeddings?: number[][];
	error?: string;
}

/** The OpenAI shape, used by llama.cpp's server and anything else compatible. */
interface OpenAIEmbedResponse {
	data?: { embedding?: number[]; index?: number }[];
	error?: { message?: string };
}

export interface EmbeddingClient {
	/** Model id used, for the index header - a vector is only comparable to its own model. */
	readonly model: string;
	embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>;
}

class OllamaEmbeddings implements EmbeddingClient {
	constructor(
		private readonly endpoint: string,
		readonly model: string,
		private readonly timeoutMs: number
	) { }

	async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
		const response = await requestJson<OllamaEmbedResponse>({
			url: `${this.endpoint.replace(/\/+$/, '')}/api/embed`,
			method: 'POST',
			body: { model: this.model, input: texts },
			timeoutMs: this.timeoutMs,
			signal,
		});

		if (response.error) {
			throw new ProviderError(`Embedding failed: ${response.error}`, embeddingHint(this.model));
		}
		if (!response.embeddings || response.embeddings.length !== texts.length) {
			throw new ProviderError(
				`The embedding server returned ${response.embeddings?.length ?? 0} vectors for ${texts.length} inputs.`,
				embeddingHint(this.model)
			);
		}
		return response.embeddings.map(vector => Float32Array.from(vector));
	}
}

class OpenAICompatibleEmbeddings implements EmbeddingClient {
	constructor(
		private readonly endpoint: string,
		readonly model: string,
		private readonly apiKey: string,
		private readonly timeoutMs: number
	) { }

	async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
		const response = await requestJson<OpenAIEmbedResponse>({
			url: `${this.endpoint.replace(/\/+$/, '')}/v1/embeddings`,
			method: 'POST',
			headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
			body: { model: this.model, input: texts },
			timeoutMs: this.timeoutMs,
			signal,
		});

		if (response.error) {
			throw new ProviderError(`Embedding failed: ${response.error.message ?? 'unknown error'}`);
		}
		const data = response.data ?? [];
		if (data.length !== texts.length) {
			throw new ProviderError(`The embedding server returned ${data.length} vectors for ${texts.length} inputs.`);
		}
		// `index` is authoritative: the spec does not promise response order.
		const out: Float32Array[] = new Array(texts.length);
		data.forEach((entry, position) => {
			const at = typeof entry.index === 'number' ? entry.index : position;
			out[at] = Float32Array.from(entry.embedding ?? []);
		});
		return out;
	}
}

/**
 * The bundled embedding engine, whose URL only exists once it is running.
 *
 * Starting it here rather than at activation is deliberate: this is the first line of
 * `PSCode: Build Semantic Index`, so the several hundred megabytes it needs are only spent by
 * someone who actually asked for @codebase.
 */
class LazyEndpointEmbeddings implements EmbeddingClient {
	constructor(
		private readonly ensureEndpoint: () => Promise<string>,
		readonly model: string,
		private readonly timeoutMs: number
	) { }

	async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
		const endpoint = await this.ensureEndpoint();
		return new OpenAICompatibleEmbeddings(endpoint, this.model, '', this.timeoutMs).embed(texts, signal);
	}
}

function embeddingHint(model: string): string {
	return `Pull the embedding model first: "ollama pull ${model}". It is separate from the chat model, and a chat model cannot stand in for it.`;
}

/**
 * Anthropic has no embeddings endpoint, so semantic search is unavailable there rather than
 * silently degraded. Said plainly at the point of use instead of failing mid-index.
 */
export function createEmbeddingClient(settings: AISettings): EmbeddingClient {
	switch (settings.provider) {
		case 'bundled': {
			const runtime = bundledRuntime();
			if (!runtime?.embedModel) {
				throw new ProviderError(
					'This build does not include an embedding model, so @codebase search is unavailable.',
					'Run scripts/fetch-llm-runtime.sh to fetch it, or point "pscode.ai.provider" at a server that offers embeddings.'
				);
			}
			return new LazyEndpointEmbeddings(
				() => runtime.ensureEmbedEndpoint(),
				settings.embeddingModel,
				settings.requestTimeoutMs
			);
		}
		case 'ollama':
			return new OllamaEmbeddings(settings.endpoint, settings.embeddingModel, settings.requestTimeoutMs);
		case 'openai-compatible':
			return new OpenAICompatibleEmbeddings(
				settings.endpoint,
				settings.embeddingModel,
				settings.apiKey,
				settings.requestTimeoutMs
			);
		case 'anthropic':
		default:
			throw new ProviderError(
				'The Anthropic provider does not offer embeddings, so @codebase search is unavailable.',
				'Switch "pscode.ai.provider" to ollama (local) to build a semantic index.'
			);
	}
}

/**
 * Cosine similarity. The vectors come back unnormalised, so the norms are computed rather
 * than assumed - a wrong assumption here does not error, it just quietly ranks badly.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	const length = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) {
		return 0;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
