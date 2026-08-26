/*---------------------------------------------------------------------------------------------
 *  PSCode AI - logging
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Single output channel for the whole extension. Everything that talks to a model
 * logs here, because the most common failure mode of a local-model setup is a
 * silent connection problem and the user needs somewhere to look.
 */
class Logger {
	private channel: vscode.LogOutputChannel | undefined;

	init(): vscode.LogOutputChannel {
		if (!this.channel) {
			this.channel = vscode.window.createOutputChannel('PSCode AI', { log: true });
		}
		return this.channel;
	}

	info(message: string, ...args: unknown[]): void {
		this.init().info(message, ...args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.init().warn(message, ...args);
	}

	error(message: string, error?: unknown): void {
		if (error instanceof Error) {
			this.init().error(error, message);
		} else if (error !== undefined) {
			this.init().error(`${message} ${String(error)}`);
		} else {
			this.init().error(message);
		}
	}

	debug(message: string, ...args: unknown[]): void {
		this.init().debug(message, ...args);
	}

	show(): void {
		this.init().show();
	}

	dispose(): void {
		this.channel?.dispose();
		this.channel = undefined;
	}
}

export const log = new Logger();
