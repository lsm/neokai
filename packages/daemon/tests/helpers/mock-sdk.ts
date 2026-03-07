/**
 * Mock SDK Helpers for Offline Integration Tests
 *
 * Provides message builders and a mock query runner that feeds scripted
 * SDK messages through the real SDKMessageHandler pipeline. This exercises
 * the full harness (DB persistence, MessageHub broadcasting, state management,
 * metadata tracking) without making real API calls.
 *
 * ## How It Works
 *
 * `mockAgentSessionWithResponses()` replaces `queryRunner.start()` on the
 * AgentSession with a mock that:
 * 1. Starts the message queue (same as real)
 * 2. Consumes user messages from the queue (triggers state transitions)
 * 3. Feeds scripted SDK messages through `messageHandler.handleMessage()`
 * 4. Yields to event loop between messages (matches real async stream behavior)
 * 5. Cleans up (stops queue, clears pending messages)
 *
 * ## Multi-turn Support
 *
 * Pass `SDKMessage[][]` to script multi-turn conversations. Each inner array
 * is one turn's response. The mock consumes one user message per turn:
 *
 * ```ts
 * mockAgentSessionWithResponses(sessionManager, sessionId, [
 *   simpleTextResponse('First reply'),   // Turn 1
 *   simpleTextResponse('Second reply'),  // Turn 2
 * ]);
 * ```
 *
 * ## Usage — Transparent Mode (recommended)
 *
 * ```ts
 * // In beforeEach — tests look identical to online tests
 * ctx = await createTestApp();
 * installAutoMock(ctx, simpleTextResponse('Hello!'));
 *
 * // Test code — no mock references at all
 * const sessionId = await createSession(ctx);
 * await sendMessage(ctx, sessionId, 'Hi');
 * await waitForIdle(ctx.sessionManager, sessionId);
 * ```
 *
 * ## Usage — Manual Mode
 *
 * ```ts
 * mockAgentSessionWithResponses(ctx.sessionManager, sessionId, [...]);
 * await sendMessage(ctx, sessionId, 'Hi');
 * await waitForIdle(ctx.sessionManager, sessionId);
 * ```
 */

import type { UUID } from 'crypto';
import { randomUUID } from 'crypto';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { SessionManager } from '../../src/lib/session-manager';

// ============================================================================
// Message Builders
// ============================================================================

/**
 * Create a system init message (first message in every SDK session)
 */
export function sdkSystemInit(opts?: { sessionId?: string; slashCommands?: string[] }): SDKMessage {
	return {
		type: 'system',
		subtype: 'init',
		uuid: randomUUID() as UUID,
		session_id: opts?.sessionId || randomUUID(),
		slash_commands: opts?.slashCommands || [],
	} as unknown as SDKMessage;
}

/**
 * Create an assistant text message
 */
export function sdkAssistantText(text: string): SDKMessage {
	return {
		type: 'assistant',
		uuid: randomUUID() as UUID,
		session_id: '',
		parent_tool_use_id: null,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text }],
		},
	} as unknown as SDKMessage;
}

/**
 * Create an assistant message with tool use
 */
