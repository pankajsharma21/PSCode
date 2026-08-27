/*---------------------------------------------------------------------------------------------
 *  PSCode AI - extension entry point
 *
 *  Wiring only. Every feature lives in its own module so this file stays readable as the
 *  one place that answers "what does PSCode AI actually register?".
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EXPLAIN_PROMPT } from './agent/prompts';
import { ChatViewProvider } from './chat/chatViewProvider';
import { ChatHistory } from './chat/history';
import { registerProjectRulesWatcher } from './context/projectRules';
import { initSemanticIndex } from './context/semanticIndex';
import { acceptPendingEdit, discardPendingEdit, reportProviderError, runInlineEdit } from './inline/inlineEdit';
import { registerProposalProvider } from './inline/proposalDocuments';
import { createProvider, readSettings } from './providers/registry';
import { AIStatusBar } from './statusBar';
import { log } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
	log.info('PSCode AI activating');

	// workspaceState, not globalState: a conversation belongs to the codebase it is about.
	const history = new ChatHistory(context.workspaceState);
	const chat = new ChatViewProvider(context.extensionUri, history);
	// globalStorage, so indexing never writes into the user's repository.
	const index = initSemanticIndex(context.globalStorageUri);
	const statusBar = new AIStatusBar();

	context.subscriptions.push(
		statusBar,
		registerProposalProvider(),
		registerProjectRulesWatcher(),

		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
			// Keeps the transcript alive when the user switches to another side-bar view.
			webviewOptions: { retainContextWhenHidden: true },
		}),

		vscode.commands.registerCommand('pscode.chat.focus', async () => {
			await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
			chat.focusInput();
		}),

		vscode.commands.registerCommand('pscode.chat.new', () => chat.newChat()),
		vscode.commands.registerCommand('pscode.restoreCheckpoint', () => chat.restoreLatestCheckpoint()),

		vscode.commands.registerCommand('pscode.buildSemanticIndex', async () => {
			try {
				const outcome = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'PSCode AI — building the semantic index',
						cancellable: true,
					},
					(progress, token) => index.build(readSettings(), progress, token)
				);

				// Reported in full, including what was skipped. A bare "done" would hide that a
				// cap or an exclude glob quietly left most of the repo out of the index.
				const parts = [
					`${outcome.chunks} chunks from ${outcome.filesIndexed} files`,
					`${outcome.reusedChunks} reused`,
					`${outcome.filesSkipped} skipped`,
				];
				void vscode.window.showInformationMessage(
					`Semantic index ${outcome.cancelled ? 'partially built (cancelled)' : 'ready'}: ${parts.join(', ')}. `
					+ 'Use @codebase in chat.'
				);
			} catch (error) {
				reportProviderError(error);
			}
		}),

		vscode.commands.registerCommand('pscode.clearSemanticIndex', async () => {
			await index.clear();
			void vscode.window.showInformationMessage('Semantic index cleared.');
		}),
		vscode.commands.registerCommand('pscode.chat.cancel', () => chat.cancel()),
		vscode.commands.registerCommand('pscode.addSelectionToChat', () => chat.addSelectionToChat()),

		vscode.commands.registerCommand('pscode.inlineEdit', async () => {
			try {
				await runInlineEdit();
			} catch (error) {
				reportProviderError(error);
			}
		}),

		vscode.commands.registerCommand('pscode.explainSelection', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.selection.isEmpty) {
				void vscode.window.showInformationMessage('Select the code you want explained.');
				return;
			}
			await chat.ask(EXPLAIN_PROMPT);
		}),

		vscode.commands.registerCommand('pscode.diff.accept', () => acceptPendingEdit()),
		vscode.commands.registerCommand('pscode.diff.discard', () => discardPendingEdit()),
		vscode.commands.registerCommand('pscode.showLogs', () => log.show()),
		vscode.commands.registerCommand('pscode.pickModel', () => pickModel()),

		// Settings changes must reach the status bar and the chat header immediately,
		// otherwise the UI claims a model that is no longer selected.
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('pscode')) {
				statusBar.refresh();
				chat.publishStatus();
			}
		}),
	);

	revealPanelOnFirstRun(context);

	log.info('PSCode AI ready');
}

/**
 * Shows the AI panel the first time a profile is used.
 *
 * `contributes.configurationDefaults` opens the secondary side bar, but it opens with no active
 * container: upstream's default there is the Copilot chat panel, which `disableCloudChat` hides,
 * and nothing promotes this container into the empty slot. The result on a fresh profile - the
 * only experience a new installer gets - is an empty pane where the AI should be, with no hint
 * that "PSCode: Open AI Chat" is what fixes it.
 *
 * Done once per profile and recorded in globalState, because after that the user's own decision
 * to close the panel has to win. An editor that reopens a panel you closed is worse than one
 * that never opened it.
 */
function revealPanelOnFirstRun(context: vscode.ExtensionContext): void {
	const KEY = 'pscode.panelRevealed';
	if (context.globalState.get<boolean>(KEY)) {
		return;
	}
	void context.globalState.update(KEY, true);
	log.info('First run for this profile: revealing the AI panel');
	void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
}

export function deactivate(): void {
	log.dispose();
}

/**
 * Lists what the server actually has and lets the user choose, rather than making them
 * type a model id into settings and guess why nothing works.
 */
async function pickModel(): Promise<void> {
	const settings = readSettings();
	const provider = createProvider(settings);

	const controller = new AbortController();
	let models: string[] = [];

	try {
		models = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Asking ${settings.provider} which models it has…` },
			() => provider.listModels(controller.signal)
		);
	} catch (error) {
		reportProviderError(error);
		// Still let the user type an id: the server may be down but the setting valid.
	}

	interface ModelItem extends vscode.QuickPickItem { value?: string }

	const items: ModelItem[] = models.map(model => ({
		label: model,
		description: model === settings.model ? 'current' : undefined,
		value: model,
	}));
	items.push(
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(edit) Enter a model id manually…' },
		{ label: '$(gear) Open PSCode AI settings' },
	);

	const choice = await vscode.window.showQuickPick(items, {
		title: 'PSCode AI — select model',
		placeHolder: models.length ? `${models.length} model(s) on ${settings.endpoint}` : 'No models reported; type one manually',
	});
	if (!choice) {
		return;
	}

	if (choice.label.includes('Open PSCode AI settings')) {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'pscode.ai');
		return;
	}

	let model = choice.value;
	if (!model) {
		model = await vscode.window.showInputBox({
			title: 'PSCode AI — model id',
			value: settings.model,
			prompt: 'e.g. qwen2.5-coder:7b, deepseek-coder-v2:16b, claude-sonnet-5',
		});
	}
	if (!model?.trim()) {
		return;
	}

	await vscode.workspace.getConfiguration('pscode').update('ai.model', model.trim(), vscode.ConfigurationTarget.Global);
	void vscode.window.showInformationMessage(`PSCode AI is now using ${model.trim()}.`);
}
