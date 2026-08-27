/*---------------------------------------------------------------------------------------------
 *  PSCode AI - UI driver
 *
 *  Minimal Chrome DevTools Protocol client for driving the AI panel, written because Playwright
 *  cannot be used here.
 *
 * `chromium.connectOverCDP()` auto-attaches to every target in the browser, and that includes
 * the webview's service worker. VS Code serves webview resources through that worker, so once
 * Playwright pauses it the panel goes blank - even if it had already rendered. The blanking is
 * caused by the debugger client, not by `--remote-debugging-port`: with the flag set and nothing
 * connected, the panel renders perfectly.
 *
 * So: attach only to the targets we actually need (the workbench page, and the webview iframe),
 * over their own WebSocket endpoints, and never touch the service worker.
 *
 *  Usage:
 *    ./scripts/code.sh --remote-debugging-port=9333 --user-data-dir=/tmp/pscode-uitest <folder>
 *    node extensions/pscode-ai/test/activity-smoke.js 9333
 *
 *  Test first-run behaviour with a throwaway --user-data-dir, or you are testing your own
 *  stored workbench state rather than what a new user sees.
 *--------------------------------------------------------------------------------------------*/

const CDP_TIMEOUT_MS = 20000;

async function listTargets(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	return response.json();
}

class Session {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		ws.addEventListener('message', event => {
			let message;
			try { message = JSON.parse(event.data); } catch { return; }
			const waiter = this.pending.get(message.id);
			if (!waiter) { return; }
			this.pending.delete(message.id);
			if (message.error) { waiter.reject(new Error(message.error.message)); } else { waiter.resolve(message.result); }
		});
	}

	static async open(wsUrl) {
		const ws = new WebSocket(wsUrl);
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve, { once: true });
			ws.addEventListener('error', () => reject(new Error(`could not open ${wsUrl}`)), { once: true });
		});
		return new Session(ws);
	}

	send(method, params = {}) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.delete(id)) { reject(new Error(`${method} timed out`)); }
			}, CDP_TIMEOUT_MS);
		});
	}

	/**
	 * Evaluates an expression in the target and returns it by value.
	 *
	 * When `contextId` is set, evaluation happens in that execution context - needed for the
	 * webview, whose real content lives in a nested frame rather than in the target itself.
	 */
	async eval(expression) {
		const result = await this.send('Runtime.evaluate', {
			expression: `(() => { ${expression} })()`,
			returnByValue: true,
			awaitPromise: true,
			...(this.contextId ? { contextId: this.contextId } : {}),
		});
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description || 'evaluate threw');
		}
		return result.result?.value;
	}

	/** A single keystroke. `text` is what a printable key inserts. */
	async key(key, { code, text, modifiers = 0 } = {}) {
		const base = { key, code: code || key, modifiers, windowsVirtualKeyCode: 0 };
		await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
		await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
	}

	async type(value) {
		for (const character of value) {
			await this.send('Input.insertText', { text: character });
			await sleep(12);
		}
	}

	close() { try { this.ws.close(); } catch { /* already gone */ } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The workbench window. */
async function attachWorkbench(port) {
	const targets = await listTargets(port);
	const page = targets.find(t => t.type === 'page' && (t.url || '').includes('workbench'));
	if (!page) { throw new Error('no workbench page target'); }
	return Session.open(page.webSocketDebuggerUrl);
}

/**
 * The AI panel's webview, or undefined while it has not been opened yet.
 *
 * The `vscode-webview://` target is only the host frame - its own document is empty and the
 * chat UI lives in a nested frame. So walk the frame tree, make an isolated world in each
 * child, and keep the one that can see the composer.
 */
async function attachPanel(port) {
	const targets = await listTargets(port);
	const frames = targets.filter(t => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview://'));

	for (const frame of frames) {
		const session = await Session.open(frame.webSocketDebuggerUrl);
		try {
			await session.send('Page.enable');
			await session.send('Runtime.enable');

			const { frameTree } = await session.send('Page.getFrameTree');
			const candidates = [frameTree, ...(frameTree.childFrames ?? [])];
			// Depth two is enough: host -> active-frame.
			for (const child of frameTree.childFrames ?? []) {
				candidates.push(...(child.childFrames ?? []));
			}

			for (const candidate of candidates) {
				const frameId = candidate.frame ? candidate.frame.id : candidate.id;
				let contextId;
				try {
					({ executionContextId: contextId } = await session.send('Page.createIsolatedWorld', {
						frameId,
						worldName: 'pscode-ui-test',
					}));
				} catch {
					continue; // frame went away between the tree and here
				}
				session.contextId = contextId;
				let hasComposer = false;
				try {
					hasComposer = await session.eval('return !!document.getElementById("composer")');
				} catch {
					hasComposer = false;
				}
				if (hasComposer) {
					return session;
				}
			}
		} catch {
			// try the next frame target
		}
		session.close();
	}
	return undefined;
}

/** Runs a command through the palette. Keyboard-driven, exactly as a user would. */
async function runCommand(workbench, command) {
	await workbench.key('P', { code: 'KeyP', modifiers: 2 | 8 }); // Ctrl+Shift+P
	await sleep(900);
	await workbench.type(command);
	await sleep(1200);
	await workbench.key('Enter');
	await sleep(1200);
}

/** Waits for the panel webview to be attachable, opening it if necessary. */
async function openPanel(port, workbench, seconds = 40) {
	let panel = await attachPanel(port);
	if (panel) { return panel; }
	await runCommand(workbench, 'PSCode: Open AI Chat');
	for (let i = 0; i < seconds; i++) {
		panel = await attachPanel(port);
		if (panel) { return panel; }
		await sleep(1000);
	}
	return undefined;
}

module.exports = { listTargets, Session, attachWorkbench, attachPanel, runCommand, openPanel, sleep };
