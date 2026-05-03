/**
 * Gemini Bridge Server
 *
 * A local HTTP server that accepts Anthropic Messages API requests and
 * translates them to Gemini Code Assist API calls.
 *
 * This bridge allows the Claude Agent SDK to talk to Gemini models
 * as if they were Anthropic models, by:
 * 1. Receiving Anthropic-format requests on /v1/messages
 * 2. Converting to Gemini Code Assist format
 * 3. Making streaming requests to cloudcode-pa.googleapis.com
 * 4. Converting Gemini SSE responses back to Anthropic SSE format
 */

import { createLogger } from '@neokai/shared/logger';
import {
	contentBlockStartTextSSE,
	contentBlockStartToolUseSSE,
	contentBlockStopSSE,
	inputJsonDeltaSSE,
	messageDeltaSSE,
	messageStartSSE,
	messageStopSSE,
	textDeltaSSE,
	type AnthropicRequest,
} from '../codex-anthropic-bridge/translator.js';
import { createAnthropicErrorBody, type AnthropicErrorType } from '../shared/error-envelope.js';
import {
	type GeminiRequest,
	type GeminiResponseChunk,
	type GeminiStreamState,
	anthropicToGemini,
	convertFinishReason,
	createStreamState,
} from './format-converter.js';
import type { GoogleOAuthAccount } from './oauth-client.js';
import { refreshAccessToken } from './oauth-client.js';
import { AccountRotationManager } from './account-rotation.js';

const _log = createLogger('kai:providers:gemini:bridge');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeminiBridgeServer {
	port: number;
	stop(): void;
}

export interface GeminiBridgeConfig {
	rotationManager: AccountRotationManager;
	fetchImpl?: typeof fetch;
	sessionId?: string;
}

// ---------------------------------------------------------------------------
// Code Assist API endpoint
// ---------------------------------------------------------------------------

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent';

/** Maximum retry attempts for transient errors. */
const MAX_RETRIES = 3;

/** Status codes that trigger a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Bridge server (synchronous Bun.serve)
// ---------------------------------------------------------------------------

/**
 * Create a Gemini bridge server that speaks the Anthropic Messages API.
 *
 * Uses Bun.serve() for synchronous creation (required by the Provider interface).
 * The server listens on a random available port and translates incoming
 * Anthropic requests to Gemini Code Assist API calls.
 */
