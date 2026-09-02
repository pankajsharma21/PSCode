/*---------------------------------------------------------------------------------------------
 *  PSCode AI - inline edit (Ctrl+I)
 *
 *  The flow deliberately never writes to the user's buffer until they accept. The model's
 *  output is streamed into a virtual document that is diffed against the real file, so what
 *  the user approves is exactly what gets applied.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { inlineEditPrompt } from '../agent/prompts';
import { createProvider, readSettings } from '../providers/registry';
import { ChatMessage, ProviderError } from '../providers/types';
import { toAbortSignal } from '../util/cancellation';
import { log } from '../util/logger';
import { clearProposal, PROPOSAL_SCHEME, setProposal } from './proposalDocuments';

interface PendingEdit {
	documentUri: vscode.Uri;
	proposalUri: vscode.Uri;
	range: vscode.Range;
	replacement: string;
	/** Document version at capture time; a later version means the file moved under us. */
	version: number;
}

let pending: PendingEdit | undefined;
let proposalCounter = 0;

async function setDiffActive(active: boolean): Promise<void> {
	await vscode.commands.executeCommand('setContext', 'pscode.diffActive', active);
}

/** Strips a fenced code block if the model wrapped its output despite being told not to. */
function unfence(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return fenced ? fenced[1] : trimmed;
}

/**
 * Puts back the leading whitespace the model dropped.
 *
 * The prompt asks it to preserve indentation, and it mostly does - but `unfence` trims, and a model
 * asked to rewrite one indented line routinely answers with the line un-indented. Spliced back at
 * the original offset that silently de-indents the code, which on a single-line edit is the whole
 * visible result of pressing Ctrl+I.
 *
 * Only applied when the model produced no leading whitespace of its own and every line of the
 * original shares an indent, so a multi-line block that already carries its own shape is left
 * alone. Measured case: `\tfor (let i = 0; ...)` came back with the tab gone.
 */
function restoreIndent(original: string, replacement: string): string {
	if (/^[ \t]/.test(replacement)) {
		return replacement;
	}

	const lines = original.split('\n');
	const indents = lines
		.filter(line => line.trim())
		.map(line => /^[ \t]*/.exec(line)?.[0] ?? '');
	if (indents.length === 0) {
		return replacement;
	}

	const indent = indents[0];
	if (!indent || !indents.every(other => other.startsWith(indent))) {
		return replacement;
	}

	// Every line gets it, so a one-line snippet replaced by several stays inside its block.
	return replacement.split('\n')
		.map(line => (line.trim() ? indent + line : line))
		.join('\n');
}

export async function runInlineEdit(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		void vscode.window.showInformationMessage('Open a file first, then press Ctrl+I to edit it with AI.');
		return;
	}

	const document = editor.document;

	// An empty selection means "this line" - predictable, and saves the user selecting
	// before every small edit.
	const range = editor.selection.isEmpty
		? document.lineAt(editor.selection.active.line).range
		: new vscode.Range(editor.selection.start, editor.selection.end);

	const original = document.getText(range);
	if (original.trim().length === 0) {
		void vscode.window.showInformationMessage('Nothing to edit on this line. Select some code and press Ctrl+I.');
		return;
	}

	const instruction = await vscode.window.showInputBox({
		title: 'PSCode AI - edit selection',
		prompt: `Describe the change to lines ${range.start.line + 1}-${range.end.line + 1}`,
		placeHolder: 'e.g. handle the null case and add a doc comment',
		ignoreFocusOut: true,
	});
	if (!instruction?.trim()) {
		return;
	}

	// Discard any diff still open from a previous run so the user is never looking
	// at a stale proposal.
	if (pending) {
		await discardPendingEdit();
	}

	const settings = readSettings();
	const provider = createProvider(settings);

	const proposalUri = vscode.Uri.parse(
		`${PROPOSAL_SCHEME}:${document.uri.path}?inline-${++proposalCounter}`
	);
	// Seed the proposal with the unmodified file so the diff opens with no changes
	// rather than showing the whole file as deleted.
	setProposal(proposalUri, document.getText());

	await vscode.commands.executeCommand(
		'vscode.diff',
		document.uri,
		proposalUri,
		`PSCode AI: ${path.basename(document.fileName)}`,
		{ preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside }
	);

	const messages: ChatMessage[] = [
		{ role: 'system', content: inlineEditPrompt(document.languageId) },
		{
			role: 'user',
			content: [
				`File: ${vscode.workspace.asRelativePath(document.uri, false)}`,
				`Instruction: ${instruction.trim()}`,
				'',
				'Snippet to rewrite:',
				original,
			].join('\n'),
		},
	];

	let produced = '';

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'PSCode AI is rewriting your selection',
				cancellable: true,
			},
			async (progress, token) => {
				const abort = toAbortSignal(token);
				try {
					for await (const event of provider.stream(
						{
							messages,
							temperature: settings.temperature,
							maxTokens: settings.maxTokens,
						},
						abort.signal
					)) {
						if (token.isCancellationRequested) {
							break;
						}
						if (event.type === 'text') {
							produced += event.text;
							// Re-render the whole proposed document each tick so the diff
							// updates live; the file is already in memory, so this is cheap.
							setProposal(
								proposalUri,
								replaceRange(document, range, restoreIndent(original, unfence(produced)))
							);
							progress.report({ message: `${produced.length} characters` });
						}
					}
				} finally {
					abort.dispose();
				}
			}
		);
	} catch (error) {
		clearProposal(proposalUri);
		reportProviderError(error);
		return;
	}

	const replacement = restoreIndent(original, unfence(produced));
	if (!replacement) {
		clearProposal(proposalUri);
		void vscode.window.showWarningMessage('PSCode AI returned an empty result. Nothing was changed.');
		return;
	}
	if (replacement === original) {
		clearProposal(proposalUri);
		void vscode.window.showInformationMessage('PSCode AI left the code unchanged.');
		return;
	}

	pending = {
		documentUri: document.uri,
		proposalUri,
		range,
		replacement,
		version: document.version,
	};
	await setDiffActive(true);

	const choice = await vscode.window.showInformationMessage(
		`PSCode AI proposed a change to ${path.basename(document.fileName)}.`,
		{ modal: false },
		'Accept',
		'Discard'
	);
	if (choice === 'Accept') {
		await acceptPendingEdit();
	} else if (choice === 'Discard') {
		await discardPendingEdit();
	}
	// No choice: the notification was dismissed. The diff stays open and the editor
	// title buttons (Accept / Discard) remain available.
}

