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

import { BridgeSession, AppServerConn } from './process-manager.js';
import {
	type AnthropicRequest,
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
} from './translator.js';
import { Logger } from '../../logger.js';

const logger = new Logger('codex-bridge-server');

/** Default TTL before an unresolved tool-call session is abandoned (5 min). */
export const DEFAULT_TOOL_SESSION_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Session state for tool-call round-trips
// ---------------------------------------------------------------------------

type ToolSession = {
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

async function drainToSSE(
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
			// Emit a minimal error text block so the SDK gets a response
			if (!textBlockOpen) {
				send(contentBlockStartTextSSE(blockIndex));
			}
			send(textDeltaSSE(blockIndex, `[Codex error: ${event.message}]`));
			send(contentBlockStopSSE(blockIndex));
			send(messageDeltaSSE('end_turn', outputTokens));
			send(messageStopSSE());
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
	/** OpenAI API key passed to the Codex subprocess. */
	apiKey: string;
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
				return new Response('Not Found', { status: 404 });
			}

			let body: AnthropicRequest;
			try {
				body = (await req.json()) as AnthropicRequest;
			} catch {
				return new Response('Bad Request', { status: 400 });
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
					return new Response('Bad Request: no tool_result found', { status: 400 });
				}

				// For simplicity handle one tool result at a time (Codex sends one at a time)
				const tr = toolResults[0];
				const stored = toolSessions.get(tr.toolUseId);
				if (!stored) {
					logger.error(`codex-bridge: no active session for tool_use_id=${tr.toolUseId}`);
					return new Response('Session not found', { status: 404 });
				}
				toolSessions.delete(tr.toolUseId);

				// Cancel the TTL timer — session is being resumed normally
				clearTimeout(stored.cleanupTimer);

				const { gen, session, provideResult, model: sessionModel } = stored;
				// Provide the tool result — this unblocks the Codex read loop
				provideResult(tr.text);

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
			const dynamicTools = buildDynamicTools(body.tools ?? []);

			let session: BridgeSession;
			try {
				const conn = AppServerConn.create(config.codexBinaryPath, config.cwd, config.apiKey);
				session = new BridgeSession(conn, model, dynamicTools, config.cwd);
				await session.initialize();
			} catch (err) {
				logger.error('codex-bridge: failed to start BridgeSession:', err);
				return new Response(`Internal Server Error: ${String(err)}`, { status: 500 });
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
			server.stop();
		},
	};
}
