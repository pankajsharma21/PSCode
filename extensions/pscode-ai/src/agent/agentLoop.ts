/*---------------------------------------------------------------------------------------------
 *  PSCode AI - the agent loop
 *
 *  The loop is deliberately small and explicit: stream a turn, run whatever tools the model
 *  asked for, append the results, repeat. Bounded by `pscode.agent.maxIterations` so a model
 *  that gets stuck cannot spin forever against the user's files.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AISettings } from '../providers/registry';
import { ChatMessage, LLMProvider, ToolCall } from '../providers/types';
import { log } from '../util/logger';
import { ApprovalHandler } from './approvals';
import { AGENT_SYSTEM_PROMPT } from './prompts';
import { ALL_TOOLS, describeToolError, toolByName, ToolContext } from './tools';

export interface AgentEvents {
	onText(delta: string): void;
	onToolStart(call: ToolCall): void;
	onToolTrace(line: string): void;
	onToolResult(call: ToolCall, ok: boolean, summary: string): void;
	onIteration(index: number, max: number): void;
	onDone(reason: string): void;
}

export interface AgentRunOptions {
	provider: LLMProvider;
	settings: AISettings;
	/** Conversation so far, excluding the agent system prompt. */
	history: ChatMessage[];
	events: AgentEvents;
	token: vscode.CancellationToken;
	signal: AbortSignal;
	/** Renders Accept/Reject in the chat panel and resolves with the user's choice. */
	requestApproval: ApprovalHandler;
}

/**
 * Runs the agent until the model stops requesting tools, the iteration budget is spent,
 * or the user cancels. Returns the messages produced, so the caller can persist them
 * into the conversation.
 */
export async function runAgent(options: AgentRunOptions): Promise<ChatMessage[]> {
	const { provider, settings, history, events, token, signal, requestApproval } = options;

	if (!provider.supportsTools) {
		throw new Error(`${provider.label} does not support tool calling, so Agent mode is unavailable. Switch to Chat mode.`);
	}

	const messages: ChatMessage[] = [
		{ role: 'system', content: AGENT_SYSTEM_PROMPT },
		...history,
	];
	const produced: ChatMessage[] = [];

	const toolContext: ToolContext = {
		settings,
		report: line => events.onToolTrace(line),
		requestApproval,
	};

	const maxIterations = Math.max(1, settings.agentMaxIterations);

	// Small models loop: they re-issue an identical call, or keep "improving" a file they
	// already edited. Prompt rules alone do not stop it, so the loop enforces both.
	const seenCalls = new Set<string>();
	const editsPerFile = new Map<string, number>();
	const MAX_EDITS_PER_FILE = 2;

	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		if (token.isCancellationRequested) {
			events.onDone('cancelled');
			return produced;
		}
		events.onIteration(iteration, maxIterations);

		let text = '';
		const toolCalls: ToolCall[] = [];

		for await (const event of provider.stream(
			{
				messages,
				tools: ALL_TOOLS.map(tool => tool.schema),
				temperature: settings.temperature,
				maxTokens: settings.maxTokens,
			},
			signal
		)) {
			if (token.isCancellationRequested) {
				break;
			}
			if (event.type === 'text') {
				text += event.text;
				events.onText(event.text);
			} else if (event.type === 'toolCall') {
				toolCalls.push(event.call);
			}
		}

		if (token.isCancellationRequested) {
			events.onDone('cancelled');
			return produced;
		}

		const assistantMessage: ChatMessage = toolCalls.length
			? { role: 'assistant', content: text, toolCalls }
			: { role: 'assistant', content: text };
		messages.push(assistantMessage);
		produced.push(assistantMessage);

		// No tools requested means the model considers the task finished.
		if (toolCalls.length === 0) {
			events.onDone('stop');
			return produced;
		}

		for (const call of toolCalls) {
			if (token.isCancellationRequested) {
				events.onDone('cancelled');
				return produced;
			}

			events.onToolStart(call);

			const repeatGuard = checkRepeat(call, seenCalls, editsPerFile, MAX_EDITS_PER_FILE);
			const result = repeatGuard ?? await executeTool(call, toolContext, token);
			events.onToolResult(call, result.ok, result.content);

			const toolMessage: ChatMessage = {
				role: 'tool',
				content: result.content,
				toolCallId: call.id,
				name: call.name,
			};
			messages.push(toolMessage);
			produced.push(toolMessage);
		}
	}

	// Budget exhausted. Tell the model's caller, not just the log: a silent stop here
	// looks identical to a finished task, which is how agents appear to "lie".
	const notice: ChatMessage = {
		role: 'assistant',
		content: `_Stopped after ${maxIterations} tool rounds without finishing. Increase "pscode.agent.maxIterations" or narrow the task._`,
	};
	produced.push(notice);
	events.onText(`\n\n${notice.content}`);
	events.onDone('maxIterations');
	return produced;
}

