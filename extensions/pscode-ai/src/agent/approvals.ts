/*---------------------------------------------------------------------------------------------
 *  PSCode AI - approval gate
 *
 *  Tool actions that touch the workspace are approved *in the chat panel*, not through a modal
 *  dialog. Two reasons:
 *
 *   1. A modal steals focus and reads as an interruption. Reviewing a diff and clicking Accept
 *      where the conversation already is matches how Cursor and similar tools behave.
 *   2. A modal is confirmed by the Enter key, so any stray keypress can approve a file write.
 *      An approval here resolves only when the webview posts back the matching request id,
 *      which no keystroke can forge.
 *--------------------------------------------------------------------------------------------*/

export type ApprovalKind = 'edit' | 'create' | 'overwrite' | 'command';

export interface ApprovalRequest {
	id: string;
	kind: ApprovalKind;
	/** Short headline, e.g. "Edit src/cart.ts". */
	title: string;
	/** Secondary line: the command to run, or where in the file the edit lands. */
	detail?: string;
	/** Workspace-relative path, when the action targets a file. */
	filePath?: string;
	/** True when a side-by-side diff of the proposal is open for review. */
	hasDiff?: boolean;
}

/** Resolves true to proceed, false to decline. Never rejects. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

let sequence = 0;

export function nextApprovalId(): string {
	sequence += 1;
	return `approval-${sequence}`;
}

/**
 * Tracks in-flight approvals so they can all be declined at once when the user stops the
 * agent or closes the panel. Leaving a promise unresolved there would hang the agent loop.
 */
export class ApprovalRegistry {
	private readonly pending = new Map<string, (approved: boolean) => void>();

	create(id: string): Promise<boolean> {
		return new Promise<boolean>(resolve => this.pending.set(id, resolve));
	}

	resolve(id: string, approved: boolean): boolean {
		const resolver = this.pending.get(id);
		if (!resolver) {
			return false;
		}
		this.pending.delete(id);
		resolver(approved);
		return true;
	}

	/** Declines everything still outstanding. Called on cancel and on dispose. */
	declineAll(): void {
		for (const [, resolver] of this.pending) {
			resolver(false);
		}
		this.pending.clear();
	}

	get size(): number {
		return this.pending.size;
	}
}
