/**
 * Codex Anthropic Bridge — HTTP Server
 *
 * Exposes a POST /v1/messages endpoint that speaks the Anthropic Messages API
 * (server-sent events). Translates requests to Codex app-server invocations and
 * streams Anthropic-format SSE back to the caller.
 *
 * Tool use round-trips:
 *   1. First request  → Codex processes → emits tool_use SSE → HTTP response ends.
 *   2. Codex generator is suspended; session stored keyed by callId.
 *   3. Next request carries tool_result → resume generator → continue streaming.
 */

import { BridgeSession, AppServerConn, type AppServerAuth } from './process-manager.js';

export type { AppServerAuth } from './process-manager.js';
import {
	type AnthropicRequest,
	type AnthropicErrorType,
	buildDynamicTools,
	buildConversationText,
	extractSystemText,
	isToolResultContinuation,
	extractToolResults,
	pingSSE,
	messageStartSSE,
	contentBlockStartTextSSE,
	contentBlockStartToolUseSSE,
	textDeltaSSE,
	inputJsonDeltaSSE,
	contentBlockStopSSE,
	messageDeltaSSE,
	messageStopSSE,
	errorSSE,
} from './translator.js';
import { Logger } from '../../logger.js';

const logger = new Logger('codex-bridge-server');

// ---------------------------------------------------------------------------
// Anthropic JSON error envelope
// ---------------------------------------------------------------------------

/**
 * Build a JSON Response with an Anthropic-format error envelope body.
 * Shape: {"type":"error","error":{"type":"<errorType>","message":"<message>"}}
 */
