/*---------------------------------------------------------------------------------------------
 *  PSCode AI - the bundled engine, as an LLMProvider
 *
 *  A thin adapter, and deliberately so. The engine PSCode ships speaks the OpenAI API, so the
 *  wire format is already handled by `OpenAICompatibleProvider`; the only thing this adds is
 *  *when* the endpoint is known. The engine binds a free port at startup, so its URL does not
 *  exist until the process is up, which means it cannot come from settings the way a remote
 *  endpoint does.
 *
 *  Every call therefore starts by awaiting the engine. That await is what makes "no dependency"
 *  true in practice: the first question asked after opening a window starts the engine and then
 *  answers, instead of failing with a connection error and asking the user to go start a daemon.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompat';
import { CompletionRequest, LLMProvider, StreamEvent } from './types';

export class BundledProvider implements LLMProvider {
	readonly id = 'bundled';
	readonly label = 'Bundled (llama.cpp)';
	readonly supportsTools = true;

	constructor(
		private readonly ensureEndpoint: () => Promise<string>,
		private readonly model: string,
		private readonly timeoutMs: number
	) { }

	private async delegate(): Promise<OpenAICompatibleProvider> {
		const endpoint = await this.ensureEndpoint();
		return new OpenAICompatibleProvider(endpoint, this.model, '', this.timeoutMs);
	}

	async listModels(signal: AbortSignal): Promise<string[]> {
		return (await this.delegate()).listModels(signal);
	}

	async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const provider = await this.delegate();
		yield* provider.stream(request, signal);
	}
}
