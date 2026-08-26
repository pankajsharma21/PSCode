/*---------------------------------------------------------------------------------------------
 *  PSCode AI - agent tools
 *
 *  These are the only ways the model can affect the machine. Two rules hold throughout:
 *    1. Every path is resolved and then verified to be inside an open workspace folder,
 *       so a model that emits "../../.ssh/id_rsa" is refused rather than obeyed.
 *    2. Anything that writes a file or runs a command asks the user first, unless the
 *       user has explicitly turned that approval off in settings.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { relativePath } from '../context/contextBuilder';
import { PROPOSAL_SCHEME, setProposal } from '../inline/proposalDocuments';
import { AISettings } from '../providers/registry';
import { ToolSchema } from '../providers/types';
import { log } from '../util/logger';

const MAX_TOOL_OUTPUT = 20000;
const COMMAND_TIMEOUT_MS = 120000;

export interface ToolContext {
	settings: AISettings;
	/** Streams a human-readable trace line into the chat transcript. */
	report(line: string): void;
}

export interface ToolResult {
	ok: boolean;
	/** Text handed back to the model as the tool result. */
	content: string;
}

export interface AgentTool {
	readonly schema: ToolSchema;
	execute(args: Record<string, unknown>, context: ToolContext, token: vscode.CancellationToken): Promise<ToolResult>;
}

/* -------------------------------------------------------------------------- */
/* Path safety                                                                */
/* -------------------------------------------------------------------------- */

class ToolError extends Error { }

/**
 * Resolves a model-supplied path against the workspace and refuses anything that
 * escapes it. This is the security boundary of agent mode - never bypass it.
 */
function resolveInWorkspace(rawPath: unknown): vscode.Uri {
	if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
		throw new ToolError('A "path" argument (relative to the workspace root) is required.');
	}

	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new ToolError('No folder is open in PSCode, so there is nothing to read or write.');
	}

	const candidate = rawPath.trim();
	if (path.isAbsolute(candidate)) {
		const resolved = path.resolve(candidate);
		for (const folder of folders) {
			if (isInside(folder.uri.fsPath, resolved)) {
				return vscode.Uri.file(resolved);
			}
		}
		throw new ToolError(`Refused: "${candidate}" is outside the open workspace.`);
	}

	// Relative paths resolve against the first folder, then verified anyway.
	const base = folders[0].uri.fsPath;
	const resolved = path.resolve(base, candidate);
	if (!isInside(base, resolved)) {
		throw new ToolError(`Refused: "${candidate}" resolves outside the workspace folder.`);
	}
	return vscode.Uri.file(resolved);
}

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function clip(text: string): string {
	return text.length > MAX_TOOL_OUTPUT
		? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[...truncated by PSCode: ${text.length - MAX_TOOL_OUTPUT} more characters...]`
		: text;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

const readFile: AgentTool = {
	schema: {
		name: 'read_file',
		description: 'Read a text file from the workspace. Use this before editing anything so the edit is based on the real current content.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the workspace root, e.g. "src/main.ts".' },
				startLine: { type: 'number', description: 'Optional 1-based first line to return.' },
				endLine: { type: 'number', description: 'Optional 1-based last line to return.' },
			},
			required: ['path'],
		},
	},
	async execute(args, context) {
		const uri = resolveInWorkspace(args['path']);
		const document = await vscode.workspace.openTextDocument(uri);
		const lines = document.getText().split('\n');

		const start = typeof args['startLine'] === 'number' ? Math.max(1, args['startLine']) : 1;
		const end = typeof args['endLine'] === 'number' ? Math.min(lines.length, args['endLine']) : lines.length;

		const slice = lines.slice(start - 1, end);
		context.report(`Read ${relativePath(uri)} (lines ${start}-${end} of ${lines.length})`);

		// Line numbers let the model refer to positions precisely in its reply.
		const numbered = slice.map((line, i) => `${start + i}\t${line}`).join('\n');
		return { ok: true, content: clip(numbered) };
	},
};

const listDir: AgentTool = {
	schema: {
		name: 'list_dir',
		description: 'List the files and folders directly inside a workspace directory.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory relative to the workspace root. Use "." for the root.' },
			},
			required: ['path'],
		},
	},
	async execute(args, context) {
		const uri = resolveInWorkspace(args['path'] === '.' ? '.' : args['path']);
		const entries = await vscode.workspace.fs.readDirectory(uri);
		context.report(`Listed ${relativePath(uri)} (${entries.length} entries)`);

		const rendered = entries
			.filter(([name]) => name !== 'node_modules' && name !== '.git')
			.map(([name, kind]) => (kind === vscode.FileType.Directory ? `${name}/` : name))
			.sort()
			.join('\n');
		return { ok: true, content: rendered || '(empty directory)' };
	},
};

const searchText: AgentTool = {
	schema: {
		name: 'search_text',
		description: 'Search the workspace for a literal string and return matching file paths with line numbers. Use this to locate code instead of guessing file names.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Literal text to find.' },
				include: { type: 'string', description: 'Optional glob to limit the search, e.g. "**/*.ts".' },
			},
			required: ['query'],
		},
	},
	async execute(args, context) {
		const query = args['query'];
		if (typeof query !== 'string' || !query) {
			throw new ToolError('A non-empty "query" is required.');
		}
		const include = typeof args['include'] === 'string' && args['include'] ? args['include'] : '**/*';

		const files = await vscode.workspace.findFiles(include, '**/{node_modules,.git,out,dist,build}/**', 400);
		const hits: string[] = [];

		for (const file of files) {
			if (hits.length >= 100) {
				break;
			}
			let text: string;
			try {
				text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
			} catch {
				continue; // Binary or unreadable - skip silently.
			}
			if (!text.includes(query)) {
				continue;
			}
			const lines = text.split('\n');
			for (let i = 0; i < lines.length && hits.length < 100; i++) {
				if (lines[i].includes(query)) {
					hits.push(`${relativePath(file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
				}
			}
		}

		context.report(`Searched for "${query}" - ${hits.length} match(es)`);
		return { ok: true, content: hits.length ? clip(hits.join('\n')) : `No matches for "${query}".` };
	},
};

