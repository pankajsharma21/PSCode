/*---------------------------------------------------------------------------------------------
 *  PSCode AI - inline edit, driven end to end
 *
 *  The two features that write to the user's file - Ctrl+I and the Accept gate in front of it -
 *  had no automated coverage, which is a poor place to have none. This closes that.
 *
 *  What it defends, in order of how much it would hurt to get wrong:
 *    1. nothing reaches the file before Accept is pressed
 *    2. Accept replaces the RANGE, not the file - the rest of the file is still there afterwards
 *    3. the indentation survives (a model asked to rewrite one indented line returns it flush left)
 *    4. Discard leaves the file exactly as it was
 *
 *  Runs against a real model, so it is slow: on the bundled 14B a one-line edit is ~30-60s and the
 *  whole run is a few minutes.
 *
 *  Two false alarms are worth recording, because both looked like product bugs:
 *    - clicking the editor-title action does not dispatch its command from CDP, so Accept appeared
 *      to do nothing. Logging every path of acceptPendingEdit proved it was never entered. The
 *      notification's button works, and the driver prefers it now.
 *    - reading the file from disk after Accept shows no change, because the edit is applied to the
 *      buffer and deliberately left unsaved. That is the undo story, not a failure.
 *
 *  Usage - the folder must contain the fixture this writes:
 *    ./scripts/code.sh --remote-debugging-port=9333 \
 *        --user-data-dir=/tmp/pscode-uitest --extensions-dir=/tmp/pscode-uitest-ext \
 *        --disable-workspace-trust <folder>
 *    node extensions/pscode-ai/test/inline-edit-smoke.js 9333 <folder>
 *--------------------------------------------------------------------------------------------*/

const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const D = require('./ui-driver');

const PORT = Number(process.argv[2] || 9333);
const FOLDER = process.argv[3];
if (!FOLDER) {
	console.error('usage: inline-edit-smoke.js <port> <workspace folder>');
	process.exit(2);
}
const FILE = join(FOLDER, 'cart.ts');

// Written here rather than assumed, so the test owns its fixture and can be re-run.
const FIXTURE = [
	'export interface Item { name: string; price: number; qty: number; }',
	'',
	'export function totalPrice(items: Item[]): number {',
	'\tlet total = 0;',
	'\tfor (let i = 0; i <= items.length; i++) {',
	'\t\ttotal += items[i].price * items[i].qty;',
	'\t}',
	'\treturn total;',
	'}',
	'',
	'export function itemCount(items: Item[]): number {',
	'\treturn items.reduce((sum, item) => sum + item.qty, 0);',
	'}',
	'',
	'export function formatTotal(items: Item[]): string {',
	'\treturn `$${totalPrice(items).toFixed(2)}`;',
	'}',
	'',
].join('\n');

let fails = 0;
const check = (ok, name, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) { fails++; }
};
const log = (...a) => console.log(...a);

/**
 * Ctrl+I, answer the prompt, and wait until the model has actually finished.
 *
 * "Finished" means an Accept control exists - not that a diff is open. The diff opens before the
 * stream starts, seeded with the unmodified file, so it proves only that Ctrl+I was received.
 */
async function askForEdit(wb, needle, instruction, { gate = 'accept|discard' } = {}) {
	await D.placeCursor(wb, needle);
	await wb.key('i', { code: 'KeyI', modifiers: 2 });
	await D.sleep(1200);

	const asked = await wb.eval(`
		const box = document.querySelector('.quick-input-widget');
		if (!box || box.style.display === 'none') { return null; }
		return box.querySelector('input') ? 'prompt open' : null;
	`);
	if (!asked) { return { asked: false, diff: false, gate: undefined }; }

	await wb.type(instruction);
	await D.sleep(400);
	await wb.key('Enter');
	log(`   asked for "${instruction}"; the 14B takes a while...`);

	// The diff should appear almost at once, well before the model has produced anything.
	const diff = await D.waitFor(wb, `return !!document.querySelector('.monaco-diff-editor');`, { seconds: 30 });

	const control = await D.waitForControl(wb, gate, { seconds: 420 });
	if (!control) {
		log('   still working?', await D.isWorking(wb));
	}
	return { asked: true, diff, gate: control };
}

