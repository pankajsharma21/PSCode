/*---------------------------------------------------------------------------------------------
 *  PSCode AI - embedding smoke test
 *
 *  Runs against a REAL embedding server, for the same reason the provider smoke test does: the
 *  failures that matter are wire-shaped. A mocked embedder will happily return vectors that
 *  rank perfectly; a real one tells you whether the batch came back in the order you sent it,
 *  whether the dimensions are what the index assumed, and whether similarity actually
 *  separates related code from unrelated code.
 *
 *  Usage:
 *    ollama serve &
 *    ollama pull nomic-embed-text
 *    node extensions/pscode-ai/test/embedding-smoke.js
 *
 *  Requires the extension to be compiled first (npm run compile at the repo root).
 *--------------------------------------------------------------------------------------------*/

const { createEmbeddingClient, cosineSimilarity } = require('../out/providers/embeddings');
const { ProviderError } = require('../out/providers/types');

const MODEL = process.env.PSCODE_TEST_EMBED_MODEL || 'nomic-embed-text';

const settings = {
	provider: 'ollama',
	endpoint: 'http://127.0.0.1:11434',
	embeddingModel: MODEL,
	apiKey: '',
	requestTimeoutMs: 120000,
};

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

async function main() {
	const client = createEmbeddingClient(settings);
	check('client reports its model', client.model === MODEL, client.model);

	// 1. A batch returns one vector per input, all the same width. The index stores vectors in
	//    one flat Float32Array and slices by a fixed stride, so a ragged batch would corrupt
	//    every chunk after the odd one rather than fail loudly.
	const inputs = [
		'function retryWithBackoff(fn, attempts) { for (let i = 0; i < attempts; i++) { try { return fn(); } catch (e) { sleep(2 ** i); } } }',
		'export function formatCurrency(value, locale) { return new Intl.NumberFormat(locale, { style: "currency" }).format(value); }',
		'CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL);',
	];
	const vectors = await client.embed(inputs, AbortSignal.timeout(120000));
	check('one vector per input', vectors.length === inputs.length, `${vectors.length} vectors`);
	const dims = vectors[0].length;
	check('vectors are non-empty', dims > 0, `${dims} dimensions`);
	check('all vectors share a width', vectors.every(v => v.length === dims), 'stride is uniform');
	check('vectors are Float32Array', vectors.every(v => v instanceof Float32Array), 'index writes them raw');

	// 2. Self-similarity is the sanity check on cosineSimilarity itself.
	const self = cosineSimilarity(vectors[0], vectors[0]);
	check('a vector is identical to itself', Math.abs(self - 1) < 1e-4, `cos=${self.toFixed(4)}`);

	// 3. The property the whole feature rests on: a plain-words query must rank the code it
	//    describes above unrelated code. If this fails, @codebase is decoration.
	const [query] = await client.embed(['how does the code retry a failed operation'], AbortSignal.timeout(120000));
	const scores = vectors.map(v => cosineSimilarity(query, v));
	const best = scores.indexOf(Math.max(...scores));
	check(
		'a meaning-based query ranks the retry snippet first',
		best === 0,
		scores.map((s, i) => `#${i}=${s.toFixed(3)}`).join(' ')
	);
	check(
		'the winning score is clearly ahead',
		scores[0] - Math.max(scores[1], scores[2]) > 0.02,
		`margin=${(scores[0] - Math.max(scores[1], scores[2])).toFixed(3)}`
	);

	// 4. Ordering is positional for Ollama, so a mismatched count is the only guard available;
	//    confirm a single input still round-trips (the search path always sends exactly one).
	const single = await client.embed(['just one'], AbortSignal.timeout(60000));
	check('a single-input batch works', single.length === 1 && single[0].length === dims);

	// 5. Anthropic must refuse rather than silently return nothing.
	try {
		createEmbeddingClient({ ...settings, provider: 'anthropic' });
		check('anthropic is refused', false, 'no error was thrown');
	} catch (error) {
		check('anthropic is refused with a usable message', error instanceof ProviderError, error.message);
	}

	// 6. A dead port must explain itself; this is the first thing a new user hits.
	try {
		const dead = createEmbeddingClient({ ...settings, endpoint: 'http://127.0.0.1:9', requestTimeoutMs: 4000 });
		await dead.embed(['x'], AbortSignal.timeout(6000));
		check('a dead endpoint errors', false, 'it resolved instead');
	} catch (error) {
		check('a dead endpoint explains itself', error instanceof ProviderError, error.message);
	}
}

main().then(
	() => {
		console.log(failures === 0 ? '\nAll embedding checks passed.' : `\n${failures} check(s) FAILED.`);
		process.exit(failures === 0 ? 0 : 1);
	},
	error => {
		console.error('\nSmoke test threw:', error && error.message ? error.message : error);
		if (error && error.hint) {
			console.error('Hint:', error.hint);
		}
		process.exit(1);
	}
);
