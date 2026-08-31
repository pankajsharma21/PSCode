/*---------------------------------------------------------------------------------------------
 *  PSCode AI - routing smoke test
 *
 *  The Chat/Agent switch is gone, so this function now makes the call the user used to make. It
 *  is the one piece of PSCode where being wrong is silently expensive - a misrouted question
 *  costs a minute on CPU - so every rule has a case here, including the ones that only matter in
 *  Hinglish.
 *
 *  No model, no window, no engine. Runs in well under a second:
 *    npm run compile
 *    node extensions/pscode-ai/test/routing-smoke.js
 *--------------------------------------------------------------------------------------------*/

const { routeMessage } = require('../out/chat/routing');

let failures = 0;
const check = (text, expected) => {
	const { route, reason } = routeMessage(text);
	const ok = route === expected;
	if (!ok) { failures++; }
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${expected.padEnd(6)} ${JSON.stringify(text)}`
		+ (ok ? `  — ${reason}` : `  — GOT "${route}" (${reason})`));
};

console.log('--- questions must stay on the fast path (no tools) ---');
check('what does totalPrice do?', 'answer');
check('what does totalPrice do', 'answer');
check('totalPrice kya karta hai?', 'answer');
check('why is this loop wrong', 'answer');
check('explain this function', 'answer');
check('is this correct?', 'answer');
check('how do I fix this?', 'answer');
check('bug kaise fix karu?', 'answer');
check('summarize cart.ts', 'answer');
check('hi', 'answer');
check('', 'answer');

console.log('\n--- instructions must get tools ---');
check('fix the off-by-one bug', 'work');
check('add a test for cart.ts', 'work');
check('rename totalPrice to cartTotal', 'work');
check('refactor this into two functions', 'work');
check('run the tests', 'work');
check('delete the unused import', 'work');

console.log('\n--- "go look at the workspace" needs tools too, not just "change it" ---');
check('read cart.ts and tell me what it does', 'work');
check('find every caller of totalPrice', 'work');
check('search for TODO comments', 'work');
check('edit cart.ts to use reduce', 'work');
check('open the package.json', 'work');
check('list the files in src', 'work');

console.log('\n--- but the ambiguous ones stay on the fast path, on purpose ---');
// A wrong "answer" costs 11s and a button. A wrong "work" costs a minute with no way back.
check('look at this function', 'answer');
check('check if this is correct', 'answer');

console.log('\n--- politeness is not a route ---');
check('can you fix the off-by-one bug?', 'work');
check('please add a test for cart.ts', 'work');
check('could you rename totalPrice?', 'work');

console.log('\n--- Hinglish instructions, where the imperative is the LAST word ---');
check('cart.ts mein bug fix karo', 'work');
check('ek test file banao', 'work');
check('ye unused import hatao', 'work');
check('totalPrice ko cartTotal kar do', 'work');

console.log('\n--- a task verb buried mid-sentence is the weakest signal, but still a signal ---');
check('the loop has a bug, please fix it', 'work');

console.log('\n--- and question shape beats a buried task verb ---');
check('which test should I write?', 'answer');
check('what does the build command run?', 'answer');

console.log(failures === 0 ? '\nAll routing checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
