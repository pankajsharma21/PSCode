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
import { showProposedDiff } from '../inline/proposalDocuments';
import { ApprovalHandler, nextApprovalId } from './approvals';
import { AISettings } from '../providers/registry';
import { ToolSchema } from '../providers/types';
import { log } from '../util/logger';

const MAX_TOOL_OUTPUT = 20000;
const COMMAND_TIMEOUT_MS = 120000;

export interface ToolContext {
	settings: AISettings;
	/** Streams a human-readable trace line into the chat transcript. */
	report(line: string): void;
	/**
	 * Asks the user to approve a workspace-touching action. Rendered as Accept/Reject
	 * buttons in the chat panel rather than a modal dialog, so it cannot be confirmed
	 * by a stray keypress.
	 */
	requestApproval: ApprovalHandler;
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
		description: 'Search the workspace for text and return matching file paths with line numbers. Prefer find_symbol or find_usages for code symbols; use this for strings, comments, config values, or languages with no language server.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Text to find.' },
				include: { type: 'string', description: 'Optional glob to limit the search, e.g. "**/*.ts".' },
				regex: { type: 'boolean', description: 'Treat "query" as a JavaScript regular expression. Default false.' },
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

		let pattern: RegExp | undefined;
		if (args['regex'] === true) {
			try {
				pattern = new RegExp(query, 'g');
			} catch (error) {
				return {
					ok: false,
					content: `"${query}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		const matches = (line: string): boolean => {
			if (!pattern) {
				return line.includes(query);
			}
			pattern.lastIndex = 0;
			return pattern.test(line);
		};

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
			const lines = text.split('\n');
			if (!lines.some(matches)) {
				continue;
			}
			for (let i = 0; i < lines.length && hits.length < 100; i++) {
				if (matches(lines[i])) {
					hits.push(`${relativePath(file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
				}
			}
		}

		context.report(`Searched for "${query}" - ${hits.length} match(es)`);
		return { ok: true, content: hits.length ? clip(hits.join('\n')) : `No matches for "${query}".` };
	},
};

/* -------------------------------------------------------------------------- */
/* Project-wide navigation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * These three tools are what make the agent work on a project rather than a file.
 * They deliberately go through the language server (workspace symbols, references,
 * definitions) rather than text matching: an embedding index guesses at relevance,
 * whereas the language server *knows* what a symbol resolves to. It also costs nothing
 * to maintain, because the editor already built it.
 */

const projectMap: AgentTool = {
	schema: {
		name: 'project_map',
		description: 'Get an overview of the project: source files grouped by directory. Call this first when you do not know the layout.',
		parameters: {
			type: 'object',
			properties: {
				include: { type: 'string', description: 'Optional glob, e.g. "**/*.ts". Defaults to common source types.' },
			},
		},
	},
	async execute(args, context) {
		const include = typeof args['include'] === 'string' && args['include']
			? args['include']
			: '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,go,rs,rb,php,cs,cpp,c,h,hpp,kt,swift,scala,json,yaml,yml,md}';

		const files = await vscode.workspace.findFiles(include, '**/{node_modules,.git,out,dist,build,target,vendor,.venv,__pycache__}/**', 1200);

		const byDir = new Map<string, string[]>();
		for (const file of files) {
			const rel = relativePath(file);
			const slash = rel.lastIndexOf('/');
			const dir = slash === -1 ? '.' : rel.slice(0, slash);
			const name = slash === -1 ? rel : rel.slice(slash + 1);
			const bucket = byDir.get(dir);
			if (bucket) {
				bucket.push(name);
			} else {
				byDir.set(dir, [name]);
			}
		}

		const lines: string[] = [`${files.length} file(s) in ${byDir.size} directory/ies`];
		for (const dir of [...byDir.keys()].sort()) {
			const names = (byDir.get(dir) ?? []).sort();
			lines.push(`${dir}/`);
			// Cap per directory so one generated folder cannot swamp the context.
			for (const name of names.slice(0, 40)) {
				lines.push(`  ${name}`);
			}
			if (names.length > 40) {
				lines.push(`  ...and ${names.length - 40} more`);
			}
		}

		context.report(`Mapped the project (${files.length} files)`);
		return { ok: true, content: clip(lines.join('\n')) };
	},
};

