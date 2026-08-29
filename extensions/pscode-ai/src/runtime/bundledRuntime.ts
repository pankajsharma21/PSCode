/*---------------------------------------------------------------------------------------------
 *  PSCode AI - what ships in the box
 *
 *  Finds the engine and weights inside the installed extension and owns the two server processes
 *  built on them. There are two because they are different jobs: a chat model answers, and a much
 *  smaller embedding model turns files into vectors for @codebase. Loading one model and using it
 *  for both would be slower at chat and worse at search.
 *
 *  The embedding engine starts *lazily*, on the first @codebase use. Someone who never uses
 *  semantic search should not pay several hundred megabytes of resident memory for it.
 *
 *  Nothing here imports `vscode`; the extension passes its own install path in. That keeps this
 *  runnable from plain Node, which is how test/runtime-smoke.js checks a real engine start.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ModelServer } from './modelServer';

export interface BundledModel {
	path: string;
	/** Human-readable id, shown in the status bar and stored in the semantic index header. */
	name: string;
}

export interface RuntimeLayout {
	binDir: string;
	chat: BundledModel;
	embed: BundledModel | undefined;
	/** Chat template shipped beside the weights; undefined means "use the one in the .gguf". */
	chatTemplate: string | undefined;
}

interface RuntimeManifest {
	engine?: string;
	chat?: { file?: string; name?: string };
	embed?: { file?: string; name?: string };
}

/**
 * Locates the bundled runtime, or returns undefined when it was never fetched.
 *
 * Undefined is a normal state, not a broken install: a source checkout does not carry a 2GB model
 * (`scripts/fetch-llm-runtime.sh` puts it there, and git ignores it), so a developer who has not
 * run that script still gets a working editor - just one that needs an endpoint in settings.
 */
export function discoverRuntime(extensionPath: string): RuntimeLayout | undefined {
	const root = join(extensionPath, 'runtime');
	const binDir = join(root, 'bin');
	if (!existsSync(join(binDir, 'llama-server'))) {
		return undefined;
	}

	let manifest: RuntimeManifest = {};
	try {
		manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as RuntimeManifest;
	} catch {
		// The manifest only supplies display names; the files themselves are what matter.
	}

	const chatPath = join(root, 'models', manifest.chat?.file ?? 'chat.gguf');
	if (!existsSync(chatPath)) {
		return undefined;
	}

	const embedPath = join(root, 'models', manifest.embed?.file ?? 'embed.gguf');
	const templatePath = join(root, 'models', 'chat.jinja');

	return {
		binDir,
		chatTemplate: existsSync(templatePath) ? templatePath : undefined,
		chat: { path: chatPath, name: manifest.chat?.name ?? 'bundled-chat' },
		embed: existsSync(embedPath)
			? { path: embedPath, name: manifest.embed?.name ?? 'bundled-embed' }
			: undefined,
	};
}

export interface BundledRuntimeOptions {
	contextSize: number;
	threads: number;
	startupTimeoutMs: number;
	log: (message: string) => void;
}

export class BundledRuntime {
	private readonly chatServer: ModelServer;
	private embedServer: ModelServer | undefined;

	constructor(
		private readonly layout: RuntimeLayout,
		private readonly options: BundledRuntimeOptions
	) {
		this.chatServer = new ModelServer({
			binDir: layout.binDir,
			modelPath: layout.chat.path,
			alias: layout.chat.name,
			contextSize: options.contextSize,
			threads: options.threads,
			startupTimeoutMs: options.startupTimeoutMs,
			chatTemplatePath: layout.chatTemplate,
			log: options.log,
		});
	}

	get chatModel(): string {
		return this.layout.chat.name;
	}

	get embedModel(): string | undefined {
		return this.layout.embed?.name;
	}

	get chatRunning(): boolean {
		return this.chatServer.running;
	}

	ensureChatEndpoint(): Promise<string> {
		return this.chatServer.ensureStarted();
	}

	/**
	 * Starts the embedding engine on demand.
	 *
	 * `--embeddings` switches the server into embedding mode, and mean pooling is what the
	 * embedding models here are trained for - the default pooling would return vectors that are
	 * self-consistent but much worse at ranking, which looks like "@codebase found the wrong
	 * file" rather than like a configuration mistake.
	 */
	ensureEmbedEndpoint(): Promise<string> {
		const embed = this.layout.embed;
		if (!embed) {
			return Promise.reject(new Error('No embedding model is bundled with this build, so @codebase is unavailable.'));
		}
		if (!this.embedServer) {
			this.embedServer = new ModelServer({
				binDir: this.layout.binDir,
				modelPath: embed.path,
				alias: embed.name,
				// Embedding models have short context windows; asking for more is rejected outright.
				contextSize: 2048,
				threads: this.options.threads,
				startupTimeoutMs: this.options.startupTimeoutMs,
				extraArgs: ['--embeddings', '--pooling', 'mean'],
				log: this.options.log,
			});
		}
		return this.embedServer.ensureStarted();
	}

	dispose(): void {
		this.chatServer.dispose();
		this.embedServer?.dispose();
		this.embedServer = undefined;
	}
}

/*
 * A module-level instance, set once by `activate`.
 *
 * `createProvider()` is called from a dozen places and is synchronous, so threading the runtime
 * through every one of them would mean changing every call site to pass something they have no
 * other use for. One window owns exactly one runtime, so a module singleton says that plainly.
 */
let current: BundledRuntime | undefined;

export function setBundledRuntime(runtime: BundledRuntime | undefined): void {
	current = runtime;
}

export function bundledRuntime(): BundledRuntime | undefined {
	return current;
}
