/*---------------------------------------------------------------------------------------------
 *  PSCode AI - activity indicator smoke test
 *
 *  The point of the indicator is that a slow local model never looks hung, so the assertions are
 *  about the strip's phases and its clock: it must appear, name what is happening, count upwards
 *  on its own, and disappear when the turn ends.
 *
 *  Drives a real window over CDP (see ui-driver.js for why not Playwright) against a real model.
 *
 *  Usage:
 *    ollama serve &
 *    ./scripts/code.sh --remote-debugging-port=9333 \
 *        --user-data-dir=/tmp/pscode-uitest --extensions-dir=/tmp/pscode-uitest-ext \
 *        --disable-workspace-trust <a small folder>
 *    node extensions/pscode-ai/test/activity-smoke.js 9333
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

	const seen = [];
	for (let i = 0; i < 150; i++) {
		await sleep(1200);
		strip = JSON.parse(await panel.eval(readStrip));
		if (!strip.hidden && strip.phase && !seen.some(s => s.phase === strip.phase)) {
			seen.push({ phase: strip.phase, label: strip.label, meta: strip.meta });
			log(`   phase "${strip.phase}": ${strip.label}  [${strip.meta}]`);
		}
		const busy = await panel.eval('return !document.getElementById("stop").hidden');
		if (!busy && i > 3) break;
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

	const writing = seen.find(s => s.phase === 'writing');
	check(phases.includes('writing'), 'posted a "writing" phase once tokens arrived');
	if (writing) {
		check(/tok/.test(writing.meta), 'writing phase reports a token rate', writing.meta);
	}

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

	const agentPhases = [];
	for (let i = 0; i < 180; i++) {
		await sleep(1200);
		strip = JSON.parse(await panel.eval(readStrip));
		if (!strip.hidden && strip.phase && !agentPhases.some(s => s.phase === strip.phase && s.label === strip.label)) {
			agentPhases.push({ phase: strip.phase, label: strip.label, meta: strip.meta });
			log(`   phase "${strip.phase}": ${strip.label}  [${strip.meta}]`);
		}
		const busy = await panel.eval('return !document.getElementById("stop").hidden');
		if (!busy && i > 3) break;
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
