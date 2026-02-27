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
 * 2. Consumes the user message from the queue (triggers state transitions)
 * 3. Feeds scripted SDK messages through `messageHandler.handleMessage()`
 * 4. Cleans up (stops queue, clears pending messages)
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
import type { TestContext } from './test-app';

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
	opts?: { text?: string }
): SDKMessage {
	const content: unknown[] = [];
	if (opts?.text) {
		content.push({ type: 'text', text: opts.text });
	}
	content.push({
		type: 'tool_use',
		id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
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
 * Error response: init → error result
 */
export function errorResponse(errorMessage?: string): SDKMessage[] {
	return [sdkSystemInit(), sdkResultError('error_during_execution', errorMessage)];
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
 * @param sessionManager - The SessionManager instance
 * @param sessionId - The session ID to mock
 * @param messages - SDK messages to feed, or a factory function for per-call messages
 * @returns The mocked AgentSession or null if not found
 */
export function mockAgentSessionWithResponses(
	sessionManager: SessionManager,
	sessionId: string,
	messages: SDKMessage[] | (() => SDKMessage[])
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
			const sdkMessages = getMessages();
			try {
				// Wait for and consume the first user message from the queue.
				// This unblocks the enqueueWithId promise and triggers state transitions.
				const first = await gen.next();
				if (first.value && !first.done) {
					const { message, onSent } = first.value;
					const isInternal = (message as Record<string, unknown>).internal || false;
					if (!isInternal) {
						await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
					}
					onSent();
				}

				ctx.firstMessageReceived = true;

				// Feed scripted SDK messages through the real handler pipeline
				for (const msg of sdkMessages) {
					await messageHandler.handleMessage(msg);
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
 * Response factory type — produces SDK messages for each query.
 * Can be:
 * - SDKMessage[] — same response every time
 * - () => SDKMessage[] — factory called fresh for each query
 */
export type MockResponseFactory = SDKMessage[] | (() => SDKMessage[]);

/**
 * Install auto-mocking on a TestContext so every new session automatically
 * gets its query runner replaced with the mock pipeline.
 *
 * After calling this, test code is completely transparent — identical to
 * online tests. No `mockAgentSessionWithResponses()` calls needed.
 *
 * @param ctx - TestContext from createTestApp()
 * @param responses - Default responses for all sessions
 * @returns Controls object to change responses per-session or globally
 *
 * @example
 * ```ts
 * ctx = await createTestApp();
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
export function installAutoMock(ctx: TestContext, responses: MockResponseFactory): MockControls {
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
