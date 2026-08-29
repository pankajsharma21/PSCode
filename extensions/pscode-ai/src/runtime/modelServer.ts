/*---------------------------------------------------------------------------------------------
 *  PSCode AI - bundled model server
 *
 *  PSCode ships its own inference engine (llama.cpp's `llama-server`) and its own weights, and
 *  owns their lifecycle: the process starts with the window and dies with it. That is the whole
 *  point - installing the IDE is the only install step, and there is no second daemon that can be
 *  running, stopped, or a different version than the editor expects.
 *
 *  The engine speaks the OpenAI API, so nothing above this file had to change to use it: the
 *  existing `OpenAICompatibleProvider` talks to it, and `--jinja` is what makes it emit real
 *  `tool_calls` rather than prose that looks like one, which is what agent mode depends on.
 *
 *  Imports nothing from `vscode`, like `providers/`, so it can be exercised from plain Node
 *  (test/runtime-smoke.js) against the real binary rather than only inside a window.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';

export interface ModelServerOptions {
	/** Directory holding `llama-server` and the shared objects it links against. */
	binDir: string;
	/** Absolute path to the .gguf weights. */
	modelPath: string;
	/** Model id reported to callers and sent in requests. */
	alias: string;
	contextSize: number;
	/** 0 means "let this class decide from the CPU count". */
	threads: number;
	/** How long to wait for the server to answer /health before giving up. */
	startupTimeoutMs: number;
	/**
	 * Jinja chat template to use instead of the one baked into the .gguf.
	 *
	 * Needed because a quantised model's embedded template is often an older or trimmed copy of
	 * the one the model was actually trained with - and when the missing part is the tool-call
	 * section, the model answers a tool request with prose that merely looks like JSON, which
	 * agent mode cannot execute.
	 */
	chatTemplatePath?: string;
	/** Appended verbatim - `--embeddings` and its pooling flags for the embedding engine. */
	extraArgs?: string[];
	log: (message: string) => void;
}

/** Kept small: every line is also mirrored into the extension log as the server produces it. */
const STDERR_KEEP_LINES = 40;

/** util-linux, present on any Linux worth shipping to; absence only costs the orphan guard. */
const SETPRIV = '/usr/bin/setpriv';

export class ModelServer {
	private child: ChildProcess | undefined;
	private starting: Promise<string> | undefined;
	private endpointUrl = '';
	private readonly recentStderr: string[] = [];
	private disposed = false;

	constructor(private readonly options: ModelServerOptions) { }

	/** The endpoint once running, or '' - callers that need it must await `ensureStarted()`. */
	get endpoint(): string {
		return this.endpointUrl;
	}

	get running(): boolean {
		return !!this.child && this.child.exitCode === null && !this.child.killed;
	}

	/**
	 * Starts the server if it is not already up, and returns its endpoint.
	 *
	 * Idempotent and safe to call concurrently: the first caller creates the promise and everyone
	 * else awaits the same one, so two chat turns racing at startup cannot spawn two engines. A
	 * crashed server clears the promise, so the next call restarts it rather than handing out an
	 * endpoint that nothing is listening on.
	 */
	ensureStarted(): Promise<string> {
		if (this.disposed) {
			return Promise.reject(new Error('The model server has been shut down.'));
		}
		if (this.running && this.endpointUrl) {
			return Promise.resolve(this.endpointUrl);
		}
		if (!this.starting) {
			this.starting = this.start().catch(error => {
				this.starting = undefined;
				throw error;
			});
		}
		return this.starting;
	}