export function sdkAssistantToolUse(
	toolName: string,
	input: Record<string, unknown>,
	opts?: { text?: string; toolUseId?: string }
): SDKMessage {
	const content: unknown[] = [];
	if (opts?.text) {
		content.push({ type: 'text', text: opts.text });
	}
	const toolUseId = opts?.toolUseId || `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
	content.push({
		type: 'tool_use',
		id: toolUseId,
		name: toolName,
		input,
	});

	return {
		type: 'assistant',
		uuid: randomUUID() as UUID,
		session_id: '',
		parent_tool_use_id: null,
		message: {
			role: 'assistant',
			content,
		},
	} as unknown as SDKMessage;
}

/**
 * Create a tool result message (response to a tool use)
 */
export function sdkToolResult(
	toolUseId: string,
	output: string,
	opts?: { isError?: boolean }
): SDKMessage {
	return {
		type: 'assistant',
		uuid: randomUUID() as UUID,
		session_id: '',
		parent_tool_use_id: toolUseId,
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: toolUseId,
					content: output,
					is_error: opts?.isError ?? false,
				},
			],
		},
	} as unknown as SDKMessage;
}

/**
 * Create a successful result message (end of turn)
 *
 * NOTE: Defaults to zero tokens to avoid triggering internal /context
 * command queuing, which would block in the mock. Pass non-zero tokens
 * only when using `mockAgentSessionWithFullConsumer()` (future).
 */
export function sdkResultSuccess(opts?: {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}): SDKMessage {
	return {
		type: 'result',
		subtype: 'success',
		uuid: randomUUID() as UUID,
		session_id: '',
		usage: {
			input_tokens: opts?.inputTokens ?? 0,
			output_tokens: opts?.outputTokens ?? 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		total_cost_usd: opts?.costUsd ?? 0,
	} as unknown as SDKMessage;
}

/**
 * Create an error result message
 */
export function sdkResultError(
	subtype:
		| 'error_during_execution'
		| 'error_max_turns'
		| 'error_max_budget_usd' = 'error_during_execution',
	errorMessage?: string
): SDKMessage {
	return {
		type: 'result',
		subtype,
		uuid: randomUUID() as UUID,
		session_id: '',
		error: errorMessage || 'An error occurred',
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		total_cost_usd: 0,
	} as unknown as SDKMessage;
}

/**
 * Create a user message replay (SDK echoes back the user's message)
 */
export function sdkUserReplay(
	text: string,
	opts?: { uuid?: string; sessionId?: string }
): SDKMessage {
	return {
		type: 'user',
		uuid: (opts?.uuid || randomUUID()) as UUID,
		session_id: opts?.sessionId || '',
		parent_tool_use_id: null,
		message: {
			role: 'user',
			content: [{ type: 'text', text }],
		},
	} as unknown as SDKMessage;
}

// ============================================================================
// Pre-built Scenarios
// ============================================================================

/**
 * Simple text response: init → assistant text → result
 */
export function simpleTextResponse(text: string): SDKMessage[] {
	return [sdkSystemInit(), sdkAssistantText(text), sdkResultSuccess()];
}

/**
 * Tool use response: init → assistant with tool call → result
 */
export function toolUseResponse(
	toolName: string,
	input: Record<string, unknown>,
	opts?: { text?: string }
): SDKMessage[] {
	return [sdkSystemInit(), sdkAssistantToolUse(toolName, input, opts), sdkResultSuccess()];
}

/**
 * Full tool use flow: init → tool call → tool result → assistant text → result
 */
export function toolUseWithResultResponse(
	toolName: string,
	input: Record<string, unknown>,
	output: string,
	opts?: { finalText?: string }
): SDKMessage[] {
	const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
	return [
		sdkSystemInit(),
		sdkAssistantToolUse(toolName, input, { toolUseId }),
		sdkToolResult(toolUseId, output),
		sdkAssistantText(opts?.finalText ?? `Tool ${toolName} completed.`),
		sdkResultSuccess(),
	];
}

/**
 * Error response: init → error result
 */
export function errorResponse(errorMessage?: string): SDKMessage[] {
	return [sdkSystemInit(), sdkResultError('error_during_execution', errorMessage)];
}

// ============================================================================
// Types
// ============================================================================

/**
 * Response factory type — produces SDK messages for each query.
 * Can be:
 * - SDKMessage[]   — single-turn, same response every time
 * - SDKMessage[][]  — multi-turn, each inner array is one turn
 * - () => SDKMessage[] | SDKMessage[][] — factory called per query
 */
export type MockResponseFactory =
	| SDKMessage[]
	| SDKMessage[][]
	| (() => SDKMessage[] | SDKMessage[][]);

/**
 * Normalize response factory output to multi-turn format (SDKMessage[][]).
 * Single-turn SDKMessage[] is wrapped into [[...messages]].
 */
function normalizeTurns(messages: SDKMessage[] | SDKMessage[][]): SDKMessage[][] {
	if (messages.length === 0) return [[]];
	// If first element is an array, it's already multi-turn
	if (Array.isArray(messages[0])) return messages as SDKMessage[][];
	// Single-turn: wrap in outer array
	return [messages as SDKMessage[]];
}

// ============================================================================
// Agent Session Mock
// ============================================================================

/**
 * Replace an AgentSession's query runner with a mock that feeds scripted
 * SDK messages through the real SDKMessageHandler pipeline.
 *
 * This bypasses the SDK entirely — no auth, no providers, no API calls —
 * while exercising the full message handling pipeline:
 * - DB persistence (saveSDKMessage)
 * - MessageHub broadcasting (state.sdkMessages.delta)
 * - State management (processing → idle)
 * - Metadata tracking (messageCount, toolCallCount)
 * - Circuit breaker
 * - Session update events
 *
 * Messages are fed asynchronously with event loop yields between each,
 * matching the real SDK's `for await` stream behavior.
 *
 * @param sessionManager - The SessionManager instance
 * @param sessionId - The session ID to mock
 * @param messages - SDK messages: SDKMessage[] for single-turn, SDKMessage[][] for multi-turn
 * @returns The mocked AgentSession or null if not found
 */
export function mockAgentSessionWithResponses(
	sessionManager: SessionManager,
	sessionId: string,
	messages: SDKMessage[] | SDKMessage[][] | (() => SDKMessage[] | SDKMessage[][])
): ReturnType<typeof sessionManager.getSession> | null {
	const agentSession = sessionManager.getSession(sessionId);
	if (!agentSession) return null;

	// biome-ignore lint/suspicious/noExplicitAny: accessing private fields for test mock
	const ctx = agentSession as any;
	const getMessages = typeof messages === 'function' ? messages : () => messages;

	// Replace queryRunner.start() with mock implementation
	ctx.queryRunner.start = async () => {
		const { messageQueue, messageHandler, stateManager } = ctx;

		if (messageQueue.isRunning()) return;

		messageQueue.start();
		ctx._queryGeneration++;
		ctx.firstMessageReceived = false;

		const currentGen = ctx._queryGeneration;

		ctx.queryPromise = (async () => {
			const gen = messageQueue.messageGenerator(sessionId);
			const turns = normalizeTurns(getMessages());

			try {
				// Process each turn by consuming one user message per turn
				for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
					// Wait for and consume a user message from the queue.
					// This unblocks the enqueueWithId promise and triggers state transitions.
					const next = await gen.next();
					if (!next.value || next.done) break;

					const { message, onSent } = next.value;
					const isInternal = (message as Record<string, unknown>).internal || false;
					if (!isInternal) {
						await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
					}
					onSent();

					ctx.firstMessageReceived = true;

					// Feed scripted SDK messages for this turn
					const turnMessages = turns[turnIndex];

					for (const msg of turnMessages) {
						// Yield to event loop between messages — matches real SDK's
						// `for await` stream behavior where each message arrives asynchronously
						await Bun.sleep(0);
						await messageHandler.handleMessage(msg);
					}
				}
			} catch (error) {
				// Mimics real QueryRunner error handling
				ctx.logger?.error?.('[MockSDK] Error processing messages:', error);
			} finally {
				if (ctx._queryGeneration === currentGen) {
					// Clean up pending messages (e.g., internal /context that was never consumed)
					messageQueue.clear();
					messageQueue.stop();
					ctx.queryPromise = null;

					// Return the generator to ensure proper cleanup
					try {
						await gen.return();
					} catch {
						// Ignore generator cleanup errors
					}

					// Always set idle in finally — matches real QueryRunner behavior.
					// handleResultMessage also calls setIdle() for success results,
					// but error results skip it. The real QueryRunner always calls
					// setIdle() in its finally block as a safety net.
					if (!ctx._isCleaningUp) {
						await stateManager.setIdle();
					}
				}
			}
		})();
	};

	return agentSession;
}

// ============================================================================
// Auto-Mock (Transparent Mode)
// ============================================================================

/**
 * Minimal interface for installAutoMock — works with both TestContext and DaemonAppContext.
 */
export interface MockableContext {
	sessionManager: SessionManager;
	eventBus: { on: (event: string, handler: (data: { sessionId: string }) => void) => void };
}

/**
 * Install auto-mocking so every new session automatically gets its query
 * runner replaced with the mock pipeline.
 *
 * After calling this, test code is completely transparent — identical to
 * online tests. No `mockAgentSessionWithResponses()` calls needed.
 *
 * @param ctx - Any context with sessionManager and eventBus (TestContext, DaemonAppContext)
 * @param responses - Default responses for all sessions
 * @returns Controls object to change responses per-session or globally
 *
 * @example
 * ```ts
 * const mock = installAutoMock(ctx, simpleTextResponse('Hello!'));
 *
 * // Test code looks identical to online tests
 * const sessionId = await createSession();
 * await sendMessage(sessionId, 'Hi');
 * await waitForIdle(ctx.sessionManager, sessionId);
 *
 * // Optionally override for specific sessions
 * mock.setResponses(sessionId, errorResponse('Boom'));
 * ```
 */
export function installAutoMock(
	ctx: MockableContext,
	responses: MockResponseFactory
): MockControls {
	const controls = new MockControls(responses);

	// Listen for session.created and auto-apply mock
	ctx.eventBus.on('session.created', async (data: { sessionId: string }) => {
		const { sessionId } = data;
		const sessionResponses = controls.getResponses(sessionId);
		mockAgentSessionWithResponses(ctx.sessionManager, sessionId, sessionResponses);
	});

	return controls;
}

/**
 * Controls for the auto-mock — allows per-session response overrides.
 */
export class MockControls {
	private defaultResponses: MockResponseFactory;
	private sessionOverrides = new Map<string, MockResponseFactory>();

	constructor(defaultResponses: MockResponseFactory) {
		this.defaultResponses = defaultResponses;
	}

	/** Override responses for a specific session */
	setResponses(sessionId: string, responses: MockResponseFactory): void {
		this.sessionOverrides.set(sessionId, responses);
	}

	/** Change the default responses for all future sessions */
	setDefaultResponses(responses: MockResponseFactory): void {
		this.defaultResponses = responses;
	}

	/** Get the response factory for a session (override or default) */
	getResponses(sessionId: string): MockResponseFactory {
		return this.sessionOverrides.get(sessionId) ?? this.defaultResponses;
	}
}

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Wait for a session to return to idle state.
 * Polls the processing state until idle or timeout.
 */
export async function waitForIdle(
	sessionManager: SessionManager,
	sessionId: string,
	timeout = 5000
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		// biome-ignore lint/suspicious/noExplicitAny: accessing internal state for test
		const agentSession = sessionManager.getSession(sessionId) as any;
		if (agentSession) {
			const state = agentSession.stateManager.getState();
			if (state.status === 'idle' && !agentSession.queryPromise) {
				return;
			}
		}
		await Bun.sleep(50);
	}
	throw new Error(`Session ${sessionId} did not reach idle within ${timeout}ms`);
}

/** @deprecated Use `waitForIdle` instead */
export const waitForMockIdle = waitForIdle;

// ============================================================================
// Script-Based Mock System
// ============================================================================

/**
 * Script-based mock system for more declarative response scripting.
 *
 * ## Script Format
 *
 * Each line in the script can be:
 *
 * - `500ms` - Pause for 500ms before the next message
 * - `builtin:system:init` - Generate a system init message
 * - `builtin:result` - Generate a success result message
 * - `builtin:result:tokens:100:50` - Success with custom tokens (input:output)
 * - `builtin:error` - Generate an error result
 * - `builtin:error:rate_limit` - Generate a rate_limit error result
 * - `ENV_VAR_NAME` - Look up env var and use its value as JSON message
 * - `{"type": "assistant", ...}` - Raw JSON object (returned as-is)
 *
 * ## Example
 *
 * ```ts
 * process.env.NEOKAI_MOCK_SCRIPT = `
 *   builtin:system:init
 *   100ms
 *   {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Hello!"}]}}
 *   builtin:result
 * `;
 *
 * installScriptAutoMock(ctx);
 * ```
 *
 * ## Multi-turn Support
 *
 * Use `---` to separate turns. Each turn consumes one user message:
 *
 * ```
 * builtin:system:init
 * builtin:result
 * ---
 * builtin:system:init
 * builtin:error
 * ```
 */

/**
 * Built-in message generators
 */
const BUILTIN_MESSAGES: Record<string, () => SDKMessage> = {
	'system:init': () => sdkSystemInit(),
	result: () => sdkResultSuccess({ inputTokens: 1, outputTokens: 1 }),
	error: () => sdkResultError('error_during_execution', 'Mock error'),
	'error:rate_limit': () =>
		({
			type: 'result',
			subtype: 'error_during_execution',
			uuid: randomUUID() as UUID,
			session_id: '',
			error: 'rate_limit_error',
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			total_cost_usd: 0,
		}) as unknown as SDKMessage,
};

/**
 * Parse a single line of the script and return either a delay or a message.
 */
function parseScriptLine(line: string): { delay?: number; message?: SDKMessage } {
	const trimmed = line.trim();

	// Empty line - skip
	if (!trimmed) {
		return {};
	}

	// Delay: "500ms" or "100ms"
	const delayMatch = trimmed.match(/^(\d+)ms$/);
	if (delayMatch) {
		return { delay: parseInt(delayMatch[1], 10) };
	}

	// Built-in message: "builtin:system:init", "builtin:result", "builtin:error:rate_limit"
	if (trimmed.startsWith('builtin:')) {
		const builtinKey = trimmed.slice(8); // Remove "builtin:" prefix
		const generator = BUILTIN_MESSAGES[builtinKey];
		if (generator) {
			return { message: generator() };
		}

		// Handle "builtin:result:tokens:100:50" format
		if (builtinKey.startsWith('result:tokens:')) {
			const parts = builtinKey.split(':');
			if (parts.length === 4) {
				const inputTokens = parseInt(parts[2], 10);
				const outputTokens = parseInt(parts[3], 10);
				return { message: sdkResultSuccess({ inputTokens, outputTokens }) };
			}
		}

		// Unknown builtin - treat as error
		return { message: sdkResultError('error_during_execution', `Unknown builtin: ${builtinKey}`) };
	}

	// JSON object - parse and return
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed);
			// Add required fields if missing
			if (!parsed.uuid) parsed.uuid = randomUUID();
			if (!parsed.session_id) parsed.session_id = '';
			return { message: parsed as SDKMessage };
		} catch (e) {
			return { message: sdkResultError('error_during_execution', `Invalid JSON: ${trimmed}`) };
		}
	}

	// Environment variable reference - look up and parse as JSON
	const envValue = process.env[trimmed];
	if (envValue !== undefined) {
		try {
			const parsed = JSON.parse(envValue);
			if (!parsed.uuid) parsed.uuid = randomUUID();
			if (!parsed.session_id) parsed.session_id = '';
			return { message: parsed as SDKMessage };
		} catch {
			// If not valid JSON, treat as plain text assistant message
			return { message: sdkAssistantText(envValue) };
		}
	}

	// Unknown format - treat as error
	return { message: sdkResultError('error_during_execution', `Unknown script line: ${trimmed}`) };
}

/**
 * Parse a full script into turns (array of arrays of message generators).
 *
 * @param script - The script string
 * @returns Array of turns, each turn is array of { delay?, message }
 */
export function parseMockScript(
	script: string
): Array<Array<{ delay?: number; message?: SDKMessage }>> {
	const turns: Array<Array<{ delay?: number; message?: SDKMessage }>> = [];
	let currentTurn: Array<{ delay?: number; message?: SDKMessage }> = [];

	for (const line of script.split('\n')) {
		const trimmed = line.trim();

		// Turn separator
		if (trimmed === '---') {
			if (currentTurn.length > 0) {
				turns.push(currentTurn);
				currentTurn = [];
			}
			continue;
		}

		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		const parsed = parseScriptLine(trimmed);
		if (parsed.delay !== undefined || parsed.message !== undefined) {
			currentTurn.push(parsed);
		}
	}

	if (currentTurn.length > 0) {
		turns.push(currentTurn);
	}

	return turns;
}

/**
 * Create a response factory from a script.
 *
 * @param script - The script string
 * @returns MockResponseFactory compatible with existing mock system
 */
export function scriptToResponseFactory(script: string): MockResponseFactory {
	return () => {
		const turns = parseMockScript(script);
		// Convert to SDKMessage[][] format for the existing mock system
		return turns.map((turn) => {
			const messages: SDKMessage[] = [];
			for (const item of turn) {
				if (item.message) {
					messages.push(item.message);
				}
			}
			return messages;
		});
	};
}

/**
 * Create a script-based mock with timing support.
 *
 * Unlike scriptToResponseFactory, this actually applies the delays between messages.
 * Use this when you need to test timing-sensitive behavior.
 *
 * @param sessionManager - The SessionManager instance
 * @param sessionId - The session ID to mock
 * @param script - The script string
 */
export function mockAgentSessionWithScript(
	sessionManager: SessionManager,
	sessionId: string,
	script: string
): ReturnType<typeof sessionManager.getSession> | null {
	const agentSession = sessionManager.getSession(sessionId);
	if (!agentSession) return null;

	// biome-ignore lint/suspicious/noExplicitAny: accessing private fields for test mock
	const ctx = agentSession as any;
	const turns = parseMockScript(script);

	// Replace queryRunner.start() with mock implementation that respects timing
	ctx.queryRunner.start = async () => {
		const { messageQueue, messageHandler, stateManager } = ctx;

		if (messageQueue.isRunning()) return;

		messageQueue.start();
		ctx._queryGeneration++;
		ctx.firstMessageReceived = false;

		const currentGen = ctx._queryGeneration;

		ctx.queryPromise = (async () => {
			const gen = messageQueue.messageGenerator(sessionId);

			try {
				// Process each turn by consuming one user message per turn
				for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
					const next = await gen.next();
					if (!next.value || next.done) break;

					const { message, onSent } = next.value;
					const isInternal = (message as Record<string, unknown>).internal || false;
					if (!isInternal) {
						await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
					}
					onSent();

					ctx.firstMessageReceived = true;

					// Feed scripted SDK messages for this turn with timing
					const turnItems = turns[turnIndex];

					for (const item of turnItems) {
						// Apply delay if specified
						if (item.delay) {
							await Bun.sleep(item.delay);
						}
						// Send message if specified
						if (item.message) {
							await messageHandler.handleMessage(item.message);
						}
					}
				}
			} catch (error) {
				ctx.logger?.error?.('[MockSDK] Error processing messages:', error);
			} finally {
				if (ctx._queryGeneration === currentGen) {
					messageQueue.clear();
					messageQueue.stop();
					ctx.queryPromise = null;

					try {
						await gen.return();
					} catch {
						// Ignore generator cleanup errors
					}

					if (!ctx._isCleaningUp) {
						await stateManager.setIdle();
					}
				}
			}
		})();
	};

	return agentSession;
}

/**
 * Install auto-mocking from NEOKAI_MOCK_SCRIPT environment variable.
 *
 * This is the simplest way to use the script-based mock system:
 *
 * ```ts
 * // In test file or setup
 * process.env.NEOKAI_MOCK_SCRIPT = `
 *   builtin:system:init
 *   100ms
 *   {"type": "assistant", ...}
 *   builtin:result
 * `;
 *
 * // In beforeEach
 * installScriptAutoMock(ctx);
 *
 * // Test code is identical to online tests
 * const sessionId = await createSession();
 * await sendMessage(sessionId, 'Hi');
 * await waitForIdle(ctx.sessionManager, sessionId);
 * ```
 *
 * @param ctx - Context with sessionManager and eventBus
 * @returns Controls object to change the script
 */
export function installScriptAutoMock(ctx: MockableContext): {
	setScript: (script: string) => void;
} {
	let currentScript = process.env.NEOKAI_MOCK_SCRIPT || '';

	// Listen for session.created and auto-apply script-based mock
	ctx.eventBus.on('session.created', async (data: { sessionId: string }) => {
		const { sessionId } = data;
		if (currentScript) {
			mockAgentSessionWithScript(ctx.sessionManager, sessionId, currentScript);
		} else {
			// Fallback to simple text response if no script
			mockAgentSessionWithResponses(
				ctx.sessionManager,
				sessionId,
				simpleTextResponse('Mock response')
			);
		}
	});

	return {
		setScript: (script: string) => {
			currentScript = script;
		},
	};
}

/**
 * Helper to create common script patterns.
 */
export const MockScripts = {
	/**
	 * Simple text response with optional delay
	 */
	simpleText: (text: string, delayMs = 0) => {
		const delayLine = delayMs > 0 ? `${delayMs}ms\n` : '';
		return `${delayLine}builtin:system:init\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}\nbuiltin:result`;
	},

	/**
	 * Multi-turn conversation
	 */
	multiTurn: (responses: string[], delayMs = 100) => {
		return responses
			.map(
				(text) =>
					`builtin:system:init\n${delayMs}ms\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}\nbuiltin:result`
			)
			.join('\n---\n');
	},

	/**
	 * Error response
	 */
	error: (message = 'Mock error') => {
		return `builtin:system:init\nbuiltin:error`;
	},

	/**
	 * Rate limit error
	 */
	rateLimit: () => {
		return `builtin:system:init\nbuiltin:error:rate_limit`;
	},

	/**
	 * Tool use and result flow
	 */
	toolUse: (toolName: string, input: Record<string, unknown>, result: string) => {
		const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
		return [
			'builtin:system:init',
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${toolUseId}","name":"${toolName}","input":${JSON.stringify(input)}}]}}`,
			`{"type":"assistant","parent_tool_use_id":"${toolUseId}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${toolUseId}","content":"${result}"}]}}`,
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}`,
			'builtin:result',
		].join('\n');
	},
};

// ============================================================================
// Room Agent Mock Scripts
// ============================================================================

/**
 * Room-specific mock scripts for multi-agent flow tests.
 *
 * LIMITATIONS:
 * These scripts simulate AI responses but do NOT execute actual tools.
 * Room tests with multi-agent flow (planner, coder, leader) require real
 * tool execution (Write, Bash, MCP tools) which cannot be fully mocked.
 *
 * USE CASES:
 * - `room-chat-constraints` test works with mock (only needs text responses)
 * - Multi-agent flow tests require real API calls for tool execution
 *
 * The runtime's lifecycle hooks run against the real filesystem/git repo
 * (with mock gh CLI from setupGitEnvironment), but the AI's tool calls
 * still need to be executed by the real SDK.
 */
export const RoomMockScripts = {
	/**
	 * Simple text response for room chat sessions.
	 * This is the only mock that works for room tests without real API.
	 */
	roomChatResponse: (text = 'room ok') => {
		return MockScripts.simpleText(text);
	},

	/**
	 * Planner Phase 1: Creates plan file, commits, pushes, creates PR.
	 *
	 * NOTE: This script simulates the AI response but does NOT execute tools.
	 * Room tests with planner agents require real API calls for tool execution.
	 */
	plannerPhase1: (opts?: { planTitle?: string }) => {
		const title = opts?.planTitle ?? 'Add utility function';
		const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
		return [
			'builtin:system:init',
			// Simulate reading/globbing files
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me examine the codebase and create a plan."}]}}`,
			// Simulate creating plan file (Write tool call - SDK handles this)
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${toolUseId}","name":"Write","input":{"file_path":"docs/plans/${title.toLowerCase().replace(/\\s+/g, '-')}.md","content":"# Plan: ${title}\\n\\n## Tasks\\n\\n1. Create utility file\\n2. Add tests\\n"}}]}}`,
			// Tool result (simulated)
			`{"type":"assistant","parent_tool_use_id":"${toolUseId}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${toolUseId}","content":"File written successfully"}]}}`,
			// Done message
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I have created the plan and pushed it to a PR. The plan is ready for review."}]}}`,
			'builtin:result',
		].join('\n');
	},

	/**
	 * Planner Phase 2: After approval, creates tasks via create_task tool.
	 *
	 * NOTE: This script simulates the AI response but does NOT execute tools.
	 * Room tests with planner agents require real API calls for tool execution.
	 */
	plannerPhase2: (opts?: { taskTitle?: string }) => {
		const title = opts?.taskTitle ?? 'Create utility file';
		const toolUseId1 = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
		const toolUseId2 = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
		return [
			'builtin:system:init',
			// Acknowledge approval
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The plan is approved. Let me merge the PR and create the execution tasks."}]}}`,
			// Create task 1 (MCP tool call)
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${toolUseId1}","name":"mcp_tool_call","input":{"server_name":"planner-tools","tool_name":"create_task","arguments":{"title":"${title}","description":"Implement the utility function with proper typing and error handling.","agent":"coder"}}}]}}`,
			`{"type":"assistant","parent_tool_use_id":"${toolUseId1}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${toolUseId1}","content":"{\\"success\\":true,\\"taskId\\":\\"task-mock-1\\",\\"title\\":\\"${title}\\"}"}]}}`,
			// Create task 2
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${toolUseId2}","name":"mcp_tool_call","input":{"server_name":"planner-tools","tool_name":"create_task","arguments":{"title":"Add tests","description":"Add unit tests for the utility function.","agent":"coder","depends_on":["task-mock-1"]}}}]}}`,
			`{"type":"assistant","parent_tool_use_id":"${toolUseId2}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${toolUseId2}","content":"{\\"success\\":true,\\"taskId\\":\\"task-mock-2\\",\\"title\\":\\"Add tests\\"}"}]}}`,
			// Done
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I have created the execution tasks. The plan is complete."}]}}`,
			'builtin:result',
		].join('\n');
	},

	/**
	 * Planner full flow: Phase 1 + Phase 2 in a multi-turn script.
	 *
	 * NOTE: This script simulates the AI response but does NOT execute tools.
	 * Room tests with planner agents require real API calls for tool execution.
	 */
	plannerFull: (opts?: { planTitle?: string; taskTitle?: string }) => {
		const phase1 = RoomMockScripts.plannerPhase1(opts);
		const phase2 = RoomMockScripts.plannerPhase2(opts);
		return `${phase1}\n---\n${phase2}`;
	},

	/**
	 * Coder: Implements task, creates feature branch, commits, pushes, creates PR.
	 *
	 * NOTE: This script simulates the AI response but does NOT execute tools.
	 * Room tests with coder agents require real API calls for tool execution.
	 */
	coder: (opts?: { fileName?: string; content?: string }) => {
		const fileName = opts?.fileName ?? 'src/util.ts';
		const content = opts?.content ?? 'export function util(): string { return "ok"; }';
		const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
		return [
			'builtin:system:init',
			// Start message
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will implement this task."}]}}`,
			// Write file (simulated - actual file creation happens via Write tool)
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${toolUseId}","name":"Write","input":{"file_path":"${fileName}","content":"${content}"}}]}}`,
			`{"type":"assistant","parent_tool_use_id":"${toolUseId}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${toolUseId}","content":"File written successfully"}]}}`,
			// Done - lifecycle hooks verify the git operations
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I have implemented the task, created a feature branch, committed, pushed, and created a PR: https://github.com/test/repo/pull/1"}]}}`,
			'builtin:result',
		].join('\n');
	},

	/**
	 * Leader: Reviews worker output and calls submit_for_review.
	 *
	 * NOTE: This script simulates the AI response but does NOT execute tools.
	 * Room tests with leader agents require real API calls for tool execution.
	 */
	leaderSubmitForReview: () => {
		const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
		return [
			'builtin:system:init',
			// Review message
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I have reviewed the worker's output. The implementation looks good. I will submit for review."}]}}`,
			// Call submit_for_review MCP tool
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${toolUseId}","name":"mcp_tool_call","input":{"server_name":"leader-agent-tools","tool_name":"submit_for_review","arguments":{"pr_url":"https://github.com/test/repo/pull/1"}}}]}}`,
			`{"type":"assistant","parent_tool_use_id":"${toolUseId}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${toolUseId}","content":"{\\"success\\":true,\\"message\\":\\"Task submitted for review\\"}"}]}}`,
			'builtin:result',
		].join('\n');
	},

	/**
	 * Leader: Reviews worker output and calls complete_task.
	 *
	 * NOTE: This script simulates the AI response but does NOT execute tools.
	 * Room tests with leader agents require real API calls for tool execution.
	 */
	leaderCompleteTask: (opts?: { summary?: string }) => {
		const summary = opts?.summary ?? 'Task completed successfully.';
		const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
		return [
			'builtin:system:init',
			// Review message
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The work has been approved. I will complete the task."}]}}`,
			// Call complete_task MCP tool
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${toolUseId}","name":"mcp_tool_call","input":{"server_name":"leader-agent-tools","tool_name":"complete_task","arguments":{"summary":"${summary}"}}}]}}`,
			`{"type":"assistant","parent_tool_use_id":"${toolUseId}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${toolUseId}","content":"{\\"success\\":true,\\"message\\":\\"Task completed\\"}"}]}}`,
			'builtin:result',
		].join('\n');
	},

	/**
	 * Leader full flow: submit_for_review -> (after human approval) -> complete_task.
	 *
	 * NOTE: This script simulates the AI response but does NOT execute tools.
	 * Room tests with leader agents require real API calls for tool execution.
	 */
	leaderFull: (opts?: { summary?: string }) => {
		const submit = RoomMockScripts.leaderSubmitForReview();
		const complete = RoomMockScripts.leaderCompleteTask(opts);
		return `${submit}\n---\n${complete}`;
	},

	/**
	 * Complete room flow: planner -> coder -> leader.
	 *
	 * Multi-turn script that simulates the entire room lifecycle:
	 * - Turn 1: Planner creates plan
	 * - Turn 2: Planner creates tasks (after approval)
	 * - Turn 3: Coder implements
	 * - Turn 4: Leader submits for review
	 * - Turn 5: Leader completes (after approval)
	 *
	 * NOTE: Each agent session gets its own script. Use roomAgentFlow instead
	 * for per-session mock scripts.
	 */
	roomFullFlow: () => {
		// This is a reference implementation - in practice, each agent
		// session gets its own mock script installed at session creation time.
		throw new Error('Use roomAgentFlow() instead - each agent session needs its own mock script');
	},

	/**
	 * Create a mock script that responds based on session type.
	 *
	 * NOTE: Room tests with multi-agent flow (planner, coder, leader) require
	 * real API calls for tool execution. Only room chat tests can be fully mocked.
	 */
	roomAgentFlow: (
		sessionType: 'planner' | 'coder' | 'leader' | 'chat',
		opts?: {
			taskTitle?: string;
			fileName?: string;
			summary?: string;
		}
	) => {
		switch (sessionType) {
			case 'planner':
				return RoomMockScripts.plannerFull(opts);
			case 'coder':
				return RoomMockScripts.coder(opts);
			case 'leader':
				return RoomMockScripts.leaderFull(opts);
			case 'chat':
				return RoomMockScripts.roomChatResponse();
			default:
				return MockScripts.simpleText('mock response');
		}
	},
};

