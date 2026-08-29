/*---------------------------------------------------------------------------------------------
 *  PSCode AI - bundled engine smoke test
 *
 *  The claim this test defends is the reason the engine is bundled at all: PSCode owns the model
 *  process. So it checks the lifecycle, not just that a reply comes back - the engine starts from
 *  a cold call, two callers racing it get one process rather than two, tool calls come back as
 *  structured `tool_calls` (agent mode is worthless without that), and `dispose()` actually leaves
 *  no process behind holding gigabytes of weights.
 *
 *  Runs against the real binary and the real weights, in plain Node, with no window open:
 *
 *    ./scripts/fetch-llm-runtime.sh
 *    npm run compile
 *    node extensions/pscode-ai/test/runtime-smoke.js
 *--------------------------------------------------------------------------------------------*/

const { execSync } = require('child_process');
const { join } = require('path');
const { discoverRuntime, BundledRuntime } = require('../out/runtime/bundledRuntime');
const { OpenAICompatibleProvider } = require('../out/providers/openaiCompat');

const EXTENSION_ROOT = join(__dirname, '..');

let failures = 0;
const check = (name, ok, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) { failures++; }
};

/*
 * Counts *our* engines.
 *
 * The bracket in `llama-serve[r]` is not decoration: `pgrep -f` matches against full command
 * lines, and the shell running this very pipeline has "llama-server" in its own command line, so
 * the naive pattern counts itself and the test reports one process too many - or, in the version
 * of this that kills strays, kills its own shell. The model path narrows it further, so an engine
 * someone else is running on this machine is not mistaken for ours.
 */
const countEngineProcesses = () => {
	try {
		return execSync(`ps -eo cmd | grep "[l]lama-serve[r]" | grep -c "${EXTENSION_ROOT}/runtime/models" || true`)
			.toString().trim();
	} catch {
		return '0';
	}
};

async function main() {
	const layout = discoverRuntime(EXTENSION_ROOT);
	check('the runtime is present', !!layout, layout ? layout.chat.name : 'run scripts/fetch-llm-runtime.sh first');
	if (!layout) { process.exit(1); }

	const runtime = new BundledRuntime(layout, {
		contextSize: 4096,
		threads: 0,
		startupTimeoutMs: 300000,
		log: message => console.log(`      [engine] ${message}`),
	});

	try {
		check('no engine is running before the first call', countEngineProcesses() === '0');

		// Two callers at once: the second must join the first start, not spawn a second engine.
		const started = Date.now();
		const [a, b] = await Promise.all([runtime.ensureChatEndpoint(), runtime.ensureChatEndpoint()]);
		check('the engine starts on demand', /^http:\/\/127\.0\.0\.1:\d+$/.test(a), `${a} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
		check('concurrent callers share one engine', a === b && countEngineProcesses() === '1', `${countEngineProcesses()} process(es)`);

		const provider = new OpenAICompatibleProvider(a, runtime.chatModel, '', 300000);

		let text = '';
		for await (const event of provider.stream(
			{ messages: [{ role: 'user', content: 'Reply with exactly: READY' }], maxTokens: 16 },
			AbortSignal.timeout(300000)
		)) {
			if (event.type === 'text') { text += event.text; }
		}
		check('it answers a chat turn', text.toUpperCase().includes('READY'), JSON.stringify(text.trim().slice(0, 40)));

		// The one that matters for agent mode: a tool must arrive as a call, not as prose.
		let call;
		for await (const event of provider.stream(
			{
				messages: [{ role: 'user', content: 'Read the file src/app.ts to see what it does.' }],
				tools: [{
					name: 'read_file',
					description: 'Read a file from the workspace',
					parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
				}],
				maxTokens: 128,
			},
			AbortSignal.timeout(300000)
		)) {
			if (event.type === 'toolCall') { call = event.call; }
		}
		check('tool calls come back structured', !!call && call.name === 'read_file', call ? `${call.name}(${call.args})` : 'no tool call');

		// @codebase: a second, smaller engine, started only now.
		if (layout.embed) {
			const embedEndpoint = await runtime.ensureEmbedEndpoint();
			check('the embedding engine starts separately', embedEndpoint !== a, `chat ${a}, embed ${embedEndpoint}`);
			const response = await fetch(`${embedEndpoint}/v1/embeddings`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: runtime.embedModel, input: ['function add(a, b) { return a + b; }'] }),
				signal: AbortSignal.timeout(120000),
			});
			const body = await response.json();
			const vector = body?.data?.[0]?.embedding ?? [];
			check('it returns an embedding vector', vector.length > 64, `${vector.length} dimensions`);
		}
	} finally {
		runtime.dispose();
		// SIGTERM is not instant; give it the same grace the class does before checking.
		await new Promise(resolve => setTimeout(resolve, 4000));
	}

	check('dispose() leaves no engine behind', countEngineProcesses() === '0', `${countEngineProcesses()} still running`);

	console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
	process.exit(failures ? 1 : 0);
}

main().catch(error => {
	console.error('ERROR', error);
	process.exit(1);
});
