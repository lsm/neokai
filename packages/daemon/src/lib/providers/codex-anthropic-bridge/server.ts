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
import { Database as BunDatabase } from 'bun:sqlite';
import {
	type AnthropicRequest,
	type AnthropicErrorType,
	type ToolResult,
	buildDynamicTools,
	buildConversationText,
	extractSystemText,
	extractLastUserMessage,
	isToolResultContinuation,
	extractToolResults,
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
import { estimateAnthropicInputTokens } from './token-estimator.js';
import { getModelContextWindow, type CodexBridgeModelId } from './model-context-windows.js';
import { Logger } from '../../logger.js';
import { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository.js';

const logger = new Logger('codex-bridge-server');

// ---------------------------------------------------------------------------
// Model catalogue for GET /v1/models stub
// ---------------------------------------------------------------------------
// The bridge server is model-agnostic (it receives the model in each request
// body), but the Claude Agent SDK calls GET /v1/models during initialisation
// for capability caching.  Returning 404 for this endpoint triggers a misleading
// "model not found" error in the SDK's CLI error handler.  We therefore expose
// a minimal Anthropic-compatible model listing that covers the models offered
// by the parent AnthropicToCodexBridgeProvider.

function bridgeModel({
	id,
	display_name,
	created_at,
}: {
	id: CodexBridgeModelId;
	display_name: string;
	created_at: string;
}) {
	const contextWindow = getModelContextWindow(id)!;
	const autoCompactTokenLimit = Math.floor(contextWindow * 0.9);
	return {
		id,
		display_name,
		created_at,
		max_input_tokens: contextWindow,
		context_window: contextWindow,
		max_context_window: contextWindow,
		model_context_window: contextWindow,
		auto_compact_token_limit: autoCompactTokenLimit,
		model_auto_compact_token_limit: autoCompactTokenLimit,
		max_tokens: 16384,
	};
}

const BRIDGE_MODELS = [
	bridgeModel({
		id: 'gpt-5.3-codex',
		display_name: 'GPT-5.3 Codex',
		created_at: '2025-12-01T00:00:00Z',
	}),
	bridgeModel({
		id: 'gpt-5.4',
		display_name: 'GPT-5.4',
		created_at: '2026-01-01T00:00:00Z',
	}),
	bridgeModel({
		id: 'gpt-5.5',
		display_name: 'GPT-5.5',
		created_at: '2026-04-01T00:00:00Z',
	}),
	bridgeModel({
		id: 'gpt-5.4-mini',
		display_name: 'GPT-5.4 Mini',
		created_at: '2026-01-01T00:00:00Z',
	}),
	bridgeModel({
		id: 'gpt-5.1-codex-mini',
		display_name: 'GPT-5.1 Codex Mini',
		created_at: '2026-01-01T00:00:00Z',
	}),
] as const;

const MODELS_LIST_RESPONSE = {
	data: BRIDGE_MODELS.map((m) => ({ ...m, type: 'model' as const })),
	has_more: false,
	first_id: BRIDGE_MODELS[0].id,
	last_id: BRIDGE_MODELS[BRIDGE_MODELS.length - 1].id,
};

const BRIDGE_MODEL_ALIASES = new Map<string, string>([
	['codex', 'gpt-5.3-codex'],
	['codex-5.4', 'gpt-5.4'],
	['codex-latest', 'gpt-5.5'],
	['codex-mini', 'gpt-5.4-mini'],
	['codex-5.1-mini', 'gpt-5.1-codex-mini'],
]);

function resolveBridgeModelId(model: string): string {
	return BRIDGE_MODEL_ALIASES.get(model) ?? model;
}

function isClosedControllerError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const maybeCodeError = error as Error & { code?: string };
	return (
		maybeCodeError.code === 'ERR_INVALID_STATE' ||
		error.message.includes('Controller is already closed')
	);
}

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
const MAX_SUBPROCESS_RETRIES = 1;
const MAX_ORPHANED_TOOL_RESULT_409_RETRIES = 3;

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
	/** Session ID for re-associating with persistent session on resume. */
	sessionId: string;
	/** TTL timer — fires if the HTTP client never sends the tool result. */
	cleanupTimer: ReturnType<typeof setTimeout>;
};

