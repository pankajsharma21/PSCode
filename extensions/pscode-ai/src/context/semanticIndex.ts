/*---------------------------------------------------------------------------------------------
 *  PSCode AI - semantic index (@codebase)
 *
 *  PSCode's navigation tools are built on the language server, and that is still the right
 *  default: `find_usages` *knows* what a symbol resolves to, where vector similarity only
 *  guesses. But the language server needs a symbol name, and the questions that matter most
 *  on an unfamiliar codebase do not have one - "where is retry handled", "what validates the
 *  upload". That is the gap this fills, and only that gap.
 *
 *  Design notes that follow from running on a CPU:
 *   - Indexing is explicit (a command), never automatic on startup. An index the user did not
 *     ask for, burning a CPU they are compiling on, is a bug.
 *   - Vectors are stored as raw Float32 next to a JSON header, not as JSON numbers. A 768-dim
 *     vector is 3KB binary and roughly 15KB as text; the difference decides whether loading
 *     the index is instant or a visible pause.
 *   - Staleness is size+mtime per file, so a rebuild re-embeds only what changed.
 *   - Saving a file re-embeds just that file, so the index stays true between full builds.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { cosineSimilarity, createEmbeddingClient } from '../providers/embeddings';
import { AISettings, readSettings } from '../providers/registry';
import { log } from '../util/logger';

/** Bumped when the on-disk layout changes, so an old index is discarded rather than misread. */
const FORMAT_VERSION = 1;

/**
 * Chunk geometry. Small enough that a hit points at something specific, large enough to carry
 * meaning on its own - a 10-line chunk of a function body is unrecognisable out of context.
 * The overlap stops a construct that straddles a boundary from being invisible to both chunks.
 */
const CHUNK_LINES = 40;
const CHUNK_OVERLAP_LINES = 10;

/** A single oversized minified file could otherwise dominate the whole index. */
const MAX_FILE_BYTES = 200 * 1024;

/** Batched because per-request overhead dominates for a small embedding model. */
const EMBED_BATCH = 16;

/**
 * How long to sit idle before writing the index back after incremental updates. Saving is a
 * whole-file rewrite of the vector blob, so doing it per save would turn a 200ms re-embed into
 * a multi-megabyte disk write on every Ctrl+S.
 */
const PERSIST_IDLE_MS = 4000;

/**
 * How long a "which files are in scope" answer stays good for.
 *
 * There is no glob matcher available to an extension, and this extension has no runtime npm
 * dependencies to add one, so scope is decided by asking `findFiles` - which honours both the
 * include and the exclude glob exactly as the full build does. That call is cheap but not free,
 * hence the cache: a burst of saves across a rename or a branch switch triggers one scan.
 */
const SCOPE_CACHE_MS = 30000;

interface Chunk {
	relativePath: string;
	startLine: number;
	endLine: number;
	text: string;
}

interface IndexedChunk extends Chunk {
	vector: Float32Array;
}

interface FileStamp {
	size: number;
	mtime: number;
}

interface IndexHeader {
	formatVersion: number;
	model: string;
	dimensions: number;
	createdAt: number;
	files: Record<string, FileStamp>;
	chunks: Chunk[];
}

export interface SearchHit {
	relativePath: string;
	startLine: number;
	endLine: number;
	text: string;
	score: number;
}

export interface BuildOutcome {
	filesIndexed: number;
	filesSkipped: number;
	chunks: number;
	reusedChunks: number;
	cancelled: boolean;
}

/* ------------------------------------------------------------------ chunking */

function chunkFile(relativePath: string, content: string): Chunk[] {
	const lines = content.split('\n');
	const chunks: Chunk[] = [];
	const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP_LINES);

	for (let start = 0; start < lines.length; start += step) {
		const end = Math.min(lines.length, start + CHUNK_LINES);
		const text = lines.slice(start, end).join('\n');

		// Whitespace-only windows happen in generated files and carry no signal, but they
		// still cost an embedding call each.
		if (text.trim().length >= 24) {
			chunks.push({ relativePath, startLine: start + 1, endLine: end, text });
		}
		if (end >= lines.length) {
			break;
		}
	}
	return chunks;
}

/* ------------------------------------------------------------------- storage */

/**
 * One index per workspace, keyed by a hash of the folder paths. Stored under the extension's
 * globalStorage rather than in the workspace, so indexing never dirties the user's repo.
 */
