/*---------------------------------------------------------------------------------------------
 *  PSCode AI - the two guards that stand between a model's output and the user's file
 *
 *  Both of these were real: a code block applied with nothing selected replaced a whole file with
 *  a fragment, and a one-line inline edit came back un-indented and silently de-indented the code
 *  it replaced. Neither needs a model to test - they are decisions about text - so they are tested
 *  here rather than left to a slow UI run.
 *
 *    node extensions/pscode-ai/test/apply-guard-smoke.js
 *--------------------------------------------------------------------------------------------*/

let failures = 0;
const check = (name, ok, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) { failures++; }
};

/* ---------------------------------------------------------------- apply guard */

/*
 * Mirrors the rule in chatViewProvider.applyToEditor. Kept as a copy rather than imported because
 * that module needs `vscode`; if the two ever drift, the numbers in the assertions below are the
 * record of what was intended.
 */
function wouldRefuseApply(fileText, blockText, hasSelection) {
	if (hasSelection) { return false; }
	const fileLines = fileText.split('\n').filter(l => l.trim()).length;
	const blockLines = blockText.split('\n').filter(l => l.trim()).length;
	return fileLines > 10 && blockLines < fileLines / 2;
}

const bigFile = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join('\n');
const fragment = 'for (let i = 0; i < items.length; i++) {\n\ttotal += items[i].price;\n}';
const wholeFile = Array.from({ length: 38 }, (_, i) => `const line${i} = ${i};`).join('\n');
const tinyFile = 'const a = 1;\nconst b = 2;';

console.log('--- a fragment must not be allowed to become the whole file ---');
check('a 3-line block over a 40-line file, nothing selected', wouldRefuseApply(bigFile, fragment, false) === true, 'refused');
check('the same block WITH a selection is fine', wouldRefuseApply(bigFile, fragment, true) === false, 'allowed');

console.log('\n--- a genuine whole-file rewrite must still work ---');
check('a 38-line block over a 40-line file', wouldRefuseApply(bigFile, wholeFile, false) === false, 'allowed');
check('a small file is never guarded (nothing to lose)', wouldRefuseApply(tinyFile, 'const a = 99;', false) === false, 'allowed');

/* -------------------------------------------------------------- indent guard */

const { readFileSync } = require('fs');
const { join } = require('path');
// restoreIndent is module-private, so it is exercised through its own source rather than exported
// purely for a test. eval of one function keeps the test honest about which code it is checking.
const source = readFileSync(join(__dirname, '..', 'out', 'inline', 'inlineEdit.js'), 'utf8');
const match = /function restoreIndent\([\s\S]*?\n\}/.exec(source);
if (!match) {
	console.log('FAIL  could not find restoreIndent in the compiled output');
	process.exit(1);
}
// eslint-disable-next-line no-eval
const restoreIndent = eval(`(${match[0].replace('function restoreIndent', 'function')})`);

console.log('\n--- indentation the model dropped must come back ---');
check('a tab-indented line rewritten without the tab',
	restoreIndent('\tfor (let i = 0; i <= n; i++) {', 'for (let i = 0; i < n; i++) {') === '\tfor (let i = 0; i < n; i++) {',
	JSON.stringify(restoreIndent('\tfor (let i = 0; i <= n; i++) {', 'for (let i = 0; i < n; i++) {')));
check('spaces work the same way',
	restoreIndent('    const x = 1;', 'const x = 2;') === '    const x = 2;');
check('a one-line snippet replaced by several keeps every line inside the block',
	restoreIndent('\tconst x = 1;', 'const x = 1;\nconst y = 2;') === '\tconst x = 1;\n\tconst y = 2;');
check('the model keeping its own indentation is left alone',
	restoreIndent('\tconst x = 1;', '\t\tconst x = 2;') === '\t\tconst x = 2;');
check('an unindented original is left alone',
	restoreIndent('const x = 1;', 'const x = 2;') === 'const x = 2;');
check('a mixed-indent block is left alone - it carries its own shape',
	restoreIndent('\tif (a) {\nreturn b;\n}', 'if (a) {\nreturn c;\n}') === 'if (a) {\nreturn c;\n}');
check('blank lines are not given phantom indentation',
	restoreIndent('\tconst x = 1;', 'const x = 1;\n\nconst y = 2;') === '\tconst x = 1;\n\n\tconst y = 2;');

console.log(failures === 0 ? '\nAll apply/indent guard checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