export type DrainResult =
	| { type: 'completed' }
	| { type: 'tool_call_suspended'; callId: string }
	| { type: 'error'; message: string; isSubprocessCrash: boolean };

function generateMsgId(): string {
	return `msg_${Math.random().toString(36).slice(2, 14)}`;
}

/** Extract session ID from Authorization header (format: Bearer codex-bridge-{sessionId}). */
function extractSessionId(req: Request): string {
	const auth = req.headers.get('Authorization') ?? req.headers.get('authorization') ?? '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
	if (token.startsWith('codex-bridge-')) return token.slice('codex-bridge-'.length);
	logger.warn('codex-bridge: no session ID in Authorization header, using default');
	return 'default';
}

/** Create a sorted comma-separated key from tool names — used to detect tool set changes. */
function toolsKey(anthropicTools: { name: string }[]): string {
	return anthropicTools
		.map((t) => t.name)
		.sort()
		.join(',');
}

function estimateLastMessageInputTokens(body: AnthropicRequest): number {
	const last = body.messages.at(-1);
	if (!last) return 0;
	return estimateAnthropicInputTokens({
		model: body.model,
		messages: [last],
	});
}

function isSubprocessCrashMessage(message: string): boolean {
	return message.toLowerCase().includes('subprocess closed');
}

/** Persistent Codex session across multiple conversation turns. */
type PersistentSession = {
	session: BridgeSession;
	model: string;
	/** Sorted comma-separated tool names — used to detect tool set changes. */
	toolsKey: string;
	/** True until the first turn/start has been called (system message injected then). */
	isFirstTurn: boolean;
	/** True while a turn is in progress — prevents concurrent turns on same session. */
	turnInProgress: boolean;
	/** Tool call IDs this persistent session is currently suspended on. */
	suspendedToolCallIds: Set<string>;
	/** Idle TTL timer — fires when no activity for IDLE_SESSION_TTL_MS. */
	idleTimer?: ReturnType<typeof setTimeout>;
};

/** How long (ms) a persistent session stays alive with no activity. */
const IDLE_SESSION_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// SSE drain loop — shared between new turns and tool continuations
// ---------------------------------------------------------------------------

