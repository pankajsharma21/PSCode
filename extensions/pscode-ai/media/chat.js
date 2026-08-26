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

	let mode = 'chat';
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

	function addTrace(text, failed) {
		hideEmptyState();
		const trace = document.createElement('div');
		trace.className = failed ? 'trace failed' : 'trace';
		trace.textContent = text;
		transcript.appendChild(trace);
		scrollToBottom();
		return trace;
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

	/* -------------------------------------------------------------- outgoing */

	function send() {
		const text = composer.value.trim();
		if (!text || busy) {
			return;
		}
		composer.value = '';
		vscode.postMessage({ type: 'send', text, mode });
	}

	sendButton.addEventListener('click', send);
	stopButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
	newChatButton.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
	modelButton.addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));

	composer.addEventListener('keydown', event => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	});

	for (const button of document.querySelectorAll('.mode')) {
		button.addEventListener('click', () => {
			mode = button.dataset.mode;
			for (const other of document.querySelectorAll('.mode')) {
				const active = other === button;
				other.classList.toggle('active', active);
				other.setAttribute('aria-checked', String(active));
			}
			composer.placeholder = mode === 'agent'
				? 'Describe a task — PSCode AI will read and edit files…'
				: 'Ask about your code…  (Enter to send, Shift+Enter for a new line)';
		});
	}

	// Delegated so buttons inside streamed markdown work without rebinding on every frame.
	transcript.addEventListener('click', event => {
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
				break;

			case 'userMessage': {
				const bubble = addTurn('user', 'You');
				bubble.textContent = message.text;
				break;
			}

			case 'assistantStart':
				streamRaw = '';
				streamTarget = addTurn('assistant', message.mode === 'agent' ? 'PSCode AI · agent' : 'PSCode AI');
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

			case 'notice':
				addBanner('notice', message.message);
				break;

			case 'error':
				statusDot.className = 'dot bad';
				addBanner('error', message.message);
				break;

			case 'cleared':
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

	vscode.postMessage({ type: 'ready' });
	composer.focus();
})();
