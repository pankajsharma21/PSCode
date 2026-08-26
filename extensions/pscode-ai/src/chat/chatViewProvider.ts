/*---------------------------------------------------------------------------------------------
 *  PSCode AI - chat view
 *
 *  Owns the conversation state and brokers between the webview (pure UI, no privileges) and
 *  the providers/agent (all privileged work). The webview never touches the filesystem or the
 *  network: it posts intents, and this class decides what is allowed to happen.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgent } from '../agent/agentLoop';
import { ApprovalRegistry, ApprovalRequest } from '../agent/approvals';
import { CHAT_SYSTEM_PROMPT } from '../agent/prompts';
import { buildContext } from '../context/contextBuilder';
import { reportProviderError } from '../inline/inlineEdit';
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
					const known = this.approvals.resolve(message.id, message.approved === true);
					log.info(`[approval] webview replied id=${message.id} approved=${message.approved === true} matched=${known}`);
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
	private requestApproval(request: ApprovalRequest): Promise<boolean> {
		if (!this.view) {
			return Promise.resolve(false);
		}
		log.info(`[approval] requested id=${request.id} kind=${request.kind} title=${request.title}`);
		const answer = this.approvals.create(request.id);
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

	private async applyToEditor(code: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showInformationMessage('Open a file to apply this code into.');
			return;
		}
		const target = editor.selection.isEmpty
			? new vscode.Range(editor.selection.active, editor.selection.active)
			: editor.selection;

		await editor.edit(builder => builder.replace(target, code));
		void vscode.window.showInformationMessage(
			editor.selection.isEmpty ? 'Inserted at the cursor.' : 'Replaced the selection.'
		);
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
