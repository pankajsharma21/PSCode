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
	/** Embedding model for @codebase. A separate, much smaller model than the chat model. */
	embeddingModel: string;
	semanticInclude: string;
	semanticExclude: string;
	semanticMaxFiles: number;
	semanticMaxHits: number;
}

/** Default endpoint per provider, used when the user has not overridden it. */
const DEFAULT_ENDPOINTS: Record<AISettings['provider'], string> = {
	'ollama': 'http://127.0.0.1:11434',
	'openai-compatible': 'http://127.0.0.1:8080',
	'anthropic': 'https://api.anthropic.com',
};

/**
 * What to index for @codebase. Source only: indexing lock files, minified bundles and
 * fixtures spends CPU to make the results worse, because a query then matches vendored
 * copies of code the user did not write.
 */
const DEFAULT_SEMANTIC_INCLUDE =
	'**/*.{ts,tsx,js,jsx,mjs,cjs,java,py,go,rs,rb,php,cs,c,h,cpp,hpp,kt,swift,scala,sh,sql,css,scss,html,vue,svelte,md,json,yaml,yml,toml}';

const DEFAULT_SEMANTIC_EXCLUDE =
	'**/{node_modules,out,dist,build,.git,.build,target,vendor,__pycache__,coverage,.next,.venv}/**';

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
		embeddingModel: config.get<string>('ai.embeddingModel', 'nomic-embed-text').trim(),
		semanticInclude: config.get<string>('ai.semanticInclude', DEFAULT_SEMANTIC_INCLUDE),
		semanticExclude: config.get<string>('ai.semanticExclude', DEFAULT_SEMANTIC_EXCLUDE),
		semanticMaxFiles: config.get<number>('ai.semanticMaxFiles', 1500),
		semanticMaxHits: config.get<number>('ai.semanticMaxHits', 6),
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
