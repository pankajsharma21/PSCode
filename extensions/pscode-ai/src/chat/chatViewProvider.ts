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
	| 'ready' | 'approvalResponse' | 'revealDiff'
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

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly history: ChatHistory
	) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;

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
			this.inflight?.cancel();
			// A pending approval whose UI just disappeared must decline, not hang the agent.
			this.approvals.declineAll();
			this.applyApprovals.declineAll();
			this.view = undefined;
		});
	}

	/* ---------------------------------------------------------------- intents */

	private async handle(message: InboundMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
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

		this.post({ type: 'userMessage', text: prompt });
		this.post({ type: 'busy', busy: true });

		const source = new vscode.CancellationTokenSource();
		this.inflight = source;
		const abort = toAbortSignal(source.token);

		try {
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
				reply += event.text;
				this.post({ type: 'assistantDelta', text: event.text });
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
				onText: delta => this.post({ type: 'assistantDelta', text: delta }),
				onToolStart: call => this.post({ type: 'toolStart', name: call.name, args: call.args }),
				onToolTrace: line => this.post({ type: 'toolTrace', line }),
				onToolResult: (call, ok, summary) => this.post({
					type: 'toolResult',
					name: call.name,
					ok,
					summary: summary.length > 600 ? `${summary.slice(0, 600)}…` : summary,
				}),
				onIteration: (index, max) => this.post({ type: 'iteration', index, max }),
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
			<button class="mode" data-mode="agent" role="radio" aria-checked="false">Agent</button>
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

function makeNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}