function storageKey(): string {
	const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath).sort();
	return crypto.createHash('sha256').update(folders.join('\0')).digest('hex').slice(0, 16);
}

export class SemanticIndex {
	private chunks: IndexedChunk[] = [];
	private files: Record<string, FileStamp> = {};
	private model = '';
	private loaded = false;
	/** Set while a full build is running, so incremental updates stay out of its way. */
	private building = false;
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private scopeCache: { paths: Set<string>; at: number } | undefined;
	/**
	 * Set when a bulk change was skipped rather than re-embedded. The log alone is not enough:
	 * nobody reads the log, and an index quietly missing a whole branch's worth of files gives
	 * confidently wrong answers. @codebase says so instead.
	 */
	private staleBatch = false;

	constructor(private readonly storageUri: vscode.Uri) { }

	get size(): number {
		return this.chunks.length;
	}

	get indexedModel(): string {
		return this.model;
	}

	/** True when a bulk change was skipped, so search results may be behind the workspace. */
	get mayBeStale(): boolean {
		return this.staleBatch;
	}

	markStaleBatch(): void {
		this.staleBatch = true;
	}

	private get headerUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.storageUri, `index-${storageKey()}.json`);
	}

	private get vectorUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.storageUri, `index-${storageKey()}.f32`);
	}

	/** Reads the index from disk once. Absent or unreadable means "no index", not an error. */
	async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;

		try {
			const headerBytes = await vscode.workspace.fs.readFile(this.headerUri);
			const header = JSON.parse(Buffer.from(headerBytes).toString('utf8')) as IndexHeader;
			if (header.formatVersion !== FORMAT_VERSION) {
				log.info(`Semantic index is format ${header.formatVersion}, expected ${FORMAT_VERSION}; ignoring it`);
				return;
			}

			const vectorBytes = await vscode.workspace.fs.readFile(this.vectorUri);
			const floats = new Float32Array(
				vectorBytes.buffer.slice(vectorBytes.byteOffset, vectorBytes.byteOffset + vectorBytes.byteLength)
			);
			const dims = header.dimensions;
			const chunkList = header.chunks ?? [];

			if (chunkList.length * dims !== floats.length) {
				log.warn('Semantic index header and vector file disagree on size; ignoring the index');
				return;
			}

			this.chunks = chunkList.map((chunk, i) => ({
				...chunk,
				vector: floats.subarray(i * dims, (i + 1) * dims),
			}));
			this.files = header.files ?? {};
			this.model = header.model;
			log.info(`Semantic index loaded: ${this.chunks.length} chunks from ${Object.keys(this.files).length} files`);
		} catch {
			// No index yet is the normal first-run state.
		}
	}

	private async save(): Promise<void> {
		const dims = this.chunks[0]?.vector.length ?? 0;
		const header: IndexHeader = {
			formatVersion: FORMAT_VERSION,
			model: this.model,
			dimensions: dims,
			createdAt: Date.now(),
			files: this.files,
			chunks: this.chunks.map(({ relativePath, startLine, endLine, text }) => ({
				relativePath, startLine, endLine, text,
			})),
		};

		const flat = new Float32Array(this.chunks.length * dims);
		this.chunks.forEach((chunk, i) => flat.set(chunk.vector, i * dims));

		await vscode.workspace.fs.createDirectory(this.storageUri);
		await vscode.workspace.fs.writeFile(this.headerUri, Buffer.from(JSON.stringify(header), 'utf8'));
		await vscode.workspace.fs.writeFile(this.vectorUri, Buffer.from(flat.buffer, 0, flat.byteLength));
	}

	async clear(): Promise<void> {
		this.chunks = [];
		this.files = {};
		this.model = '';
		this.loaded = true;
		for (const uri of [this.headerUri, this.vectorUri]) {
			try {
				await vscode.workspace.fs.delete(uri);
			} catch {
				// Already gone.
			}
		}
	}

	/* --------------------------------------------------------------- building */

	/**
	 * Builds or refreshes the index.
	 *
	 * Reports progress and honours cancellation between batches rather than only at the end,
	 * because on a CPU this is minutes of work on a large repo and an uncancellable minutes-long
	 * task is indistinguishable from a hang.
	 */
	async build(
		settings: AISettings,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken
	): Promise<BuildOutcome> {
		await this.load();
		this.building = true;
		this.scopeCache = undefined;

		try {
			return await this.buildInner(settings, progress, token);
		} finally {
			this.building = false;
		}
	}

	private async buildInner(
		settings: AISettings,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken
	): Promise<BuildOutcome> {
		const client = createEmbeddingClient(settings);
		// A vector is only comparable to vectors from the same model, so switching the
		// embedding model invalidates everything already stored.
		if (this.model && this.model !== client.model) {
			log.info(`Embedding model changed (${this.model} -> ${client.model}); discarding the old index`);
			this.chunks = [];
			this.files = {};
		}
		this.model = client.model;

		const uris = await vscode.workspace.findFiles(
			settings.semanticInclude,
			settings.semanticExclude,
			settings.semanticMaxFiles
		);

		const outcome: BuildOutcome = {
			filesIndexed: 0, filesSkipped: 0, chunks: 0, reusedChunks: 0, cancelled: false,
		};

		const keptChunks: IndexedChunk[] = [];
		const nextFiles: Record<string, FileStamp> = {};
		const pending: Chunk[] = [];

		for (const uri of uris) {
			if (token.isCancellationRequested) {
				outcome.cancelled = true;
				break;
			}

			const relative = vscode.workspace.asRelativePath(uri, false);
			let stat: vscode.FileStat;
			try {
				stat = await vscode.workspace.fs.stat(uri);
			} catch {
				outcome.filesSkipped++;
				continue;
			}
			if (stat.size > MAX_FILE_BYTES || stat.size === 0) {
				outcome.filesSkipped++;
				continue;
			}

			const stamp: FileStamp = { size: stat.size, mtime: stat.mtime };
			nextFiles[relative] = stamp;

			// Unchanged file: keep the vectors already computed for it.
			const previous = this.files[relative];
			if (previous && previous.size === stamp.size && previous.mtime === stamp.mtime) {
				const reused = this.chunks.filter(chunk => chunk.relativePath === relative);
				if (reused.length > 0) {
					keptChunks.push(...reused);
					outcome.reusedChunks += reused.length;
					outcome.filesIndexed++;
					continue;
				}
			}

			let content: string;
			try {
				content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				outcome.filesSkipped++;
				continue;
			}
			// A NUL byte means this is not text, whatever the extension claimed.
			if (content.includes('\0')) {
				outcome.filesSkipped++;
				continue;
			}

			pending.push(...chunkFile(relative, content));
			outcome.filesIndexed++;
		}

		const total = pending.length;
		let done = 0;

		for (let start = 0; start < pending.length; start += EMBED_BATCH) {
			if (token.isCancellationRequested) {
				outcome.cancelled = true;
				break;
			}

			const batch = pending.slice(start, start + EMBED_BATCH);
			const controller = new AbortController();
			const cancelSub = token.onCancellationRequested(() => controller.abort());
			try {
				const vectors = await client.embed(batch.map(chunk => chunk.text), controller.signal);
				batch.forEach((chunk, i) => keptChunks.push({ ...chunk, vector: vectors[i] }));
			} catch (error) {
				if (token.isCancellationRequested) {
					outcome.cancelled = true;
					break;
				}
				throw error;
			} finally {
				cancelSub.dispose();
			}

			done += batch.length;
			progress.report({
				message: `embedding ${done}/${total} chunks`,
				increment: total > 0 ? (batch.length / total) * 100 : 0,
			});
		}

		this.chunks = keptChunks;
		this.files = nextFiles;
		outcome.chunks = keptChunks.length;
		// A full build is the thing that catches up, so the warning has served its purpose.
		if (!outcome.cancelled) {
			this.staleBatch = false;
		}

		// Saved even on cancellation: a partial index is useful, and throwing away minutes of
		// CPU because the user changed their mind about waiting would be hostile.
		await this.save();
		log.info(
			`Semantic index built: ${outcome.chunks} chunks (${outcome.reusedChunks} reused) `
			+ `from ${outcome.filesIndexed} files, ${outcome.filesSkipped} skipped`
			+ (outcome.cancelled ? ', cancelled early' : '')
		);
		return outcome;
	}

	/* ----------------------------------------------------------- incremental */

	/**
	 * Is this file one the index covers?
	 *
	 * A file already in the index is in scope by definition - it got there through the build's
	 * own globs. Anything else is decided by `findFiles`, cached briefly, because there is no
	 * glob matcher to call directly.
	 */
	private async isInScope(uri: vscode.Uri, settings: AISettings): Promise<boolean> {
		const relative = vscode.workspace.asRelativePath(uri, false);
		if (this.files[relative]) {
			return true;
		}

		const now = Date.now();
		if (!this.scopeCache || now - this.scopeCache.at > SCOPE_CACHE_MS) {
			const found = await vscode.workspace.findFiles(
				settings.semanticInclude,
				settings.semanticExclude,
				settings.semanticMaxFiles
			);
			this.scopeCache = {
				paths: new Set(found.map(f => vscode.workspace.asRelativePath(f, false))),
				at: now,
			};
		}
		return this.scopeCache.paths.has(relative);
	}

	/** Writes the index back once the edits stop arriving. */
	private schedulePersist(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			void this.save().catch(error => log.warn('Could not persist the semantic index', error));
		}, PERSIST_IDLE_MS);
	}

	/**
	 * Re-embeds a single file in place.
	 *
	 * Deliberately a no-op when no index exists: building one as a side effect of a save would
	 * turn Ctrl+S into minutes of CPU that nobody asked for, and indexing stays an explicit act.
	 */
	async updateFile(uri: vscode.Uri, settings: AISettings): Promise<'updated' | 'skipped'> {
		await this.load();
		if (this.chunks.length === 0 || this.building) {
			return 'skipped';
		}
		if (!(await this.isInScope(uri, settings))) {
			return 'skipped';
		}

		const relative = vscode.workspace.asRelativePath(uri, false);

		let stat: vscode.FileStat;
		let content: string;
		try {
			stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_FILE_BYTES || stat.size === 0) {
				return 'skipped';
			}
			content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			// Vanished between the save event and here; the delete handler owns that case.
			return 'skipped';
		}
		if (content.includes('\0')) {
			return 'skipped';
		}

		const client = createEmbeddingClient(settings);
		if (this.model && this.model !== client.model) {
			// A vector from another model is not comparable, so quietly patching one in would
			// corrupt the ranking rather than fail. Leave it for a rebuild.
			return 'skipped';
		}

		const chunks = chunkFile(relative, content);
		const embedded: IndexedChunk[] = [];
		const controller = new AbortController();
		for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
			const batch = chunks.slice(start, start + EMBED_BATCH);
			const vectors = await client.embed(batch.map(chunk => chunk.text), controller.signal);
			batch.forEach((chunk, i) => embedded.push({ ...chunk, vector: vectors[i] }));
		}

		this.chunks = this.chunks.filter(chunk => chunk.relativePath !== relative).concat(embedded);
		this.files[relative] = { size: stat.size, mtime: stat.mtime };
		this.schedulePersist();
		log.info(`Semantic index: re-embedded ${relative} (${embedded.length} chunks)`);
		return 'updated';
	}

	/** Drops a file's chunks. Used for deletes and for the old path of a rename. */
	removeFile(uri: vscode.Uri): boolean {
		const relative = vscode.workspace.asRelativePath(uri, false);
		if (!this.files[relative]) {
			return false;
		}
		this.chunks = this.chunks.filter(chunk => chunk.relativePath !== relative);
		delete this.files[relative];
		this.scopeCache = undefined;
		this.schedulePersist();
		log.info(`Semantic index: dropped ${relative}`);
		return true;
	}

	/** Flushes a pending write. Called on shutdown so a late edit is not lost. */
	async flush(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
			await this.save().catch(error => log.warn('Could not flush the semantic index', error));
		}
	}

	/* ---------------------------------------------------------------- search */

	async search(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
		await this.load();
		if (this.chunks.length === 0) {
			return [];
		}

		const settings = readSettings();
		const client = createEmbeddingClient(settings);
		if (this.model && this.model !== client.model) {
			throw new Error(
				`The index was built with "${this.model}" but the configured embedding model is now `
				+ `"${client.model}". Rebuild it with "PSCode: Build Semantic Index".`
			);
		}

		const [queryVector] = await client.embed([query], signal);

		const scored = this.chunks.map(chunk => ({
			relativePath: chunk.relativePath,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			text: chunk.text,
			score: cosineSimilarity(queryVector, chunk.vector),
		}));

		scored.sort((a, b) => b.score - a.score);

		// One hit per file for the top slots: three overlapping chunks of the same function
		// crowd out the second-best *place*, which is usually what the user wanted to see.
		const seen = new Set<string>();
		const spread: SearchHit[] = [];
		for (const hit of scored) {
			if (seen.has(hit.relativePath)) {
				continue;
			}
			seen.add(hit.relativePath);
			spread.push(hit);
			if (spread.length >= limit) {
				break;
			}
		}
		return spread;
	}
}

