/**
 * Embedded Anthropic-compatible HTTP server for GitHub Copilot.
 *
 * Starts a loopback HTTP server that implements the Anthropic messages API
 * (`POST /v1/messages`).  The Claude Agent SDK is pointed at this server via
 * `ANTHROPIC_BASE_URL` and communicates with it using the standard Anthropic
 * wire format — streaming, tool use, multi-turn — with no custom bridging.
 *
 * ## Request routing
 *
 *   POST /v1/messages   — Anthropic messages (streaming required)
 *   GET  /health        — Liveness probe
 *
 * ## Tool-use support
 *
 * When the request carries a `tools` array the server registers those tools as
 * Copilot SDK external tools.  When the model calls one of them:
 *
 *   1. A `tool_use` SSE block is emitted and the HTTP response is ended.
 *   2. The Copilot session remains alive — its tool handler is suspended.
 *   3. The next request (with `tool_result` messages) is routed to the same
 *      session via ConversationManager, which resumes the suspended handler.
 *
 * ## Session strategy
 *
 *   - No tools: new session per request (session-per-request model).
 *   - With tools: session reuse for tool-result continuation requests.
 *
 * The server uses one shared ConversationManager across all requests.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute } from 'node:path';
import type { CopilotClient, SessionConfig } from '@github/copilot-sdk';
import { isAnthropicRequest, type AnthropicRequest } from './types.js';
import { formatAnthropicPrompt, extractSystemText, extractToolResultIds } from './prompt.js';
import { ConversationManager } from './conversation.js';
import { runSessionStreaming, resumeSessionStreaming } from './streaming.js';
import { Logger } from '../../logger.js';

const logger = new Logger('copilot-anthropic-server');

/** Maximum request body size (10 MB). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let failed = false;

		req.on('data', (chunk: Buffer) => {
			if (failed) return;
			total += chunk.byteLength;
			if (total > MAX_BODY_BYTES) {
				failed = true;
				reject(Object.assign(new Error('Request body too large'), { code: 413 }));
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
		});
		req.on('error', reject);
	});
}

function sendJsonError(
	res: ServerResponse,
	status: number,
	type: 'invalid_request_error' | 'api_error',
	message: string
): void {
	const body = JSON.stringify({ type: 'error', error: { type, message } });
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(body);
}

// ---------------------------------------------------------------------------
// Session config for non-tool requests
// ---------------------------------------------------------------------------

/**
 * Extract the per-request working directory from the `Authorization` header.
 *
 * `CopilotAnthropicProvider.buildSdkConfig()` encodes the session workspace as
 * `copilot-anthropic-proxy:<path>` in `ANTHROPIC_AUTH_TOKEN`.  Parsing it here
 * lets the singleton embedded server apply the correct `cwd` per HTTP request
 * without rebuilding a new server for every session.
 */
/** @internal exported for unit tests only */
export function resolveRequestCwd(req: IncomingMessage, defaultCwd: string): string {
	const auth = (req.headers['authorization'] ?? '') as string;
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	const prefix = 'copilot-anthropic-proxy:';
	if (!token.startsWith(prefix)) return defaultCwd;
	const resolved = token.slice(prefix.length);
	return resolved && isAbsolute(resolved) ? resolved : defaultCwd;
}