export async function drainToSSE(
	gen: AsyncGenerator<import('./process-manager.js').BridgeEvent>,
	session: BridgeSession,
	model: string,
	toolSessions: Map<string, ToolSession>,
	controller: ReadableStreamDefaultController<Uint8Array>,
	ttlMs: number,
	sessionId: string,
	onTurnDone: () => void,
	onError?: () => void,
	initialInputTokens = 0,
	returnUncommittedSubprocessCrash = true,
	recoveryRepo?: ToolContinuationRecoveryRepository
): Promise<DrainResult> {
	const enc = new TextEncoder();
	const send = (s: string) => controller.enqueue(enc.encode(s));

	let textBlockOpen = false;
	let blockIndex = 0;
	let outputTokens = 0;
	let suspendedCallId: string | null = null;
	let modelContextWindow = getModelContextWindow(model);
	let messageCommitted = false;

	const commitMessage = () => {
		if (messageCommitted) return;
		const msgId = generateMsgId();
		send(messageStartSSE(msgId, model, initialInputTokens, modelContextWindow));
		messageCommitted = true;
	};

	const sendErrorAndClose = (message: string): DrainResult => {
		logger.error('codex-bridge: BridgeSession error:', message);
		if (!messageCommitted) {
			commitMessage();
		}
		if (textBlockOpen) {
			send(contentBlockStopSSE(blockIndex));
			textBlockOpen = false;
		}
		send(errorSSE('api_error', message));
		session.kill();
		onError?.();
		controller.close();
		return { type: 'error', message, isSubprocessCrash: false };
	};

	try {
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
				commitMessage();
				if (!textBlockOpen) {
					send(contentBlockStartTextSSE(blockIndex));
					textBlockOpen = true;
				}
				send(textDeltaSSE(blockIndex, event.text));
				outputTokens += Math.ceil(event.text.length / 4);
			} else if (event.type === 'tool_call') {
				commitMessage();
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
				// At tool_call time, thread/tokenUsage/updated has not yet fired (the model
				// hasn't finished the turn yet), so use the request-side estimate here.
				send(
					messageDeltaSSE('tool_use', {
						outputTokens,
						inputTokens: initialInputTokens,
						modelContextWindow,
					})
				);
				send(messageStopSSE());

				// Store the session so the next HTTP request can resume it.
				// Schedule a TTL timer to kill the subprocess if the client never
				// sends the tool result (e.g. HTTP client disconnected).
				const callId = event.callId;
				const cleanupTimer = setTimeout(() => {
					logger.warn(`codex-bridge: TTL expired, killing abandoned session callId=${callId}`);
					recoveryRepo?.markWaitingRebind(
						callId,
						'tool_result did not arrive before bridge TTL; execution moved to waiting_rebind'
					);
					session.kill();
					toolSessions.delete(callId);
				}, ttlMs);

				toolSessions.set(callId, {
					gen,
					session,
					provideResult: event.provideResult,
					model,
					sessionId,
					cleanupTimer,
				});
				try {
					recoveryRepo?.recordToolUse({ toolUseId: callId, sessionId, ttlMs });
				} catch (err) {
					logger.warn(
						`codex-bridge: failed to persist tool_use recovery mapping callId=${callId}:`,
						err
					);
				}
				suspendedCallId = callId;

				logger.debug(`codex-bridge: tool_call suspended callId=${callId}`);
				// End this HTTP response without closing the generator
				controller.close();
				return { type: 'tool_call_suspended', callId };
			} else if (event.type === 'turn_done') {
				commitMessage();
				if (textBlockOpen) {
					send(contentBlockStopSSE(blockIndex));
					textBlockOpen = false;
				}
				// event.outputTokens is populated from thread/tokenUsage/updated (v2 protocol)
				// or from legacy inline usage. Fall back to heuristic count if both are 0.
				const endOutputTokens = event.outputTokens > 0 ? event.outputTokens : outputTokens;
				const endInputTokens = event.inputTokens > 0 ? event.inputTokens : initialInputTokens;
				modelContextWindow = event.modelContextWindow ?? modelContextWindow;
				send(
					messageDeltaSSE('end_turn', {
						outputTokens: endOutputTokens,
						inputTokens: endInputTokens,
						cacheCreationInputTokens: event.cacheCreationInputTokens,
						cacheReadInputTokens: event.cacheReadInputTokens,
						modelContextWindow,
					})
				);
				send(messageStopSSE());
				onTurnDone();
				controller.close();
				return { type: 'completed' };
			} else if (event.type === 'error') {
				if (
					returnUncommittedSubprocessCrash &&
					!messageCommitted &&
					isSubprocessCrashMessage(event.message)
				) {
					logger.error('codex-bridge: BridgeSession error:', event.message);
					session.kill();
					onError?.();
					return { type: 'error', message: event.message, isSubprocessCrash: true };
				}
				return sendErrorAndClose(event.message);
			}
		}

		// Generator exhausted without turn_done — close gracefully
		commitMessage();
		if (textBlockOpen) {
			send(contentBlockStopSSE(blockIndex));
		}
		send(
			messageDeltaSSE('end_turn', {
				outputTokens: outputTokens,
				inputTokens: initialInputTokens,
				modelContextWindow,
			})
		);
		send(messageStopSSE());
		session.kill();
		onError?.();
		controller.close();
		return { type: 'completed' };
	} catch (error) {
		if (isClosedControllerError(error)) {
			logger.debug('codex-bridge: SSE controller already closed, ending stream drain');
			if (suspendedCallId) {
				const suspended = toolSessions.get(suspendedCallId);
				if (suspended) {
					clearTimeout(suspended.cleanupTimer);
					toolSessions.delete(suspendedCallId);
				}
			}
			onError?.();
			session.kill();
			return { type: 'error', message: String(error), isSubprocessCrash: false };
		}
		const message = error instanceof Error ? error.message : String(error);
		if (
			returnUncommittedSubprocessCrash &&
			!messageCommitted &&
			isSubprocessCrashMessage(message)
		) {
			logger.error('codex-bridge: BridgeSession error:', message);
			onError?.();
			session.kill();
			return { type: 'error', message, isSubprocessCrash: true };
		}
		return sendErrorAndClose(message);
	}
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
	/** SQLite DB path for durable tool continuation recovery. Defaults to DB_PATH. */
	dbPath?: string;
};

