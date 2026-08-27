/*---------------------------------------------------------------------------------------------
 *  PSCode AI - chat history
 *
 *  Conversations used to live only in the webview's memory, so a window reload lost them.
 *  That is fine for a toy and wrong for a tool: the interesting conversations are the long
 *  ones, and those are exactly the ones worth reopening a day later.
 *
 *  Stored in `workspaceState`, not `globalState`, because a chat is about a codebase. Opening
 *  a different project should not surface the previous project's questions.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatMessage } from '../providers/types';
import { log } from '../util/logger';

const STORAGE_KEY = 'pscode.chat.sessions.v1';

/** Sessions are cheap to keep but not free; this bounds the stored state. */
const MAX_SESSIONS = 50;

/**
 * A single session is skipped rather than truncated if it is enormous. `workspaceState` is a
 * key-value store meant for small state, and an agent transcript with several whole files
 * pasted into tool results can reach megabytes. Losing one oversized session beats making
 * every window reload slow.
 */
const MAX_SESSION_BYTES = 256 * 1024;

export interface ChatSession {
	id: string;
	/** Derived from the first user message; what the list shows. */
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];
}

export interface SessionListItem {
	id: string;
	title: string;
	updatedAt: number;
	messageCount: number;
}

/** Turns the first user message into something readable in a narrow side panel. */
export function deriveTitle(messages: ChatMessage[]): string {
	const first = messages.find(message => message.role === 'user');
	if (!first || typeof first.content !== 'string') {
		return 'New chat';
	}

	// The stored user content has the context block appended to it; the question is the part
	// before that, and it is the only part worth showing.
	const question = first.content.split('\n\n--- ')[0].split('\n')[0].trim();
	if (!question) {
		return 'New chat';
	}
	return question.length > 60 ? `${question.slice(0, 57)}…` : question;
}

export class ChatHistory {
	private sessions: ChatSession[] = [];

	constructor(private readonly state: vscode.Memento) {
		this.sessions = this.read();
	}

	private read(): ChatSession[] {
		try {
			const stored = this.state.get<ChatSession[]>(STORAGE_KEY, []);
			// Anything malformed is dropped rather than crashing activation: this state
			// survives extension upgrades and may have been written by an older shape.
			return Array.isArray(stored)
				? stored.filter(session =>
					session
					&& typeof session.id === 'string'
					&& Array.isArray(session.messages))
				: [];
		} catch (error) {
			log.warn('Could not read chat history; starting empty', error);
			return [];
		}
	}

	private async write(): Promise<void> {
		try {
			await this.state.update(STORAGE_KEY, this.sessions);
		} catch (error) {
			log.warn('Could not persist chat history', error);
		}
	}

	/** Newest first. */
	list(): SessionListItem[] {
		return [...this.sessions]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(session => ({
				id: session.id,
				title: session.title,
				updatedAt: session.updatedAt,
				messageCount: session.messages.length,
			}));
	}

	get(id: string): ChatSession | undefined {
		return this.sessions.find(session => session.id === id);
	}

	/**
	 * Creates or updates a session in place. Called after every completed turn, so an
	 * interrupted window still has everything up to the last answer.
	 */
	async save(id: string, messages: ChatMessage[]): Promise<void> {
		if (messages.length === 0) {
			return;
		}

		const size = Buffer.byteLength(JSON.stringify(messages), 'utf8');
		if (size > MAX_SESSION_BYTES) {
			log.warn(`Session ${id} is ${Math.round(size / 1024)}KB, over the ${MAX_SESSION_BYTES / 1024}KB limit; not persisted`);
			return;
		}

		const now = Date.now();
		const existing = this.sessions.find(session => session.id === id);
		if (existing) {
			existing.messages = messages;
			existing.updatedAt = now;
			// The title comes from the first message, which does not change - except that a
			// session created empty got the placeholder, so recompute while it is still that.
			if (existing.title === 'New chat') {
				existing.title = deriveTitle(messages);
			}
		} else {
			this.sessions.push({
				id,
				title: deriveTitle(messages),
				createdAt: now,
				updatedAt: now,
				messages,
			});
		}

		this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		if (this.sessions.length > MAX_SESSIONS) {
			this.sessions = this.sessions.slice(0, MAX_SESSIONS);
		}
		await this.write();
	}

	async delete(id: string): Promise<void> {
		const before = this.sessions.length;
		this.sessions = this.sessions.filter(session => session.id !== id);
		if (this.sessions.length !== before) {
			await this.write();
		}
	}

	async clear(): Promise<void> {
		this.sessions = [];
		await this.write();
	}
}

export function newSessionId(): string {
	// Time plus randomness: readable ordering in the stored JSON, no collisions when two
	// windows on the same workspace both start a chat.
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