function buildPlainSessionConfig(
	model: string,
	systemMessage: string | undefined,
	cwd: string
): SessionConfig {
	return {
		clientName: 'neokai-copilot-anthropic',
		model,
		streaming: true,
		infiniteSessions: { enabled: true },
		workingDirectory: cwd,
		...(systemMessage
			? { systemMessage: { mode: 'replace' as const, content: systemMessage } }
			: {}),
		onPermissionRequest: () => Promise.resolve({ kind: 'approved' as const }),
		onUserInputRequest: () =>
			Promise.resolve({
				answer: 'User input is not available. Ask your question in your response instead.',
				wasFreeform: true,
			}),
		hooks: {
			onPreToolUse: () => Promise.resolve({ permissionDecision: 'allow' as const }),
			onPostToolUse: () => {},
			onErrorOccurred: (input) => {
				logger.warn(
					`SDK error (${input.errorContext}, recoverable=${String(input.recoverable)}): ${String(input.error)}`
				);
				if (
					input.recoverable &&
					(input.errorContext === 'model_call' || input.errorContext === 'tool_execution')
				) {
					return { errorHandling: 'retry' as const, retryCount: 2 };
				}
				return undefined;
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleMessages(
	req: IncomingMessage,
	res: ServerResponse,
	client: CopilotClient,
	manager: ConversationManager,
	cwd: string
): Promise<void> {
	// 1. Read and parse body.
	let bodyText: string;
	try {
		bodyText = await readBody(req);
	} catch (err) {
		const status = (err as { code?: number }).code === 413 ? 413 : 400;
		sendJsonError(
			res,
			status,
			'invalid_request_error',
			status === 413 ? 'Request body exceeds 10 MB limit' : 'Failed to read request body'
		);
		return;
	}

	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch {
		sendJsonError(res, 400, 'invalid_request_error', 'Request body must be valid JSON');
		return;
	}

	if (!isAnthropicRequest(body)) {
		sendJsonError(
			res,
			400,
			'invalid_request_error',
			'Missing required fields: model, max_tokens, messages'
		);
		return;
	}

	if (body.stream === false) {
		sendJsonError(res, 400, 'invalid_request_error', 'Only streaming responses are supported');
		return;
	}

	const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
	const hasToolResults = extractToolResultIds(body.messages).length > 0;

	// 2a. Tool-result continuation: resume a suspended session.
	// Note: the Anthropic spec does not require clients to re-send the `tools`
	// array on follow-up requests, so we check hasToolResults unconditionally.
	if (hasToolResults) {
		const continuation = manager.findContinuation(body.messages);
		if (continuation) {
			const { conv, toolResults } = continuation;
			// Remove routing entries and cancel the TTL timer before resuming.
			// Actual Promise resolution happens inside resumeSessionStreaming.
			manager.acknowledgeContinuation(
				conv,
				toolResults.map((r) => r.toolUseId)
			);
			try {
				const outcome = await resumeSessionStreaming(
					conv.session,
					body.model,
					req,
					res,
					conv.registry,
					toolResults,
					() => {
						// Intentionally empty: no extra action is needed when the
						// resumed session finishes.  If the model emits another
						// tool_use, setOnPendingToolCall already registered the new
						// tool call ID in the registry before onDone fires, so the
						// next HTTP request will route correctly without any help here.
						// Cleanup (cleanupConversation / releaseConversation) is handled
						// below based on the StreamingOutcome kind.
					}
				);
				if (outcome.kind === 'completed') {
					// streamSession already called session.disconnect() — use
					// cleanupConversation (no disconnect) to avoid a double-disconnect.
					manager.cleanupConversation(conv);
				}
				// outcome.kind === 'tool_use': registry already registered the new
				// pending tool call ID so the next request will find the conversation.
			} catch (err) {
				logger.error('Error resuming conversation:', err);
				// Error path: streamSession may not have disconnected — releaseConversation
				// ensures the session is properly torn down.
				await manager.releaseConversation(conv);
				if (!res.headersSent) {
					sendJsonError(res, 500, 'api_error', 'Failed to resume session');
				}
			}
			return;
		}
		// No matching pending session — fall through to create a new one.
		// This can happen if the client re-sends a tool_result after the session
		// expired (TTL) or after a restart.
	}

	// 2b. New conversation (with or without tools).
	let prompt: string;
	try {
		prompt = formatAnthropicPrompt(body.messages);
	} catch (err) {
		sendJsonError(
			res,
			400,
			'invalid_request_error',
			err instanceof Error ? err.message : 'Prompt formatting failed'
		);
		return;
	}

	const systemMessage = extractSystemText(body.system);

	const requestCwd = resolveRequestCwd(req, cwd);
	if (hasTools) {
		await handleNewToolConversation(
			req,
			res,
			body,
			client,
			manager,
			systemMessage,
			prompt,
			requestCwd
		);
	} else {
		await handlePlainRequest(req, res, body, client, systemMessage, prompt, requestCwd);
	}
}

// ---------------------------------------------------------------------------
// New conversation — with tools (stateful session reuse)
// ---------------------------------------------------------------------------

async function handleNewToolConversation(
	req: IncomingMessage,
	res: ServerResponse,
	body: AnthropicRequest,
	client: CopilotClient,
	manager: ConversationManager,
	systemMessage: string | undefined,
	prompt: string,
	cwd: string
): Promise<void> {
	let conv;
	try {
		conv = await manager.createConversation(client, body.model, systemMessage, body.tools!, cwd);
	} catch (err) {
		logger.error('Failed to create tool conversation:', err);
		sendJsonError(res, 500, 'api_error', 'Failed to create session');
		return;
	}

	try {
		const outcome = await runSessionStreaming(
			conv.session,
			prompt,
			body.model,
			req,
			res,
			conv.registry
		);
		if (outcome.kind === 'completed') {
			// streamSession already called session.disconnect() — use
			// cleanupConversation (no disconnect) to avoid a double-disconnect.
			manager.cleanupConversation(conv);
		}
		// outcome.kind === 'tool_use': session stays alive, registry registered
		// the pending tool call ID — next request will find it.
	} catch (err) {
		logger.error('Streaming failed:', err);
		// Error path: releaseConversation ensures the session is disconnected.
		await manager.releaseConversation(conv);
		if (!res.headersSent) {
			sendJsonError(res, 500, 'api_error', err instanceof Error ? err.message : 'Internal error');
		}
	}
}

// ---------------------------------------------------------------------------
// Plain request — no tools (session-per-request)
// ---------------------------------------------------------------------------

async function handlePlainRequest(
	req: IncomingMessage,
	res: ServerResponse,
	body: AnthropicRequest,
	client: CopilotClient,
	systemMessage: string | undefined,
	prompt: string,
	cwd: string
): Promise<void> {
	const sessionConfig = buildPlainSessionConfig(body.model, systemMessage, cwd);

	let session;
	try {
		session = await client.createSession(sessionConfig);
	} catch (err) {
		logger.error('Failed to create Copilot session:', err);
		sendJsonError(res, 500, 'api_error', 'Failed to create session');
		return;
	}

	try {
		await runSessionStreaming(session, prompt, body.model, req, res);
	} catch (err) {
		logger.error('Streaming failed:', err);
		// Disconnect the session in case runSessionStreaming threw before its
		// internal finishCompleted() handler had a chance to run (resource leak guard).
		session.disconnect().catch(() => {});
		if (!res.headersSent) {
			sendJsonError(res, 500, 'api_error', err instanceof Error ? err.message : 'Internal error');
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmbeddedServer {
	/** Base URL of the embedded server, e.g. `http://127.0.0.1:PORT` */
	readonly url: string;
	/** Gracefully stop the server (waits for in-flight requests to finish). */
	stop(): Promise<void>;
}

/**
 * Start an embedded Anthropic-compatible HTTP server backed by a Copilot SDK client.
 *
 * The server listens on a random loopback port (`127.0.0.1:0`).  Pass the
 * returned `url` as `ANTHROPIC_BASE_URL` when constructing a Claude Agent SDK
 * session so all API calls are routed through this server.
 *
 * @param client  Initialised `CopilotClient` to create sessions with.
 * @param cwd     Working directory for Copilot sessions (default: `process.cwd()`).
 */
export function startEmbeddedServer(
	client: CopilotClient,
	cwd = process.cwd()
): Promise<EmbeddedServer> {
	const manager = new ConversationManager();

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? '';
		const method = req.method ?? '';

		if (method === 'POST' && (url === '/v1/messages' || url.startsWith('/v1/messages?'))) {
			handleMessages(req, res, client, manager, cwd).catch((err: unknown) => {
				logger.error('Unhandled error in handleMessages:', err);
				if (!res.headersSent) {
					sendJsonError(res, 500, 'api_error', 'Internal server error');
				}
			});
			return;
		}

		if (method === 'GET' && url === '/health') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Not found' } }));
	});

	return new Promise((resolve, reject) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as AddressInfo;
			const url = `http://127.0.0.1:${addr.port}`;
			logger.debug(`Embedded Anthropic server listening at ${url}`);

			resolve({
				url,
				stop: async () => {
					// Release all active tool-use conversations first so suspended
					// Promises are rejected and TTL timers are cleared before we
					// close the HTTP server.
					await manager.shutdown();
					return new Promise<void>((res, rej) => {
						server.close((err) => {
							if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
								rej(err);
							} else {
								res();
							}
						});
						server.closeAllConnections?.();
					});
				},
			});
		});

		server.on('error', reject);
	});
}