// ============================================================================
// Room Auto-Mock Installer
// ============================================================================

/**
 * Detect session type from session ID.
 *
 * Session ID patterns:
 * - `room:chat:${roomId}` → 'chat'
 * - `planner:${roomId}:${taskId}:${uuid}` → 'planner'
 * - `coder:${roomId}:${taskId}:${uuid}` → 'coder'
 * - `general:${roomId}:${taskId}:${uuid}` → 'general'
 * - `leader:${roomId}:${taskId}:${uuid}` → 'leader'
 */
export function detectRoomSessionType(
	sessionId: string
): 'planner' | 'coder' | 'general' | 'leader' | 'chat' | 'unknown' {
	if (sessionId.startsWith('room:chat:')) return 'chat';
	if (sessionId.startsWith('planner:')) return 'planner';
	if (sessionId.startsWith('coder:')) return 'coder';
	if (sessionId.startsWith('general:')) return 'general';
	if (sessionId.startsWith('leader:')) return 'leader';
	return 'unknown';
}

/**
 * Options for room auto-mock installer.
 */
export interface RoomMockOptions {
	/** Mock script options for planner sessions */
	planner?: {
		taskTitle?: string;
	};
	/** Mock script options for coder sessions */
	coder?: {
		fileName?: string;
		content?: string;
	};
	/** Mock script options for leader sessions */
	leader?: {
		summary?: string;
	};
	/** Mock response for chat sessions */
	chatResponse?: string;
	/** Default response for unknown session types */
	defaultResponse?: string;
}

