/*---------------------------------------------------------------------------------------------
 *  PSCode AI - cancellation
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Bridges VS Code's CancellationToken to the AbortSignal that Node's http layer wants.
 * Returns a disposer so the listener does not outlive the request.
 */
export function toAbortSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	const subscription = token.onCancellationRequested(() => controller.abort());
	return {
		signal: controller.signal,
		dispose: () => subscription.dispose(),
	};
}
