/*---------------------------------------------------------------------------------------------
 *  PSCode AI - chat view
 *
 *  Owns the conversation state and brokers between the webview (pure UI, no privileges) and
 *  the providers/agent (all privileged work). The webview never touches the filesystem or the
 *  network: it posts intents, and this class decides what is allowed to happen.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgent } from '../agent/agentLoop';
import { ApprovalRegistry, ApprovalRequest, nextApprovalId } from '../agent/approvals';
import { Checkpoint, CheckpointStore } from '../agent/checkpoints';
import { AGENT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT } from '../agent/prompts';
import { buildContext } from '../context/contextBuilder';
import { readProjectRules, withProjectRules } from '../context/projectRules';
import { ChatHistory, newSessionId } from './history';
import { reportProviderError } from '../inline/inlineEdit';
import { showProposedDiff } from '../inline/proposalDocuments';
import { AISettings, createProvider, readSettings } from '../providers/registry';
import { ChatMessage, ProviderError } from '../providers/types';
import { toAbortSignal } from '../util/cancellation';
import { log } from '../util/logger';

type Mode = 'chat' | 'agent';

interface InboundMessage {
	type: 'send' | 'cancel' | 'newChat' | 'apply' | 'copyDone' | 'pickModel' | 'openSettings'
	| 'ready' | 'approvalResponse' | 'revealDiff' | 'manageTrust'
	| 'listSessions' | 'loadSession' | 'deleteSession' | 'restoreCheckpoint';
	text?: string;
	mode?: Mode;
	code?: string;
	/** approvalResponse, loadSession, deleteSession, restoreCheckpoint */
	id?: string;
	approved?: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'pscode.chatView';

	private view: vscode.WebviewView | undefined;
	private conversation: ChatMessage[] = [];
	private inflight: vscode.CancellationTokenSource | undefined;
	private readonly approvals = new ApprovalRegistry();
	/**
	 * Apply reviews live outside the agent turn. Keeping them in `approvals` meant the turn's
	 * cleanup declined a card the user was still reading, so their Accept landed on an already
	 * resolved promise and the edit vanished without a word.
	 */
	private readonly applyApprovals = new ApprovalRegistry();

	/** Snapshots of the agent's file changes, one per turn. */
	private readonly checkpoints = new CheckpointStore();

	/**
	 * Which stored session the current transcript belongs to. A new id is minted on "New
	 * chat" rather than on the first message, so an abandoned empty chat never persists.
	 */
	private sessionId = newSessionId();

	/** Set when the webview's script has actually run. See `watchForDeadWebview`. */
	private webviewReady = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly history: ChatHistory
	) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.watchForDeadWebview();

		webviewView.webview.options = {
			enableScripts: true,
			// The webview may only load files PSCode ships. Nothing from the workspace,
			// nothing from the network.
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		webviewView.webview.html = this.render(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((message: InboundMessage) => {
			void this.handle(message);
		});

		webviewView.onDidDispose(() => {
			this.webviewReady = false;
			this.inflight?.cancel();
			// A pending approval whose UI just disappeared must decline, not hang the agent.
			this.approvals.declineAll();
			this.applyApprovals.declineAll();
			this.view = undefined;
		});
	}

	/**
	 * Notices when the panel renders as an empty pane.
	 *
	 * VS Code serves webview resources through a service worker. If that worker fails to
	 * register - it happens, and a debugger client attaching to it is one way to cause it - the
	 * panel is simply blank: no error dialog, often nothing in the log, and no hint that the
	 * remedy is to clear a cache directory. That is a genuinely baffling first experience, and
	 * PSCode is in a position to name it, because the webview always posts `ready` when its
	 * script runs. Silence past this deadline means the script never ran.
	 *
	 * Only a message and a log line: no attempt to reload or repair, because guessing at a
	 * broken storage layer is how you turn a blank panel into a lost conversation.
	 */
	private watchForDeadWebview(): void {
		const DEADLINE_MS = 12000;
		setTimeout(() => {
			if (this.webviewReady || !this.view) {
				return;
			}
			log.error(
				'The AI panel webview never reported ready. Its service worker probably failed to '
				+ 'register, which renders the panel blank.'
			);
			void vscode.window.showErrorMessage(
				'The PSCode AI panel could not load.',
				'How to fix'
			).then(choice => {
				if (choice !== 'How to fix') {
					return;
				}
				void vscode.window.showInformationMessage(
					'This is a webview service-worker failure, not a problem with your model. '
					+ 'Quit PSCode, delete the "Service Worker" folder inside your user-data directory '
					+ '(~/.config/code-oss-dev for a dev build), and start it again. It is a cache and is rebuilt.',
					{ modal: true }
				);
			});
		}, DEADLINE_MS);
	}

	/* ---------------------------------------------------------------- intents */

	private async handle(message: InboundMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.webviewReady = true;
				this.publishStatus();
				this.publishSessions();
				break;
			case 'send':
				await this.send(message.text ?? '', message.mode ?? 'chat');
				break;
			case 'cancel':
				this.inflight?.cancel();
				this.approvals.declineAll();
				break;
			case 'approvalResponse':
				if (message.id) {
					const approved = message.approved === true;
					const known = this.approvals.resolve(message.id, approved)
						|| this.applyApprovals.resolve(message.id, approved);
					log.info(`[approval] webview replied id=${message.id} approved=${approved} matched=${known}`);
				}
				break;
			case 'revealDiff':
				await vscode.commands.executeCommand('workbench.action.focusRightGroup');
				break;
			case 'newChat':
				this.newChat();
				break;
			case 'listSessions':
				this.publishSessions();
				break;
			case 'loadSession':
				if (message.id) {
					await this.loadSession(message.id);
				}
				break;
			case 'deleteSession':
				if (message.id) {
					await this.history.delete(message.id);
					this.publishSessions();
				}
				break;
			case 'restoreCheckpoint':
				if (message.id) {
					await this.restoreCheckpoint(message.id);
				}
				break;
			case 'apply':
				await this.applyToEditor(message.code ?? '');
				break;
			case 'pickModel':
				await vscode.commands.executeCommand('pscode.pickModel');
				break;
			case 'openSettings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'pscode.ai');
				break;
			case 'manageTrust':
				await vscode.commands.executeCommand('workbench.trust.manage');
				break;
			default:
				break;
		}
	}

	newChat(): void {
		this.inflight?.cancel();
		this.conversation = [];
		this.sessionId = newSessionId();
		this.post({ type: 'cleared' });
		this.publishStatus();
		this.publishSessions();
	}

	cancel(): void {
		this.inflight?.cancel();
		this.approvals.declineAll();
	}

	/**
	 * Posts an approval card into the transcript and waits for the click. Nothing else can
	 * satisfy it: the webview must echo back this exact request id.
	 */
	private requestApproval(request: ApprovalRequest, registry: ApprovalRegistry = this.approvals): Promise<boolean> {
		if (!this.view) {
			return Promise.resolve(false);
		}
		log.info(`[approval] requested id=${request.id} kind=${request.kind} title=${request.title}`);
		this.activity('waitingForYou', 'Waiting for you to accept or reject', request.filePath);
		const answer = registry.create(request.id);
		this.post({ type: 'approvalRequest', ...request });
		return answer.then(approved => {
			log.info(`[approval] settled id=${request.id} approved=${approved}`);
			return approved;
		});
	}

	focusInput(): void {
		this.post({ type: 'focusInput' });
	}

	/** Adds the editor's selection to the composer as a quoted block. */
	async addSelectionToChat(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			void vscode.window.showInformationMessage('Select some code first.');
			return;
		}
		await vscode.commands.executeCommand('pscode.chat.focus');
		const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
		this.post({
			type: 'insertContext',
			label: `${relative}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
		});
	}

	/** Used by "Explain selection": seeds and immediately sends a prompt. */
	async ask(prompt: string, mode: Mode = 'chat'): Promise<void> {
		await vscode.commands.executeCommand('pscode.chat.focus');
		await this.send(prompt, mode);
	}

	publishStatus(): void {
		const settings = readSettings();
		this.post({
			type: 'status',
			provider: settings.provider,
			model: settings.model,
			endpoint: settings.endpoint,
			agentEnabled: settings.agentEnabled,
			trusted: vscode.workspace.isTrusted,
		});
	}

	/* ------------------------------------------------------------------- send */

	private async send(text: string, mode: Mode): Promise<void> {
		const prompt = text.trim();
		if (!prompt) {
			return;
		}
		if (this.inflight) {
			void vscode.window.showInformationMessage('PSCode AI is still working. Stop it first, or wait.');
			return;
		}

		const settings = readSettings();
		if (mode === 'agent' && !settings.agentEnabled) {
			this.post({ type: 'error', message: 'Agent mode is disabled in settings ("pscode.agent.enabled").' });
			return;
		}
		// The webview disables the Agent button in Restricted Mode, but the webview is untrusted
		// input: the decision that matters is this one, made next to the tools.
		if (mode === 'agent' && !vscode.workspace.isTrusted) {
			this.post({
				type: 'error',
				message: 'Agent mode needs a trusted folder - it can edit files and run commands. '
					+ 'Chat works as normal. Trust this folder to enable it.',
			});
			return;
		}

		this.post({ type: 'userMessage', text: prompt });
		this.post({ type: 'busy', busy: true });

		const source = new vscode.CancellationTokenSource();
		this.inflight = source;
		const abort = toAbortSignal(source.token);

		try {
			this.activity('context', 'Gathering context');
			const context = await buildContext({ userText: prompt, budgetChars: settings.contextBudgetChars });
			if (context.semanticNote) {
				this.post({ type: 'notice', message: context.semanticNote });
			}
			if (context.missingMentions.length) {
				this.post({
					type: 'notice',
					message: `Could not find: ${context.missingMentions.map(m => `@${m}`).join(', ')}`,
				});
			}
			this.post({ type: 'contextChips', files: context.includedFiles, approxTokens: context.approxTokens });

			// The context block is attached to the user's turn rather than the system prompt
			// so it travels with the question it belongs to, and older turns keep their own.
			const userMessage: ChatMessage = {
				role: 'user',
				content: context.text ? `${prompt}\n\n${context.text}` : prompt,
			};
			this.conversation.push(userMessage);

			this.post({ type: 'assistantStart', mode });

			if (mode === 'agent') {
				await this.runAgentTurn(settings, source, abort.signal, prompt);
			} else {
				await this.runChatTurn(settings, source, abort.signal);
			}
		} catch (error) {
			this.reportError(error);
		} finally {
			abort.dispose();
			source.dispose();
			this.inflight = undefined;
			if (this.approvals.size > 0) {
				log.warn(`[approval] declining ${this.approvals.size} outstanding request(s) because the turn ended`);
			}
			this.approvals.declineAll();
			this.activityDone();
			this.post({ type: 'busy', busy: false });
			this.post({ type: 'assistantDone' });

			// Saved here rather than on success only: a cancelled or failed turn is still
			// worth keeping, and it is the transcript the user will want to look at.
			await this.history.save(this.sessionId, this.conversation);
			this.publishSessions();
		}
	}

	private async runChatTurn(
		settings: AISettings,
		source: vscode.CancellationTokenSource,
		signal: AbortSignal
	): Promise<void> {
		const provider = createProvider(settings);
		const rules = await readProjectRules();
		let reply = '';
		// One stream event is one token for every provider PSCode speaks, so counting events is
		// a fair live rate. The authoritative count still comes from the usage event at the end.
		let tokens = 0;

		this.activity('waiting', `Waiting for ${settings.model}`, 'first token');

		for await (const event of provider.stream(
			{
				messages: [
					{ role: 'system', content: withProjectRules(CHAT_SYSTEM_PROMPT, rules) },
					...this.conversation,
				],
				temperature: settings.temperature,
				maxTokens: settings.maxTokens,
			},
			signal
		)) {
			if (source.token.isCancellationRequested) {
				break;
			}
			if (event.type === 'text') {
				if (tokens === 0) {
					this.activity('writing', 'Writing');
				}
				tokens++;
				reply += event.text;
				this.post({ type: 'assistantDelta', text: event.text });
				this.post({ type: 'tokens', tokens });
			} else if (event.type === 'usage') {
				this.post({ type: 'usage', promptTokens: event.promptTokens, completionTokens: event.completionTokens });
			}
		}

		if (reply) {
			this.conversation.push({ role: 'assistant', content: reply });
		}
	}

	private async runAgentTurn(
		settings: AISettings,
		source: vscode.CancellationTokenSource,
		signal: AbortSignal,
		prompt: string
	): Promise<void> {
		const provider = createProvider(settings);
		const rules = await readProjectRules();
		const checkpoint = this.checkpoints.begin(prompt);
		/** Whether the current phase is streamed prose, so a delta only changes phase once. */
		let streaming = false;
		/** Counted per stream event, which is one token for every provider PSCode speaks. */
		let tokens = 0;

		const produced = await runAgent({
			provider,
			settings,
			history: this.conversation,
			token: source.token,
			signal,
			systemPrompt: withProjectRules(AGENT_SYSTEM_PROMPT, rules),
			checkpoint,
			requestApproval: request => this.requestApproval(request),
			events: {
				onText: delta => {
					if (!streaming) {
						streaming = true;
						tokens = 0;
						this.activity('writing', 'Writing');
					}
					tokens++;
					this.post({ type: 'assistantDelta', text: delta });
					this.post({ type: 'tokens', tokens });
				},
				onToolStart: call => {
					streaming = false;
					this.activity('tool', describeToolActivity(call.name, call.args), call.name);
					this.post({ type: 'toolStart', name: call.name, args: call.args });
				},
				onToolTrace: line => this.post({ type: 'toolTrace', line }),
				onToolResult: (call, ok, summary) => this.post({
					type: 'toolResult',
					name: call.name,
					ok,
					summary: summary.length > 600 ? `${summary.slice(0, 600)}…` : summary,
				}),
				onIteration: (index, max) => {
					streaming = false;
					// Between tools the model is thinking, and on CPU that is the longest wait in
					// the whole run - so it gets its own phase rather than looking idle.
					this.activity(
						'thinking',
						index === 1 ? `Waiting for ${settings.model}` : 'Deciding what to do next',
						`step ${index} of ${max}`
					);
					this.post({ type: 'iteration', index, max });
				},
				onDone: reason => this.post({ type: 'agentDone', reason }),
			},
		});

		this.conversation.push(...produced);
		this.offerCheckpoint(checkpoint);
	}

	/**
	 * Posts the Restore card once the run is over. A run that only read files leaves no card,
	 * because a Restore button that reverts nothing is worse than no button at all.
	 */
	private offerCheckpoint(checkpoint: Checkpoint): void {
		this.checkpoints.discardIfEmpty(checkpoint);
		if (checkpoint.fileCount === 0) {
			return;
		}
		this.post({
			type: 'checkpoint',
			id: checkpoint.id,
			label: checkpoint.label,
			files: checkpoint.filePaths,
		});
	}

	/* ------------------------------------------------------- sessions & undo */

	private publishSessions(): void {
		this.post({ type: 'sessions', sessions: this.history.list(), currentId: this.sessionId });
	}

	/**
	 * Replays a stored session into the transcript. The webview is rebuilt from the messages
	 * rather than from a saved HTML blob, so a session recorded by an older build still
	 * renders with the current markdown renderer.
	 */
	private async loadSession(id: string): Promise<void> {
		if (this.inflight) {
			void vscode.window.showInformationMessage('PSCode AI is still working. Stop it first.');
			return;
		}

		const session = this.history.get(id);
		if (!session) {
			this.post({ type: 'notice', message: 'That conversation is no longer stored.' });
			this.publishSessions();
			return;
		}

		this.conversation = session.messages;
		this.sessionId = session.id;
		this.post({ type: 'cleared' });

		for (const message of session.messages) {
			if (typeof message.content !== 'string' || !message.content) {
				continue;
			}
			if (message.role === 'user') {
				// Strip the context block that was appended when the turn was sent; it is
				// noise on replay and the user never typed it.
				this.post({ type: 'userMessage', text: message.content.split('\n\n--- ')[0] });
			} else if (message.role === 'assistant') {
				this.post({ type: 'assistantStart', mode: 'chat' });
				this.post({ type: 'assistantDelta', text: message.content });
				this.post({ type: 'assistantDone' });
			}
		}

		this.post({ type: 'notice', message: `Reopened "${session.title}" (${session.messages.length} messages).` });
		this.publishSessions();
	}

	/** Reverts every file the given agent turn changed. */
	private async restoreCheckpoint(id: string): Promise<void> {
		const checkpoint = this.checkpoints.get(id);
		if (!checkpoint) {
			this.post({ type: 'notice', message: 'That checkpoint is no longer available.' });
			return;
		}

		const result = await checkpoint.restore();
		const parts: string[] = [];
		if (result.reverted.length) {
			parts.push(`reverted ${result.reverted.length} file(s)`);
		}
		if (result.deleted.length) {
			parts.push(`deleted ${result.deleted.length} file(s) the agent created`);
		}
		if (result.failed.length) {
			parts.push(`could NOT restore ${result.failed.join(', ')}`);
		}

		this.post({
			type: 'checkpointRestored',
			id,
			message: parts.length ? `Restored: ${parts.join(', ')}. Ctrl+Z undoes the restore.` : 'Nothing to restore.',
			ok: result.failed.length === 0,
		});
	}

	/** Backs out the most recent agent turn. Bound to a command for the palette. */
	async restoreLatestCheckpoint(): Promise<void> {
		const available = this.checkpoints.list();
		if (available.length === 0) {
			void vscode.window.showInformationMessage('No agent changes to restore.');
			return;
		}

		const choice = await vscode.window.showQuickPick(
			available.map(item => ({
				label: item.label,
				description: `${item.filePaths.length} file(s)`,
				detail: item.filePaths.join(', '),
				id: item.id,
			})),
			{ title: 'PSCode AI — restore a checkpoint', placeHolder: 'Reverts every file that agent turn changed' }
		);
		if (!choice) {
			return;
		}
		await vscode.commands.executeCommand('pscode.chat.focus');
		await this.restoreCheckpoint(choice.id);
	}

	/* -------------------------------------------------------------- utilities */

	/**
	 * Applies a fenced block from a chat reply to the active editor - but never blind.
	 * Chat mode has no tools, so this button used to be the one place PSCode changed a file
	 * without showing a diff or asking; it spliced the block in at the cursor, which turned a
	 * model that reprinted a whole file into a duplicated file. Now it proposes, diffs, and
	 * waits for Accept, exactly like agent mode.
	 *
	 * What the block means depends on the selection, because that is the only signal available:
	 *   - selection active -> the block replaces the selection
	 *   - no selection     -> the block is the file's new contents
	 * A wrong guess is now harmless: it shows up in the diff and the user rejects it.
	 */
	private async applyToEditor(code: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showInformationMessage('Open a file to apply this code into.');
			return;
		}

		const document = editor.document;
		const selection = editor.selection;
		const replacesSelection = !selection.isEmpty;
		const original = document.getText();

		const target = replacesSelection ? selection : new vscode.Range(
			document.positionAt(0),
			document.positionAt(original.length)
		);
		const proposed = replacesSelection
			? original.slice(0, document.offsetAt(selection.start)) + code + original.slice(document.offsetAt(selection.end))
			: code;

		if (proposed === original) {
			void vscode.window.showInformationMessage('That block is already what the file contains.');
			return;
		}

		const relative = vscode.workspace.asRelativePath(document.uri, false);
		await showProposedDiff(document.uri, proposed, true, 'apply');

		const before = original.split('\n').length;
		const after = proposed.split('\n').length;
		const approved = await this.requestApproval({
			id: nextApprovalId(),
			kind: replacesSelection ? 'edit' : 'overwrite',
			title: `${replacesSelection ? 'Replace selection in' : 'Rewrite'} ${relative}`,
			detail: replacesSelection
				? `lines ${selection.start.line + 1}-${selection.end.line + 1}`
				: `${before} lines to ${after}`,
			filePath: relative,
			hasDiff: true,
		}, this.applyApprovals);

		if (!approved) {
			return;
		}

		// Reviewing takes as long as it takes, and the file is editable throughout. Applying a
		// range computed against text that has since changed would corrupt it silently.
		if (document.getText() !== original) {
			void vscode.window.showWarningMessage(
				`${relative} changed while you were reviewing, so nothing was applied. Ask again for a fresh proposal.`
			);
			return;
		}

		// Applied through the editor rather than the filesystem so it lands on the undo stack
		// and stays unsaved, leaving the user one Ctrl+Z from where they were.
		await editor.edit(builder => builder.replace(target, code));
	}

	private reportError(error: unknown): void {
		if (error instanceof ProviderError) {
			this.post({ type: 'error', message: error.hint ? `${error.message}\n\n${error.hint}` : error.message });
			log.error(error.message, error);
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		this.post({ type: 'error', message });
		reportProviderError(error);
	}

	/**
	 * Announces what PSCode is doing now. The webview owns the elapsed clock, so this only has
	 * to fire on phase changes rather than on a timer.
	 */
	private activity(phase: string, label: string, detail?: string): void {
		this.post({ type: 'activity', phase, label, detail });
	}

	private activityDone(): void {
		this.post({ type: 'activityDone' });
	}

	private post(message: Record<string, unknown>): void {
		void this.view?.webview.postMessage(message);
	}

	/* ------------------------------------------------------------------ html */

	private render(webview: vscode.Webview): string {
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
		const nonce = makeNonce();

		// Strict CSP: no inline script (the nonce is the only exception), no remote anything.
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('chat.css')}" rel="stylesheet">
<title>PSCode AI</title>
</head>
<body>
	<header id="status-bar">
		<button id="model-button" class="chip" title="Change model">
			<span class="dot" id="status-dot"></span>
			<span id="model-label">connecting…</span>
		</button>
		<span class="spacer"></span>
		<button id="history-button" class="icon" title="Recent conversations" aria-label="Recent conversations" aria-expanded="false">◴</button>
		<div class="mode-switch" role="radiogroup" aria-label="Mode">
			<button class="mode active" data-mode="chat" role="radio" aria-checked="true">Chat</button>
			<button class="mode" id="mode-agent" data-mode="agent" role="radio" aria-checked="false">Agent</button>
		</div>
	</header>

	<div id="history-panel" hidden>
		<div class="history-head">
			<strong>Recent conversations</strong>
			<button id="history-close" class="ghost">Close</button>
		</div>
		<ul id="history-list"></ul>
		<p id="history-empty" class="muted">No saved conversations in this workspace yet.</p>
	</div>

	<main id="transcript" aria-live="polite">
		<div class="empty" id="empty-state">
			<h2>PSCode AI</h2>
			<p>Ask about your code, or switch to <strong>Agent</strong> to let it read and edit files.</p>
			<ul>
				<li><kbd>Ctrl</kbd>+<kbd>I</kbd> — edit the selection in place</li>
				<li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> — add the selection here</li>
				<li>Type <code>@filename</code> to pull a file into context</li>
				<li>Agent runs get a <strong>checkpoint</strong> — one click reverts the whole turn</li>
				<li>Repo conventions in <code>AGENTS.md</code> are sent automatically</li>
			</ul>
		</div>
	</main>

	<div id="context-bar" hidden></div>

	<footer>
		<div id="activity" hidden aria-live="polite">
			<span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span>
			<span id="activity-label"></span>
			<span id="activity-meta"></span>
		</div>
		<div id="restricted" hidden>
			<strong>RESTRICTED MODE</strong><span> — chat only, this folder is not trusted. </span>
			<button id="trust-button" class="link">Trust this folder</button>
			<span> to enable Agent, Ctrl+I and @codebase.</span>
		</div>
		<div id="mode-hint"><strong id="mode-hint-name"></strong><span id="mode-hint-text"></span></div>
		<textarea id="composer" rows="3" placeholder="Ask about your code…  (Enter to send, Shift+Enter for a new line)"></textarea>
		<div class="actions">
			<button id="send" class="primary">Send</button>
			<button id="stop" hidden>Stop</button>
			<span class="spacer"></span>
			<button id="new-chat" class="ghost" title="Clear this conversation">New chat</button>
		</div>
	</footer>

	<script nonce="${nonce}" src="${media('chat.js')}"></script>
</body>
</html>`;
	}
}

