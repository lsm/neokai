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
import { query } from '@anthropic-ai/claude-agent-sdk';

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

	describe('Direct SDK Call with Different API Patterns', () => {
		test('should call SDK with AsyncGenerator + bypassPermissions (DIAGNOSTIC - expected to fail on CI)', async () => {
			console.log('[ASYNC+BYPASS TEST] AsyncGenerator with bypassPermissions');
			console.log(
				'[ASYNC+BYPASS TEST] NOTE: This test is EXPECTED to fail on CI (root restriction)'
			);

			// Message generator - just one simple message
			async function* messageGenerator() {
				yield {
					type: 'user' as const,
					uuid: crypto.randomUUID(),
					session_id: 'bypass-test-session',
					parent_tool_use_id: null,
					message: {
						role: 'user' as const,
						content: [{ type: 'text' as const, text: 'What is 1+1? Answer with just the number.' }],
					},
				};
			}

			try {
				let messageCount = 0;
				let hasAssistantMessage = false;
				const stderrOutput: string[] = [];

				// CORRECT API: Wrap AsyncGenerator in object with 'prompt' field
				for await (const message of query({
					prompt: messageGenerator(),
					options: {
						model: 'haiku',
						cwd: process.cwd(),
						permissionMode: 'bypassPermissions',
						allowDangerouslySkipPermissions: true,
						settingSources: [],
						systemPrompt: undefined,
						mcpServers: {},
						maxTurns: 1,
						stderr: (msg: string) => {
							console.log('[ASYNC+BYPASS TEST] STDERR:', msg);
							stderrOutput.push(msg);
						},
					},
				})) {
					messageCount++;
					console.log(`[ASYNC+BYPASS TEST] Message ${messageCount} - type: ${message.type}`);

					if (message.type === 'assistant') {
						hasAssistantMessage = true;
					}
				}

				console.log(`[ASYNC+BYPASS TEST] Completed - ${messageCount} messages`);
				expect(messageCount).toBeGreaterThan(0);
				expect(hasAssistantMessage).toBe(true);
			} catch (error) {
				console.error('[ASYNC+BYPASS TEST] FAILED:', error);
				console.error('[ASYNC+BYPASS TEST] Message:', (error as Error).message);
				console.error('[ASYNC+BYPASS TEST] Stack:', (error as Error).stack);

				// Check if this is the expected root restriction error
				const errorMsg = (error as Error).message;
				if (errorMsg.includes('root') && errorMsg.includes('--dangerously-skip-permissions')) {
					console.log('[ASYNC+BYPASS TEST] ✓ Expected failure - root restriction confirmed');
					// Don't throw - this is expected behavior on CI
					return;
				}

				// Unexpected error - rethrow
				throw error;
			}
		}, 20000);

		test('should call SDK with AsyncGenerator + acceptEdits (CORRECT API)', async () => {
			console.log('[ASYNC+ACCEPT TEST] AsyncGenerator with acceptEdits');

			// Message generator - just one simple message
			async function* messageGenerator() {
				yield {
					type: 'user' as const,
					uuid: crypto.randomUUID(),
					session_id: 'accept-edits-test-session',
					parent_tool_use_id: null,
					message: {
						role: 'user' as const,
						content: [{ type: 'text' as const, text: 'What is 2+2? Answer with just the number.' }],
					},
				};
			}

			try {
				let messageCount = 0;
				let hasAssistantMessage = false;
				const stderrOutput: string[] = [];

				// CORRECT API: Wrap AsyncGenerator in object with 'prompt' field
				for await (const message of query({
					prompt: messageGenerator(),
					options: {
						model: 'haiku',
						cwd: process.cwd(),
						permissionMode: 'acceptEdits',
						settingSources: [],
						systemPrompt: undefined,
						mcpServers: {},
						maxTurns: 1,
						stderr: (msg: string) => {
							console.log('[ASYNC+ACCEPT TEST] STDERR:', msg);
							stderrOutput.push(msg);
						},
					},
				})) {
					messageCount++;
					console.log(`[ASYNC+ACCEPT TEST] Message ${messageCount} - type: ${message.type}`);

					if (message.type === 'assistant') {
						hasAssistantMessage = true;
					}
				}

				console.log(`[ASYNC+ACCEPT TEST] Completed - ${messageCount} messages`);
				expect(messageCount).toBeGreaterThan(0);
				expect(hasAssistantMessage).toBe(true);
			} catch (error) {
				console.error('[ASYNC+ACCEPT TEST] FAILED:', error);
				console.error('[ASYNC+ACCEPT TEST] Message:', (error as Error).message);
				console.error('[ASYNC+ACCEPT TEST] Stack:', (error as Error).stack);
				throw error;
			}
		}, 20000);

		test('should call SDK with simple prompt pattern (like PASSING tests)', async () => {
			console.log('[SIMPLE PROMPT TEST] Simple string prompt with acceptEdits');

			try {
				let messageCount = 0;
				let hasAssistantMessage = false;

				// Simple prompt pattern (SAME AS PASSING TESTS)
				for await (const message of query({
					prompt: 'What is 3+3? Answer with just the number.',
					options: {
						model: 'haiku',
						cwd: process.cwd(),
						permissionMode: 'acceptEdits',
						maxTurns: 1,
						stderr: (msg: string) => {
							console.log('[SIMPLE PROMPT TEST] STDERR:', msg);
						},
					},
				})) {
					messageCount++;
					console.log(`[SIMPLE PROMPT TEST] Message ${messageCount} - type: ${message.type}`);

					if (message.type === 'assistant') {
						hasAssistantMessage = true;
					}
				}

				console.log(`[SIMPLE PROMPT TEST] Completed - ${messageCount} messages`);
				expect(messageCount).toBeGreaterThan(0);
				expect(hasAssistantMessage).toBe(true);
				console.log('[SIMPLE PROMPT TEST] ✓ PASSED - Simple prompt pattern works');
			} catch (error) {
				console.error('[SIMPLE PROMPT TEST] FAILED:', error);
				console.error('[SIMPLE PROMPT TEST] Message:', (error as Error).message);
				console.error('[SIMPLE PROMPT TEST] Stack:', (error as Error).stack);
				throw error;
			}
		}, 20000);
	});

	describe('Session Resume', () => {
		test('should capture SDK session ID on first message', async () => {
			console.log('[SESSION RESUME TEST] Starting test...');

			try {
				// Create a new session using cwd (avoid temp path issues on CI)
				// Explicitly set permissionMode to acceptEdits for CI (bypass permissions fails on root)
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
					config: {
						model: 'haiku', // Explicitly set model for CI
						permissionMode: 'acceptEdits',
					},
				});

				expect(sessionId).toBeDefined();
				console.log('[SESSION RESUME TEST] Session created:', sessionId);

				// Get session from database - initially no SDK session ID
				let session = ctx.db.getSession(sessionId);
				expect(session).toBeDefined();
				expect(session?.sdkSessionId).toBeUndefined();

				// Get the agent session
				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				expect(agentSession).toBeDefined();
				console.log('[SESSION RESUME TEST] Agent session retrieved');

				// Send a message using sendMessageSync - this properly waits for message to be enqueued
				// and the SDK query to start
				console.log('[SESSION RESUME TEST] Sending message...');
				await sendMessageSync(agentSession!, {
					content: 'What is 1+1? Just the number.',
				});

				// Wait for SDK to process and return to idle
				console.log('[SESSION RESUME TEST] Waiting for idle...');
				await waitForIdle(agentSession!);
				console.log('[SESSION RESUME TEST] Returned to idle');

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
					console.log('[SESSION RESUME TEST] sdkSessionId not found after polling');
					console.log('[SESSION RESUME TEST] Messages in DB:', messages.length);
					console.log(
						'[SESSION RESUME TEST] Message types:',
						messages.map((m) => m.type).join(', ')
					);
					// Check for system message which should contain session_id
					const systemMsg = messages.find((m) => m.type === 'system');
					console.log('[SESSION RESUME TEST] System message found:', !!systemMsg);
					if (systemMsg) {
						console.log('[SESSION RESUME TEST] System message:', JSON.stringify(systemMsg));
					}
				}

				// Now check for SDK session ID - it should be captured after SDK responds
				expect(session?.sdkSessionId).toBeDefined();
				expect(typeof session?.sdkSessionId).toBe('string');
				console.log(
					'[SESSION RESUME TEST] ✓ PASSED - SDK session ID captured:',
					session?.sdkSessionId
				);
			} catch (error) {
				console.error('[SESSION RESUME TEST] FAILED:', error);
				console.error('[SESSION RESUME TEST] Message:', (error as Error).message);
				console.error('[SESSION RESUME TEST] Stack:', (error as Error).stack);
				throw error;
			}
		}, 30000);
	});

	describe('Message Persistence', () => {
		test('should persist messages during real SDK interaction', async () => {
			console.log('[MESSAGE PERSISTENCE TEST] Starting test...');

			try {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
					config: {
						model: 'haiku', // Use Haiku for faster, cheaper tests
						permissionMode: 'acceptEdits', // Explicitly set for CI (bypass permissions fails on root)
					},
				});

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				expect(agentSession).toBeDefined();
				console.log('[MESSAGE PERSISTENCE TEST] Session created:', sessionId);

				// Send a message to the real SDK
				console.log('[MESSAGE PERSISTENCE TEST] Sending message...');
				const result = await sendMessageSync(agentSession!, {
					content: 'What is 2+2? Answer with just the number.',
				});

				expect(result.messageId).toBeString();
				console.log('[MESSAGE PERSISTENCE TEST] Message sent:', result.messageId);

				// Wait for processing to complete
				console.log('[MESSAGE PERSISTENCE TEST] Waiting for idle...');
				await waitForIdle(agentSession!);
				console.log('[MESSAGE PERSISTENCE TEST] Returned to idle');

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
					console.log('[MESSAGE PERSISTENCE TEST] Messages in DB after polling:');
					console.log('[MESSAGE PERSISTENCE TEST] Total count:', dbMessages.length);
					console.log(
						'[MESSAGE PERSISTENCE TEST] Types:',
						dbMessages.map((m) => m.type).join(', ')
					);
					console.log(
						'[MESSAGE PERSISTENCE TEST] Full messages:',
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
				console.log(
					'[MESSAGE PERSISTENCE TEST] ✓ PASSED - Messages persisted:',
					afterReloadMessages.length
				);
			} catch (error) {
				console.error('[MESSAGE PERSISTENCE TEST] FAILED:', error);
				console.error('[MESSAGE PERSISTENCE TEST] Message:', (error as Error).message);
				console.error('[MESSAGE PERSISTENCE TEST] Stack:', (error as Error).stack);
				throw error;
			}
		}, 20000); // 20 second timeout
	});
});