const writeFile: AgentTool = {
	schema: {
		name: 'write_file',
		description: 'Create a file, or replace an existing file\'s entire contents. Read the file first unless you are creating it. Prefer replace_in_file for small edits to large files.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the workspace root.' },
				content: { type: 'string', description: 'The complete new contents of the file.' },
			},
			required: ['path', 'content'],
		},
	},
	async execute(args, context) {
		const uri = resolveInWorkspace(args['path']);
		const content = args['content'];
		if (typeof content !== 'string') {
			throw new ToolError('"content" must be a string.');
		}

		const existed = await exists(uri);
		if (context.settings.approveFileWrites) {
			const verb = existed ? 'Overwrite' : 'Create';
			const choice = await vscode.window.showWarningMessage(
				`PSCode AI wants to ${verb.toLowerCase()} ${relativePath(uri)}`,
				{ modal: true, detail: existed ? 'The current contents will be replaced.' : 'A new file will be created.' },
				verb,
				'Show diff first'
			);
			if (choice === 'Show diff first') {
				await showProposedDiff(uri, content, existed);
				const confirm = await vscode.window.showWarningMessage(
					`Apply the change to ${relativePath(uri)}?`,
					{ modal: true },
					'Apply'
				);
				if (confirm !== 'Apply') {
					return { ok: false, content: 'The user declined this write. Do not retry it; ask what to do differently.' };
				}
			} else if (choice !== verb) {
				return { ok: false, content: 'The user declined this write. Do not retry it; ask what to do differently.' };
			}
		}

		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
		context.report(`${existed ? 'Updated' : 'Created'} ${relativePath(uri)} (${content.split('\n').length} lines)`);
		return { ok: true, content: `Wrote ${relativePath(uri)}.` };
	},
};

const replaceInFile: AgentTool = {
	schema: {
		name: 'replace_in_file',
		description: 'Replace an exact snippet of text in a file. The "find" text must appear exactly once. Safer than write_file for targeted edits.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the workspace root.' },
				find: { type: 'string', description: 'Exact text to replace, including indentation.' },
				replace: { type: 'string', description: 'Replacement text.' },
			},
			required: ['path', 'find', 'replace'],
		},
	},
	async execute(args, context) {
		const uri = resolveInWorkspace(args['path']);
		const find = args['find'];
		const replacement = args['replace'];
		if (typeof find !== 'string' || typeof replacement !== 'string') {
			throw new ToolError('"find" and "replace" must both be strings.');
		}

		const document = await vscode.workspace.openTextDocument(uri);
		const original = document.getText();

		const first = original.indexOf(find);
		if (first === -1) {
			return {
				ok: false,
				content: 'That exact text was not found. Read the file again and copy the snippet verbatim, including whitespace.',
			};
		}
		if (original.indexOf(find, first + find.length) !== -1) {
			return {
				ok: false,
				content: 'That text appears more than once, so the edit is ambiguous. Include more surrounding lines to make it unique.',
			};
		}

		const updated = original.slice(0, first) + replacement + original.slice(first + find.length);

		if (context.settings.approveFileWrites) {
			await showProposedDiff(uri, updated, true);
			const confirm = await vscode.window.showWarningMessage(
				`Apply PSCode AI's change to ${relativePath(uri)}?`,
				{ modal: true, detail: 'The proposed result is open in a diff view.' },
				'Apply'
			);
			if (confirm !== 'Apply') {
				return { ok: false, content: 'The user declined this edit. Ask what to change before trying again.' };
			}
		}

		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, new vscode.Range(document.positionAt(first), document.positionAt(first + find.length)), replacement);
		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			return { ok: false, content: 'PSCode could not apply the edit (the file may have changed on disk).' };
		}
		await document.save();

		const line = document.positionAt(first).line + 1;
		context.report(`Edited ${relativePath(uri)} at line ${line}`);
		return { ok: true, content: `Replaced the snippet in ${relativePath(uri)} at line ${line}.` };
	},
};