/**
 * Turns a tool call into something a person can read at a glance.
 *
 * The transcript already logs the raw call; this is the "what is it doing right now" line, so it
 * is phrased as an activity rather than as an API name. On CPU inference a single tool round can
 * take a minute, and "Reading src/cart.ts" answers the only question the user has during it.
 */
function describeToolActivity(name: string, rawArgs: string): string {
	let args: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(rawArgs || '{}');
		if (parsed && typeof parsed === 'object') {
			args = parsed as Record<string, unknown>;
		}
	} catch {
		// Small models truncate arguments; the phase name alone is still useful.
	}
	const text = (key: string): string | undefined => {
		const value = args[key];
		return typeof value === 'string' && value.trim() ? value.trim() : undefined;
	};
	const path = text('path');
	const quote = (value: string) => `“${value.length > 40 ? `${value.slice(0, 40)}…` : value}”`;

	switch (name) {
		case 'read_file': return path ? `Reading ${path}` : 'Reading a file';
		case 'list_dir': return path ? `Listing ${path}` : 'Listing a directory';
		case 'project_map': return 'Mapping the project';
		case 'search_text': {
			const query = text('query') ?? text('pattern');
			return query ? `Searching for ${quote(query)}` : 'Searching the workspace';
		}
		case 'semantic_search': {
			const query = text('query');
			return query ? `Searching by meaning for ${quote(query)}` : 'Searching by meaning';
		}
		case 'find_symbol': {
			const symbol = text('symbol') ?? text('name');
			return symbol ? `Finding where ${symbol} is defined` : 'Finding a definition';
		}
		case 'find_usages': {
			const symbol = text('symbol') ?? text('name');
			return symbol ? `Finding every use of ${symbol}` : 'Finding usages';
		}
		case 'get_diagnostics': return path ? `Checking ${path} for errors` : 'Checking the project for errors';
		case 'replace_in_file': return path ? `Editing ${path}` : 'Editing a file';
		case 'write_file': return path ? `Writing ${path}` : 'Writing a file';
		case 'run_command': {
			const command = text('command') ?? text('cmd');
			return command ? `Running ${quote(command)}` : 'Running a command';
		}
		default: return `Running ${name}`;
	}
}

function makeNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}