/**
 * Keeps the index true between full builds.
 *
 * Saves are coalesced per file: a formatter that saves three times in a second should cost one
 * re-embed, not three. Failures are logged and swallowed - an index that has drifted slightly is
 * a worse search result, while an error toast on every Ctrl+S is a broken editor.
 */
export function registerIncrementalIndexing(index: SemanticIndex): vscode.Disposable {
	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	const DEBOUNCE_MS = 700;

	/**
	 * A `git checkout` across a branch rewrites hundreds of files at once. Re-embedding all of
	 * them would pin the CPU for minutes in the background, which is worse than a stale index -
	 * the user did not ask for it and cannot see why the machine is busy. Past this many files
	 * in one window, give up on patching and say a rebuild is needed.
	 */
	const BURST_LIMIT = 40;
	const BURST_WINDOW_MS = 5000;
	let burstCount = 0;
	let burstStartedAt = 0;
	let burstWarned = false;

	const overBurstLimit = (): boolean => {
		const now = Date.now();
		if (now - burstStartedAt > BURST_WINDOW_MS) {
			burstStartedAt = now;
			burstCount = 0;
			burstWarned = false;
		}
		burstCount++;
		if (burstCount <= BURST_LIMIT) {
			return false;
		}
		if (!burstWarned) {
			burstWarned = true;
			log.warn(
				`Semantic index: more than ${BURST_LIMIT} files changed at once (a branch switch?). `
				+ 'Skipping incremental updates for this batch - run "PSCode: Build Semantic Index" to catch up.'
			);
			for (const timer of pending.values()) {
				clearTimeout(timer);
			}
			pending.clear();
			index.markStaleBatch();
		}
		return true;
	};

	const queue = (uri: vscode.Uri) => {
		if (uri.scheme !== 'file' || !readSettings().semanticAutoUpdate) {
			return;
		}
		if (overBurstLimit()) {
			return;
		}
		const key = uri.toString();
		const existing = pending.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		pending.set(key, setTimeout(() => {
			pending.delete(key);
			void index.updateFile(uri, readSettings())
				.catch(error => log.warn(`Semantic index: could not update ${uri.fsPath}`, error));
		}, DEBOUNCE_MS));
	};

	// Watching the filesystem as well as the editor is the point: the changes that make an index
	// most wrong are the ones no editor saw - a branch switch, a pull, a generator, another tool.
	// `updateFile` re-checks scope, so events for excluded paths cost a set lookup and nothing more.
	const watcher = vscode.workspace.createFileSystemWatcher(readSettings().semanticInclude);

	const subscriptions: vscode.Disposable[] = [
		watcher,
		watcher.onDidChange(queue),
		watcher.onDidCreate(queue),
		watcher.onDidDelete(uri => index.removeFile(uri)),

		// The document event still earns its place: it fires before the watcher and coalesces a
		// formatter's repeated saves, so the common case stays one re-embed.
		vscode.workspace.onDidSaveTextDocument(document => queue(document.uri)),

		vscode.workspace.onDidDeleteFiles(event => {
			for (const uri of event.files) {
				index.removeFile(uri);
			}
		}),

		vscode.workspace.onDidRenameFiles(event => {
			for (const { oldUri, newUri } of event.files) {
				index.removeFile(oldUri);
				queue(newUri);
			}
		}),
	];

	return {
		dispose() {
			for (const timer of pending.values()) {
				clearTimeout(timer);
			}
			pending.clear();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			void index.flush();
		},
	};
}

/** Created once in `activate` and shared by the chat context builder and the agent tool. */
let shared: SemanticIndex | undefined;

export function initSemanticIndex(storageUri: vscode.Uri): SemanticIndex {
	shared = new SemanticIndex(storageUri);
	return shared;
}

export function semanticIndex(): SemanticIndex | undefined {
	return shared;
}

/** Renders hits for a model prompt: path, line range, and the code itself. */
export function formatHits(hits: SearchHit[]): string {
	return hits
		.map(hit => [
			`--- ${hit.relativePath}:${hit.startLine}-${hit.endLine} (similarity ${hit.score.toFixed(2)})`,
			'```',
			hit.text,
			'```',
		].join('\n'))
		.join('\n\n');
}