const getDiagnostics: AgentTool = {
	schema: {
		name: 'get_diagnostics',
		description: 'Get compiler and linter errors currently reported for a file, or for the whole workspace. Call this after editing to check the change did not break anything.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Optional file relative to the workspace root. Omit for all files.' },
			},
		},
	},
	async execute(args, context) {
		const entries = typeof args['path'] === 'string' && args['path']
			? [[resolveInWorkspace(args['path']), vscode.languages.getDiagnostics(resolveInWorkspace(args['path']))] as const]
			: vscode.languages.getDiagnostics();

		const lines: string[] = [];
		for (const [uri, diagnostics] of entries) {
			for (const d of diagnostics) {
				if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) {
					continue;
				}
				const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
				lines.push(`${relativePath(uri)}:${d.range.start.line + 1}: ${severity}: ${d.message.replace(/\s+/g, ' ')}`);
				if (lines.length >= 200) {
					break;
				}
			}
		}

		context.report(`Checked diagnostics (${lines.length} problem(s))`);
		return { ok: true, content: lines.length ? clip(lines.join('\n')) : 'No errors or warnings reported.' };
	},
};

const runCommand: AgentTool = {
	schema: {
		name: 'run_command',
		description: 'Run a shell command in the workspace root and return its output. Use it for builds, tests and git. Do not use it to edit files.',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command line to run, e.g. "npm test".' },
				reason: { type: 'string', description: 'One short sentence on why this command is needed, shown to the user in the approval prompt.' },
			},
			required: ['command'],
		},
	},
	async execute(args, context, token) {
		const command = args['command'];
		if (typeof command !== 'string' || !command.trim()) {
			throw new ToolError('A non-empty "command" is required.');
		}
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			throw new ToolError('No folder is open, so there is no directory to run the command in.');
		}
		const cwd = folders[0].uri.fsPath;

		if (context.settings.approveShellCommands) {
			const reason = typeof args['reason'] === 'string' ? args['reason'] : undefined;
			const choice = await vscode.window.showWarningMessage(
				`PSCode AI wants to run a command`,
				{ modal: true, detail: `${command}\n\nWorking directory: ${cwd}${reason ? `\n\nWhy: ${reason}` : ''}` },
				'Run'
			);
			if (choice !== 'Run') {
				return { ok: false, content: 'The user declined to run that command. Continue without it or suggest an alternative.' };
			}
		}

		context.report(`$ ${command}`);
		const result = await runShell(command, cwd, token);
		const body = [
			`exit code: ${result.code}`,
			result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : 'stdout: (empty)',
			result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
		].filter(Boolean).join('\n\n');

		return { ok: result.code === 0, content: clip(body) };
	},
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function runShell(
	command: string,
	cwd: string,
	token: vscode.CancellationToken
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const child = exec(
			command,
			{ cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			}
		);
		const subscription = token.onCancellationRequested(() => {
			child.kill();
			subscription.dispose();
		});
		child.on('exit', () => subscription.dispose());
	});
}

/** Opens a read-only side-by-side diff of the proposal against what is on disk. */
async function showProposedDiff(uri: vscode.Uri, proposed: string, existed: boolean): Promise<void> {
	const proposalUri = vscode.Uri.parse(`${PROPOSAL_SCHEME}:${uri.path}?agent`);
	setProposal(proposalUri, proposed);
	await vscode.commands.executeCommand(
		'vscode.diff',
		existed ? uri : vscode.Uri.parse(`${PROPOSAL_SCHEME}:/empty?blank`),
		proposalUri,
		`PSCode AI proposal: ${path.basename(uri.fsPath)}`,
		{ preview: true }
	);
}

export const ALL_TOOLS: AgentTool[] = [
	readFile,
	listDir,
	searchText,
	getDiagnostics,
	replaceInFile,
	writeFile,
	runCommand,
];

export function toolByName(name: string): AgentTool | undefined {
	return ALL_TOOLS.find(tool => tool.schema.name === name);
}

export function describeToolError(error: unknown): string {
	if (error instanceof ToolError) {
		return error.message;
	}
	log.error('Tool execution failed', error);
	return `The tool failed: ${error instanceof Error ? error.message : String(error)}`;
}
