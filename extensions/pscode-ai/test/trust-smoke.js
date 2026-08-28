/*---------------------------------------------------------------------------------------------
 *  PSCode AI - Restricted Mode smoke test
 *
 *  The bug this guards against was silence: with `untrustedWorkspaces.supported: false` the
 *  extension never activated in an untrusted folder, so the AI panel was not "disabled" - it did
 *  not exist. The side bar showed an empty pane with nothing to read and nothing to click, and
 *  the logs showed nothing at all, because an extension that never activates never logs.
 *
 *  So the assertions are about what an untrusted folder must still show: the panel renders, it
 *  says which mode it is in and why, Agent cannot be selected, and the way out is one click away.
 *  The last one matters most - a refusal with no route to trust is the same dead end as before.
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
  const agent = document.getElementById('mode-agent');
  return JSON.stringify({
    restrictedVisible: !restricted.hidden,
    notice: restricted.innerText.replace(/\\s+/g, ' ').trim(),
    agentDisabled: agent.disabled,
    agentTitle: agent.title,
    mode: document.getElementById('mode-hint-name').textContent,
    sendVerb: document.getElementById('send').textContent,
  });
`;

const CLICK_AGENT = `
  document.getElementById('mode-agent').click();
  return JSON.stringify({
    mode: document.getElementById('mode-hint-name').textContent,
    active: document.querySelector('.mode.active').dataset.mode,
  });
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
	check(state.agentDisabled, 'Agent mode cannot be selected');
	check(/trusted folder/.test(state.agentTitle), 'the Agent button says why', state.agentTitle);
	check(state.mode === 'CHAT', 'the mode line reads CHAT', state.mode);
	check(state.sendVerb === 'Send', 'the button keeps the chat verb', state.sendVerb);

	// A disabled button is a hint, not a guarantee. Clicking it must change nothing.
	const after = JSON.parse(await panel.eval(CLICK_AGENT));
	check(after.mode === 'CHAT' && after.active === 'chat',
		'clicking Agent while untrusted leaves the panel in Chat', `${after.mode}/${after.active}`);

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
