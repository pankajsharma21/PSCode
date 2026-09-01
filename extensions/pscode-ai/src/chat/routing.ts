/*---------------------------------------------------------------------------------------------
 *  PSCode AI - message routing
 *
 *  Decides, per message, whether the model gets tools. This replaced a Chat/Agent switch the
 *  user had to operate, which was the single most confusing thing in the panel: it asked people
 *  to understand an implementation detail before they could type.
 *
 *  Merging the two and simply always sending tools is what a cloud-model IDE does, and it is the
 *  right answer there. It is the wrong answer here, and the gap is not small. Measured on the
 *  bundled 3B engine, same question, same file in context:
 *
 *      no tools      299 prompt tokens     11.4s   answered it
 *      11 tools    2,064 prompt tokens    110.8s   called find_symbol instead of answering
 *
 *  So the choice still has to be made - it just should not be made by the user. This module makes
 *  it from the text, and `route === 'answer'` is always recoverable in one click, which is why the
 *  default leans that way: a wrong "answer" costs 11s and a button, a wrong "work" costs a minute.
 *
 *  Imports nothing from `vscode`, so it is testable in plain Node - see test/routing-smoke.js.
 *--------------------------------------------------------------------------------------------*/

/** `answer` sends no tools. `work` sends all of them and runs the agent loop. */
export type Route = 'answer' | 'work';

export interface RoutingDecision {
	route: Route;
	/** Why, in words, for the log and the panel. Never a rule number. */
	reason: string;
}

/*
 * Politeness wraps a request without changing it: "can you fix the bug" is the same instruction
 * as "fix the bug". Stripped first so the verb that follows is seen in first position.
 *
 * Stripped repeatedly, not once: the common forms are two words ("can you", "could you"), and
 * removing only "can" leaves "you" in first position, where it matches nothing and the trailing
 * question mark then routes a plain instruction to the answer path.
 */
const POLITE_PREFIX = /^(?:hey|hi|ok|okay|please|pls|plz|kindly|now|can|could|would|will|you|u)\b[\s,]*/i;

/** Bounded so a message made entirely of these words cannot spin. */
function stripPoliteness(text: string): string {
	let out = text;
	for (let i = 0; i < 4; i++) {
		const next = out.replace(POLITE_PREFIX, '').trim();
		if (next === out || !next) {
			break;
		}
		out = next;
	}
	return out || text;
}

/*
 * Verbs that need the workspace: either they change it, or they ask PSCode to go and look at it,
 * which is equally impossible without tools. First position is the strong signal; anywhere in the
 * sentence is a weak one, applied last.
 *
 * This list is kept deliberately tight, because the two mistakes are not symmetrical. A question
 * misrouted to the answer path costs ~11s and leaves a "Retry with tools" button; a question
 * misrouted to the tool path costs a minute or more and has no recovery at all. So a verb earns a
 * place here only when it plainly cannot be satisfied from context - `read`, `find` and `search`
 * qualify, `check` and `look` are more often rhetorical and are left out on purpose.
 */
const CHANGE_VERBS = new Set([
	'fix', 'add', 'remove', 'delete', 'rename', 'refactor', 'implement', 'create', 'write',
	'update', 'change', 'edit', 'move', 'extract', 'replace', 'rewrite', 'convert', 'migrate',
	'split', 'merge', 'generate', 'make', 'build', 'run', 'install', 'commit', 'apply', 'wire',
	'hook', 'rerun', 'revert', 'undo', 'bump', 'clean', 'format', 'lint', 'test', 'port', 'patch',
]);

/** Do not change anything, but cannot be answered without going and looking. */
const LOOK_VERBS = new Set(['read', 'open', 'find', 'search', 'list', 'grep', 'inspect']);

const TASK_VERBS = new Set([...CHANGE_VERBS, ...LOOK_VERBS]);

/** The two groups need tools for different reasons, and the log should say which. */
const whyItNeedsTools = (verb: string): string => CHANGE_VERBS.has(verb)
	? `it opens with "${verb}", which asks for a change`
	: `it opens with "${verb}", which means going and looking at your files`;

/*
 * Words that open a question. `explain`, `describe` and `summarize` are here rather than in
 * TASK_VERBS on purpose: they are imperative in form but they ask for prose, not for an edit.
 */
const QUESTION_WORDS = new Set([
	'what', 'why', 'how', 'when', 'where', 'which', 'who', 'whose', 'whom',
	'is', 'are', 'was', 'were', 'do', 'does', 'did', 'should', 'shall', 'may', 'might',
	'explain', 'describe', 'summarize', 'summarise', 'tell', 'show', 'compare', 'define',
	// Hinglish question openers, because that is how this panel actually gets used.
	'kya', 'kyu', 'kyun', 'kaise', 'kahan', 'kaun', 'kitna', 'kitne', 'kab',
]);

/*
 * Hindi/Hinglish imperatives. These land at the END of a sentence rather than the start, so first
 * word matching cannot see them: "cart.ts mein bug fix karo" is an instruction, and every signal
 * that says so is in the last word.
 *
 * Deliberately excludes the interrogative forms - `karu`/`karun` ("should I do") and `karta`
 * ("does") are questions, and matching them loosely would route "bug kaise fix karu?" to a
 * minute-long agent run.
 */
const HINGLISH_IMPERATIVE =
	/\b(?:kar\s?do|karo|kardo|kardijiye|kar\s?dijiye|banao|bana\s?do|hatao|hata\s?do|likho|likh\s?do|badlo|badal\s?do|chalao|chala\s?do|jodo|jod\s?do|nikalo|nikal\s?do|theek\s?karo|thik\s?karo|update\s?karo|fix\s?karo)\b/i;

const firstWord = (text: string): string => (text.match(/[a-z@]+/i)?.[0] ?? '').toLowerCase();

/**
 * Picks a route for one user message.
 *
 * Order is the whole design. Imperatives are checked before question shape, because a question
 * mark is punctuation and an instruction is an instruction - "can you fix the bug?" is a task
 * wearing a question mark. Question shape then wins over a task verb buried mid-sentence, so
 * "how do I fix this?" stays a fast answer.
 */
export function routeMessage(text: string): RoutingDecision {
	const trimmed = text.trim();
	if (!trimmed) {
		return { route: 'answer', reason: 'empty message' };
	}

	const stripped = stripPoliteness(trimmed);
	const first = firstWord(stripped);

	if (TASK_VERBS.has(first)) {
		return { route: 'work', reason: whyItNeedsTools(first) };
	}

	if (HINGLISH_IMPERATIVE.test(stripped)) {
		return { route: 'work', reason: 'it is phrased as an instruction' };
	}

	if (QUESTION_WORDS.has(first) || stripped.endsWith('?')) {
		return { route: 'answer', reason: 'it is phrased as a question' };
	}

	for (const word of stripped.toLowerCase().split(/[^a-z]+/)) {
		if (TASK_VERBS.has(word)) {
			return { route: 'work', reason: `it mentions "${word}"` };
		}
	}

	return { route: 'answer', reason: 'no instruction to change anything' };
}
