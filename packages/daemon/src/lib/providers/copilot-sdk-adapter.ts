/**
 * GitHub Copilot SDK Adapter
 *
 * Transparent backend for AgentSession using @github/copilot-sdk, which
 * communicates with the copilot CLI via JSON-RPC 2.0 over stdio. This is
 * the TypeScript-SDK-based counterpart to the CLI adapter (which uses raw
 * NDJSON subprocesses).
 *
 * ## Architecture
 *
 * - `CopilotClient` (singleton per provider): manages the CLI subprocess
 *   lifecycle via JSON-RPC 2.0 over stdio.
 * - `CopilotSession` (per query): represents a single conversation. Sessions
 *   are created via `client.createSession()` and resumed via
 *   `client.resumeSession()` for multi-turn continuity.
 * - `AsyncMessageQueue<T>`: bridges the event-based CopilotSession API to
 *   an AsyncGenerator that the NeoKai query runner can consume.
 *
 * ## Communication Flow
 *
 * ```
 * NeoKai QueryRunner
 *   → copilotSdkQueryGenerator()    (async generator)
 *     → CopilotSession.send()       (JSON-RPC over stdio)
 *       → Copilot CLI binary        (autonomous tool execution)
 *       → session events            (message_delta, message, idle, error)
 *     → AsyncMessageQueue           (buffers events for async iteration)
 *   → yields SDKMessage sequence
 * ```
 *
 * ## Event to SDK Message Mapping
 *
 * | SDK Event                  | NeoKai SDK Message             |
 * |----------------------------|--------------------------------|
 * | `assistant.message_delta`  | `stream_event` (text_delta)    |
 * | `assistant.message`        | `SDKAssistantMessage`          |
 * | `session.error`            | `SDKResultMessage` (error)     |
 * | `session.idle`             | `SDKResultMessage` (success)   |
 *
 * @see packages/daemon/src/lib/providers/copilot-sdk-provider.ts
 */

import type { UUID } from 'crypto';
import type {
	SDKMessage,
	SDKUserMessage,
	SDKAssistantMessage,
	SDKSystemMessage,
	SDKResultMessage,
	SDKPartialAssistantMessage,
} from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
} from '@neokai/shared/provider/query-types';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { approveAll } from '@github/copilot-sdk';
import { generateUUID } from '@neokai/shared';
import { extractTextFromUserMessage } from './copilot-cli-adapter.js';
import { Logger } from '../logger.js';

const logger = new Logger('copilot-sdk-adapter');

// ---------------------------------------------------------------------------
// Async Message Queue — bridges event callbacks to async generator
// ---------------------------------------------------------------------------

/**
 * A minimal async queue that allows pushing items and consuming them via
 * async iteration. Bridges the event-based CopilotSession.on() API to an
 * AsyncGenerator that yields NeoKai SDK messages.
 *
 * - `push(item)`: delivers an item to the next waiting consumer, or buffers it.
 * - `close(err?)`: signals end-of-stream; pending and future consumers get
 *   `{ done: true }`. If `err` is provided, the error is recorded for the
 *   caller to inspect after iteration finishes.
 */
