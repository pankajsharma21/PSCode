/*---------------------------------------------------------------------------------------------
 *  PSCode AI - configuration and provider selection
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { OpenAICompatibleProvider } from './openaiCompat';
import { LLMProvider } from './types';

export interface AISettings {
	provider: 'ollama' | 'openai-compatible' | 'anthropic';
	endpoint: string;
	model: string;
	apiKey: string;
	temperature: number;
	maxTokens: number;
	requestTimeoutMs: number;
	contextBudgetChars: number;
	agentEnabled: boolean;
	agentMaxIterations: number;
	approveShellCommands: boolean;
	approveFileWrites: boolean;
}

/** Default endpoint per provider, used when the user has not overridden it. */
const DEFAULT_ENDPOINTS: Record<AISettings['provider'], string> = {
	'ollama': 'http://127.0.0.1:11434',
	'openai-compatible': 'http://127.0.0.1:8080',
	'anthropic': 'https://api.anthropic.com',
};

export function readSettings(): AISettings {
	const config = vscode.workspace.getConfiguration('pscode');
	const provider = config.get<AISettings['provider']>('ai.provider', 'ollama');

	return {
		provider,
		endpoint: (config.get<string>('ai.endpoint', '') || DEFAULT_ENDPOINTS[provider]).trim(),
		model: config.get<string>('ai.model', 'qwen2.5:7b').trim(),
		// An environment variable beats settings.json so a key never has to be committed.
		apiKey: (process.env['PSCODE_API_KEY'] ?? config.get<string>('ai.apiKey', '')).trim(),
		temperature: config.get<number>('ai.temperature', 0.2),
		maxTokens: config.get<number>('ai.maxTokens', 4096),
		requestTimeoutMs: config.get<number>('ai.requestTimeoutMs', 300000),
		contextBudgetChars: config.get<number>('ai.contextBudgetChars', 24000),
		agentEnabled: config.get<boolean>('agent.enabled', true),
		agentMaxIterations: config.get<number>('agent.maxIterations', 12),
		approveShellCommands: config.get<boolean>('agent.approveShellCommands', true),
		approveFileWrites: config.get<boolean>('agent.approveFileWrites', true),
	};
}

export function createProvider(settings: AISettings): LLMProvider {
	switch (settings.provider) {
		case 'anthropic':
			return new AnthropicProvider(settings.endpoint, settings.model, settings.apiKey, settings.requestTimeoutMs);
		case 'openai-compatible':
			return new OpenAICompatibleProvider(settings.endpoint, settings.model, settings.apiKey, settings.requestTimeoutMs);
		case 'ollama':
		default:
			return new OllamaProvider(settings.endpoint, settings.model, settings.requestTimeoutMs);
	}
}
