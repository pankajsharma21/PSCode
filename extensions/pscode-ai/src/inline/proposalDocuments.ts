/*---------------------------------------------------------------------------------------------
 *  PSCode AI - proposal documents
 *
 *  AI output is never written straight to the user's file. It is published as a virtual,
 *  read-only document under the `pscode-proposal:` scheme and shown in VS Code's own diff
 *  editor, so the user reviews a real diff and PSCode does not have to invent diff UI.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';

export const PROPOSAL_SCHEME = 'pscode-proposal';

const contents = new Map<string, string>();
const onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

class ProposalContentProvider implements vscode.TextDocumentContentProvider {
	readonly onDidChange = onDidChangeEmitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return contents.get(uri.toString()) ?? '';
	}
}

/** Publishes (or updates) the proposed text behind a `pscode-proposal:` URI. */
export function setProposal(uri: vscode.Uri, text: string): void {
	contents.set(uri.toString(), text);
	// Fires the diff editor's re-read, which is what makes streaming output appear live.
	onDidChangeEmitter.fire(uri);
}

export function getProposal(uri: vscode.Uri): string | undefined {
	return contents.get(uri.toString());
}

export function clearProposal(uri: vscode.Uri): void {
	contents.delete(uri.toString());
}

/**
 * Opens a read-only side-by-side diff of a proposal against what is on disk, and returns the
 * proposal URI. Shared by agent mode and by Apply in chat, because both owe the user the same
 * thing: see the change before it happens. `tag` keeps the three callers on separate URIs, so an
 * inline edit and an Apply proposal for one file do not overwrite each other.
 */
export async function showProposedDiff(
	uri: vscode.Uri,
	proposed: string,
	existed: boolean,
	tag: string = 'agent'
): Promise<vscode.Uri> {
	const proposalUri = vscode.Uri.parse(`${PROPOSAL_SCHEME}:${uri.path}?${tag}`);
	setProposal(proposalUri, proposed);
	await vscode.commands.executeCommand(
		'vscode.diff',
		existed ? uri : vscode.Uri.parse(`${PROPOSAL_SCHEME}:/empty?blank`),
		proposalUri,
		`PSCode AI proposal: ${path.basename(uri.fsPath)}`,
		// preserveFocus keeps the caret in the chat panel, so Accept/Reject stays one click away.
		{ preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside }
	);
	return proposalUri;
}

export function registerProposalProvider(): vscode.Disposable {
	return vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, new ProposalContentProvider());
}
