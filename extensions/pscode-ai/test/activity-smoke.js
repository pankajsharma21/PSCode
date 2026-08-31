/*---------------------------------------------------------------------------------------------
 *  PSCode AI - activity indicator smoke test
 *
 *  The point of the indicator is that a slow local model never looks hung, so the assertions are
 *  about the strip's phases and its clock: it must appear, name what is happening, count upwards
 *  on its own, and disappear when the turn ends.
 *
 *  Drives a real window over CDP (see ui-driver.js for why not Playwright) against a real model.
 *
 *  Usage - no daemon to start, the window brings up its own engine:
 *    ./scripts/code.sh --remote-debugging-port=9333 \
 *        --user-data-dir=/tmp/pscode-uitest --extensions-dir=/tmp/pscode-uitest-ext \
 *        --disable-workspace-trust <a small folder>
 *    node extensions/pscode-ai/test/activity-smoke.js 9333
 *
 *  Runs against whatever `pscode.ai.provider` is set to, so by default that is the bundled
 *  engine. It is slow, and the test is built to wait rather than to assume - see the sampling
 *  loops below.
 *--------------------------------------------------------------------------------------------*/
const { attachWorkbench, openPanel, sleep } = require('./ui-driver');

const PORT = Number(process.argv[2] || 9333);
const log = (...a) => console.log(...a);
let fails = 0;
const check = (ok, n, d) => { log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); if (!ok) fails++; };

const readStrip = `
  const el = document.getElementById('activity');
  return JSON.stringify({
    hidden: el.hidden,
    phase: el.dataset.phase || null,
    label: document.getElementById('activity-label').textContent,
    meta: document.getElementById('activity-meta').textContent,
  });
`;

/*
 * Polling misses short phases: on a three-file workspace the context build and a read_file both
 * finish inside any sane sampling interval. So record every activity message instead. An
 * isolated world shares the DOM but not the JS globals, so the log is parked on a data attribute.
 */
const INSTALL_RECORDER = `
  if (!window.__pscodeRecorderInstalled) {
    window.__pscodeRecorderInstalled = true;
    document.body.dataset.phaseLog = '[]';
    window.addEventListener('message', event => {
      const m = event.data;
      if (!m || (m.type !== 'activity' && m.type !== 'activityDone')) { return; }
      const log = JSON.parse(document.body.dataset.phaseLog || '[]');
      log.push(m.type === 'activityDone'
        ? { phase: 'done' }
        : { phase: m.phase, label: m.label, detail: m.detail });
      document.body.dataset.phaseLog = JSON.stringify(log);
    });
  }
  return true;
`;

const READ_RECORDER = `return document.body.dataset.phaseLog || '[]';`;
const RESET_RECORDER = `document.body.dataset.phaseLog = '[]'; return true;`;

