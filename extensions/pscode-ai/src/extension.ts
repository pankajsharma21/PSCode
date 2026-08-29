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
import { initSemanticIndex, registerIncrementalIndexing, SemanticIndex } from './context/semanticIndex';
import { acceptPendingEdit, discardPendingEdit, reportProviderError, runInlineEdit } from './inline/inlineEdit';
import { registerProposalProvider } from './inline/proposalDocuments';
import { createProvider, readSettings } from './providers/registry';
import { BundledRuntime, bundledRuntime, discoverRuntime, setBundledRuntime } from './runtime/bundledRuntime';
import { AIStatusBar } from './statusBar';
import { log } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
	log.info('PSCode AI activating');

	// Before anything reads settings: `readSettings()` asks the runtime for the model name and
	// falls back to another provider when this build carries no weights.
	startBundledRuntime(context);

	// workspaceState, not globalState: a conversation belongs to the codebase it is about.
	const history = new ChatHistory(context.workspaceState);
	const chat = new ChatViewProvider(context.extensionUri, history);
	// globalStorage, so indexing never writes into the user's repository.
	const index = initSemanticIndex(context.globalStorageUri);
	const statusBar = new AIStatusBar();

	context.subscriptions.push(
		statusBar,
		registerProposalProvider(),

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
			if (!requireTrust('Building the @codebase index')) {
				return;
			}
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
			if (!requireTrust('Editing with Ctrl+I')) {
				return;
			}
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

	enableTrustedFeatures(context, index, chat);
	revealPanelOnFirstRun(context);

	log.info('PSCode AI ready');
}

/**
 * Turns on everything that may only run in a trusted folder - now, or the moment trust is granted.
 *
 * Restricted Mode is not an all-or-nothing switch for this extension. Chat has no tools and cannot
 * touch the workspace, so it answers questions perfectly well in an untrusted folder, and the
 * manifest says `"supported": "limited"` so the panel loads instead of silently vanishing. What
 * cannot run is anything the *folder* gets to influence on its own:
 *
 * - Agent mode, because `run_command` is one of its tools - opening a repo must never be enough
 *   to run its code.
 * - The AGENTS.md project rules, because that file is attacker-controlled text that would land
 *   in the system prompt. Prompt injection is the interesting half of this: rules that say
 *   "always run the build script first" are instructions to a model holding real tools.
 * - The semantic index, because it walks the whole tree and posts chunks of it to the configured
 *   endpoint, which is not necessarily localhost.
 *
 * Granting trust re-enables them in place: VS Code keeps the extension host alive, so a reload
 * would only throw away the conversation the user is in the middle of.
 */
function enableTrustedFeatures(
	context: vscode.ExtensionContext,
	index: SemanticIndex,
	chat: ChatViewProvider,
): void {
	if (!vscode.workspace.isTrusted) {
		log.warn('Restricted Mode: chat only. Agent mode, Ctrl+I, AGENTS.md rules and @codebase stay off until this folder is trusted.');
		context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
			log.info('Workspace trust granted');
			enableTrustedFeatures(context, index, chat);
			// The panel is showing a "Restricted Mode" notice and a disabled Agent button;
			// without this it would keep showing them in a folder that is now trusted.
			chat.publishStatus();
		}));
		return;
	}

	context.subscriptions.push(
		registerProjectRulesWatcher(),
		registerIncrementalIndexing(index),
	);
	log.info('Workspace is trusted: agent mode, project rules and @codebase indexing are active');
}

/**
 * Refuses a trusted-only action with the one sentence that explains it, and a way out.
 *
 * A command that quietly does nothing is the worst version of Restricted Mode: the user presses
 * Ctrl+I, nothing happens, and nothing on screen says why.
 */
function requireTrust(action: string): boolean {
	if (vscode.workspace.isTrusted) {
		return true;
	}
	void vscode.window
		.showWarningMessage(`${action} needs a trusted folder. PSCode AI is in chat-only mode.`, 'Manage Workspace Trust')
		.then(choice => {
			if (choice) {
				void vscode.commands.executeCommand('workbench.trust.manage');
			}
		});
	return false;
}

/**
 * Shows the AI panel the first time each workspace is opened.
 *
 * `contributes.configurationDefaults` opens the secondary side bar, but it opens with no active
 * container: upstream's default there is the Copilot chat panel, which `disableCloudChat` hides,
 * and nothing promotes this container into the empty slot. The result is an empty pane where the
 * AI should be, with no hint that "PSCode: Open AI Chat" is what fixes it.
 *
 * Recorded per workspace, not once per profile. Container visibility is itself workspace state -
 * `workbench.view.extension.pscode-ai.state` is stored per folder - so a single profile-wide flag
 * could be spent in one folder and leave every folder opened after it with the same blank pane the
 * function exists to prevent. That is exactly what happened here: the flag was set, the view was
 * separately left hidden for this folder, and the reveal could never run again.
 *
 * Still once per workspace, and the flag is written before the reveal, because after the first
 * time the user's own decision to close the panel has to win. An editor that reopens a panel you
 * closed is worse than one that never opened it.
 */
function revealPanelOnFirstRun(context: vscode.ExtensionContext): void {
	const KEY = 'pscode.panelRevealed';
	if (context.workspaceState.get<boolean>(KEY)) {
		return;
	}
	void context.workspaceState.update(KEY, true);
	log.info('First run for this workspace: revealing the AI panel');
	void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
}

/**
 * Brings up the engine that ships with PSCode.
 *
 * Started here, at activation, rather than on the first question: loading several gigabytes of
 * weights takes tens of seconds on CPU, and doing it while someone waits for an answer makes the
 * model look far slower than it is. Nothing blocks on it - `ensureChatEndpoint()` is awaited per
 * request, so a question asked during startup simply waits for the same promise.
 *
 * A build without weights is not an error: `discoverRuntime` returns undefined, settings fall
 * back to Ollama, and the status bar says what is missing.
 */
function startBundledRuntime(context: vscode.ExtensionContext): void {
	const layout = discoverRuntime(context.extensionPath);
	if (!layout) {
		log.warn('No bundled model engine in this build; falling back to the configured provider.');
		setBundledRuntime(undefined);
		return;
	}

	const config = vscode.workspace.getConfiguration('pscode');
	const runtime = new BundledRuntime(layout, {
		contextSize: config.get<number>('ai.contextSize', 8192),
		threads: config.get<number>('ai.threads', 0),
		// Reading a multi-gigabyte model off a cold disk is slow the first time and fast after
		// the page cache is warm, so this is sized for the cold case.
		startupTimeoutMs: config.get<number>('ai.startupTimeoutMs', 180000),
		log: message => log.info(message),
	});
	setBundledRuntime(runtime);
	context.subscriptions.push({ dispose: () => runtime.dispose() });

	// Kick it off now, but never let a startup failure take activation down with it: chat can
	// still be pointed at another provider, and the status bar reports the failure.
	void runtime.ensureChatEndpoint().catch(error => {
		log.error('The bundled model engine failed to start', error);
	});
}

export function deactivate(): void {
	// The subscription registered in startBundledRuntime already stops the engine, but deactivate
	// is the one hook guaranteed to run on shutdown, and an inference process left holding
	// gigabytes of weights after its window is gone is exactly what a user would blame the editor
	// for. dispose() is idempotent, so stopping it twice costs nothing.
	bundledRuntime()?.dispose();
	setBundledRuntime(undefined);
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
