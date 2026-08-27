/*---------------------------------------------------------------------------------------------
 *  PSCode AI - project rules
 *
 *  Cursor reads `.cursorrules`, the OpenAI and Copilot tooling read `AGENTS.md`. Same idea: a
 *  file committed to the repo that states the house conventions, so the user does not retype
 *  them every turn and every contributor gets the same assistant behaviour.
 *
 *  This matters more for a local 7B model than for a frontier one. A large model can infer
 *  house style from the surrounding code; a 7B model cannot reliably, and will happily write
 *  `var`, add a framework you do not use, or invent a logging helper. Stating the rules is the
 *  cheapest quality win available - it costs a few hundred prompt tokens and no extra thinking.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../util/logger';

/**
 * Checked in this order; the first file that exists in a workspace folder wins. `.pscoderules`
 * is first so a PSCode user can override rules meant for another tool without deleting them.
 */
const RULE_FILENAMES = [
	'.pscoderules',
	'AGENTS.md',
	'.cursorrules',
	'.github/copilot-instructions.md',
];

/**
 * Rules share the prompt with the user's actual code. Without a cap of their own, a long
 * AGENTS.md (this repo's is thousands of words) would crowd out the file being asked about -
 * the rules would win an argument they should not even be in.
 */
const MAX_RULE_CHARS = 4000;

export interface ProjectRules {
	/** Rule text, already capped. Empty when the workspace has no rules file. */
	text: string;
	/** Relative paths the text came from, for display and for the log. */
	sources: string[];
}

const EMPTY: ProjectRules = { text: '', sources: [] };

/**
 * Cached because every turn asks for it and the answer changes only when the file does.
 * `undefined` means "not read yet", which is distinct from a cached empty result.
 */
let cached: ProjectRules | undefined;

/**
 * Invalidates the cache when a rules file is created, edited or deleted, so editing
 * AGENTS.md takes effect on the next message instead of after a window reload.
 */
export function registerProjectRulesWatcher(): vscode.Disposable {
	const pattern = `**/{${RULE_FILENAMES.join(',')}}`;
	const watcher = vscode.workspace.createFileSystemWatcher(pattern);
	const invalidate = (uri: vscode.Uri) => {
		log.info(`Project rules changed (${uri.fsPath}); cache dropped`);
		cached = undefined;
	};

	watcher.onDidCreate(invalidate);
	watcher.onDidChange(invalidate);
	watcher.onDidDelete(invalidate);

	// Adding or removing a folder changes which rules files are in scope at all.
	const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		cached = undefined;
	});

	return vscode.Disposable.from(watcher, folders);
}

/** Drops the cache. Exposed for the "reload rules" command and for tests. */
export function invalidateProjectRules(): void {
	cached = undefined;
}

async function readIfPresent(folder: vscode.WorkspaceFolder, name: string): Promise<string | undefined> {
	const uri = vscode.Uri.joinPath(folder.uri, name);
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8').trim();
		return text.length > 0 ? text : undefined;
	} catch {
		// Missing is the common case, not an error worth logging on every turn.
		return undefined;
	}
}

/**
 * Reads the rules for the current workspace. One file per folder: the first match in
 * RULE_FILENAMES order, not a merge of all of them, because two rules files in one folder
 * usually means one is stale and concatenating them produces contradictions.
 */
export async function readProjectRules(): Promise<ProjectRules> {
	if (!vscode.workspace.getConfiguration('pscode').get<boolean>('ai.projectRules', true)) {
		return EMPTY;
	}
	if (cached) {
		return cached;
	}

	const folders = vscode.workspace.workspaceFolders ?? [];
	const parts: string[] = [];
	const sources: string[] = [];

	for (const folder of folders) {
		for (const name of RULE_FILENAMES) {
			const text = await readIfPresent(folder, name);
			if (text === undefined) {
				continue;
			}
			const label = folders.length > 1 ? `${folder.name}/${name}` : name;
			parts.push(folders.length > 1 ? `# ${label}\n${text}` : text);
			sources.push(label);
			break;
		}
	}

	let text = parts.join('\n\n');
	if (text.length > MAX_RULE_CHARS) {
		text = `${text.slice(0, MAX_RULE_CHARS)}\n\n[...truncated by PSCode: rules exceed ${MAX_RULE_CHARS} characters...]`;
	}

	cached = { text, sources };
	if (sources.length > 0) {
		log.info(`Project rules loaded from ${sources.join(', ')} (${text.length} chars)`);
	}
	return cached;
}

/**
 * Appends the rules to a system prompt.
 *
 * They go last on purpose. A 7B model weights the end of a long system prompt more heavily
 * than the middle, and these rules are the part that is specific to this user's repo - the
 * generic tool instructions above them are the part it can afford to half-remember.
 */
export function withProjectRules(basePrompt: string, rules: ProjectRules): string {
	if (!rules.text) {
		return basePrompt;
	}

	return `${basePrompt}

PROJECT RULES
The user's repository ships the conventions below in ${rules.sources.join(' and ')}. They describe
this specific codebase and override your general habits. Follow them. If a rule conflicts with
something the user asks for directly in chat, the user's message wins - say that you noticed.

${rules.text}`;
}
