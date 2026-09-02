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

/*
 * Everything below drives the *workbench* rather than the panel webview: opening a file, moving
 * the cursor, selecting a range, reading toasts, clicking editor-title actions. It exists because
 * the parts of PSCode that touch the user's file - Ctrl+I and the Accept/Discard gate - live there,
 * and were the only features with no automated coverage.
 *
 * One rule throughout: never hand-write a string literal into an evaluated expression. Every needle
 * goes through `JSON.stringify`, because a quote or a bracket that survives Node but not the shell
 * produces a filter that silently matches nothing - which reads as "the feature is broken" and cost
 * three wrong diagnoses before it was noticed.
 */

/**
 * Gives the window a real click so it will accept keystrokes.
 *
 * Aimed at the editor area's centre when there is one, and at the workbench otherwise, so it never
 * lands on a control that does something.
 */
async function ensureFocus(workbench) {
	const point = await workbench.eval(`
		const target = document.querySelector('.editor-container, .monaco-workbench');
		if (!target) { return null; }
		const box = target.getBoundingClientRect();
		return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
	`);
	if (!point) { return; }
	const { x, y } = JSON.parse(point);
	const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
	await workbench.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
	await workbench.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
	await workbench.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
	await sleep(400);
}

/**
 * Every rendered editor line, in order, with whitespace normalised.
 *
 * The normalisation is the whole point. Monaco renders **every** space as U+00A0, so a line that
 * looks like `for (let i = 0; i <= n; i++)` contains no ASCII spaces at all - matching it against a
 * needle typed normally silently finds nothing. That produced three separate wrong diagnoses here
 * (a blamed `innerText`, then blamed shell quoting, then a blamed selector) before anyone printed
 * the character codes. If a match ever fails again, print them first.
 */
async function editorLines(workbench) {
	const json = await workbench.eval(`
		return JSON.stringify(Array.from(document.querySelectorAll('.view-line'))
			.map(line => (line.textContent || '').replace(/\u00a0/g, ' ')));
	`);
	return JSON.parse(json);
}

/**
 * Opens a file by name through quick-open.
 *
 * Deliberately not by clicking the explorer: the tree virtualises and scrolls, so a click target
 * depends on window height. Quick-open depends on the filename only.
 */
async function openFile(workbench, name, { timeoutSeconds = 20 } = {}) {
	/*
	 * Click the window first. A freshly launched workbench has not been interacted with, and the
	 * very first synthesised keystroke goes nowhere - so Ctrl+P was silently lost and the file
	 * never opened, which then surfaced as "saw 0 lines" from whatever looked at the editor next.
	 * Earlier runs only worked because something else (opening the AI panel) had clicked first.
	 */
	/*
	 * Retried as a whole, because the failure is silent and intermittent: quick-open either did not
	 * receive the keystroke or was dismissed, and the only symptom is an editor with no rendered
	 * lines - which the next call reports as "saw 0 lines", i.e. as if the file did not exist.
	 * Re-driving the sequence is cheap; diagnosing it from one attempt is not.
	 */
	for (let attempt = 1; attempt <= 3; attempt++) {
		await ensureFocus(workbench);
		await workbench.key('P', { code: 'KeyP', modifiers: 2 }); // Ctrl+P
		await sleep(900);

		const pickerOpen = await workbench.eval(`
			const box = document.querySelector('.quick-input-widget');
			return !!(box && box.style.display !== 'none' && box.querySelector('input'));
		`);
		if (!pickerOpen) {
			await sleep(1000);
			continue;
		}

		await workbench.type(name);
		await sleep(1300);
		await workbench.key('Enter');

		if (await waitFor(workbench, `
			const tabs = Array.from(document.querySelectorAll('.tab'))
				.map(tab => (tab.getAttribute('aria-label') || tab.textContent || ''));
			return tabs.some(label => label.includes(${JSON.stringify(name)}))
				&& document.querySelectorAll('.view-line').length > 0;
		`, { seconds: Math.max(4, Math.ceil(timeoutSeconds / 3)) })) {
			return true;
		}
	}
	return false;
}


/**
 * Puts the caret on the first line containing `needle`, and returns its 1-based line number.
 *
 * Uses Go to Line rather than a click. A click needs the line's bounding box, which is wrong the
 * moment the editor scrolls or the side bar resizes; a line number is a line number.
 */
async function placeCursor(workbench, needle, { timeoutSeconds = 15 } = {}) {
	// Retried, because a layout change - opening the AI panel, closing a diff - re-renders the
	// viewport, and a look taken mid-render sees no lines at all.
	let lines = [];
	let index = -1;
	for (let i = 0; i < timeoutSeconds; i++) {
		lines = await editorLines(workbench);
		index = lines.findIndex(line => line.includes(needle));
		if (index !== -1) { break; }
		await sleep(1000);
	}
	if (index === -1) {
		throw new Error(`no editor line contains ${JSON.stringify(needle)} (saw ${lines.length} lines)`);
	}
	const lineNumber = index + 1;

	await workbench.key('g', { code: 'KeyG', modifiers: 2 }); // Ctrl+G
	await sleep(700);
	await workbench.type(String(lineNumber));
	await sleep(600);
	await workbench.key('Enter');
	await sleep(600);
	return lineNumber;
}

