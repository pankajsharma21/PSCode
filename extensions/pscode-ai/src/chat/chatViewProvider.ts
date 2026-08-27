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
import { CHAT_SYSTEM_PROMPT } from '../agent/prompts';
import { buildContext } from '../context/contextBuilder';
import { reportProviderError } from '../inline/inlineEdit';
import { showProposedDiff } from '../inline/proposalDocuments';
import { AISettings, createProvider, readSettings } from '../providers/registry';
import { ChatMessage, ProviderError } from '../providers/types';
import { toAbortSignal } from '../util/cancellation';
import { log } from '../util/logger';

type Mode = 'chat' | 'agent';

interface InboundMessage {
	type: 'send' | 'cancel' | 'newChat' | 'apply' | 'copyDone' | 'pickModel' | 'openSettings'
	| 'ready' | 'approvalResponse' | 'revealDiff';
	text?: string;
	mode?: Mode;
	code?: string;
	/** approvalResponse */
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

	constructor(private readonly extensionUri: vscode.Uri) { }

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
		this.post({ type: 'cleared' });
		this.publishStatus();
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
				await this.runAgentTurn(settings, source, abort.signal);
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
		}
	}

	private async runChatTurn(
		settings: AISettings,
		source: vscode.CancellationTokenSource,
		signal: AbortSignal
	): Promise<void> {
		const provider = createProvider(settings);
		let reply = '';

		for await (const event of provider.stream(
			{
				messages: [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...this.conversation],
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
		signal: AbortSignal
	): Promise<void> {
		const provider = createProvider(settings);

		const produced = await runAgent({
			provider,
			settings,
			history: this.conversation,
			token: source.token,
			signal,
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
		<div class="mode-switch" role="radiogroup" aria-label="Mode">
			<button class="mode active" data-mode="chat" role="radio" aria-checked="true">Chat</button>
			<button class="mode" data-mode="agent" role="radio" aria-checked="false">Agent</button>
		</div>
	</header>

	<main id="transcript" aria-live="polite">
		<div class="empty" id="empty-state">
			<h2>PSCode AI</h2>
			<p>Ask about your code, or switch to <strong>Agent</strong> to let it read and edit files.</p>
			<ul>
				<li><kbd>Ctrl</kbd>+<kbd>I</kbd> — edit the selection in place</li>
				<li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> — add the selection here</li>
				<li>Type <code>@filename</code> to pull a file into context</li>
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
