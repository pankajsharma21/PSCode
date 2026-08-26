/*---------------------------------------------------------------------------------------------
 *  PSCode AI - proposal documents
 *
 *  AI output is never written straight to the user's file. It is published as a virtual,
 *  read-only document under the `pscode-proposal:` scheme and shown in VS Code's own diff
 *  editor, so the user reviews a real diff and PSCode does not have to invent diff UI.
 *--------------------------------------------------------------------------------------------*/

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

export function registerProposalProvider(): vscode.Disposable {
	return vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, new ProposalContentProvider());
}