(async () => {
	const wb = await attachWorkbench(PORT);
	const panel = await openPanel(PORT, wb);
	if (!panel) { log('FAIL: panel not attachable'); process.exit(1); }
	check(true, 'panel reachable, webview alive under the driver');

	await panel.eval(INSTALL_RECORDER);
	check(true, 'activity recorder installed');

	// Start from a known state so the test can be run repeatedly against the same window: it
	// ends in Agent mode, and a second run would otherwise open with an agent turn and never
	// see the chat-mode phases it asserts on.
	await panel.eval(`
	  document.getElementById('new-chat').click();
	  document.querySelector('.mode[data-mode="chat"]').click();
	  return true;
	`);
	await sleep(1000);
	await panel.eval(RESET_RECORDER);
	check(await panel.eval('return document.querySelector(".mode.active")?.dataset.mode === "chat"'),
		'reset to Chat mode before starting');

	/*
	 * The mode indicator is the fix for the one recurring confusion in this UI - after typing a
	 * character, it used to be the case that nothing on screen said whether Send would answer a
	 * question or edit your files. Assert it here so a future change cannot quietly remove it.
	 */
	const chatMode = JSON.parse(await panel.eval(`
	  document.getElementById('composer').value = 'fix the tax rounding bug';
	  return JSON.stringify({
	    hint: document.getElementById('mode-hint').innerText,
	    send: document.getElementById('send').textContent,
	  });
	`));
	check(/CHAT/.test(chatMode.hint) && /cannot edit/i.test(chatMode.hint),
		'Chat mode says it cannot edit, with text typed', chatMode.hint);
	check(chatMode.send === 'Send', 'Chat mode button reads "Send"', chatMode.send);

	const agentMode = JSON.parse(await panel.eval(`
	  document.querySelector('.mode[data-mode="agent"]').click();
	  return JSON.stringify({
	    hint: document.getElementById('mode-hint').innerText,
	    send: document.getElementById('send').textContent,
	  });
	`));
	check(/AGENT/.test(agentMode.hint) && /edits files/i.test(agentMode.hint),
		'Agent mode says it edits files', agentMode.hint);
	check(agentMode.send === 'Run task', 'Agent mode button reads "Run task"', agentMode.send);

	await panel.eval(`
	  document.querySelector('.mode[data-mode="chat"]').click();
	  document.getElementById('composer').value = '';
	  return true;
	`);
	await sleep(400);

	/* ---- the strip is invisible while idle ---- */
	let strip = JSON.parse(await panel.eval(readStrip));
	check(strip.hidden === true, 'strip is hidden when nothing is happening', JSON.stringify(strip));

	/* ---- send a question and watch the phases go by ---- */
	await panel.eval(`
	  const c = document.getElementById('composer');
	  c.value = 'In one short sentence, what does this project do?';
	  document.getElementById('send').click();
	  return true;
	`);
	log('sent a question; sampling the strip...');

	/*
	 * The exit condition is "a turn that started has now ended", not "the panel looks idle".
	 *
	 * Waiting a fixed few seconds and then trusting `!busy` raced the model: on CPU-only
	 * inference the Stop button has not appeared yet several seconds in, so the loop declared
	 * the turn over before it began and the run failed on a phase that simply had not happened.
	 * Measured on the bundled 3B engine, a first tool call took 51s. Requiring `busy` to have
	 * been true at least once removes the guess entirely - and costs nothing when the model is
	 * fast, because the loop still exits on the same tick the turn actually ends.
	 */
	const seen = [];
	let everBusy = false;
	for (let i = 0; i < 150; i++) {
		await sleep(1200);
		strip = JSON.parse(await panel.eval(readStrip));
		if (!strip.hidden && strip.phase && !seen.some(s => s.phase === strip.phase)) {
			seen.push({ phase: strip.phase, label: strip.label, meta: strip.meta });
			log(`   phase "${strip.phase}": ${strip.label}  [${strip.meta}]`);
		}
		const busy = await panel.eval('return !document.getElementById("stop").hidden');
		if (busy) { everBusy = true; }
		if (everBusy && !busy) break;
	}

	const recorded = JSON.parse(await panel.eval(READ_RECORDER));
	const phases = recorded.map(r => r.phase);
	log(`   recorded phases: ${JSON.stringify(phases)}`);

	check(seen.length > 0, 'the strip appeared during the turn', `${seen.length} distinct phase(s)`);
	check(phases.includes('context'), 'posted a "gathering context" phase', JSON.stringify(phases));
	check(phases.includes('waiting'), 'posted a "waiting for the model" phase');
	check(recorded.some(r => r.label && /waiting for/i.test(r.label)), 'the waiting label names the model',
		recorded.find(r => r.phase === 'waiting')?.label);
	check(phases[phases.length - 1] === 'done', 'the last thing posted is activityDone', JSON.stringify(phases.slice(-3)));

	/*
	 * The clock is tested directly rather than through a real turn: with a warm prompt the model
	 * can answer in under a second, so the waiting phase may never last long enough to sample
	 * twice. Feeding the webview a synthetic phase tests the thing that actually matters here -
	 * that the strip keeps counting on its own, without the extension posting anything.
	 */
	await panel.eval(`
	  window.postMessage({ type: 'activity', phase: 'waiting', label: 'Waiting for a slow model', detail: 'first token' }, '*');
	  return true;
	`);
	await sleep(600);
	const clock0 = JSON.parse(await panel.eval(readStrip));
	await sleep(3200);
	const clock1 = JSON.parse(await panel.eval(readStrip));
	await panel.eval(`window.postMessage({ type: 'activityDone' }, '*'); return true;`);

	const seconds = text => {
		const m = /(\d+)s/.exec(text || '');
		return m ? Number(m[1]) : -1;
	};
	check(clock0.hidden === false && clock1.hidden === false, 'synthetic phase showed the strip');
	check(seconds(clock1.meta) > seconds(clock0.meta),
		'the elapsed clock ticks upward on its own', `${clock0.meta}  ->  ${clock1.meta}`);
	check(/Waiting for a slow model/.test(clock1.label), 'the label is what was posted', clock1.label);

	check(phases.includes('writing'), 'posted a "writing" phase once tokens arrived');

	/*
	 * The rate is rendered synthetically for the same reason as the clock: polling can catch the
	 * writing phase in the instant before its first token message is processed, which made this
	 * assertion flaky against a fast model. The real turn above already proves the phase fires;
	 * this proves the strip renders a rate when told about tokens.
	 */
	await panel.eval(`
	  window.postMessage({ type: 'activity', phase: 'writing', label: 'Writing' }, '*');
	  for (let i = 1; i <= 42; i++) { window.postMessage({ type: 'tokens', tokens: i }, '*'); }
	  return true;
	`);
	await sleep(1400);
	const rate = JSON.parse(await panel.eval(readStrip));
	await panel.eval(`window.postMessage({ type: 'activityDone' }, '*'); return true;`);
	check(/~42 tok/.test(rate.meta), 'writing phase reports the token count', rate.meta);
	check(/tok\/s/.test(rate.meta), 'writing phase reports a token rate', rate.meta);

	/* ---- and it must clear itself when the turn is over ---- */
	await sleep(2500);
	strip = JSON.parse(await panel.eval(readStrip));
	check(strip.hidden === true, 'strip hides itself when the turn ends', JSON.stringify(strip));

	/* ---- agent mode: a tool call must be described in words ---- */
	await panel.eval(`
	  document.getElementById('new-chat').click();
	  return true;
	`);
	await sleep(1200);
	await panel.eval(RESET_RECORDER);
	await panel.eval(`
	  document.querySelector('.mode[data-mode="agent"]').click();
	  const c = document.getElementById('composer');
	  c.value = 'Read a source file in this workspace and tell me in one sentence what it does. Do not edit anything.';
	  document.getElementById('send').click();
	  return true;
	`);
	log('agent turn started; watching for a tool phase...');

	// Same exit condition as the chat loop above, and it matters more here: the agent's first
	// tool call is the slowest thing in the test, because it arrives only after the model has
	// read a prompt carrying all 11 tool definitions.
	const agentPhases = [];
	let agentEverBusy = false;
	for (let i = 0; i < 180; i++) {
		await sleep(1200);
		strip = JSON.parse(await panel.eval(readStrip));
		if (!strip.hidden && strip.phase && !agentPhases.some(s => s.phase === strip.phase && s.label === strip.label)) {
			agentPhases.push({ phase: strip.phase, label: strip.label, meta: strip.meta });
			log(`   phase "${strip.phase}": ${strip.label}  [${strip.meta}]`);
		}
		const busy = await panel.eval('return !document.getElementById("stop").hidden');
		if (busy) { agentEverBusy = true; }
		if (agentEverBusy && !busy) break;
	}

	const agentRecorded = JSON.parse(await panel.eval(READ_RECORDER));
	const agentPhaseNames = agentRecorded.map(r => r.phase);
	log(`   recorded phases: ${JSON.stringify(agentPhaseNames)}`);

	check(agentPhaseNames.includes('thinking'), 'agent posted a thinking phase',
		agentRecorded.find(r => r.phase === 'thinking')?.detail);
	const tool = agentRecorded.find(r => r.phase === 'tool');
	check(!!tool, 'agent posted a tool phase', tool ? `${tool.label} (${tool.detail})` : 'never');
	if (tool) {
		check(/Reading|Searching|Mapping|Finding|Checking|Listing|Editing|Writing|Running/i.test(tool.label),
			'the tool phase is phrased as an activity, not an API name', tool.label);
	}

	log(fails === 0 ? '\nAll activity-indicator checks passed.' : `\n${fails} check(s) FAILED.`);
	process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('driver threw:', e.message); process.exit(1); });