/** Places the caret, then extends the selection down `count - 1` lines. */
async function selectLines(workbench, needle, count = 1) {
	const lineNumber = await placeCursor(workbench, needle);
	// Home first, so the selection starts at column 1 rather than wherever Go to Line landed.
	await workbench.key('Home');
	for (let i = 0; i < count; i++) {
		await workbench.key('ArrowDown', { modifiers: 8 }); // Shift+Down
	}
	await sleep(500);
	const selected = await workbench.eval(`
		return document.querySelectorAll('.monaco-editor .selected-text').length > 0;
	`);
	if (!selected) {
		throw new Error(`selection did not take on line ${lineNumber}`);
	}
	return lineNumber;
}

/** Notification toasts, newest first, whitespace collapsed. */
async function toasts(workbench) {
	const json = await workbench.eval(`
		return JSON.stringify(Array.from(document.querySelectorAll('.notification-toast'))
			.map(t => (t.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()));
	`);
	return JSON.parse(json);
}

/** True once a side-by-side diff editor is on screen. */
function diffIsOpen(workbench) {
	return workbench.eval(`return !!document.querySelector('.monaco-diff-editor');`);
}

/**
 * Clicks the first workbench control whose visible label or tooltip matches.
 *
 * Dispatches a real mouse event at the element's centre rather than calling `el.click()`.
 * `el.click()` looked like it worked - it returned the label it had found - but nothing happened,
 * because a VS Code editor-title action responds to pointer/mousedown and ignores a synthetic
 * click. The symptom was an Accept that reported success and applied nothing, which is exactly the
 * shape of bug this test exists to catch, so it must not come from the driver.
 *
 * Covers editor-title actions and notification buttons in one helper, because Accept and Discard
 * appear in both places.
 */
/*
 * Notification buttons are searched first, deliberately.
 *
 * A click on an editor-title action does not dispatch its command from here - proven, not guessed:
 * with logging on every path of acceptPendingEdit, clicking "PSCode: Accept AI Change" in the title
 * bar produced no log line at all, so the command never ran. The same click on the notification's
 * Accept works. Ordering the notification first means these helpers exercise a button that fires.
 *
 * (This note lives out here because a backtick inside an evaluated template literal ends it.)
 */
async function clickControl(workbench, pattern) {
	const found = await workbench.eval(`
		const re = new RegExp(${JSON.stringify(pattern)}, 'i');
		const controls = Array.from(document.querySelectorAll(
			'.notification-toast a, .notification-toast .monaco-button, .monaco-text-button, .monaco-button, a.action-label, li.action-item a'
		));
		const hit = controls.find(el => {
			const label = ((el.textContent || '') + ' ' + (el.title || '') + ' '
				+ (el.getAttribute('aria-label') || '')).replace(/\u00a0/g, ' ');
			if (!re.test(label)) { return false; }
			const box = el.getBoundingClientRect();
			return box.width > 0 && box.height > 0;   // an offscreen action cannot be clicked
		});
		if (!hit) { return null; }
		const box = hit.getBoundingClientRect();
		return JSON.stringify({
			label: (hit.textContent || hit.title || hit.getAttribute('aria-label') || 'control').trim(),
			x: Math.round(box.left + box.width / 2),
			y: Math.round(box.top + box.height / 2),
		});
	`);
	if (!found) { return undefined; }

	const { label, x, y } = JSON.parse(found);
	const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
	await workbench.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
	await workbench.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
	await workbench.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
	return label;
}

/**
 * Waits until a control matching `pattern` exists, and returns its label.
 *
 * This is the completion signal for an inline edit, and the diff editor is NOT: `runInlineEdit`
 * opens the diff *before* it streams, seeded with the unmodified file, so "a diff is open" is true
 * within a second of pressing Ctrl+I and says nothing about whether the model has finished. Waiting
 * on the diff instead of on Accept is what made an earlier version of this test look for a button
 * while the model was still producing its 39th character.
 */
async function waitForControl(workbench, pattern, { seconds = 300 } = {}) {
	for (let i = 0; i < seconds; i++) {
		const found = await workbench.eval(`
			const re = new RegExp(${JSON.stringify(pattern)}, 'i');
			// Same ordering as clickControl: the notification's button is the one that fires.
			const controls = Array.from(document.querySelectorAll(
				'.notification-toast a, .notification-toast .monaco-button, .monaco-text-button, .monaco-button, a.action-label, li.action-item a'
			));
			const hit = controls.find(el => re.test(
				((el.textContent || '') + ' ' + (el.title || '') + ' ' + (el.getAttribute('aria-label') || ''))
					.replace(/\u00a0/g, ' ')
			));
			return hit ? ((hit.textContent || hit.title || hit.getAttribute('aria-label') || 'control').trim()) : null;
		`);
		if (found) { return found; }
		await sleep(1000);
	}
	return undefined;
}

/** True while a progress notification is on screen - i.e. the model is still working. */
async function isWorking(workbench) {
	return workbench.eval(`
		return Array.from(document.querySelectorAll('.notification-toast'))
			.some(t => /rewriting your selection/i.test((t.textContent || '').replace(/\u00a0/g, ' ')));
	`);
}

/** Polls an expression in `session` until it is truthy. Returns false on timeout rather than throwing. */
async function waitFor(session, expression, { seconds = 60, intervalMs = 1000 } = {}) {
	for (let i = 0; i < seconds; i++) {
		if (await session.eval(expression)) { return true; }
		await sleep(intervalMs);
	}
	return false;
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

module.exports = {
	listTargets, Session, attachWorkbench, attachPanel, runCommand, openPanel, sleep,
	// workbench driving
	ensureFocus, editorLines, openFile, placeCursor, selectLines, toasts, diffIsOpen, clickControl, waitFor,
	waitForControl, isWorking,
};