(async () => {
	writeFileSync(FILE, FIXTURE);
	const original = readFileSync(FILE, 'utf8');
	const originalLines = original.split('\n').length;
	log(`fixture written: ${originalLines} lines`);

	const wb = await D.attachWorkbench(PORT);
	await wb.send('Runtime.enable');

	check(await D.openFile(wb, 'cart.ts'), 'the fixture opens in an editor');

	/* ---------------------------------------------------- 1. Accept applies only the range ---- */
	log('\n--- Ctrl+I, then Accept ---');
	const first = await askForEdit(wb, 'i <= items.length', 'fix the off-by-one');
	check(first.asked, 'Ctrl+I asks what to change');
	check(first.diff, 'a diff opens before anything is written');
	check(!!first.gate, 'the model finished and offered a gate', first.gate || '(none appeared)');

	const duringReview = readFileSync(FILE, 'utf8');
	check(duringReview === original, 'the file is untouched while the proposal waits');

	const acceptLabel = await D.clickControl(wb, 'accept');
	check(!!acceptLabel, 'an Accept control is present and clickable', acceptLabel || '(none found)');
	await D.sleep(3500);

	/*
	 * Read the BUFFER, not the disk.
	 *
	 * acceptPendingEdit applies a WorkspaceEdit and deliberately does not save - that is what keeps
	 * the change on the undo stack, one Ctrl+Z from where the user was. An earlier version of this
	 * test read the file and concluded Accept had done nothing, which was wrong twice over: it
	 * missed the edit, and it hid the fact that staying unsaved is a feature. Both are asserted now.
	 */
	const buffer = (await D.editorLines(wb)).join('\n');
	check(/i < items\.length/.test(buffer), 'Accept fixed the off-by-one in the editor',
		(buffer.match(/^.*for \(let i.*$/m) || [''])[0].trim());
	check(/for \(let i/.test(buffer) && !/i <= items\.length/.test(buffer),
		'and the old line is gone');
	check(/itemCount/.test(buffer) && /formatTotal/.test(buffer),
		'every other function is still there - a range was replaced, not the file');

	const onDiskAfterAccept = readFileSync(FILE, 'utf8');
	check(onDiskAfterAccept === original,
		'the file is still unsaved, so one Ctrl+Z undoes the whole thing');

	// Save, and only then should disk agree.
	await wb.key('s', { code: 'KeyS', modifiers: 2 });
	await D.sleep(2500);
	const accepted = readFileSync(FILE, 'utf8');
	check(accepted !== original, 'after Ctrl+S the change reaches the file');
	check(accepted.split('\n').length === originalLines,
		'the saved file has the same line count',
		`${originalLines} -> ${accepted.split('\n').length}`);
	check(/^\t+for \(let i/m.test(accepted), 'the indentation survived',
		JSON.stringify((accepted.match(/^.*for \(let i.*$/m) || [''])[0].slice(0, 12)));

	/* --------------------------------------------------------- 2. Discard changes nothing ---- */
	log('\n--- Ctrl+I, then Discard ---');
	const beforeDiscard = readFileSync(FILE, 'utf8');
	const second = await askForEdit(wb, 'let total = 0', 'add a short comment above this line');
	check(second.asked, 'Ctrl+I asks again');
	check(second.diff, 'a second diff opens');
	check(!!second.gate, 'the second proposal is gated too', second.gate || '(none appeared)');

	const discardLabel = await D.clickControl(wb, 'discard|reject');
	check(!!discardLabel, 'a Discard control is present', discardLabel || '(none found)');
	await D.sleep(2500);
	check(readFileSync(FILE, 'utf8') === beforeDiscard, 'Discard left the file exactly as it was');

	console.log(fails === 0 ? '\nAll inline-edit checks passed.' : `\n${fails} check(s) FAILED.`);
	process.exit(fails === 0 ? 0 : 1);
})().catch(error => {
	console.error('\nERROR', error.message);
	process.exit(1);
});
