/*---------------------------------------------------------------------------------------------
 *  PSCode AI - chat panel behaviour
 *
 *  Runs in the webview sandbox: no Node, no filesystem, no network. Everything that needs
 *  privilege is posted to the extension host, which decides whether to honour it.
 *--------------------------------------------------------------------------------------------*/

(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const transcript = document.getElementById('transcript');
	const emptyState = document.getElementById('empty-state');
	const composer = document.getElementById('composer');
	const sendButton = document.getElementById('send');
	const stopButton = document.getElementById('stop');
	const newChatButton = document.getElementById('new-chat');
	const modelButton = document.getElementById('model-button');
	const modelLabel = document.getElementById('model-label');
	const statusDot = document.getElementById('status-dot');
	const contextBar = document.getElementById('context-bar');
	const historyButton = document.getElementById('history-button');
	const historyPanel = document.getElementById('history-panel');
	const historyList = document.getElementById('history-list');
	const historyEmpty = document.getElementById('history-empty');
	const historyClose = document.getElementById('history-close');
	const activity = document.getElementById('activity');
	const activityLabel = document.getElementById('activity-label');
	const activityMeta = document.getElementById('activity-meta');
	const capabilityHint = document.getElementById('capability-hint');
	const capabilityHintText = document.getElementById('capability-hint-text');
	const restricted = document.getElementById('restricted');
	const trustButton = document.getElementById('trust-button');


	/** Set from the status message. Editing files is unavailable while this is false. */
	let trusted = true;
	/** Live activity state. The clock ticks here so the extension only posts phase changes. */
	let activityState = null;
	let activityTimer = null;
	let tokenCount = 0;

	let busy = false;
	/** Element currently receiving streamed text, and its raw markdown source. */
	let streamTarget = null;
	let streamRaw = '';
	let renderQueued = false;

	/* ---------------------------------------------------------------- escaping */

	function escapeHtml(text) {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	/* -------------------------------------------------------------- markdown */

	function renderInline(text) {
		// Operates on already-escaped text, so no markup can be injected here.
		return text
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
			.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
	}

	function renderProse(block) {
		const lines = block.split('\n');
		const html = [];
		let listType = null;

		const closeList = () => {
			if (listType) {
				html.push(`</${listType}>`);
				listType = null;
			}
		};

		for (const rawLine of lines) {
			const line = rawLine.trimEnd();

			if (!line.trim()) {
				closeList();
				continue;
			}

			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			if (heading) {
				closeList();
				const level = Math.min(6, heading[1].length + 2);
				html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
				continue;
			}

			const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
			if (bullet) {
				if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
				html.push(`<li>${renderInline(escapeHtml(bullet[1]))}</li>`);
				continue;
			}

			const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
			if (numbered) {
				if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
				html.push(`<li>${renderInline(escapeHtml(numbered[1]))}</li>`);
				continue;
			}

			closeList();
			html.push(`<p>${renderInline(escapeHtml(line))}</p>`);
		}

		closeList();
		return html.join('');
	}

	function renderMarkdown(text) {
		const html = [];
		// Splitting on fences also matches an unterminated final fence, so a code block
		// renders as a code block while it is still streaming rather than as prose.
		const pattern = /```([\w+-]*)\n([\s\S]*?)(?:```|$)/g;
		let cursor = 0;
		let match;

		while ((match = pattern.exec(text)) !== null) {
			if (match.index > cursor) {
				html.push(renderProse(text.slice(cursor, match.index)));
			}
			const language = match[1] || 'text';
			const code = match[2];
			html.push(
				'<div class="code-block">' +
					'<div class="code-head">' +
						`<span>${escapeHtml(language)}</span>` +
						'<span style="flex:1"></span>' +
						'<button class="code-action" data-action="apply">Apply</button>' +
						'<button class="code-action" data-action="copy">Copy</button>' +
					'</div>' +
					`<pre><code>${escapeHtml(code)}</code></pre>` +
				'</div>'
			);
			cursor = pattern.lastIndex;
		}

		if (cursor < text.length) {
			html.push(renderProse(text.slice(cursor)));
		}
		return html.join('');
	}

	/* ------------------------------------------------------------------- DOM */

	function hideEmptyState() {
		if (emptyState) {
			emptyState.hidden = true;
		}
	}

	function atBottom() {
		return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
	}

	function scrollToBottom(force) {
		if (force || atBottom()) {
			transcript.scrollTop = transcript.scrollHeight;
		}
	}

	function addTurn(role, label) {
		hideEmptyState();
		const turn = document.createElement('div');
		turn.className = `turn ${role}`;

		const roleTag = document.createElement('div');
		roleTag.className = 'role';
		roleTag.textContent = label;
		turn.appendChild(roleTag);

		const bubble = document.createElement('div');
		bubble.className = 'bubble';
		turn.appendChild(bubble);

		transcript.appendChild(turn);
		scrollToBottom(true);
		return bubble;
	}

	function addBanner(kind, message) {
		hideEmptyState();
		const banner = document.createElement('div');
		banner.className = kind;
		banner.textContent = message;
		transcript.appendChild(banner);
		scrollToBottom(true);
	}

	const APPROVAL_ICON = { edit: '\u270E', create: '\uFF0B', overwrite: '\u21BB', command: '\u25B6' };

	/**
	 * Renders an approval card. The buttons post the request id back; nothing else can
	 * satisfy the gate, which is why this replaced the old modal dialog.
	 */
	function addApproval(request) {
		hideEmptyState();
		const card = document.createElement('div');
		card.className = 'approval';
		card.dataset.id = request.id;

		const head = document.createElement('div');
		head.className = 'approval-head';
		const icon = document.createElement('span');
		icon.className = 'approval-icon';
		icon.textContent = APPROVAL_ICON[request.kind] || '?';
		head.appendChild(icon);
		const title = document.createElement('span');
		title.className = request.kind === 'command' ? 'approval-title mono' : 'approval-title';
		title.textContent = request.title;
		head.appendChild(title);
		card.appendChild(head);

		if (request.detail) {
			const detail = document.createElement('div');
			detail.className = 'approval-detail';
			detail.textContent = request.detail;
			card.appendChild(detail);
		}

		const actions = document.createElement('div');
		actions.className = 'approval-actions';

		const accept = document.createElement('button');
		accept.className = 'approve';
		accept.textContent = 'Accept';
		accept.dataset.approve = '1';
		actions.appendChild(accept);

		const reject = document.createElement('button');
		reject.className = 'reject';
		reject.textContent = 'Reject';
		reject.dataset.approve = '0';
		actions.appendChild(reject);

		if (request.hasDiff) {
			const reveal = document.createElement('button');
			reveal.className = 'approval-link';
			reveal.textContent = 'View diff';
			reveal.dataset.reveal = '1';
			actions.appendChild(reveal);
		}

		card.appendChild(actions);
		transcript.appendChild(card);
		scrollToBottom(true);
		accept.focus();
		return card;
	}

	function settleApproval(card, approved) {
		const actions = card.querySelector('.approval-actions');
		if (actions) {
			actions.remove();
		}
		card.classList.add(approved ? 'accepted' : 'rejected');
		const status = document.createElement('div');
		status.className = 'approval-status';
		status.textContent = approved ? 'Accepted' : 'Rejected';
		card.appendChild(status);
	}

	function addTrace(text, failed) {
		hideEmptyState();
		const trace = document.createElement('div');
		trace.className = failed ? 'trace failed' : 'trace';
		trace.textContent = text;
		transcript.appendChild(trace);
		scrollToBottom();
		return trace;
	}

	/**
	 * The whole-turn undo card. Rendered once per agent run that changed files; the button is
	 * disabled the moment it is used, because a second Restore would revert the user's own
	 * work done since the first one.
	 */
	function addCheckpoint(message) {
		hideEmptyState();
		const card = document.createElement('div');
		card.className = 'checkpoint-card';
		card.dataset.checkpointId = message.id;

		const title = document.createElement('div');
		title.className = 'checkpoint-title';
		title.textContent = `Checkpoint — ${message.files.length} file(s) changed`;
		card.appendChild(title);

		const files = document.createElement('div');
		files.className = 'checkpoint-files';
		files.textContent = message.files.join(', ');
		card.appendChild(files);

		const actions = document.createElement('div');
		actions.className = 'checkpoint-actions';
		const restore = document.createElement('button');
		restore.textContent = 'Restore';
		restore.title = 'Revert every file this agent turn changed';
		restore.addEventListener('click', () => {
			restore.disabled = true;
			restore.textContent = 'Restoring…';
			vscode.postMessage({ type: 'restoreCheckpoint', id: message.id });
		});
		actions.appendChild(restore);
		card.appendChild(actions);

		transcript.appendChild(card);
		scrollToBottom();
	}

	function markCheckpointRestored(id, text, ok) {
		const card = transcript.querySelector(`[data-checkpoint-id="${id}"]`);
		if (!card) {
			return;
		}
		const actions = card.querySelector('.checkpoint-actions');
		if (actions) {
			actions.textContent = '';
		}
		const status = document.createElement('div');
		status.className = ok ? 'checkpoint-status' : 'checkpoint-status failed';
		status.textContent = text;
		card.appendChild(status);
	}

	function renderSessions(sessions, currentId) {
		historyList.textContent = '';
		const items = sessions || [];
		historyEmpty.hidden = items.length > 0;

		for (const session of items) {
			const row = document.createElement('li');
			if (session.id === currentId) {
				row.className = 'current';
			}

			const open = document.createElement('button');
			open.className = 'session-open';
			open.title = 'Reopen this conversation';
			const name = document.createElement('span');
			name.className = 'session-title';
			name.textContent = session.title;
			const meta = document.createElement('span');
			meta.className = 'session-meta';
			meta.textContent = `${session.messageCount} msg · ${relativeTime(session.updatedAt)}`;
			open.appendChild(name);
			open.appendChild(meta);
			open.addEventListener('click', () => {
				vscode.postMessage({ type: 'loadSession', id: session.id });
				toggleHistory(false);
			});

			const remove = document.createElement('button');
			remove.className = 'session-delete';
			remove.textContent = '×';
			remove.title = 'Delete this conversation';
			remove.addEventListener('click', event => {
				event.stopPropagation();
				vscode.postMessage({ type: 'deleteSession', id: session.id });
			});

			row.appendChild(open);
			row.appendChild(remove);
			historyList.appendChild(row);
		}
	}

	function relativeTime(timestamp) {
		const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
		if (seconds < 60) {
			return 'just now';
		}
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) {
			return `${minutes}m ago`;
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return `${hours}h ago`;
		}
		return `${Math.round(hours / 24)}d ago`;
	}

	function toggleHistory(open) {
		const show = open === undefined ? historyPanel.hidden : open;
		historyPanel.hidden = !show;
		historyButton.setAttribute('aria-expanded', String(show));
		if (show) {
			vscode.postMessage({ type: 'listSessions' });
		}
	}

	/*
	 * There was a Chat/Agent switch here, and two rounds of making it clearer did not fix it.
	 *
	 * First the only signals were a pill in the header and the composer placeholder, and the
	 * placeholder disappears the moment you type - so after one character nothing on screen said
	 * whether Send would answer a question or edit your files. Stating the mode permanently above
	 * the composer fixed that, and the switch was still the thing people asked about, because the
	 * problem was never the label. It was being asked to choose at all.
	 *
	 * So the choice moved into routing.ts and the switch is gone. What remains here is a standing
	 * statement of what the panel can do, and a "Retry with tools" button on any answer where the
	 * router may have guessed wrong.
	 */
	/*
	 * Restricted Mode, said once and kept on screen.
	 *
	 * The old behaviour was that the whole panel simply did not exist in an untrusted folder -
	 * the extension declared `untrustedWorkspaces.supported: false`, so it never activated and the
	 * side bar showed an empty pane with nothing to click and nothing to read. Answering needs no
	 * tools, so it works here; editing files and running commands does not. Saying which is
	 * which, with the fix one click away, is the whole point.
	 */
	function paintTrust() {
		restricted.hidden = trusted;
		paintCapability();
	}

	/*
	 * There is no mode to report any more, so this line answers the question the mode readout was
	 * really there to answer: can this thing change my files, yes or no. It states a standing fact
	 * about the workspace rather than a setting the user has to track, and it cannot vanish the way
	 * the composer placeholder did.
	 */
	function paintCapability() {
		capabilityHint.dataset.trusted = String(trusted);
		// Kept short enough to survive a narrow side bar without the ellipsis eating the half that
		// matters. The full sentence is on the title attribute.
		capabilityHintText.textContent = trusted
			? 'Answers questions · edits files only after a diff'
			: 'Answers only — folder not trusted, cannot edit files';
		capabilityHint.title = trusted
			? 'Ask a question and PSCode answers. Tell it to change something and it reads, edits and '
				+ 'runs commands - every change shown as a diff with Accept/Reject first, and the whole '
				+ 'run revertable from its checkpoint. You do not pick which; PSCode reads it from what you typed.'
			: 'This folder is not trusted, so PSCode can only answer. Trust it to allow edits.';
	}

	/* -------------------------------------------------------------- activity */

	/*
	 * On CPU-only inference the first token can be minutes away. Without a running clock and a
	 * phase name, a working editor and a hung one look identical - which is the single most
	 * confusing thing about a local model. So the strip always answers two questions: what is
	 * happening, and for how long.
	 */

	function showActivity(message) {
		activityState = { phase: message.phase, label: message.label, detail: message.detail, since: Date.now() };
		if (message.phase !== 'writing') {
			tokenCount = 0;
		}
		activity.hidden = false;
		paintActivity();
		if (!activityTimer) {
			activityTimer = setInterval(paintActivity, 1000);
		}
	}

	function hideActivity() {
		activityState = null;
		tokenCount = 0;
		if (activityTimer) {
			clearInterval(activityTimer);
			activityTimer = null;
		}
		activity.hidden = true;
		activityLabel.textContent = '';
		activityMeta.textContent = '';
	}

	function formatElapsed(ms) {
		const total = Math.floor(ms / 1000);
		const minutes = Math.floor(total / 60);
		const seconds = total % 60;
		return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
	}

	function paintActivity() {
		if (!activityState) {
			return;
		}
		const elapsed = Date.now() - activityState.since;
		activityLabel.textContent = activityState.label;

		const parts = [formatElapsed(elapsed)];
		if (activityState.detail) {
			parts.push(activityState.detail);
		}
		if (activityState.phase === 'writing' && tokenCount > 0) {
			const perSecond = tokenCount / Math.max(1, elapsed / 1000);
			parts.push(`~${tokenCount} tok`);
			parts.push(`${perSecond.toFixed(1)} tok/s`);
		}
		// A local model really can take this long on first token; say so rather than let the
		// user conclude it has hung.
		if ((activityState.phase === 'waiting' || activityState.phase === 'thinking') && elapsed > 30000) {
			parts.push('CPU inference is slow to start — still working');
		}
		activityMeta.textContent = parts.join(' · ');

		activity.dataset.phase = activityState.phase;
	}

	/** Batches re-renders to one per frame; streaming deltas arrive faster than paint. */
	function queueRender() {
		if (renderQueued || !streamTarget) {
			return;
		}
		renderQueued = true;
		requestAnimationFrame(() => {
			renderQueued = false;
			if (streamTarget) {
				const stick = atBottom();
				streamTarget.innerHTML = renderMarkdown(streamRaw);
				if (stick) {
					transcript.scrollTop = transcript.scrollHeight;
				}
			}
		});
	}

	function setBusy(value) {
		busy = value;
		sendButton.hidden = value;
		stopButton.hidden = !value;
		composer.disabled = false; // Let the user keep typing the next question.
	}

	/*
	 * The recovery path for a message the router read as a question when it was a task.
	 *
	 * Rendered after the answer, not instead of it: on this hardware the answer arrives in about
	 * 11s and a tool run takes minutes, so withholding the fast reply to be safe would cost every
	 * correctly-routed question a minute. The prompt is carried on the button rather than re-read
	 * from the composer, which by now holds whatever the user typed next.
	 *
	 * Only one offer is kept on screen - the previous one is dropped when a new answer lands, so
	 * the transcript does not accumulate stale buttons pointing at old questions.
	 */
	function addToolsOffer(text) {
		for (const stale of transcript.querySelectorAll('.tools-offer')) {
			stale.remove();
		}
		const row = document.createElement('div');
		row.className = 'tools-offer';
		const button = document.createElement('button');
		button.className = 'link';
		button.textContent = '\u27f3 Retry with tools';
		button.title = 'Send this again and let PSCode read and edit files. Slower, and every change '
			+ 'is shown as a diff you accept or reject.';
		button.addEventListener('click', () => {
			row.remove();
			send(text, 'work');
		});
		row.appendChild(button);
		transcript.appendChild(row);
		scrollToBottom();
	}

	/* -------------------------------------------------------------- outgoing */

	function send(text, forceRoute) {
		const body = (text ?? composer.value).trim();
		if (!body || busy) {
			return;
		}
		if (text === undefined) {
			composer.value = '';
		}
		vscode.postMessage({ type: 'send', text: body, forceRoute });
	}

	sendButton.addEventListener('click', () => send());
	stopButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
	newChatButton.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
	modelButton.addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));
	historyButton.addEventListener('click', () => toggleHistory());
	historyClose.addEventListener('click', () => toggleHistory(false));

	composer.addEventListener('keydown', event => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	});

	trustButton.addEventListener('click', () => vscode.postMessage({ type: 'manageTrust' }));

	// Delegated so buttons inside streamed markdown work without rebinding on every frame.
	transcript.addEventListener('click', event => {
		// Approval buttons first: they gate real changes to the user's files.
		const approvalButton = event.target.closest('.approval-actions button');
		if (approvalButton) {
			const card = approvalButton.closest('.approval');
			if (!card) {
				return;
			}
			if (approvalButton.dataset.reveal) {
				vscode.postMessage({ type: 'revealDiff' });
				return;
			}
			const approved = approvalButton.dataset.approve === '1';
			vscode.postMessage({ type: 'approvalResponse', id: card.dataset.id, approved });
			settleApproval(card, approved);
			return;
		}

		const button = event.target.closest('.code-action');
		if (!button) {
			return;
		}
		const block = button.closest('.code-block');
		const code = block ? block.querySelector('pre code').textContent : '';
		if (!code) {
			return;
		}
		if (button.dataset.action === 'apply') {
			vscode.postMessage({ type: 'apply', code });
		} else {
			navigator.clipboard.writeText(code).then(() => {
				const original = button.textContent;
				button.textContent = 'Copied';
				setTimeout(() => { button.textContent = original; }, 1200);
			});
		}
	});

	/* -------------------------------------------------------------- incoming */

	window.addEventListener('message', event => {
		const message = event.data;

		switch (message.type) {
			case 'status':
				modelLabel.textContent = `${message.model} · ${message.provider}`;
				modelButton.title = `${message.provider} at ${message.endpoint}\nClick to change model`;
				statusDot.className = 'dot ok';
				trusted = message.trusted !== false;
				paintTrust();
				break;

			case 'userMessage': {
				const bubble = addTurn('user', 'You');
				bubble.textContent = message.text;
				break;
			}

			case 'assistantStart':
				streamRaw = '';
				streamTarget = addTurn('assistant', message.route === 'work'
					? 'PSCode AI · working in your files'
					: 'PSCode AI');
				streamTarget.classList.add('cursor');
				break;

			case 'assistantDelta':
				if (!streamTarget) {
					streamRaw = '';
					streamTarget = addTurn('assistant', 'PSCode AI');
				}
				streamRaw += message.text;
				queueRender();
				break;

			case 'assistantDone':
				if (streamTarget) {
					streamTarget.classList.remove('cursor');
					streamTarget.innerHTML = renderMarkdown(streamRaw);
					streamTarget = null;
					streamRaw = '';
				}
				scrollToBottom();
				break;

			case 'busy':
				setBusy(message.busy);
				break;

			case 'toolStart': {
				// A new tool call ends the current text bubble; the next text starts a fresh one.
				if (streamTarget) {
					streamTarget.classList.remove('cursor');
					streamTarget.innerHTML = renderMarkdown(streamRaw);
					streamTarget = null;
					streamRaw = '';
				}
				const trace = addTrace('', false);
				const name = document.createElement('span');
				name.className = 'tool-name';
				name.textContent = message.name;
				trace.appendChild(name);
				trace.appendChild(document.createTextNode(' running…'));
				break;
			}

			case 'approvalRequest':
				// End any in-flight text bubble so the card is not appended inside it.
				if (streamTarget) {
					streamTarget.classList.remove('cursor');
					streamTarget.innerHTML = renderMarkdown(streamRaw);
					streamTarget = null;
					streamRaw = '';
				}
				addApproval(message);
				break;

			case 'toolTrace':
				addTrace(message.line, false);
				break;

			case 'toolResult':
				addTrace(`${message.ok ? '✓' : '✗'} ${message.name}: ${message.summary.split('\n')[0]}`, !message.ok);
				break;

			case 'iteration':
				if (message.index > 1) {
					const marker = document.createElement('div');
					marker.className = 'iteration';
					marker.textContent = `— step ${message.index} of ${message.max} —`;
					transcript.appendChild(marker);
					scrollToBottom();
				}
				break;

			case 'agentDone':
				if (message.reason === 'cancelled') {
					addBanner('notice', 'Stopped.');
				}
				break;

			case 'contextChips':
				contextBar.textContent = '';
				if (message.files && message.files.length) {
					contextBar.hidden = false;
					const label = document.createElement('span');
					label.textContent = `context (~${message.approxTokens} tokens):`;
					contextBar.appendChild(label);
					for (const file of message.files) {
						const chip = document.createElement('span');
						chip.className = 'file-chip';
						chip.textContent = file;
						contextBar.appendChild(chip);
					}
				} else {
					contextBar.hidden = true;
				}
				break;

			case 'insertContext':
				composer.value = composer.value
					? `${composer.value.trimEnd()} @${message.label} `
					: `@${message.label} `;
				composer.focus();
				break;

			case 'focusInput':
				composer.focus();
				break;

			case 'activity':
				showActivity(message);
				break;

			case 'activityDone':
				hideActivity();
				break;

			case 'tokens':
				tokenCount = message.tokens;
				break;

			case 'checkpoint':
				addCheckpoint(message);
				break;

			case 'checkpointRestored':
				markCheckpointRestored(message.id, message.message, message.ok);
				break;

			case 'sessions':
				renderSessions(message.sessions, message.currentId);
				break;

			case 'offerTools':
				addToolsOffer(message.text);
				break;

			case 'notice':
				addBanner('notice', message.message);
				break;

			case 'error':
				statusDot.className = 'dot bad';
				addBanner('error', message.message);
				break;

			case 'cleared':
				hideActivity();
				transcript.textContent = '';
				if (emptyState) {
					transcript.appendChild(emptyState);
					emptyState.hidden = false;
				}
				contextBar.hidden = true;
				streamTarget = null;
				streamRaw = '';
				break;

			default:
				break;
		}
	});

	paintCapability();
	vscode.postMessage({ type: 'ready' });
	composer.focus();
})();
