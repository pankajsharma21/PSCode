/*---------------------------------------------------------------------------------------------
 *  PSCode AI - configuration and provider selection
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { bundledRuntime } from '../runtime/bundledRuntime';
import { AnthropicProvider } from './anthropic';
import { BundledProvider } from './bundled';
import { OllamaProvider } from './ollama';
import { OpenAICompatibleProvider } from './openaiCompat';
import { LLMProvider, ProviderError } from './types';

export interface AISettings {
	provider: 'bundled' | 'ollama' | 'openai-compatible' | 'anthropic';
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
	/** Re-embed a file when it is saved, so @codebase does not go stale between builds. */
	semanticAutoUpdate: boolean;
}

/** Default endpoint per provider, used when the user has not overridden it. */
const DEFAULT_ENDPOINTS: Record<AISettings['provider'], string> = {
	// The bundled engine binds a free port at startup, so its endpoint is discovered, never
	// configured. Empty here means "ask the runtime", not "unset".
	'bundled': '',
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
	const runtime = bundledRuntime();
	// The bundled engine is the default, and the only one that works with nothing else installed.
	// It is also skipped automatically when a build has no weights in it, so a source checkout
	// that never ran scripts/fetch-llm-runtime.sh falls back to Ollama instead of failing.
	const configured = config.get<AISettings['provider']>('ai.provider', 'bundled');
	const provider: AISettings['provider'] = configured === 'bundled' && !runtime ? 'ollama' : configured;

	// The model is the file that shipped; there is nothing to choose and nothing to mistype.
	const bundledModel = provider === 'bundled' ? runtime?.chatModel : undefined;

	return {
		provider,
		endpoint: (config.get<string>('ai.endpoint', '') || DEFAULT_ENDPOINTS[provider]).trim(),
		model: (bundledModel ?? config.get<string>('ai.model', 'qwen2.5:7b')).trim(),
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
		embeddingModel: (
			(provider === 'bundled' ? runtime?.embedModel : undefined)
			?? config.get<string>('ai.embeddingModel', 'nomic-embed-text')
		).trim(),
		semanticInclude: config.get<string>('ai.semanticInclude', DEFAULT_SEMANTIC_INCLUDE),
		semanticExclude: config.get<string>('ai.semanticExclude', DEFAULT_SEMANTIC_EXCLUDE),
		semanticMaxFiles: config.get<number>('ai.semanticMaxFiles', 1500),
		semanticMaxHits: config.get<number>('ai.semanticMaxHits', 6),
		semanticAutoUpdate: config.get<boolean>('ai.semanticAutoUpdate', true),
	};
}

export function createProvider(settings: AISettings): LLMProvider {
	switch (settings.provider) {
		case 'bundled': {
			const runtime = bundledRuntime();
			if (!runtime) {
				throw new ProviderError(
					'This build does not include the model engine.',
					'Run scripts/fetch-llm-runtime.sh, or point "pscode.ai.provider" at a server you run yourself.'
				);
			}
			return new BundledProvider(() => runtime.ensureChatEndpoint(), settings.model, settings.requestTimeoutMs);
		}
		case 'anthropic':
			return new AnthropicProvider(settings.endpoint, settings.model, settings.apiKey, settings.requestTimeoutMs);
		case 'openai-compatible':
			return new OpenAICompatibleProvider(settings.endpoint, settings.model, settings.apiKey, settings.requestTimeoutMs);
		case 'ollama':
		default:
			return new OllamaProvider(settings.endpoint, settings.model, settings.requestTimeoutMs);
	}
}
