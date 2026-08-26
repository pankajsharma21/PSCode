/*---------------------------------------------------------------------------------------------
 *  PSCode AI - provider smoke test
 *
 *  Runs against a REAL local model server, because the failures that matter here (a stream
 *  that never terminates, tool arguments that arrive in the wrong shape, an unhelpful error
 *  on a dead port) are exactly the ones a mocked HTTP layer cannot catch.
 *
 *  Usage:
 *    ollama serve &
 *    ollama pull llama3.2
 *    node extensions/pscode-ai/test/provider-smoke.js
 *
 *  Requires the extension to be compiled first (npm run compile at the repo root).
 *--------------------------------------------------------------------------------------------*/

const { OllamaProvider } = require('../out/providers/ollama');
const { ProviderError } = require('../out/providers/types');

const ENDPOINT = 'http://127.0.0.1:11434';
const MODEL = process.env.PSCODE_TEST_MODEL || 'llama3.2:latest';   // small + tool-capable = fast test

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

async function main() {
	const p = new OllamaProvider(ENDPOINT, MODEL, 300000);

	// 1. listModels
	const models = await p.listModels(AbortSignal.timeout(15000));
	check('listModels returns models', models.length >= 1, models.join(', '));

	// 2. plain streaming chat
	const events = [];
	let text = '';
	for await (const e of p.stream({
		messages: [
			{ role: 'system', content: 'Reply with exactly one word.' },
			{ role: 'user', content: 'Say the word: ready' },
		],
		temperature: 0,
		maxTokens: 32,
	}, AbortSignal.timeout(180000))) {
		events.push(e.type);
		if (e.type === 'text') text += e.text;
	}
	check('stream emits text events', events.includes('text'), `${events.filter(t=>t==='text').length} deltas`);
	check('stream emits exactly one done', events.filter(t => t === 'done').length === 1);
	check('stream reports usage', events.includes('usage'));
	check('model produced text', text.trim().length > 0, JSON.stringify(text.trim().slice(0,60)));

	// 3. tool calling — the path agent mode depends on
	const toolEvents = [];
	for await (const e of p.stream({
		messages: [
			{ role: 'system', content: 'You must use the provided tool to answer. Do not answer from memory.' },
			{ role: 'user', content: 'Read the file src/main.ts for me.' },
		],
		tools: [{
			name: 'read_file',
			description: 'Read a text file from the workspace.',
			parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' } }, required: ['path'] },
		}],
		temperature: 0,
		maxTokens: 256,
	}, AbortSignal.timeout(180000))) {
		toolEvents.push(e);
	}
	const calls = toolEvents.filter(e => e.type === 'toolCall');
	check('tool call is parsed', calls.length >= 1, calls.map(c => `${c.call.name}(${c.call.args})`).join(' '));
	if (calls.length) {
		const args = JSON.parse(calls[0].call.args);
		check('tool args normalise to JSON text', typeof calls[0].call.args === 'string' && typeof args === 'object',
			`path=${args.path}`);
		check('tool call has an id', !!calls[0].call.id);
	}

	// 4. connection failure produces an actionable ProviderError
	const dead = new OllamaProvider('http://127.0.0.1:59999', MODEL, 5000);
	try {
		for await (const _ of dead.stream({ messages: [{ role: 'user', content: 'hi' }] }, AbortSignal.timeout(8000))) { /* drain */ }
		check('dead endpoint throws', false, 'no error thrown');
	} catch (err) {
		check('dead endpoint throws ProviderError', err instanceof ProviderError, err.message);
		check('error carries an actionable hint', typeof err.hint === 'string' && err.hint.includes('ollama serve'), err.hint);
	}

	// 5. missing model -> useful message
	const badModel = new OllamaProvider(ENDPOINT, 'definitely-not-a-real-model:1b', 20000);
	try {
		for await (const _ of badModel.stream({ messages: [{ role: 'user', content: 'hi' }] }, AbortSignal.timeout(20000))) { /* drain */ }
		check('missing model throws', false, 'no error thrown');
	} catch (err) {
		check('missing model throws ProviderError', err instanceof ProviderError, err.message);
	}

	console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('HARNESS ERROR:', err); process.exit(2); });