export function createGeminiBridgeServer(config: GeminiBridgeConfig): GeminiBridgeServer {
	const fetchImpl = config.fetchImpl ?? fetch;
	const rotationManager = config.rotationManager;
	const sessionId = config.sessionId ?? 'default';

	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			// Health check endpoint
			if (url.pathname === '/health' || url.pathname === '/v1/health') {
				return new Response('ok');
			}

			// Models endpoint (minimal)
			if (url.pathname === '/v1/models' && req.method === 'GET') {
				return new Response(
					JSON.stringify({
						data: [
							{ id: 'gemini-2.5-pro', type: 'model', display_name: 'Gemini 2.5 Pro' },
							{ id: 'gemini-2.5-flash', type: 'model', display_name: 'Gemini 2.5 Flash' },
						],
					}),
					{ headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Only handle /v1/messages POST
			if (url.pathname !== '/v1/messages' && url.pathname !== '/v1/messages/') {
				return new Response(createAnthropicErrorBody('not_found_error', 'Not found'), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (req.method !== 'POST') {
				return new Response(
					createAnthropicErrorBody('invalid_request_error', 'Method not allowed'),
					{ status: 405, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Parse request body
			let anthropicRequest: AnthropicRequest;
			try {
				anthropicRequest = (await req.json()) as AnthropicRequest;
			} catch {
				return new Response(createAnthropicErrorBody('invalid_request_error', 'Invalid JSON'), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Get an account for this session
			const account = await rotationManager.getAccountForSession(sessionId);

			if (!account) {
				return new Response(
					createAnthropicErrorBody(
						'api_error',
						'No Google OAuth accounts available. Add an account via the settings.'
					),
					{ status: 503, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Convert Anthropic request to Gemini request
			const geminiRequest = anthropicToGemini(anthropicRequest);

			// Make the streaming request to Gemini
			return handleGeminiRequest(
				geminiRequest,
				account,
				anthropicRequest,
				rotationManager,
				sessionId,
				fetchImpl
			);
		},
	});

	return {
		port: server.port ?? 0,
		stop: () => server.stop(),
	};
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleGeminiRequest(
	geminiRequest: GeminiRequest,
	account: GoogleOAuthAccount,
	anthropicRequest: AnthropicRequest,
	rotationManager: AccountRotationManager,
	sessionId: string,
	fetchImpl: typeof fetch
): Promise<Response> {
	// Get a fresh access token
	let accessToken: string;
	try {
		const tokenResponse = await refreshAccessToken(account.refresh_token, { fetchImpl });
		accessToken = tokenResponse.access_token;
	} catch (error) {
		// If the token is invalid, mark the account
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('invalid') || message.includes('revoked')) {
			await rotationManager.markInvalid(account.id);
		}
		return new Response(
			createAnthropicErrorBody(
				'authentication_error',
				`Failed to refresh token for ${account.email}: ${message}`
			),
			{ status: 401, headers: { 'Content-Type': 'application/json' } }
		);
	}

	// Make the streaming request with retries
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetchImpl(`${CODE_ASSIST_ENDPOINT}?alt=sse`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${accessToken}`,
				},
				body: JSON.stringify(geminiRequest),
			});

			// Handle rate limiting
			if (response.status === 429) {
				await rotationManager.handleRateLimit(account.id);

				// Try to get a different account
				const newAccount = await rotationManager.getAccountForSession(sessionId);
				if (newAccount && newAccount.id !== account.id) {
					return handleGeminiRequest(
						geminiRequest,
						newAccount,
						anthropicRequest,
						rotationManager,
						sessionId,
						fetchImpl
					);
				}

				return new Response(
					createAnthropicErrorBody('rate_limit_error', 'All accounts rate limited'),
					{ status: 429, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Handle server errors with retry
			if (!response.ok) {
				if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
					await response.text(); // consume body
					const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
					await sleep(delay);
					continue;
				}

				const errorText = await response.text();
				return new Response(
					createAnthropicErrorBody(mapStatusToAnthropicError(response.status), errorText),
					{ status: response.status, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Record successful request
			await rotationManager.recordRequest(account.id);

			if (!response.body) {
				return new Response(
					createAnthropicErrorBody('api_error', 'No response body from Gemini API'),
					{ status: 502, headers: { 'Content-Type': 'application/json' } }
				);
			}

			const isStreaming = anthropicRequest.stream !== false;

			if (isStreaming) {
				// Stream the response back in Anthropic SSE format
				return streamGeminiResponse(response, anthropicRequest.model);
			} else {
				// Non-streaming: collect all chunks and return as JSON
				return collectGeminiResponse(response, anthropicRequest.model);
			}
		} catch (error) {
			if (attempt < MAX_RETRIES && error instanceof TypeError) {
				// Network error — retry
				const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
				await sleep(delay);
				continue;
			}
			return new Response(
				createAnthropicErrorBody(
					'api_error',
					error instanceof Error ? error.message : 'Internal server error'
				),
				{ status: 500, headers: { 'Content-Type': 'application/json' } }
			);
		}
	}

	// All retries exhausted
	return new Response(createAnthropicErrorBody('api_error', 'All retries exhausted'), {
		status: 502,
		headers: { 'Content-Type': 'application/json' },
	});
}

// ---------------------------------------------------------------------------
// Streaming response handling
// ---------------------------------------------------------------------------

function streamGeminiResponse(geminiResponse: Response, model: string): Response {
	const state = createStreamState(model);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			// Send message_start event
			controller.enqueue(encoder.encode(messageStartSSE(state.messageId, model, 0)));

			if (!geminiResponse.body) {
				controller.enqueue(encoder.encode(messageDeltaSSE('end_turn', { outputTokens: 1 })));
				controller.enqueue(encoder.encode(messageStopSSE()));
				controller.close();
				return;
			}

			const reader = geminiResponse.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });

					// Parse SSE lines
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					let dataBuffer = '';

					for (const line of lines) {
						if (line.startsWith('data: ')) {
							dataBuffer += line.slice(6).trim();
						} else if (line === '' && dataBuffer) {
							// End of SSE event — process the data
							try {
								const chunk = JSON.parse(dataBuffer) as GeminiResponseChunk;
								const events = processGeminiChunk(chunk, state);
								for (const event of events) {
									controller.enqueue(encoder.encode(event));
								}
							} catch {
								// Skip malformed JSON chunks
							}
							dataBuffer = '';
						}
					}
				}

				// Process any remaining buffer
				if (buffer.startsWith('data: ')) {
					try {
						const chunk = JSON.parse(buffer.slice(6).trim()) as GeminiResponseChunk;
						const events = processGeminiChunk(chunk, state);
						for (const event of events) {
							controller.enqueue(encoder.encode(event));
						}
					} catch {
						// Skip
					}
				}
			} finally {
				reader.releaseLock();
			}

			// Close the message if not already done
			if (!state.finished) {
				controller.enqueue(
					encoder.encode(
						messageDeltaSSE('end_turn', { outputTokens: Math.max(state.outputTokens, 1) })
					)
				);
				controller.enqueue(encoder.encode(messageStopSSE()));
			}

			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

/**
 * Process a single Gemini response chunk and return Anthropic SSE events.
 */
function processGeminiChunk(chunk: GeminiResponseChunk, state: GeminiStreamState): string[] {
	const events: string[] = [];
	const response = chunk.response;
	if (!response) return events;

	// Update usage metadata
	if (response.usageMetadata) {
		state.inputTokens = response.usageMetadata.promptTokenCount ?? state.inputTokens;
		state.outputTokens = response.usageMetadata.candidatesTokenCount ?? state.outputTokens;
	}

	const candidates = response.candidates ?? [];
	for (const candidate of candidates) {
		if (!candidate.content?.parts) continue;

		for (const part of candidate.content.parts) {
			if (part.text !== undefined) {
				// Text content
				events.push(contentBlockStartTextSSE(state.contentBlockIndex));
				events.push(textDeltaSSE(state.contentBlockIndex, part.text));
				events.push(contentBlockStopSSE(state.contentBlockIndex));
				state.contentBlockIndex++;
				state.outputTokens += Math.ceil(part.text.length / 4);
			} else if (part.functionCall) {
				// Function call (tool use)
				const toolUseId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
				const argsJson = JSON.stringify(part.functionCall.args ?? {});

				events.push(
					contentBlockStartToolUseSSE(state.contentBlockIndex, toolUseId, part.functionCall.name)
				);
				events.push(inputJsonDeltaSSE(state.contentBlockIndex, argsJson));
				events.push(contentBlockStopSSE(state.contentBlockIndex));
				state.contentBlockIndex++;
			}
		}

		// Check finish reason
		if (candidate.finishReason) {
			const stopReason = convertFinishReason(candidate.finishReason);
			events.push(messageDeltaSSE(stopReason, { outputTokens: Math.max(state.outputTokens, 1) }));
			events.push(messageStopSSE());
			state.finished = true;
		}
	}

	return events;
}

/**
 * Collect a non-streaming Gemini response.
 */
async function collectGeminiResponse(geminiResponse: Response, model: string): Promise<Response> {
	const reader = geminiResponse.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	const chunks: GeminiResponseChunk[] = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		// Parse SSE lines
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		let dataBuffer = '';
		for (const line of lines) {
			if (line.startsWith('data: ')) {
				dataBuffer += line.slice(6).trim();
			} else if (line === '' && dataBuffer) {
				try {
					chunks.push(JSON.parse(dataBuffer) as GeminiResponseChunk);
				} catch {
					// Skip
				}
				dataBuffer = '';
			}
		}
	}

	// Combine chunks into a single Anthropic response
	const state = createStreamState(model);
	const contentBlocks: Array<Record<string, unknown>> = [];
	let stopReason = 'end_turn';
	let inputTokens = 0;
	let outputTokens = 0;

	for (const chunk of chunks) {
		if (!chunk.response) continue;

		if (chunk.response.usageMetadata) {
			inputTokens = chunk.response.usageMetadata.promptTokenCount ?? inputTokens;
			outputTokens = chunk.response.usageMetadata.candidatesTokenCount ?? outputTokens;
		}

		for (const candidate of chunk.response.candidates ?? []) {
			if (!candidate.content?.parts) continue;

			for (const part of candidate.content.parts) {
				if (part.text !== undefined) {
					contentBlocks.push({
						type: 'text',
						text: part.text,
					});
				} else if (part.functionCall) {
					contentBlocks.push({
						type: 'tool_use',
						id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
						name: part.functionCall.name,
						input: part.functionCall.args ?? {},
					});
					stopReason = 'tool_use';
				}
			}

			if (candidate.finishReason) {
				stopReason = convertFinishReason(candidate.finishReason);
			}
		}
	}

	return new Response(
		JSON.stringify({
			id: state.messageId,
			type: 'message',
			role: 'assistant',
			content: contentBlocks,
			model,
			stop_reason: stopReason,
			stop_sequence: null,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			},
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function mapStatusToAnthropicError(status: number): AnthropicErrorType {
	if (status === 401 || status === 403) return 'authentication_error';
	if (status === 404) return 'not_found_error';
	if (status === 429) return 'rate_limit_error';
	if (status >= 500) return 'api_error';
	return 'invalid_request_error';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