const findSymbol: AgentTool = {
	schema: {
		name: 'find_symbol',
		description: 'Find where a class, function, interface or variable is DEFINED anywhere in the project, by name. Uses the language server, so it understands the language rather than matching text.',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Symbol name, or part of it, e.g. "totalPrice".' },
			},
			required: ['name'],
		},
	},
	async execute(args, context) {
		const name = args['name'];
		if (typeof name !== 'string' || !name.trim()) {
			throw new ToolError('A non-empty "name" is required.');
		}

		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
			'vscode.executeWorkspaceSymbolProvider',
			name.trim()
		);

		const found = (symbols ?? []).slice(0, 60).map(symbol => {
			const kind = vscode.SymbolKind[symbol.kind] ?? 'Symbol';
			return `${kind} ${symbol.name} — ${relativePath(symbol.location.uri)}:${symbol.location.range.start.line + 1}`;
		});

		context.report(`Looked up symbol "${name}" — ${found.length} definition(s)`);
		if (found.length === 0) {
			return {
				ok: false,
				content: `No symbol named "${name}" was found by the language server. It may be spelled differently, or the language may have no language server installed — fall back to search_text.`,
			};
		}
		return { ok: true, content: found.join('\n') };
	},
};

const findUsages: AgentTool = {
	schema: {
		name: 'find_usages',
		description: 'Find EVERY place a symbol is used across the whole project, resolved by the language server. Use this before changing anything shared, so you know what you are about to break.',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Symbol name, e.g. "discountFor".' },
			},
			required: ['name'],
		},
	},
	async execute(args, context) {
		const name = args['name'];
		if (typeof name !== 'string' || !name.trim()) {
			throw new ToolError('A non-empty "name" is required.');
		}

		// Locate the definition first: references are resolved from a position, not a string.
		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
			'vscode.executeWorkspaceSymbolProvider',
			name.trim()
		);
		const exact = (symbols ?? []).find(s => s.name === name.trim()) ?? (symbols ?? [])[0];
		if (!exact) {
			return {
				ok: false,
				content: `Could not locate a definition for "${name}", so references cannot be resolved. Try find_symbol, or search_text for a textual match.`,
			};
		}

		const locations = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeReferenceProvider',
			exact.location.uri,
			exact.location.range.start
		);

		const byFile = new Map<string, number[]>();
		for (const location of locations ?? []) {
			const rel = relativePath(location.uri);
			const line = location.range.start.line + 1;
			const bucket = byFile.get(rel);
			if (bucket) {
				bucket.push(line);
			} else {
				byFile.set(rel, [line]);
			}
		}

		const lines: string[] = [
			`"${name}" is defined at ${relativePath(exact.location.uri)}:${exact.location.range.start.line + 1}`,
			`used in ${byFile.size} file(s), ${(locations ?? []).length} reference(s):`,
		];
		for (const file of [...byFile.keys()].sort()) {
			const at = (byFile.get(file) ?? []).sort((a, b) => a - b);
			lines.push(`  ${file} — line(s) ${at.join(', ')}`);
		}

		context.report(`Found ${(locations ?? []).length} usage(s) of "${name}" in ${byFile.size} file(s)`);
		return { ok: true, content: clip(lines.join('\n')) };
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
			// Always show the diff, then ask. Reviewing before deciding is the point.
			await showProposedDiff(uri, content, existed);
			const approved = await context.requestApproval({
				id: nextApprovalId(),
				kind: existed ? 'overwrite' : 'create',
				title: `${existed ? 'Overwrite' : 'Create'} ${relativePath(uri)}`,
				detail: existed
					? `Replaces all ${(await lineCount(uri))} lines with ${content.split('\n').length}`
					: `${content.split('\n').length} lines`,
				filePath: relativePath(uri),
				hasDiff: true,
			});
			if (!approved) {
				return { ok: false, content: 'The user rejected this write. Do not retry it; ask what to do differently.' };
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
			const line = document.positionAt(first).line + 1;
			const approved = await context.requestApproval({
				id: nextApprovalId(),
				kind: 'edit',
				title: `Edit ${relativePath(uri)}`,
				detail: `line ${line}`,
				filePath: relativePath(uri),
				hasDiff: true,
			});
			if (!approved) {
				return { ok: false, content: 'The user rejected this edit. Ask what to change before trying again.' };
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
			const approved = await context.requestApproval({
				id: nextApprovalId(),
				kind: 'command',
				title: command,
				detail: reason ? `${reason} — in ${cwd}` : `in ${cwd}`,
			});
			if (!approved) {
				return { ok: false, content: 'The user rejected that command. Continue without it or suggest an alternative.' };
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

async function lineCount(uri: vscode.Uri): Promise<number> {
	try {
		return (await vscode.workspace.openTextDocument(uri)).lineCount;
	} catch {
		return 0;
	}
}

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

export const ALL_TOOLS: AgentTool[] = [
	projectMap,
	findSymbol,
	findUsages,
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
