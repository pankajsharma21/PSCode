/*---------------------------------------------------------------------------------------------
 *  PSCode AI - fetching the engine and weights on first run
 *
 *  The installer does not carry the model. It carried it once, and two things were wrong with
 *  that: the .deb reached 9GB, which a GitHub release cannot even hold in one asset (2 GiB cap),
 *  and shipping weights means redistributing them - a licence question that changes with every
 *  model. Fetching from the publisher on first run removes both.
 *
 *  This runs the same `fetch-llm-runtime.sh` the repo has always used, in a visible terminal,
 *  rather than reimplementing 9GB of resumable download in TypeScript. That is deliberate:
 *  wget's progress output is better than anything a progress notification would show, the script
 *  is already the tested path, and a user who wants to run it by hand tomorrow uses the same
 *  command. The editor's job here is to know that the model is missing and to offer the fix.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import { discoverRuntime, runtimeInstallPath } from './bundledRuntime';
import { log } from '../util/logger';

/** Where the script lives inside the extension - it ships, so a packaged install can run it. */
function scriptPath(context: vscode.ExtensionContext): string {
	return join(context.extensionPath, 'scripts', 'fetch-llm-runtime.sh');
}

export function modelIsInstalled(context: vscode.ExtensionContext): boolean {
	return !!discoverRuntime(context.extensionPath, context.globalStorageUri.fsPath);
}

/**
 * Starts the download in a terminal.
 *
 * A terminal rather than a background task, because this is a ~9GB transfer that can take an hour
 * on a slow line: it needs to be visible, interruptible, and readable when it fails. Returning
 * before it finishes is intentional - the caller has nothing useful to do while it runs, and the
 * next question asked will pick up the runtime once it is there.
 */
export function startModelDownload(context: vscode.ExtensionContext): void {
	const script = scriptPath(context);
	if (!existsSync(script)) {
		void vscode.window.showErrorMessage(
			`PSCode cannot find its download script at ${script}. Fetch the model manually with `
			+ 'scripts/fetch-llm-runtime.sh from a source checkout.'
		);
		return;
	}

	const target = runtimeInstallPath(context.extensionPath, context.globalStorageUri.fsPath);
	log.info(`Fetching the model engine into ${target}`);

	const terminal = vscode.window.createTerminal({
		name: 'PSCode: download AI model',
		iconPath: new vscode.ThemeIcon('cloud-download'),
	});
	terminal.show();
	// Quoted because both paths can contain spaces, and globalStorage on some systems does.
	terminal.sendText(`"${script}" "--target=${target}"`);

	void vscode.window.showInformationMessage(
		'Downloading the AI model (~9GB). Progress is in the terminal. '
		+ 'Reload the window when it finishes.',
		'Reload when done'
	).then(choice => {
		if (choice === 'Reload when done') {
			void vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

/**
 * Offered once per installation, not once per window.
 *
 * A 9GB prompt on every startup would be nagging, and "Later" has to mean later. The flag lives in
 * globalState so a decision survives a restart; the command stays available either way, and the
 * status bar keeps saying the model is missing.
 */
const OFFERED_KEY = 'pscode.modelDownloadOffered';

export async function offerModelDownload(context: vscode.ExtensionContext): Promise<void> {
	if (modelIsInstalled(context)) {
		return;
	}

	// Someone pointing PSCode at their own server does not need our weights at all.
	const provider = vscode.workspace.getConfiguration('pscode').get<string>('ai.provider', 'bundled');
	if (provider !== 'bundled') {
		log.info(`No local model, but provider is "${provider}" - not offering the download.`);
		return;
	}

	if (context.globalState.get<boolean>(OFFERED_KEY)) {
		log.info('No local model. The download was offered before, so not asking again.');
		return;
	}
	await context.globalState.update(OFFERED_KEY, true);

	const download = 'Download (~9GB)';
	const settings = 'Use my own server';
	const choice = await vscode.window.showInformationMessage(
		'PSCode AI needs a model. It is not in the installer - the weights are fetched from their '
		+ 'publisher so nothing is redistributed and the download stays yours. About 9GB, one time.',
		download,
		settings
	);

	if (choice === download) {
		startModelDownload(context);
	} else if (choice === settings) {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'pscode.ai.provider');
	}
}
