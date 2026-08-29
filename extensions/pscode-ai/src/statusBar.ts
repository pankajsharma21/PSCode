/*---------------------------------------------------------------------------------------------
 *  PSCode AI - status bar
 *
 *  Shows which model is live and whether the engine is actually answering. This exists because
 *  the failure mode of a local model is silence: without an indicator, an engine that died looks
 *  exactly like one that is thinking.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createProvider, readSettings } from './providers/registry';
import { log } from './util/logger';

export class AIStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private probe: NodeJS.Timeout | undefined;

	constructor() {
		this.item = vscode.window.createStatusBarItem('pscode.ai.status', vscode.StatusBarAlignment.Right, 100);
		this.item.name = 'PSCode AI';
		this.item.command = 'pscode.pickModel';
		this.item.show();
		this.refresh();
	}

	/** Re-reads settings, then checks reachability in the background. */
	refresh(): void {
		const settings = readSettings();
		this.item.text = `$(sparkle) ${settings.model}`;
		this.item.tooltip = settings.provider === 'bundled'
			? `PSCode AI — ${settings.model}, running inside PSCode\nClick to change model`
			: `PSCode AI — ${settings.provider} at ${settings.endpoint}\nClick to change model`;
		this.item.backgroundColor = undefined;

		if (this.probe) {
			clearTimeout(this.probe);
		}
		// Debounced: settings changes arrive one keystroke at a time.
		this.probe = setTimeout(() => void this.checkReachable(), 400);
	}

	private async checkReachable(): Promise<void> {
		const settings = readSettings();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8000);

		try {
			const models = await createProvider(settings).listModels(controller.signal);
			if (models.length > 0 && !models.includes(settings.model)) {
				this.item.text = `$(warning) ${settings.model}`;
				this.item.tooltip = `PSCode AI — "${settings.model}" is not available on ${settings.endpoint}.\n`
					+ `Available: ${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}\n`
					+ `Click to pick one.`;
				this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				return;
			}
			this.item.text = `$(sparkle) ${settings.model}`;
			this.item.tooltip = `PSCode AI — ${settings.provider} at ${settings.endpoint} (reachable)\nClick to change model`;
			this.item.backgroundColor = undefined;
		} catch (error) {
			log.debug(`Status probe failed: ${error instanceof Error ? error.message : String(error)}`);
			this.item.text = `$(debug-disconnect) ${settings.model}`;
			this.item.tooltip = settings.provider === 'bundled'
				? `PSCode AI — the bundled engine is not answering yet.\n`
					+ `It starts with the window and can take a minute to load its weights the first time.\n`
					+ `"PSCode: Show AI Logs" has the details.`
				: `PSCode AI — cannot reach ${settings.endpoint || '(no endpoint set)'}.\n`
					+ `That server is one you run yourself; "bundled" needs nothing running.\nClick to change model.`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} finally {
			clearTimeout(timeout);
		}
	}

	dispose(): void {
		if (this.probe) {
			clearTimeout(this.probe);
		}
		this.item.dispose();
	}
}