async function executeTool(
	call: ToolCall,
	context: ToolContext,
	token: vscode.CancellationToken
): Promise<{ ok: boolean; content: string }> {
	const tool = toolByName(call.name);
	if (!tool) {
		return {
			ok: false,
			content: `There is no tool called "${call.name}". Available tools: ${ALL_TOOLS.map(t => t.schema.name).join(', ')}.`,
		};
	}

	let args: Record<string, unknown>;
	try {
		const parsed: unknown = call.args.trim() ? JSON.parse(call.args) : {};
		args = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
	} catch {
		// Small models truncate or malform JSON arguments regularly; the model can recover
		// from being told so, but not from a thrown exception.
		return {
			ok: false,
			content: `Your arguments for "${call.name}" were not valid JSON. Send them again as a single valid JSON object.`,
		};
	}

	try {
		return await tool.execute(args, context, token);
	} catch (error) {
		log.error(`Tool ${call.name} threw`, error);
		return { ok: false, content: describeToolError(error) };
	}
}


/** Tool calls that mutate a file, for the per-file edit cap. */
const MUTATING_TOOLS = new Set(['write_file', 'replace_in_file']);

/**
 * Refuses a tool call that repeats work already done in this run. Returned as a tool
 * *result* rather than an exception so the model reads it and moves on, which is the only
 * thing that actually breaks the loop.
 */
function checkRepeat(
	call: ToolCall,
	seenCalls: Set<string>,
	editsPerFile: Map<string, number>,
	maxEditsPerFile: number
): { ok: boolean; content: string } | undefined {
	const fingerprint = `${call.name}:${call.args}`;
	if (seenCalls.has(fingerprint)) {
		log.warn(`Blocked a repeated tool call: ${call.name}`);
		return {
			ok: false,
			content: `You already called ${call.name} with exactly these arguments in this task, and the result has not changed. Do not repeat it. Either use what you already learned, or stop and report what you have done.`,
		};
	}
	seenCalls.add(fingerprint);

	if (!MUTATING_TOOLS.has(call.name)) {
		return undefined;
	}

	let target: string | undefined;
	try {
		const parsed: unknown = JSON.parse(call.args || '{}');
		if (parsed && typeof parsed === 'object') {
			const value = (parsed as Record<string, unknown>)['path'];
			if (typeof value === 'string') {
				target = value;
			}
		}
	} catch {
		return undefined; // Malformed args are handled downstream.
	}
	if (!target) {
		return undefined;
	}

	const count = (editsPerFile.get(target) ?? 0) + 1;
	editsPerFile.set(target, count);
	if (count > maxEditsPerFile) {
		log.warn(`Blocked edit ${count} to ${target} in one task`);
		return {
			ok: false,
			content: `You have already edited ${target} ${count - 1} time(s) for this task, which is the limit. Stop editing. If something is still wrong, say so in your report and let the user decide.`,
		};
	}
	return undefined;
}
