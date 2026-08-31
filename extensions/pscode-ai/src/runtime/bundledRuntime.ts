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
 * Where the engine and weights may live, most-specific first.
 *
 * Two locations, because a packaged install cannot use one:
 *
 *  - `<extension>/runtime` is the source-checkout and bundled-build case. Writable there.
 *  - `<globalStorage>/runtime` is where a packaged install puts them, because the app directory is
 *    `/usr/share/pscode/...` and root-owned - a first-run download into it would need sudo, which
 *    is not a thing an editor should ask for to answer a question.
 *
 * The app directory is checked first so a build that genuinely bundles weights keeps using its
 * own, and a user download never silently shadows it.
 */
export function runtimeSearchPaths(extensionPath: string, storagePath?: string): string[] {
	const paths = [join(extensionPath, 'runtime')];
	if (storagePath) {
		paths.push(join(storagePath, 'runtime'));
	}
	return paths;
}

/** Where a download should go: the first location that is not inside the read-only app directory. */
export function runtimeInstallPath(extensionPath: string, storagePath?: string): string {
	return storagePath ? join(storagePath, 'runtime') : join(extensionPath, 'runtime');
}

/**
 * Locates the engine and weights, or returns undefined when they were never fetched.
 *
 * Undefined is a normal state, not a broken install: neither a source checkout nor the shipped
 * installer carries a 9GB model, so this returns undefined until either
 * `scripts/fetch-llm-runtime.sh` or the in-editor download has run. Chat still works if an
 * endpoint is configured, and the status bar says what is missing.
 */
export function discoverRuntime(extensionPath: string, storagePath?: string): RuntimeLayout | undefined {
	for (const candidate of runtimeSearchPaths(extensionPath, storagePath)) {
		const found = discoverRuntimeAt(candidate);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function discoverRuntimeAt(root: string): RuntimeLayout | undefined {
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
