/*---------------------------------------------------------------------------------------------
 *  PSCode AI - streaming HTTP
 *
 *  Deliberately built on Node's own `http`/`https` rather than a fetch wrapper or axios:
 *  a built-in extension that ships inside the product should not drag npm dependencies
 *  (and their supply chain) into the editor for something this small.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { ProviderError } from './types';

export interface HttpRequest {
	url: string;
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	/** Serialised as JSON when present. */
	body?: unknown;
	timeoutMs: number;
	signal: AbortSignal;
}

const MAX_ERROR_BODY = 4000;

/**
 * Turns low-level socket failures into messages that tell the user what to do.
 * A bare "ECONNREFUSED 127.0.0.1:11434" is the single most common thing a new
 * local-model user sees, and on its own it explains nothing.
 */
function explain(error: NodeJS.ErrnoException, url: string): ProviderError {
	const target = safeOrigin(url);
	switch (error.code) {
		case 'ECONNREFUSED':
			return new ProviderError(
				`Could not connect to the model server at ${target}.`,
				`Nothing is listening there. If you are using Ollama, start it with "ollama serve", then check the model is pulled with "ollama list".`
			);
		case 'ENOTFOUND':
			return new ProviderError(
				`Could not resolve the host in ${target}.`,
				`Check "pscode.ai.endpoint" in your settings.`
			);
		case 'ETIMEDOUT':
		case 'UND_ERR_HEADERS_TIMEOUT':
			return new ProviderError(
				`The model server at ${target} did not respond in time.`,
				`CPU-only inference can be slow to produce a first token. Raise "pscode.ai.requestTimeoutMs" or try a smaller model.`
			);
		default:
			if (error.name === 'AbortError') {
				return new ProviderError('Request cancelled.');
			}
			return new ProviderError(`Request to ${target} failed: ${error.message}`);
	}
}

/** Strips any credentials before a URL reaches a log or an error message. */
function safeOrigin(url: string): string {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}`;
	} catch {
		return url;
	}
}

function open(req: HttpRequest): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		let target: URL;
		try {
			target = new URL(req.url);
		} catch {
			reject(new ProviderError(
				`"${req.url}" is not a valid URL.`,
				`Check "pscode.ai.endpoint" — it should look like http://127.0.0.1:11434 with no trailing path.`
			));
			return;
		}

		const transport = target.protocol === 'https:' ? https : http;
		const payload = req.body === undefined
			? undefined
			: Buffer.from(JSON.stringify(req.body), 'utf8');

		const headers: Record<string, string> = {
			'accept': 'application/json, text/event-stream',
			...req.headers,
		};
		if (payload) {
			headers['content-type'] = 'application/json';
			headers['content-length'] = String(payload.byteLength);
		}

		const request = transport.request(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port || (target.protocol === 'https:' ? 443 : 80),
				path: `${target.pathname}${target.search}`,
				method: req.method ?? (payload ? 'POST' : 'GET'),
				headers,
				signal: req.signal,
			},
			response => {
				const status = response.statusCode ?? 0;
				if (status >= 200 && status < 300) {
					resolve(response);
					return;
				}
				// Read the error body: model servers put the useful part in there
				// ("model not found", "invalid api key") and the status alone is useless.
				let body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
					if (body.length < MAX_ERROR_BODY) {
						body += chunk;
					}
				});
				response.on('end', () => reject(httpError(status, body, req.url)));
				response.on('error', () => reject(httpError(status, body, req.url)));
			}
		);

		request.setTimeout(req.timeoutMs, () => {
			request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
		});
		request.on('error', (error: NodeJS.ErrnoException) => reject(explain(error, req.url)));

		if (payload) {
			request.end(payload);
		} else {
			request.end();
		}
	});
}

function httpError(status: number, body: string, url: string): ProviderError {
	const detail = extractMessage(body);
	const target = safeOrigin(url);

	if (status === 401 || status === 403) {
		return new ProviderError(
			`The model server rejected the request (HTTP ${status}).`,
			`Check your API key. Local servers usually need none — set "pscode.ai.apiKey" to empty for Ollama.`
		);
	}
	if (status === 404) {
		return new ProviderError(
			`${target} returned 404${detail ? `: ${detail}` : ''}.`,
			`Either the model is not pulled ("ollama pull <model>") or the endpoint path is wrong for this provider.`
		);
	}
	return new ProviderError(
		`Model server returned HTTP ${status}${detail ? `: ${detail}` : ''}.`
	);
}

/** Model servers nest their error text inconsistently; try the common shapes. */
function extractMessage(body: string): string {
	if (!body) {
		return '';
	}
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === 'object') {
			const record = parsed as Record<string, unknown>;
			if (typeof record['error'] === 'string') {
				return record['error'];
			}
			const nested = record['error'];
			if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>)['message'] === 'string') {
				return (nested as Record<string, unknown>)['message'] as string;
			}
			if (typeof record['message'] === 'string') {
				return record['message'];
			}
		}
	} catch {
		// Not JSON - fall through and use the raw text.
	}
	return body.slice(0, 300).trim();
}

/** POSTs/GETs JSON and parses the whole response. Used for non-streaming calls like listing models. */
export async function requestJson<T>(req: HttpRequest): Promise<T> {
	const response = await open(req);
	let body = '';
	response.setEncoding('utf8');
	for await (const chunk of response) {
		body += chunk as string;
	}
	try {
		return JSON.parse(body) as T;
	} catch {
		throw new ProviderError(`Model server returned a response that is not valid JSON.`);
	}
}

/**
 * Streams the response body as complete lines. Both wire formats PSCode speaks are
 * line-delimited: Ollama sends newline-delimited JSON, OpenAI-compatible servers and
 * Anthropic send Server-Sent Events. Splitting on newlines here means each provider
 * only has to interpret lines, not manage sockets and partial chunks.
 */
export async function* streamLines(req: HttpRequest): AsyncGenerator<string, void, undefined> {
	const response = await open(req);
	let buffer = '';

	for await (const chunk of response) {
		buffer += (chunk as Buffer).toString('utf8');

		let newline = buffer.indexOf('\n');
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, '');
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				yield line;
			}
			newline = buffer.indexOf('\n');
		}
	}

	// A server that ends without a trailing newline still owes us the last line.
	const tail = buffer.trim();
	if (tail.length > 0) {
		yield tail;
	}
}