class AsyncMessageQueue<T> {
	private readonly items: T[] = [];
	private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void }> = [];
	private closed = false;
	/** Populated when close(err) is called; caller checks this after iteration. */
	closeError?: Error;

	push(item: T): void {
		if (this.closed) return;
		if (this.waiters.length > 0) {
			this.waiters.shift()!.resolve({ done: false, value: item });
		} else {
			this.items.push(item);
		}
	}

	close(err?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.closeError = err;
		for (const waiter of this.waiters) {
			waiter.resolve({ done: true, value: undefined as unknown as T });
		}
		this.waiters.length = 0;
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const q = this;
		return {
			next(): Promise<IteratorResult<T>> {
				if (q.items.length > 0) {
					return Promise.resolve({ done: false, value: q.items.shift()! });
				}
				if (q.closed) {
					return Promise.resolve({ done: true, value: undefined as unknown as T });
				}
				return new Promise<IteratorResult<T>>((resolve) => {
					q.waiters.push({ resolve });
				});
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CopilotSdkAdapterConfig {
	/** CopilotClient singleton provided by the provider */
	client: CopilotClient;
	/** Model ID to use (e.g., 'claude-sonnet-4.6', 'gpt-5.3-codex') */
	model: string;
	/** Working directory for CLI tool operations */
	cwd?: string;
	/** Resume an existing Copilot session by ID for multi-turn conversations */
	resumeSessionId?: string;
	/** Called with the new session ID so the provider can offer future resumption */
	onSessionId?: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers: build NeoKai SDK messages
// ---------------------------------------------------------------------------

/**
 * Build the system init message that begins every SDK query stream.
 */
export function createCopilotSdkSystemInitMessage(
	sessionId: string,
	options: ProviderQueryOptions
): SDKSystemMessage {
	return {
		type: 'system',
		subtype: 'init',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		cwd: options.cwd,
		model: options.model,
		permissionMode: (options.permissionMode as SDKSystemMessage['permissionMode']) || 'default',
		tools: [],
		mcp_servers: [],
		slash_commands: [],
		output_style: 'default',
		skills: [],
		plugins: [],
		apiKeySource: 'user',
		claude_code_version: 'copilot-sdk-adapter',
	};
}

/**
 * Build a `stream_event` NeoKai message from a single token delta.
 */
export function createCopilotSdkStreamEvent(
	sessionId: string,
	delta: string
): SDKPartialAssistantMessage {
	return {
		type: 'stream_event',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		parent_tool_use_id: null,
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'text_delta', text: delta },
		} as SDKPartialAssistantMessage['event'],
	};
}

/**
 * Convert a Copilot SDK `assistant.message` event data to an SDKAssistantMessage.
 *
 * Key differences from the CLI adapter:
 * - `data.content` is a plain string (not a content-block array)
 * - Tool call ID field is `toolCallId` (not `id` as in NDJSON mode)
 */
export function copilotSdkMessageToSdkAssistant(
	data: {
		messageId: string;
		content: string;
		reasoningText?: string;
		toolRequests?: Array<{
			toolCallId: string;
			name: string;
			arguments?: Record<string, unknown>;
		}>;
	},
	sessionId: string
): SDKAssistantMessage {
	const content: Array<
		| { type: 'text'; text: string }
		| { type: 'thinking'; thinking: string }
		| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	> = [];

	// Extended thinking from Anthropic models (e.g., Claude 3.7 Sonnet)
	if (data.reasoningText) {
		content.push({ type: 'thinking', thinking: data.reasoningText });
	}

	if (data.content) {
		content.push({ type: 'text', text: data.content });
	}

	// Tool requests are informational — the CLI executes them autonomously
	for (const req of data.toolRequests ?? []) {
		content.push({
			type: 'tool_use',
			id: req.toolCallId,
			name: req.name,
			input: req.arguments ?? {},
		});
	}

	return {
		type: 'assistant',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		parent_tool_use_id: null,
		message: { role: 'assistant', content },
	} as SDKAssistantMessage;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Main async generator for the Copilot SDK adapter.
 *
 * Creates or resumes a CopilotSession, sends the user prompt, and yields
 * NeoKai SDK messages by subscribing to session events. Bridges the
 * event-based SDK API to an async generator via `AsyncMessageQueue`.
 *
 * IMPORTANT: Like the CLI adapter, this consumes exactly ONE message from
 * the prompt generator. The Copilot CLI handles multi-turn tool execution
 * autonomously within a single session invocation.
 */
export async function* copilotSdkQueryGenerator(
	prompt: AsyncGenerator<SDKUserMessage>,
	options: ProviderQueryOptions,
	context: ProviderQueryContext,
	config: CopilotSdkAdapterConfig
): AsyncGenerator<SDKMessage, void, unknown> {
	const startTime = Date.now();

	yield createCopilotSdkSystemInitMessage(context.sessionId, options);

	// Consume exactly one message from the prompt generator
	const firstMsg = await prompt.next();
	if (firstMsg.done) {
		yield makeErrorResult(context.sessionId, startTime, 0, 'No user message provided');
		return;
	}

	if (context.signal.aborted) {
		yield makeErrorResult(context.sessionId, startTime, 0, 'Query aborted before start');
		return;
	}

	const promptText = extractTextFromUserMessage(firstMsg.value);
	if (!promptText.trim()) {
		yield makeErrorResult(context.sessionId, startTime, 0, 'Empty prompt');
		return;
	}

	const queue = new AsyncMessageQueue<SDKMessage>();
	let session: CopilotSession | undefined;
	let numTurns = 0;
	let accumulatedText = '';
	let caughtError: Error | undefined;

	const abortHandler = (): void => {
		logger.debug('Aborting Copilot SDK session');
		// Fire-and-forget: abort the session and close the queue
		void session?.abort().catch(() => {});
		queue.close(new Error('Query aborted'));
	};
	context.signal.addEventListener('abort', abortHandler);

	try {
		const sessionConfig = {
			model: config.model,
			onPermissionRequest: approveAll,
			streaming: true,
			workingDirectory: config.cwd ?? options.cwd,
		};

		// Create or resume a Copilot session
		session =
			config.resumeSessionId !== undefined
				? await config.client.resumeSession(config.resumeSessionId, sessionConfig)
				: await config.client.createSession(sessionConfig);

		if (config.onSessionId) {
			config.onSessionId(session.sessionId);
		}

		// Subscribe to session events — all handlers are fire-and-forget (SDK semantics)
		session.on('assistant.message_delta', (event) => {
			const delta = event.data.deltaContent;
			if (delta) {
				accumulatedText += delta;
				queue.push(createCopilotSdkStreamEvent(context.sessionId, delta));
			}
		});

		session.on('assistant.message', (event) => {
			numTurns++;
			// accumulatedText is already populated by message_delta events;
			// fall back to event.data.content only if streaming was disabled.
			if (!accumulatedText && event.data.content) {
				accumulatedText = event.data.content;
			}
			queue.push(
				copilotSdkMessageToSdkAssistant(
					{
						messageId: event.data.messageId,
						content: event.data.content,
						reasoningText: event.data.reasoningText,
						toolRequests: event.data.toolRequests?.map((r) => ({
							toolCallId: r.toolCallId,
							name: r.name,
							arguments: r.arguments,
						})),
					},
					context.sessionId
				)
			);
		});

		session.on('session.error', (event) => {
			logger.warn(`Copilot SDK session error [${event.data.errorType}]: ${event.data.message}`);
			// Record the error and close the queue; the result message is emitted below
			queue.close(new Error(`${event.data.errorType}: ${event.data.message}`));
		});

		session.on('session.idle', () => {
			// Agent is idle — all output has been delivered; close the queue
			queue.close();
		});

		// Send the prompt; session events are delivered asynchronously
		await session.send({ prompt: promptText });

		// Drain the queue, yielding each SDK message as it arrives
		for await (const msg of queue) {
			yield msg;
		}

		// Capture any error recorded when the queue was closed
		caughtError = queue.closeError;
	} catch (err) {
		caughtError = err instanceof Error ? err : new Error(String(err));
		logger.warn(`Copilot SDK adapter error: ${caughtError.message}`);
	} finally {
		context.signal.removeEventListener('abort', abortHandler);
		if (session) {
			// Disconnect releases in-memory resources; session data is preserved on disk
			await session.disconnect().catch(() => {});
		}
	}

	const durationMs = Date.now() - startTime;

	if (context.signal.aborted) {
		yield makeErrorResult(context.sessionId, startTime, numTurns, 'Query aborted');
		return;
	}

	if (caughtError) {
		yield makeErrorResult(
			context.sessionId,
			startTime,
			numTurns,
			`Copilot SDK error: ${caughtError.message}`
		);
		return;
	}

	yield {
		type: 'result',
		uuid: generateUUID() as UUID,
		session_id: context.sessionId,
		subtype: 'success',
		is_error: false,
		result: accumulatedText,
		stop_reason: 'end_turn',
		duration_ms: durationMs,
		duration_api_ms: durationMs,
		num_turns: numTurns || 1,
		total_cost_usd: 0,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
	} as SDKResultMessage;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function makeErrorResult(
	sessionId: string,
	startTime: number,
	numTurns: number,
	errorMsg: string
): SDKResultMessage {
	const durationMs = Date.now() - startTime;
	return {
		type: 'result',
		uuid: generateUUID() as UUID,
		session_id: sessionId,
		subtype: 'error_during_execution',
		is_error: true,
		errors: [errorMsg],
		stop_reason: errorMsg,
		duration_ms: durationMs,
		duration_api_ms: durationMs,
		num_turns: numTurns || 1,
		total_cost_usd: 0,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
	} as SDKResultMessage;
}
