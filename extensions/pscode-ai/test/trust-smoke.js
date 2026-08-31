/*---------------------------------------------------------------------------------------------
 *  PSCode AI - Restricted Mode smoke test
 *
 *  The bug this guards against was silence: with `untrustedWorkspaces.supported: false` the
 *  extension never activated in an untrusted folder, so the AI panel was not "disabled" - it did
 *  not exist. The side bar showed an empty pane with nothing to read and nothing to click, and
 *  the logs showed nothing at all, because an extension that never activates never logs.
 *
 *  So the assertions are about what an untrusted folder must still show: the panel renders, it
 *  says plainly that it cannot edit files and why, a task typed here is answered rather than
 *  thrown away, and the way out is one click. The last one matters most - a refusal with no route
 *  to trust is the same dead end as before.
 *
 *  Trust is deliberately NOT granted here. Granting it writes into
 *  `~/.pscode-shared/sharedStorage/state.vscdb`, which is shared across every profile and is not
 *  covered by --user-data-dir, so a test that trusts a folder cannot be run twice and cannot be
 *  cleaned up by deleting a throwaway profile.
 *
 *  Usage - the folder must be one that has never been trusted:
 *    ./scripts/code.sh --remote-debugging-port=9333 \
 *        --user-data-dir=/tmp/pscode-trusttest --extensions-dir=/tmp/pscode-trusttest-ext \
 *        /tmp/some-never-trusted-folder
 *    node extensions/pscode-ai/test/trust-smoke.js 9333
 *
 *  Passing --disable-workspace-trust (what `pscode --trust` does) makes every folder trusted and
 *  this test vacuous, so it refuses to run in that case.
 *--------------------------------------------------------------------------------------------*/
const { attachWorkbench, openPanel, runCommand, sleep } = require('./ui-driver');

const PORT = Number(process.argv[2] || 9333);
let fails = 0;
const check = (ok, name, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) { fails++; }
};

const READ_PANEL = `
  const restricted = document.getElementById('restricted');
  const hint = document.getElementById('capability-hint');
  return JSON.stringify({
    restrictedVisible: !restricted.hidden,
    notice: restricted.innerText.replace(/\\s+/g, ' ').trim(),
    hint: hint.innerText.replace(/\\s+/g, ' ').trim(),
    hintTrusted: hint.dataset.trusted,
    modeButtons: document.querySelectorAll('.mode').length,
    sendVerb: document.getElementById('send').textContent,
  });
`;

/*
 * Typing a task into an untrusted folder is the case that used to lose work: the send was refused
 * outright and the text was gone. It must now be answered instead, with a line saying why - so the
 * probe sends an instruction and reads back what the panel said about it.
 */
const SEND_A_TASK = `
  const c = document.getElementById('composer');
  c.value = 'fix the off-by-one bug in cart.ts';
  document.getElementById('send').click();
  return true;
`;

// addBanner() sets className to the kind itself, so these are the two classes it can produce.
const READ_BANNERS = `
  const els = Array.from(document.querySelectorAll('.notice, .error'));
  return els.map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join(' | ');
`;

(async () => {
	const workbench = await attachWorkbench(PORT);
	await workbench.send('Runtime.enable');

	const panel = await openPanel(PORT, workbench);
	// The headline assertion: in an untrusted folder the panel exists at all.
	check(!!panel, 'the AI panel renders in an untrusted folder');
	if (!panel) { process.exit(1); }

	const state = JSON.parse(await panel.eval(READ_PANEL));
	if (!state.restrictedVisible) {
		console.log('FAIL  this folder is already trusted, so the test proves nothing');
		console.log('      use a folder that has never been trusted, and do not pass --disable-workspace-trust');
		process.exit(1);
	}

	check(state.restrictedVisible, 'Restricted Mode is stated in the panel', state.notice);
	check(/Trust this folder/i.test(state.notice), 'the notice offers a one-click way out');
	check(state.modeButtons === 0, 'there is no mode switch to be disabled', `${state.modeButtons} found`);
	check(state.hintTrusted === 'false', 'the capability line knows the folder is untrusted', state.hintTrusted);
	check(/answers only/i.test(state.hint) && /not trusted/i.test(state.hint),
		'it says it can only answer, and why', state.hint);
	check(state.sendVerb === 'Send', 'one send verb, as everywhere else', state.sendVerb);

	/*
	 * The real guarantee is in the extension host, not in the panel: a task typed here must be
	 * answered rather than refused, and the reason must be on screen. This is the case that used
	 * to discard what the user had typed.
	 */
	await panel.eval(SEND_A_TASK);
	await sleep(2500);
	const banners = await panel.eval(READ_BANNERS);
	check(/trusted folder/i.test(banners), 'a task typed while untrusted explains itself', banners.slice(0, 120));
	check(/answering instead/i.test(banners), 'and is answered rather than thrown away', banners.slice(0, 120));

	// A trusted-only command must refuse out loud rather than doing nothing.
	await runCommand(workbench, 'PSCode: Edit Selection with AI');
	await sleep(1200);
	const toast = await workbench.eval(`
	  const els = Array.from(document.querySelectorAll('.notification-toast'));
	  return els.map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join(' | ');
	`);
	check(/needs a trusted folder/i.test(toast), 'Ctrl+I refuses with a reason', toast.slice(0, 90));
	check(/Manage Workspace Trust/i.test(toast), 'the refusal links to the trust editor');

	console.log(fails ? `\n${fails} failure(s)` : '\nall checks passed');
	process.exit(fails ? 1 : 0);
})().catch(error => {
	console.error('ERROR', error.message);
	process.exit(1);
});