/**
 * Install auto-mocking for room tests with session-type-aware scripts.
 *
 * Detects session type from the session ID and installs the appropriate mock:
 * - `room:chat:*` → Simple text response
 * - `planner:*` → Planner mock script
 * - `coder:*` → Coder mock script
 * - `leader:*` → Leader mock script
 *
 * @param ctx - Context with sessionManager and eventBus
 * @param options - Options for customizing mock scripts per session type
 * @returns Controls object
 *
 * @example
 * ```ts
 * // In beforeEach
 * daemon = await createDaemonServer();
 *
 * if (IS_MOCK && daemon.daemonContext) {
 *     installRoomAutoMock(daemon.daemonContext, {
 *         chatResponse: 'room ok',
 *         coder: { fileName: 'src/util.ts' },
 *     });
 * }
 * ```
 */
export function installRoomAutoMock(ctx: MockableContext, options: RoomMockOptions = {}) {
	const {
		planner = {},
		coder = {},
		leader = {},
		chatResponse = 'room ok',
		defaultResponse = 'mock response',
	} = options;

	// Listen for session.created and auto-apply session-type-aware mock
	ctx.eventBus.on('session.created', async (data: { sessionId: string }) => {
		const { sessionId } = data;
		const sessionType = detectRoomSessionType(sessionId);

		let script: string;
		switch (sessionType) {
			case 'planner':
				script = RoomMockScripts.plannerFull(planner);
				break;
			case 'coder':
				script = RoomMockScripts.coder(coder);
				break;
			case 'leader':
				script = RoomMockScripts.leaderFull(leader);
				break;
			case 'chat':
				script = MockScripts.simpleText(chatResponse);
				break;
			default:
				script = MockScripts.simpleText(defaultResponse);
		}

		mockAgentSessionWithScript(ctx.sessionManager, sessionId, script);
	});
}