export function createAnthropicError(
	httpStatus: number,
	type: AnthropicErrorType,
	message: string
): Response {
	return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
		status: httpStatus,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** Default TTL before an unresolved tool-call session is abandoned (5 min). */
export const DEFAULT_TOOL_SESSION_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Session state for tool-call round-trips
// ---------------------------------------------------------------------------

export type ToolSession = {
	/** The suspended generator — resume with provideResult then continue polling. */
	gen: AsyncGenerator<import('./process-manager.js').BridgeEvent>;
	/** The underlying BridgeSession — needed to kill the subprocess when done. */
	session: BridgeSession;
	/** Resolve with the tool result text to unblock the Codex read loop. */
	provideResult: (text: string) => void;
	/** Model from the original request — preserved across tool round-trips. */
	model: string;
	/** TTL timer — fires if the HTTP client never sends the tool result. */
	cleanupTimer: ReturnType<typeof setTimeout>;
};

function generateMsgId(): string {
	return `msg_${Math.random().toString(36).slice(2, 14)}`;
}

// ---------------------------------------------------------------------------
// SSE drain loop — shared between new turns and tool continuations
// ---------------------------------------------------------------------------

export async function drainToSSE(
	gen: AsyncGenerator<import('./process-manager.js').BridgeEvent>,
	session: BridgeSession,
	model: string,
	toolSessions: Map<string, ToolSession>,
	controller: ReadableStreamDefaultController<Uint8Array>,
	ttlMs: number
): Promise<void> {
	const enc = new TextEncoder();
	const send = (s: string) => controller.enqueue(enc.encode(s));

	let textBlockOpen = false;
	let blockIndex = 0;
	let outputTokens = 0;

	const msgId = generateMsgId();
	send(messageStartSSE(msgId, model, 0));
	send(pingSSE());

	// Use gen.next() manually instead of for-await-of.  The for-await-of
	// construct calls gen.return() on early exit (break / return), which
	// permanently closes the generator — preventing the next HTTP request
	// from resuming it after a tool_use round-trip.
	while (true) {
		const { value: event, done } = await gen.next();
		if (done) break;

		logger.debug(
			`drainToSSE event: ${event.type}${event.type === 'text_delta' ? ` text=${JSON.stringify((event as { text: string }).text)}` : ''}`
		);

		if (event.type === 'text_delta') {
			if (!textBlockOpen) {
				send(contentBlockStartTextSSE(blockIndex));
				textBlockOpen = true;
			}
			send(textDeltaSSE(blockIndex, event.text));
			outputTokens += Math.ceil(event.text.length / 4);
		} else if (event.type === 'tool_call') {
			// Close any open text block first
			if (textBlockOpen) {
				send(contentBlockStopSSE(blockIndex));
				blockIndex++;
				textBlockOpen = false;
			}
			// Emit the tool_use block
			send(contentBlockStartToolUseSSE(blockIndex, event.callId, event.toolName));
			send(inputJsonDeltaSSE(blockIndex, JSON.stringify(event.toolInput)));
			send(contentBlockStopSSE(blockIndex));
			send(messageDeltaSSE('tool_use', outputTokens));
			send(messageStopSSE());

			// Store the session so the next HTTP request can resume it.
			// Schedule a TTL timer to kill the subprocess if the client never
			// sends the tool result (e.g. HTTP client disconnected).
			const callId = event.callId;
			const cleanupTimer = setTimeout(() => {
				logger.warn(`codex-bridge: TTL expired, killing abandoned session callId=${callId}`);
				session.kill();
				toolSessions.delete(callId);
			}, ttlMs);

			toolSessions.set(callId, {
				gen,
				session,
				provideResult: event.provideResult,
				model,
				cleanupTimer,
			});

			logger.debug(`codex-bridge: tool_call suspended callId=${callId}`);
			// End this HTTP response without closing the generator
			controller.close();
			return;
		} else if (event.type === 'turn_done') {
			if (textBlockOpen) {
				send(contentBlockStopSSE(blockIndex));
				textBlockOpen = false;
			}
			send(messageDeltaSSE('end_turn', event.outputTokens ?? outputTokens));
			send(messageStopSSE());
			session.kill();
			controller.close();
			return;
		} else if (event.type === 'error') {
			logger.error('codex-bridge: BridgeSession error:', event.message);
			// Close any open text block before emitting the error event
			if (textBlockOpen) {
				send(contentBlockStopSSE(blockIndex));
				textBlockOpen = false;
			}
			// Emit an Anthropic-format error SSE event then close the stream
			send(errorSSE('api_error', event.message));
			session.kill();
			controller.close();
			return;
		}
	}

	// Generator exhausted without turn_done — close gracefully
	if (textBlockOpen) {
		send(contentBlockStopSSE(blockIndex));
	}
	send(messageDeltaSSE('end_turn', outputTokens));
	send(messageStopSSE());
	session.kill();
	controller.close();
}

// ---------------------------------------------------------------------------
// Bridge server factory
// ---------------------------------------------------------------------------

export type BridgeServerConfig = {
	/** Path to the `codex` binary. */
	codexBinaryPath: string;
	/** Auth passed to codex app-server (API key or ChatGPT OAuth tokens). */
	auth?: AppServerAuth;
	/** Working directory for Codex subprocess. */
	cwd: string;
	/** Milliseconds before an unresolved tool-call session is abandoned (default 5 min). */
	toolSessionTtlMs?: number;
};

export type BridgeServer = {
	port: number;
	stop(): void;
};

export function createBridgeServer(config: BridgeServerConfig): BridgeServer {
	/** Active tool-call sessions waiting for tool results. */
	const toolSessions = new Map<string, ToolSession>();
	const ttlMs = config.toolSessionTtlMs ?? DEFAULT_TOOL_SESSION_TTL_MS;

	const server = Bun.serve({
		port: 0, // random available port
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			// Health check
			if (url.pathname === '/health' || url.pathname === '/v1/health') {
				return new Response('ok');
			}

			if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
				return createAnthropicError(404, 'not_found_error', 'Not found');
			}

			let body: AnthropicRequest;
			try {
				body = (await req.json()) as AnthropicRequest;
			} catch {
				return createAnthropicError(400, 'invalid_request_error', 'Bad Request: invalid JSON');
			}

			const sseHeaders = {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
			};

			// ------------------------------------------------------------------
			// Tool-continuation: resume a suspended generator
			// ------------------------------------------------------------------
			if (isToolResultContinuation(body.messages)) {
				const toolResults = extractToolResults(body.messages);
				if (toolResults.length === 0) {
					return createAnthropicError(
						400,
						'invalid_request_error',
						'Bad Request: no tool_result found'
					);
				}

				// Iterate ALL tool results — the Anthropic API allows multiple tool_result
				// blocks in a single continuation request (one per parallel tool call).
				//
				// NOTE: The Codex app-server only ever emits one tool call per turn, because
				// each item/tool/call RPC handler blocks until its result is provided before
				// Codex can proceed to the next tool call. In practice there is therefore
				// always exactly one suspended ToolSession at continuation time. We still
				// handle the multi-result path correctly here for forward compatibility: if
				// Codex ever gains parallel tool-call support, this code will work without
				// changes.
				//
				// The first matched session's generator drives the resumed SSE stream.
				// All matched sessions have their Deferreds resolved. Unmatched tool_use_ids
				// produce a warning and are skipped (not silently dropped).
				let primaryStored: ToolSession | null = null;

				for (const tr of toolResults) {
					const stored = toolSessions.get(tr.toolUseId);
					if (!stored) {
						logger.warn(
							`codex-bridge: orphaned tool_result — no active session for tool_use_id=${tr.toolUseId}, skipping`
						);
						continue;
					}
					toolSessions.delete(tr.toolUseId);
					// Cancel the TTL timer — session is being resumed normally
					clearTimeout(stored.cleanupTimer);
					// Provide the tool result — this unblocks the Codex read loop for this call
					stored.provideResult(tr.text);
					if (!primaryStored) {
						primaryStored = stored;
					}
				}

				if (!primaryStored) {
					logger.error(
						`codex-bridge: no active sessions found for any tool_use_id in this continuation`
					);
					return createAnthropicError(
						404,
						'not_found_error',
						'Session not found for all tool_use_ids in this continuation'
					);
				}

				const { gen, session, model: sessionModel } = primaryStored;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						void drainToSSE(gen, session, sessionModel, toolSessions, controller, ttlMs);
					},
				});
				return new Response(stream, { headers: sseHeaders });
			}

			// ------------------------------------------------------------------
			// New conversation turn: spawn a fresh Codex session
			// ------------------------------------------------------------------
			const model = body.model;
			const system = extractSystemText(body.system);
			const userText = buildConversationText(body.messages, system);
			const anthropicTools = body.tools ?? [];
			const dynamicTools = buildDynamicTools(anthropicTools);
			const originalToolNames = anthropicTools.map((t) => t.name);

			let session: BridgeSession;
			try {
				const conn = AppServerConn.create(config.codexBinaryPath, config.cwd, config.auth);
				session = new BridgeSession(
					conn,
					model,
					dynamicTools,
					config.cwd,
					config.auth,
					originalToolNames
				);
				await session.initialize();
			} catch (err) {
				logger.error('codex-bridge: failed to start BridgeSession:', err);
				return createAnthropicError(500, 'api_error', `Internal Server Error: ${String(err)}`);
			}

			const gen = session.startTurn(userText);

			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					void drainToSSE(gen, session, model, toolSessions, controller, ttlMs);
				},
			});
			return new Response(stream, { headers: sseHeaders });
		},
	});

	const port = server.port!;
	logger.info(`codex-bridge: HTTP server listening on port ${port}`);

	return {
		port,
		stop(): void {
			// Clean up every suspended tool session before stopping the HTTP server.
			// For each entry: cancel the TTL timer (so it doesn't fire after cleanup)
			// and kill the underlying codex app-server subprocess.
			for (const [callId, stored] of toolSessions) {
				clearTimeout(stored.cleanupTimer);
				stored.session.kill();
				toolSessions.delete(callId);
				logger.debug(`codex-bridge: cleaned up suspended session callId=${callId} on stop`);
			}
			server.stop();
		},
	};
}
