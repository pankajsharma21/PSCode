/*---------------------------------------------------------------------------------------------
 *  PSCode AI - context building
 *
 *  A local 7B model has a small context window and is slow per token, so what gets sent
 *  matters more here than it does with a hosted frontier model. Everything is assembled
 *  under an explicit character budget and truncated predictably rather than silently.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../util/logger';

/** Rough bytes-per-token ratio for code; only used to keep the budget human-meaningful. */
const CHARS_PER_TOKEN = 3.5;

export interface AttachedFile {
	relativePath: string;
	languageId: string;
	content: string;
	truncated: boolean;
}

export interface BuiltContext {
	/** Ready-to-send context block, or '' when there is nothing to attach. */
	text: string;
	/** Relative paths actually included, for display as context chips in the UI. */
	includedFiles: string[];
	/** Files referenced with @ but not found. */
	missingMentions: string[];
	approxTokens: number;
}

export interface ContextRequest {
	/** The user's message; scanned for @file mentions. */
	userText: string;
	budgetChars: number;
	includeActiveFile?: boolean;
	includeSelection?: boolean;
	includeDiagnostics?: boolean;
	includeOpenTabs?: boolean;
}

export function relativePath(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (folder) {
		return vscode.workspace.asRelativePath(uri, false);
	}
	return uri.fsPath;
}

/** Extracts `@some/file.ts` style mentions. Stops at whitespace; strips trailing punctuation. */
export function parseMentions(text: string): string[] {
	const mentions = new Set<string>();
	const pattern = /(?:^|\s)@([^\s@]+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const cleaned = match[1].replace(/[.,;:)\]}'"]+$/, '');
		if (cleaned.length > 0) {
			mentions.add(cleaned);
		}
	}
	return [...mentions];
}

/**
 * Resolves a mention to a workspace file. Accepts a full relative path or a bare
 * filename, so `@extension.ts` works without the user typing the whole path.
 */
async function resolveMention(mention: string): Promise<vscode.Uri | undefined> {
	const direct = await vscode.workspace.findFiles(mention, '**/node_modules/**', 1);
	if (direct.length > 0) {
		return direct[0];
	}
	const byName = await vscode.workspace.findFiles(`**/${mention}`, '**/node_modules/**', 2);
	return byName[0];
}

async function readFileForContext(uri: vscode.Uri, budget: number): Promise<AttachedFile | undefined> {
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		const full = document.getText();
		const truncated = full.length > budget;
		return {
			relativePath: relativePath(uri),
			languageId: document.languageId,
			content: truncated ? `${full.slice(0, budget)}\n/* ...truncated by PSCode: file exceeds the context budget... */` : full,
			truncated,
		};
	} catch (error) {
		log.warn(`Could not read ${uri.fsPath} for context`, error);
		return undefined;
	}
}

function fence(file: AttachedFile): string {
	return [
		`--- FILE: ${file.relativePath} (${file.languageId})${file.truncated ? ' [truncated]' : ''}`,
		'```' + file.languageId,
		file.content,
		'```',
	].join('\n');
}

function describeDiagnostics(uri: vscode.Uri): string {
	const problems = vscode.languages.getDiagnostics(uri)
		.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
		.slice(0, 25);

	if (problems.length === 0) {
		return '';
	}

	const lines = problems.map(d => {
		const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
		// +1 because VS Code positions are zero-based but every compiler the user
		// reads output from is one-based.
		return `  line ${d.range.start.line + 1}: ${severity}: ${d.message.replace(/\s+/g, ' ')}`;
	});

	return `--- PROBLEMS REPORTED BY THE LANGUAGE SERVER in ${relativePath(uri)}\n${lines.join('\n')}`;
}

export async function buildContext(request: ContextRequest): Promise<BuiltContext> {
	const {
		userText,
		budgetChars,
		includeActiveFile = true,
		includeSelection = true,
		includeDiagnostics = true,
		includeOpenTabs = true,
	} = request;

	const sections: string[] = [];
	const includedFiles: string[] = [];
	const missingMentions: string[] = [];
	let remaining = budgetChars;

	// 1. Workspace shape - cheap and orients the model about where it is.
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length > 0) {
		sections.push(`--- WORKSPACE\n${folders.map(f => `  ${f.name} (${f.uri.fsPath})`).join('\n')}`);
	}

	const editor = vscode.window.activeTextEditor;

	// 2. Selection first: it is the most specific signal of intent, so it gets budget
	//    before the whole file does.
	if (includeSelection && editor && !editor.selection.isEmpty) {
		const selected = editor.document.getText(editor.selection);
		const slice = selected.slice(0, Math.min(remaining, 8000));
		remaining -= slice.length;
		sections.push([
			`--- SELECTED CODE in ${relativePath(editor.document.uri)} `
			+ `(lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1})`,
			'```' + editor.document.languageId,
			slice,
			'```',
		].join('\n'));
	}

	// 3. Explicit @mentions outrank the active file: the user named them on purpose.
	const seen = new Set<string>();
	for (const mention of parseMentions(userText)) {
		if (remaining <= 0) {
			break;
		}
		const uri = await resolveMention(mention);
		if (!uri) {
			missingMentions.push(mention);
			continue;
		}
		const key = uri.toString();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const file = await readFileForContext(uri, remaining);
		if (file) {
			sections.push(fence(file));
			includedFiles.push(file.relativePath);
			remaining -= file.content.length;
		}
	}

	// 4. Active file, if it did not already come in as a mention.
	if (includeActiveFile && editor && remaining > 0) {
		const key = editor.document.uri.toString();
		if (!seen.has(key)) {
			seen.add(key);
			const file = await readFileForContext(editor.document.uri, remaining);
			if (file) {
				sections.push(`--- ACTIVE FILE\n${fence(file)}`);
				includedFiles.push(file.relativePath);
				remaining -= file.content.length;
			}
		}
	}

	// 5. Diagnostics: small, and the highest-value context for a "fix this" request.
	if (includeDiagnostics && editor) {
		const problems = describeDiagnostics(editor.document.uri);
		if (problems) {
			sections.push(problems);
			remaining -= problems.length;
		}
	}

	// 6. Open tabs by name only - tells the model what else exists without spending budget.
	if (includeOpenTabs) {
		const tabs = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.map(tab => (tab.input instanceof vscode.TabInputText ? relativePath(tab.input.uri) : undefined))
			.filter((p): p is string => !!p && !includedFiles.includes(p))
			.slice(0, 20);
		if (tabs.length > 0) {
			sections.push(`--- OTHER OPEN FILES (names only; ask to read them if needed)\n${tabs.map(t => `  ${t}`).join('\n')}`);
		}
	}

	const text = sections.join('\n\n');
	return {
		text,
		includedFiles,
		missingMentions,
		approxTokens: Math.round(text.length / CHARS_PER_TOKEN),
	};
}