/** Renders what the document would look like with `range` replaced by `replacement`. */
function replaceRange(document: vscode.TextDocument, range: vscode.Range, replacement: string): string {
	const text = document.getText();
	const start = document.offsetAt(range.start);
	const end = document.offsetAt(range.end);
	return text.slice(0, start) + replacement + text.slice(end);
}

export async function acceptPendingEdit(): Promise<void> {
	/*
	 * Logged, because this function has three silent exits and no way to tell them apart from
	 * outside. An Accept that quietly does nothing is indistinguishable from a click that never
	 * landed, and that ambiguity cost a whole debugging session: a UI test could see the gate,
	 * click it, and not know whether the click missed or the guard fired.
	 */
	if (!pending) {
		log.warn('[inline] Accept pressed with no pending proposal - nothing to apply.');
		return;
	}
	const { documentUri, proposalUri, range, replacement, version } = pending;

	const document = await vscode.workspace.openTextDocument(documentUri);
	log.info(
		`[inline] Accept: ${vscode.workspace.asRelativePath(documentUri, false)} `
		+ `lines ${range.start.line + 1}-${range.end.line + 1}, `
		+ `${replacement.split('\n').length} replacement line(s), `
		+ `version ${document.version} (expected ${version})`
	);
	if (document.version !== version) {
		log.warn(`[inline] refused: the document moved from version ${version} to ${document.version}`);
		void vscode.window.showWarningMessage(
			'The file changed while PSCode AI was working, so the proposal was not applied. Run Ctrl+I again.'
		);
		await discardPendingEdit();
		return;
	}

	const edit = new vscode.WorkspaceEdit();
	edit.replace(documentUri, range, replacement);
	const applied = await vscode.workspace.applyEdit(edit);

	clearProposal(proposalUri);
	pending = undefined;
	await setDiffActive(false);

	if (applied) {
		log.info('[inline] applied');
		await closeDiffEditor(proposalUri);
		const shown = await vscode.window.showTextDocument(document, { preview: false });
		// Leave the cursor on the edited text so the user sees what changed.
		shown.selection = new vscode.Selection(range.start, range.start);
	} else {
		log.error('[inline] applyEdit returned false - the workspace edit was rejected');
		void vscode.window.showErrorMessage('PSCode AI could not apply the change.');
	}
}

export async function discardPendingEdit(): Promise<void> {
	if (!pending) {
		return;
	}
	const { proposalUri } = pending;
	clearProposal(proposalUri);
	pending = undefined;
	await setDiffActive(false);
	await closeDiffEditor(proposalUri);
}

/** Closes just the tab holding this proposal, leaving the user's other tabs alone. */
async function closeDiffEditor(proposalUri: vscode.Uri): Promise<void> {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input;
			if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === proposalUri.toString()) {
				await vscode.window.tabGroups.close(tab);
			}
		}
	}
}

export function reportProviderError(error: unknown): void {
	if (error instanceof ProviderError) {
		log.error(error.message, error);
		const actions = error.hint ? ['Show details', 'Open settings'] : ['Show details'];
		void vscode.window.showErrorMessage(
			error.hint ? `${error.message} ${error.hint}` : error.message,
			...actions
		).then(choice => {
			if (choice === 'Show details') {
				log.show();
			} else if (choice === 'Open settings') {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'pscode.ai');
			}
		});
		return;
	}
	log.error('Inline edit failed', error);
	void vscode.window.showErrorMessage(
		`PSCode AI failed: ${error instanceof Error ? error.message : String(error)}`
	);
}
