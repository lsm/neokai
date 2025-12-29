/**
 * SDK Streaming CI Failures - Isolated Tests
 *
 * These tests are isolated because they fail on CI due to SDK subprocess crashes.
 * The SDK subprocess exits with code 1 before yielding any messages when using
 * streaming AsyncGenerator queries.
 *
 * Root cause:
 * - User messages ARE saved (by SessionManager before SDK)
 * - SDK messages are NOT saved (subprocess crashes before yielding them)
 * - CI logs show: "Claude Code process exited with code 1"
 *
 * Tests isolated from:
 * - session-resume.test.ts: 'should capture SDK session ID on first message'
 * - message-persistence.test.ts: 'should persist messages during real SDK interaction'
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp } from '../../test-utils';
import { sendMessageSync } from '../../helpers/test-message-sender';

describe('SDK Streaming CI Failures', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	/**
	 * Helper: Wait for agent session to return to idle state
	 */
	async function waitForIdle(
		agentSession: NonNullable<Awaited<ReturnType<typeof ctx.sessionManager.getSessionAsync>>>,
		timeoutMs = 15000
	): Promise<void> {
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			const state = agentSession.getProcessingState();
			if (state.status === 'idle') {
				return;
			}
			await Bun.sleep(100);
		}
		throw new Error(`Timeout waiting for idle state after ${timeoutMs}ms`);
	}

	describe('Session Resume', () => {
		test('should capture SDK session ID on first message', async () => {
			// Create a new session using cwd (avoid temp path issues on CI)
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			expect(sessionId).toBeDefined();

			// Get session from database - initially no SDK session ID
			let session = ctx.db.getSession(sessionId);
			expect(session).toBeDefined();
			expect(session?.sdkSessionId).toBeUndefined();

			// Get the agent session
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Send a message using sendMessageSync - this properly waits for message to be enqueued
			// and the SDK query to start
			await sendMessageSync(agentSession!, {
				content: 'What is 1+1? Just the number.',
			});

			// Wait for SDK to process and return to idle
			await waitForIdle(agentSession!);

			// Poll for SDK session ID to be captured (it's set asynchronously from SDK messages)
			// On fast CI machines, we may need to wait a bit for the DB update to complete
			const timeout = 5000;
			const start = Date.now();
			while (Date.now() - start < timeout) {
				session = ctx.db.getSession(sessionId);
				if (session?.sdkSessionId) {
					break;
				}
				await Bun.sleep(100);
			}

			// Debug: If sdkSessionId not found, log what messages we have
			if (!session?.sdkSessionId) {
				const messages = ctx.db.getSDKMessages(sessionId);
				console.log('[DEBUG] sdkSessionId not found after polling');
				console.log('[DEBUG] Messages in DB:', messages.length);
				console.log('[DEBUG] Message types:', messages.map((m) => m.type).join(', '));
				// Check for system message which should contain session_id
				const systemMsg = messages.find((m) => m.type === 'system');
				console.log('[DEBUG] System message found:', !!systemMsg);
				if (systemMsg) {
					console.log('[DEBUG] System message:', JSON.stringify(systemMsg));
				}
			}

			// Now check for SDK session ID - it should be captured after SDK responds
			expect(session?.sdkSessionId).toBeDefined();
			expect(typeof session?.sdkSessionId).toBe('string');
		}, 30000);
	});

	describe('Message Persistence', () => {
		test('should persist messages during real SDK interaction', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Send a message to the real SDK
			const result = await sendMessageSync(agentSession!, {
				content: 'What is 2+2? Answer with just the number.',
			});

			expect(result.messageId).toBeString();

			// Wait for processing to complete
			await waitForIdle(agentSession!);

			// Poll for messages to be persisted to DB
			// On fast CI machines, DB writes may complete slightly after waitForIdle returns
			let dbMessages: ReturnType<typeof ctx.db.getSDKMessages> = [];
			let assistantMessage: (typeof dbMessages)[number] | undefined;
			const pollTimeout = 5000;
			const pollStart = Date.now();
			while (Date.now() - pollStart < pollTimeout) {
				dbMessages = ctx.db.getSDKMessages(sessionId);
				assistantMessage = dbMessages.find((msg) => msg.type === 'assistant');
				if (assistantMessage) {
					break;
				}
				await Bun.sleep(100);
			}

			// Check messages were persisted to DB
			expect(dbMessages.length).toBeGreaterThan(0);

			// Verify user message is saved
			const userMessage = dbMessages.find((msg) => msg.type === 'user');
			expect(userMessage).toBeDefined();

			// Debug: Log all message types if assistant is not found
			if (!assistantMessage) {
				console.log('[DEBUG] Messages in DB after polling:');
				console.log('[DEBUG] Total count:', dbMessages.length);
				console.log('[DEBUG] Types:', dbMessages.map((m) => m.type).join(', '));
				console.log(
					'[DEBUG] Full messages:',
					JSON.stringify(
						dbMessages.map((m) => ({ type: m.type, uuid: m.uuid })),
						null,
						2
					)
				);
			}

			// Verify assistant response is saved
			expect(assistantMessage).toBeDefined();

			// Simulate page refresh - reload session and check messages still there
			const reloadedSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const afterReloadMessages = reloadedSession!.getSDKMessages();

			expect(afterReloadMessages.length).toBe(dbMessages.length);
			expect(afterReloadMessages.length).toBeGreaterThan(0);
		}, 20000); // 20 second timeout
	});
});
