/**
 * SDK Streaming CI Failures - Isolated Tests
 *
 * These tests are isolated because they test SDK behavior with bypassPermissions mode,
 * which fails when running as root due to SDK restrictions.
 *
 * The SDK subprocess exits with code 1 when:
 * - Running as root (UID 0)
 * - Using bypassPermissions mode with --dangerously-skip-permissions
 *
 * Test behavior:
 * - Detects if running as root using process.getuid() === 0 (not just CI environment)
 * - When running as root: expects SDK to throw root restriction error (test passes)
 * - When NOT running as root: expects SDK to succeed normally (test passes)
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will SKIP if credentials are not available
 *
 * MODEL MAPPING:
 * - Uses 'haiku' model (provider-agnostic)
 * - With GLM_API_KEY: haiku → glm-4.5-air (via ANTHROPIC_DEFAULT_HAIKU_MODEL)
 * - With ANTHROPIC_API_KEY: haiku → Claude Haiku
 * - This makes tests provider-agnostic and easy to switch
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import 'dotenv/config';

// Check for GLM credentials
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

// Set up GLM provider environment if GLM_API_KEY is available
// This makes 'haiku' model automatically map to glm-4.5-air
if (GLM_API_KEY) {
	process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
	process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
	process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
	process.env.API_TIMEOUT_MS = '3000000';
}
import type { TestContext } from '../../test-utils';
import { createTestApp } from '../../test-utils';
import { sendMessageSync } from '../../helpers/test-message-sender';
import { waitForIdle } from '../../helpers/test-wait-for-idle';
import { query } from '@anthropic-ai/claude-agent-sdk';

// Skip all tests if GLM credentials are not available
describe.skipIf(!GLM_API_KEY)('SDK Streaming CI Failures', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(
		async () => {
			await ctx.cleanup();
		},
		{ timeout: 20000 }
	);

	describe('Direct SDK Call with Different API Patterns', () => {
		test('should call SDK with AsyncGenerator + bypassPermissions (DIAGNOSTIC - SDK fails as root)', async () => {
			console.log('[ASYNC+BYPASS TEST] AsyncGenerator with bypassPermissions');
			const isRunningAsRoot = process.getuid && process.getuid() === 0;
			const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
			console.log(
				`[ASYNC+BYPASS TEST] Running in ${isCI ? 'CI' : 'local'} environment, as root: ${isRunningAsRoot}`
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

			let stderrOutput: string[] = [];

			try {
				let messageCount = 0;
				let hasAssistantMessage = false;

				// CORRECT API: Wrap AsyncGenerator in object with 'prompt' field
				// SDK should throw when running as root with bypassPermissions
				for await (const message of query({
					prompt: messageGenerator(),
					options: {
						model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
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

				// If running as root, the SDK should have thrown before reaching here
				if (isRunningAsRoot) {
					throw new Error(
						'SDK succeeded with bypassPermissions while running as root - expected SDK to throw root restriction error'
					);
				}

				// Non-root environment - verify success
				expect(messageCount).toBeGreaterThan(0);
				expect(hasAssistantMessage).toBe(true);
				console.log('[ASYNC+BYPASS TEST] ✓ PASSED - Successfully completed (non-root environment)');
			} catch (error) {
				const errorMsg = (error as Error).message;
				console.error('[ASYNC+BYPASS TEST] Caught error:', errorMsg);

				// Check if this is the expected root restriction error from the SDK
				// The error message is "Claude Code process exited with code 1"
				// But stderr contains the actual root restriction message
				const stderrText = stderrOutput.join('\n');
				const isRootRestrictionError =
					errorMsg.includes('exited with code 1') &&
					stderrText.includes('--dangerously-skip-permissions') &&
					stderrText.includes('root');

				if (isRootRestrictionError) {
					if (isRunningAsRoot) {
						console.log(
							'[ASYNC+BYPASS TEST] ✓ PASSED - Got expected root restriction error from SDK'
						);
						// SDK correctly threw the root restriction error - test passes
						return;
					} else {
						console.error(
							'[ASYNC+BYPASS TEST] ✗ FAILED - Got root restriction error in non-root environment'
						);
						throw error;
					}
				}

				// Unexpected error - rethrow
				console.error('[ASYNC+BYPASS TEST] Stack:', (error as Error).stack);
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
						model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
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
						model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
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
						model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
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
						model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
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