export type BridgeServer = {
	port: number;
	stop(): void;
};

export function createBridgeServer(config: BridgeServerConfig): BridgeServer {
	/** Active tool-call sessions waiting for tool results. */
	const toolSessions = new Map<string, ToolSession>();
	/** Persistent Codex sessions across multiple conversation turns. */
	const persistentSessions = new Map<string, PersistentSession>();
	const ttlMs = config.toolSessionTtlMs ?? DEFAULT_TOOL_SESSION_TTL_MS;
	const recoveryDbPath = config.dbPath ?? process.env.DB_PATH;
	const recoveryDb = recoveryDbPath ? new BunDatabase(recoveryDbPath) : null;
	const recoveryRepo = recoveryDb ? new ToolContinuationRecoveryRepository(recoveryDb) : null;
	if (recoveryRepo) {
		try {
			recoveryRepo.ensureSchema();
		} catch (err) {
			logger.warn('codex-bridge: failed to initialize tool continuation recovery store:', err);
		}
	}

	/** Helper: schedule idle cleanup for a persistent session. */
	function scheduleIdle(sessionId: string): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			const ps = persistentSessions.get(sessionId);
			if (ps) {
				logger.info(`codex-bridge: idle timeout, killing session ${sessionId}`);
				ps.session.kill();
				persistentSessions.delete(sessionId);
			}
		}, IDLE_SESSION_TTL_MS);
		timer.unref?.();
		return timer;
	}

	/** Retire a persistent session after its own suspended tool call can no longer resume. */
	function cleanupPersistentSession(sessionId: string, reason: string): void {
		const ps = persistentSessions.get(sessionId);
		if (!ps) return;
		logger.warn(`codex-bridge: cleaning up persistent session ${sessionId}: ${reason}`);
		ps.turnInProgress = false;
		ps.suspendedToolCallIds.clear();
		clearTimeout(ps.idleTimer);
		ps.session.kill();
		persistentSessions.delete(sessionId);
	}

	function shouldCleanupOrphanedContinuation(
		sessionId: string,
		toolResults: ToolResult[]
	): boolean {
		const ps = persistentSessions.get(sessionId);
		if (!ps?.turnInProgress || ps.suspendedToolCallIds.size === 0) {
			return false;
		}
		return toolResults.some((tr) => ps.suspendedToolCallIds.has(tr.toolUseId));
	}

	const server = Bun.serve({
		port: 0, // random available port
		idleTimeout: 0, // disable idle timeout — bridge server handles long-running SSE streams
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			// Health check
			if (url.pathname === '/health' || url.pathname === '/v1/health') {
				return new Response('ok');
			}

			// Model listing — the Claude Agent SDK calls this during init for
			// capability caching.  A 404 here would trigger a misleading "model
			// not found" error in the SDK's CLI error handler.
			if (url.pathname === '/v1/models' && req.method === 'GET') {
				return new Response(JSON.stringify(MODELS_LIST_RESPONSE), {
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Token counting — the SDK calls this for context usage. Codex
			// app-server does not expose a count endpoint, so use the bridge-local
			// deterministic estimator and let real app-server usage win at turn end.
			if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
				try {
					const body = (await req.json()) as AnthropicRequest;
					const sessionId = extractSessionId(req);
					const ps = persistentSessions.get(sessionId);
					const resolvedModel = resolveBridgeModelId(body.model);
					const currentToolsKey = toolsKey(body.tools ?? []);
					const shouldCountOnlyCurrentTurn =
						ps !== undefined &&
						!ps.isFirstTurn &&
						ps.model === resolvedModel &&
						ps.toolsKey === currentToolsKey;
					const inputTokens = shouldCountOnlyCurrentTurn
						? estimateLastMessageInputTokens(body)
						: estimateAnthropicInputTokens(body);
					return new Response(JSON.stringify({ input_tokens: inputTokens }), {
						headers: { 'Content-Type': 'application/json' },
					});
				} catch {
					return createAnthropicError(400, 'invalid_request_error', 'Bad Request');
				}
			}

			// Catch-all: return 501 instead of 404.  The SDK specifically maps
			// HTTP 404 to a user-facing "model not found" message regardless of
			// which endpoint returned it.  501 falls through to the generic
			// error handler which does not produce that misleading message.
			if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
				return createAnthropicError(501, 'not_implemented_error', 'Not implemented');
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

			if (body.tool_choice !== undefined) {
				logger.warn(
					`tool_choice is not supported by the Codex bridge and will be ignored (received: ${JSON.stringify(body.tool_choice)})`
				);
			}

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
					recoveryRepo?.markConsumed(tr.toolUseId);
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
					const sessionId = extractSessionId(req);
					if (shouldCleanupOrphanedContinuation(sessionId, toolResults)) {
						cleanupPersistentSession(sessionId, 'orphaned tool_result continuation');
					}
					let recoveryMessage =
						'Tool continuation expired or was already consumed. The Codex turn was reset; resend your message to continue.';
					let recoveryAction = 'unmapped';
					for (const tr of toolResults) {
						try {
							const mappingBefore = recoveryRepo?.getToolUse(tr.toolUseId) ?? null;
							const reason = mappingBefore
								? 'orphaned tool_result queued for deterministic recovery'
								: 'orphaned tool_result has no durable mapping';
							recoveryRepo?.queueContinuation({
								toolUseId: tr.toolUseId,
								sessionId,
								requestBody: body,
								reason,
								ttlMs,
							});
							const mappingAfter = recoveryRepo?.increment409(tr.toolUseId, reason) ?? null;
							if (mappingAfter && Date.now() <= mappingAfter.expiresAt) {
								if (mappingAfter.attempts409 >= MAX_ORPHANED_TOOL_RESULT_409_RETRIES) {
									const failReason =
										`orphaned tool_result circuit breaker tripped after ` +
										`${mappingAfter.attempts409} HTTP 409 retries`;
									recoveryRepo?.failToolUse(tr.toolUseId, failReason);
									recoveryAction = 'fail_forward';
									recoveryMessage = failReason;
								} else {
									recoveryAction = 'waiting_rebind';
									recoveryMessage =
										`Tool continuation queued for recovery: execution=${mappingAfter.executionId ?? 'unknown'} ` +
										`attempt=${mappingAfter.attempts409}/${MAX_ORPHANED_TOOL_RESULT_409_RETRIES}`;
								}
							}
						} catch (err) {
							logger.warn(
								`codex-bridge: failed to queue orphaned tool_result tool_use_id=${tr.toolUseId}:`,
								err
							);
						}
					}
					return createAnthropicError(
						409,
						'api_error',
						`${recoveryMessage} [recovery_action=${recoveryAction}]`
					);
				}

				const { gen, session, model: sessionModel, sessionId: tsSessionId } = primaryStored;
				const estimatedInputTokens = estimateLastMessageInputTokens(body);
				const toolContinuationPs = persistentSessions.get(tsSessionId);
				const onTurnDone = toolContinuationPs
					? () => {
							toolContinuationPs.turnInProgress = false;
							toolContinuationPs.idleTimer = scheduleIdle(tsSessionId);
						}
					: () => {
							primaryStored.session.kill();
						};
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						void drainToSSE(
							gen,
							session,
							sessionModel,
							toolSessions,
							controller,
							ttlMs,
							tsSessionId,
							onTurnDone,
							() => {
								// Error: clean up persistent session
								if (toolContinuationPs) {
									toolContinuationPs.turnInProgress = false;
									clearTimeout(toolContinuationPs.idleTimer);
									toolContinuationPs.session.kill();
									persistentSessions.delete(tsSessionId);
								}
							},
							estimatedInputTokens,
							false,
							recoveryRepo ?? undefined
						);
					},
				});
				return new Response(stream, { headers: sseHeaders });
			}

			// ------------------------------------------------------------------
			// New conversation turn: look up or create a persistent session
			// ------------------------------------------------------------------
			const neokaiSessionId = extractSessionId(req);
			const model = resolveBridgeModelId(body.model);
			const system = extractSystemText(body.system);
			const anthropicTools = body.tools ?? [];
			const dynamicTools = buildDynamicTools(anthropicTools);
			const originalToolNames = anthropicTools.map((t) => t.name);
			const currentToolsKey = toolsKey(anthropicTools);
			const createInitializedSession = async (): Promise<BridgeSession> => {
				const conn = AppServerConn.create(config.codexBinaryPath, config.cwd, config.auth);
				const session = new BridgeSession(
					conn,
					model,
					dynamicTools,
					config.cwd,
					config.auth,
					originalToolNames
				);
				await session.initialize();
				return session;
			};

			// Look up or create a persistent session
			let ps = persistentSessions.get(neokaiSessionId);
			if (ps && (ps.model !== model || ps.toolsKey !== currentToolsKey)) {
				// Model or tool set changed — retire the old session and start fresh
				clearTimeout(ps.idleTimer);
				ps.session.kill();
				persistentSessions.delete(neokaiSessionId);
				ps = undefined;
			}

			// Check for concurrent turn — return 409 if a turn is already in progress
			if (ps?.turnInProgress) {
				return createAnthropicError(
					409,
					'api_error',
					'A turn is already in progress for this session'
				);
			}

			let bridgeSession: BridgeSession;
			if (ps) {
				// Reuse existing session — cancel idle timer while the turn runs
				clearTimeout(ps.idleTimer);
				bridgeSession = ps.session;
			} else {
				// First turn for this NeoKai session — spin up a new Codex subprocess
				try {
					bridgeSession = await createInitializedSession();
				} catch (err) {
					logger.error('codex-bridge: failed to start BridgeSession:', err);
					return createAnthropicError(500, 'api_error', `Internal Server Error: ${String(err)}`);
				}
				ps = {
					session: bridgeSession,
					model,
					toolsKey: currentToolsKey,
					isFirstTurn: true,
					turnInProgress: false,
					suspendedToolCallIds: new Set(),
					idleTimer: undefined,
				};
				persistentSessions.set(neokaiSessionId, ps);
			}

			// Mark turn as in progress (ps is guaranteed to be defined at this point)
			ps!.turnInProgress = true;

			// Build the text to send Codex for this turn.
			// First turn: include the full conversation history (as structured text) so Codex
			// has context from any messages that pre-date the persistent session.
			// Subsequent turns: Codex already has the thread history — send only the new
			// user message to avoid duplicating context.
			const isFirstTurn = ps.isFirstTurn;
			let userText = isFirstTurn
				? buildConversationText(body.messages, system)
				: extractLastUserMessage(body.messages);
			ps.isFirstTurn = false;
			let estimatedInputTokens = isFirstTurn
				? estimateAnthropicInputTokens(body)
				: estimateLastMessageInputTokens(body);

			// Schedule idle timer on turn completion
			const capturedPs = ps!;
			const capturedSessionId = neokaiSessionId;
			const onTurnDone = () => {
				capturedPs.turnInProgress = false;
				capturedPs.suspendedToolCallIds.clear();
				capturedPs.idleTimer = scheduleIdle(capturedSessionId);
			};
			const onError = () => {
				// Error: clean up persistent session
				capturedPs.turnInProgress = false;
				capturedPs.suspendedToolCallIds.clear();
				clearTimeout(capturedPs.idleTimer);
				capturedPs.session.kill();
				persistentSessions.delete(capturedSessionId);
			};
			const sendUncommittedError = (
				controller: ReadableStreamDefaultController<Uint8Array>,
				message: string
			) => {
				const enc = new TextEncoder();
				const send = (s: string) => controller.enqueue(enc.encode(s));
				send(
					messageStartSSE(
						generateMsgId(),
						model,
						estimatedInputTokens,
						getModelContextWindow(model)
					)
				);
				send(errorSSE('api_error', message));
				send(messageStopSSE());
				controller.close();
			};

			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					void (async () => {
						let currentSession = bridgeSession;
						let retriesLeft = MAX_SUBPROCESS_RETRIES;

						while (true) {
							const gen = currentSession.startTurn(userText);
							const result = await drainToSSE(
								gen,
								currentSession,
								model,
								toolSessions,
								controller,
								ttlMs,
								capturedSessionId,
								onTurnDone,
								onError,
								estimatedInputTokens,
								true,
								recoveryRepo ?? undefined
							);

							if (result.type === 'completed' || result.type === 'tool_call_suspended') {
								if (result.type === 'tool_call_suspended') {
									capturedPs.suspendedToolCallIds.add(result.callId);
								}
								return;
							}

							if (!result.isSubprocessCrash) {
								return;
							}

							if (retriesLeft <= 0) {
								sendUncommittedError(controller, result.message);
								return;
							}

							retriesLeft--;
							logger.warn(
								'codex-bridge: subprocess crashed before output, retrying turn with a fresh session'
							);

							capturedPs.turnInProgress = true;
							clearTimeout(capturedPs.idleTimer);
							persistentSessions.set(capturedSessionId, capturedPs);

							try {
								const newSession = await createInitializedSession();
								capturedPs.session = newSession;
								capturedPs.isFirstTurn = false;
								currentSession = newSession;
								userText = buildConversationText(body.messages, system);
								estimatedInputTokens = estimateAnthropicInputTokens(body);
							} catch (err) {
								logger.error('codex-bridge: failed to restart BridgeSession:', err);
								capturedPs.turnInProgress = false;
								clearTimeout(capturedPs.idleTimer);
								capturedPs.session.kill();
								persistentSessions.delete(capturedSessionId);
								sendUncommittedError(
									controller,
									`Internal Server Error: ${err instanceof Error ? err.message : String(err)}`
								);
								return;
							}
						}
					})();
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
				recoveryRepo?.markWaitingRebind(
					callId,
					'bridge server stopped while tool_result was in-flight'
				);
				stored.session.kill();
				toolSessions.delete(callId);
				logger.debug(`codex-bridge: cleaned up suspended session callId=${callId} on stop`);
			}
			// Clean up persistent sessions
			for (const [sessionId, ps] of persistentSessions) {
				clearTimeout(ps.idleTimer);
				ps.session.kill();
				persistentSessions.delete(sessionId);
				logger.debug(`codex-bridge: cleaned up persistent session ${sessionId} on stop`);
			}
			recoveryDb?.close();
			server.stop();
		},
	};
}
