/*---------------------------------------------------------------------------------------------
 *  PSCode AI - checkpoints
 *
 *  One safety net for the whole agent turn. Before the agent touches a file for the first
 *  time in a run, its previous contents are captured; afterwards a single Restore puts every
 *  one of them back, and deletes the files the agent created.
 *
 *  This is the feature a local 7B model needs most. The per-edit Accept/Reject card protects
 *  each change in isolation, but a run can be five individually-plausible edits that together
 *  do the wrong thing - and reviewing five diffs carefully is exactly what a tired user does
 *  not do. Undo does not cover it either: the agent writes through the filesystem and saves,
 *  so the edits are spread across documents that may never have been open.
 *
 *  Restoring is deliberately one WorkspaceEdit. That makes it a single undo step, so an
 *  accidental Restore is itself reversible with Ctrl+Z.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../util/logger';

/** How many turns of history to keep. Contents are held in memory, so this is a memory bound. */
const MAX_CHECKPOINTS = 10;

/**
 * A file that was created rather than modified records `before: undefined`, which is the
 * signal to delete it on restore instead of writing empty contents over it.
 */
interface CapturedFile {
	uri: vscode.Uri;
	relativePath: string;
	before: string | undefined;
}

export interface CheckpointSummary {
	id: string;
	/** The user's prompt, trimmed - what the run was trying to do. */
	label: string;
	createdAt: number;
	filePaths: string[];
}

let nextId = 1;

/**
 * A single agent turn's snapshot. Created before the run, filled in by the tools as they
 * touch files, and read back only if the user asks to restore.
 */
export class Checkpoint {
	readonly id = `cp-${nextId++}`;
	readonly createdAt = Date.now();
	private readonly files = new Map<string, CapturedFile>();
	private restored = false;

	constructor(readonly label: string) { }

	get fileCount(): number {
		return this.files.size;
	}

	get filePaths(): string[] {
		return [...this.files.values()].map(file => file.relativePath);
	}

	get alreadyRestored(): boolean {
		return this.restored;
	}

	summary(): CheckpointSummary {
		return { id: this.id, label: this.label, createdAt: this.createdAt, filePaths: this.filePaths };
	}

	/**
	 * Captures a file's current state, once per run.
	 *
	 * Called *before* the mutation, and only the first call for a given file wins - the
	 * checkpoint has to hold the state from before the whole turn, not before the latest of
	 * three successive edits to the same file.
	 */
	async capture(uri: vscode.Uri): Promise<void> {
		const key = uri.toString();
		if (this.files.has(key)) {
			return;
		}

		let before: string | undefined;
		try {
			before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			// Unreadable means it does not exist yet: the agent is creating it.
			before = undefined;
		}

		this.files.set(key, {
			uri,
			relativePath: vscode.workspace.asRelativePath(uri, false),
			before,
		});
	}

	/**
	 * Puts every captured file back. Returns what it did, so the caller can report it
	 * honestly rather than claiming success it did not verify.
	 */
	async restore(): Promise<{ reverted: string[]; deleted: string[]; failed: string[] }> {
		const reverted: string[] = [];
		const deleted: string[] = [];
		const failed: string[] = [];

		const edit = new vscode.WorkspaceEdit();

		for (const file of this.files.values()) {
			if (file.before === undefined) {
				edit.deleteFile(file.uri, { ignoreIfNotExists: true });
				deleted.push(file.relativePath);
				continue;
			}
			try {
				const document = await vscode.workspace.openTextDocument(file.uri);
				const whole = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length)
				);
				edit.replace(file.uri, whole, file.before);
				reverted.push(file.relativePath);
			} catch (error) {
				// The agent modified it, so it existed; if it cannot be opened now the user
				// deleted or moved it since. Recreate it rather than losing the contents.
				log.warn(`Checkpoint ${this.id}: ${file.relativePath} could not be opened, recreating`, error);
				edit.createFile(file.uri, {
					overwrite: true,
					contents: Buffer.from(file.before, 'utf8'),
				});
				reverted.push(file.relativePath);
			}
		}

		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			log.error(`Checkpoint ${this.id}: applyEdit refused the restore`);
			return { reverted: [], deleted: [], failed: [...reverted, ...deleted] };
		}

		// Saving keeps disk and editor in agreement. The agent wrote through the filesystem,
		// so leaving the reverts unsaved would mean a rebuild still saw the agent's version.
		for (const file of this.files.values()) {
			if (file.before === undefined) {
				continue;
			}
			try {
				const document = await vscode.workspace.openTextDocument(file.uri);
				await document.save();
			} catch (error) {
				log.warn(`Checkpoint ${this.id}: could not save ${file.relativePath}`, error);
				failed.push(file.relativePath);
			}
		}

		this.restored = true;
		log.info(`Checkpoint ${this.id} restored: ${reverted.length} reverted, ${deleted.length} deleted`);
		return { reverted, deleted, failed };
	}
}

/** Keeps the recent checkpoints so the user can go back more than one turn. */
export class CheckpointStore {
	private readonly checkpoints: Checkpoint[] = [];

	begin(label: string): Checkpoint {
		const checkpoint = new Checkpoint(label.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Agent run');
		this.checkpoints.unshift(checkpoint);
		while (this.checkpoints.length > MAX_CHECKPOINTS) {
			this.checkpoints.pop();
		}
		return checkpoint;
	}

	/**
	 * Drops a checkpoint that captured nothing. A run that only read files should not leave
	 * a "Restore" affordance that would do nothing when clicked.
	 */
	discardIfEmpty(checkpoint: Checkpoint): void {
		if (checkpoint.fileCount === 0) {
			const index = this.checkpoints.indexOf(checkpoint);
			if (index !== -1) {
				this.checkpoints.splice(index, 1);
			}
		}
	}

	get(id: string): Checkpoint | undefined {
		return this.checkpoints.find(checkpoint => checkpoint.id === id);
	}

	/** Newest first, and only the ones that still have something to restore. */
	list(): CheckpointSummary[] {
		return this.checkpoints
			.filter(checkpoint => checkpoint.fileCount > 0 && !checkpoint.alreadyRestored)
			.map(checkpoint => checkpoint.summary());
	}
}