	private async start(): Promise<string> {
		const port = await findFreePort();
		const binary = join(this.options.binDir, 'llama-server');
		const threads = this.options.threads > 0 ? this.options.threads : defaultThreads();

		const args = [
			'--model', this.options.modelPath,
			'--alias', this.options.alias,
			'--host', '127.0.0.1',
			'--port', String(port),
			'--ctx-size', String(this.options.contextSize),
			'--threads', String(threads),
			// Without this the server falls back to a generic template and returns tool calls as
			// text in `content`. Agent mode then sees a model that "narrates" tools it never
			// called - the exact failure this project already documents for small models, except
			// caused by the server rather than the model.
			'--jinja',
			...(this.options.chatTemplatePath ? ['--chat-template-file', this.options.chatTemplatePath] : []),
			...(this.options.extraArgs ?? []),
		];

		// `dispose()` covers a window that closes; this covers one that is killed.
		//
		// The engine is a child of the extension host, and an orphaned child is not cleaned up -
		// it is reparented and carries on holding gigabytes of weights, which is exactly what was
		// wrong with depending on a separate daemon. PR_SET_PDEATHSIG makes the kernel signal it
		// the moment the extension host dies, however the host died. setpriv execs the binary, so
		// the PID we hold is still llama-server and kill() below is unaffected.
		const guarded = existsSync(SETPRIV);
		const command = guarded ? SETPRIV : binary;
		const argv = guarded ? ['--pdeathsig', 'TERM', binary, ...args] : args;

		this.options.log(
			`Starting the model engine: llama-server on 127.0.0.1:${port} (${threads} threads, ctx ${this.options.contextSize})`
			+ (guarded ? '' : ' — without setpriv, so a killed window can leave it running')
		);

		const child = spawn(command, argv, {
			env: {
				...process.env,
				// The release tarball keeps libllama/libggml next to the binary rather than in a
				// system directory, which is what makes the bundle relocatable.
				LD_LIBRARY_PATH: [this.options.binDir, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(':'),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child = child;

		child.stderr?.on('data', chunk => this.recordOutput(String(chunk)));
		child.stdout?.on('data', chunk => this.recordOutput(String(chunk)));

		const exited = new Promise<never>((_, reject) => {
			child.once('error', error => reject(new Error(`Could not run the bundled engine at ${binary}: ${error.message}`)));
			child.once('exit', (code, signal) => {
				this.endpointUrl = '';
				this.starting = undefined;
				const how = signal ? `signal ${signal}` : `code ${code}`;
				this.options.log(`The model engine exited (${how})`);
				reject(new Error(`The bundled engine stopped (${how}).\n${this.stderrTail()}`));
			});
		});

		const endpoint = `http://127.0.0.1:${port}`;
		// Racing the health poll against the exit promise matters: a bad model file makes
		// llama-server exit within a second, and without this the caller would sit through the
		// full startup timeout before being told something that was already known.
		await Promise.race([waitForHealth(endpoint, this.options.startupTimeoutMs), exited]);

		this.endpointUrl = endpoint;
		this.options.log(`The model engine is ready at ${endpoint}`);
		return endpoint;
	}

	private recordOutput(text: string): void {
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			this.recentStderr.push(trimmed);
			if (this.recentStderr.length > STDERR_KEEP_LINES) {
				this.recentStderr.shift();
			}
		}
	}

	private stderrTail(): string {
		return this.recentStderr.slice(-12).join('\n');
	}

	/**
	 * Stops the engine. Called from `deactivate`, so the process cannot outlive the window that
	 * started it - a stray engine holding gigabytes of weights is worse than no engine at all.
	 */
	dispose(): void {
		this.disposed = true;
		this.starting = undefined;
		this.endpointUrl = '';
		const child = this.child;
		this.child = undefined;
		if (!child || child.exitCode !== null) {
			return;
		}
		child.kill('SIGTERM');
		// SIGTERM is enough for llama-server, but a wedged process must not keep the weights
		// resident after the window is gone.
		const hard = setTimeout(() => {
			if (child.exitCode === null) {
				child.kill('SIGKILL');
			}
		}, 3000);
		hard.unref?.();
	}
}

/** Threads for inference. One core is left for the editor, which is the process being typed in. */
function defaultThreads(): number {
	const cpus = require('os').cpus?.().length ?? 4;
	return Math.max(1, Math.min(cpus - 1, 8));
}

/**
 * Asks the OS for a free port and hands it straight back.
 *
 * A fixed port would collide with a second PSCode window, and each window owns its own engine.
 */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => (port ? resolve(port) : reject(new Error('Could not find a free port for the model engine.'))));
		});
	});
}

async function waitForHealth(endpoint: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';

	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) {
				return;
			}
			// 503 while the weights are still being read is expected, not a failure.
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}

	throw new Error(`The model engine did not become ready within ${Math.round(timeoutMs / 1000)}s (${lastError}).`);
}
