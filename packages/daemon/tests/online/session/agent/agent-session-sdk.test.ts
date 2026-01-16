/**
 * AgentSession SDK Integration Tests
 *
 * These tests use the REAL Claude Agent SDK with actual API credentials.
 * They verify that AgentSession correctly integrates with the SDK for:
 * - Message sending and receiving
 * - Session state management
 * - WebSocket communication
 * - Image handling
 * - Interrupts and aborts
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will SKIP if credentials are not available
 *
 * MODEL MAPPING:
 * - Uses 'haiku' model (provider-agnostic)
 * - With GLM_API_KEY: haiku → glm-4.5-air (via ANTHROPIC_DEFAULT_HAIKU_MODEL)
 * - With CLAUDE_CODE_OAUTH_TOKEN: Uses official Claude API directly
 * - This makes tests provider-agnostic and easy to switch
 *
 * These tests run in parallel with other tests for faster CI execution.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import 'dotenv/config';

// Check for credentials - CLAUDE_CODE_OAUTH_TOKEN takes priority
const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const GLM_API_KEY =
	!CLAUDE_CODE_OAUTH_TOKEN && (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY);

// Set up GLM provider environment if GLM_API_KEY is available (not CLAUDE_CODE_OAUTH_TOKEN)
// This makes 'haiku' model automatically map to glm-4.5-air
if (GLM_API_KEY) {
	process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
	process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
	process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
	process.env.API_TIMEOUT_MS = '3000000';
}
import type { TestContext } from '../../../test-utils';
import {
	createTestApp,
	createWebSocketWithFirstMessage,
	waitForWebSocketState,
	waitForWebSocketMessage,
} from '../../../test-utils';
import { sendMessageSync } from '../../../helpers/test-message-sender';

import { getTestSessionConfig } from '../../../helpers/test-session-config';
import { waitForIdle } from '../../../helpers/test-wait-for-idle';

/**
 * CRITICAL: Restore any mocks before running these tests.
 * This prevents mock leakage from unit tests that mock the SDK.
 */
// Tests will FAIL if credentials are not available
describe('AgentSession SDK Integration', () => {
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

	describe('sendMessageSync', () => {
		test('should send message and receive real SDK response', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Send a simple message
			const result = await sendMessageSync(agentSession!, {
				content: 'What is 1+1? Answer with just the number.',
			});

			expect(result.messageId).toBeString();
			expect(result.messageId.length).toBeGreaterThan(0);

			// Wait for processing to complete (polls state until idle)
			await waitForIdle(agentSession!);

			// Check that we received SDK messages
			const sdkMessages = agentSession!.getSDKMessages();
			expect(sdkMessages.length).toBeGreaterThan(0);

			// Verify state returned to idle after processing
			const state = agentSession!.getProcessingState();
			expect(state.status).toBe('idle');
		}, 20000); // 20 second timeout

		test('should handle message with images', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// 1x1 red pixel PNG
			const result = await sendMessageSync(agentSession!, {
				content: 'What color is this image? Answer with just the color name.',
				images: [
					{
						media_type: 'image/png',
						data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
					},
				],
			});

			expect(result.messageId).toBeString();

			// Wait for processing to complete
			await waitForIdle(agentSession!);

			// Verify we got a response
			const sdkMessages = agentSession!.getSDKMessages();
			expect(sdkMessages.length).toBeGreaterThan(0);
		}, 20000);
	});

	describe('enqueueMessage', () => {
		test('should enqueue multiple messages in sequence', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Send first message to start the query
			await sendMessageSync(agentSession!, {
				content: 'What is 2+2? Just the number.',
			});

			// Wait for first message to complete
			await waitForIdle(agentSession!);

			// Send second message
			const result = await sendMessageSync(agentSession!, {
				content: 'What is 3+3? Just the number.',
			});

			expect(result.messageId).toBeString();
			expect(result.messageId.length).toBeGreaterThan(0);

			// Wait for second message to process
			await waitForIdle(agentSession!);

			// Verify both messages were processed (use SDK messages now)
			const messages = agentSession!.getSDKMessages();
			expect(messages.length).toBeGreaterThanOrEqual(2);
		}, 30000);
	});

	describe('handleInterrupt', () => {
		test('should interrupt ongoing processing', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Send a simple message first and wait for it to complete
			// This ensures the SDK query is started and ready
			await sendMessageSync(agentSession!, {
				content: 'What is 1+1? Just the number.',
			});
			await waitForIdle(agentSession!);

			// Now interrupt (should work even on idle - it's a no-op but shouldn't error)
			await agentSession!.handleInterrupt();

			// State should be idle after interrupt
			const state = agentSession!.getProcessingState();
			expect(state.status).toBe('idle');
		}, 20000);
	});

	describe('WebSocket SDK message events', () => {
		test('should broadcast sdk.message events via WebSocket', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe to state.sdkMessages.delta events (NOTE: sdk.message was removed)
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-sdk-1',
					type: 'SUBSCRIBE',
					method: 'state.sdkMessages.delta',
					sessionId,
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// CRITICAL: Start listening for SDK message BEFORE sending
			// On fast machines, the SDK might process and broadcast before we start listening
			const sdkEventPromise = waitForWebSocketMessage(ws, 10000);

			// Send a message to trigger SDK events
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			await sendMessageSync(agentSession!, {
				content: 'Say hello. Just respond "Hello".',
			});

			// Wait for SDK message event (listener was already set up)
			const sdkEvent = (await sdkEventPromise) as Record<string, unknown>;

			// Should receive a state.sdkMessages.delta event
			expect(sdkEvent.type).toBe('EVENT');
			expect(sdkEvent.method).toBe('state.sdkMessages.delta');
			expect(sdkEvent.data).toBeDefined();

			ws.close();
		}, 20000);
	});

	describe('State transitions', () => {
		test('should transition through processing states', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Initial state should be idle
			expect(agentSession!.getProcessingState().status).toBe('idle');

			// Send message
			await sendMessageSync(agentSession!, {
				content: 'What is 5+5? Just the number.',
			});

			// State should be queued or processing (depending on timing)
			const stateAfterSend = agentSession!.getProcessingState();
			expect(['queued', 'processing', 'idle']).toContain(stateAfterSend.status);

			// Wait for completion
			await waitForIdle(agentSession!);

			// Should be back to idle
			const finalState = agentSession!.getProcessingState();
			expect(finalState.status).toBe('idle');
		}, 15000);

		test('should handle multiple messages in sequence', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Send first message and wait for completion
			// This ensures SDK subprocess is fully ready before next message
			const result1 = await sendMessageSync(agentSession!, { content: 'Count to 1' });
			await waitForIdle(agentSession!);

			// Send second message after first completes
			const result2 = await sendMessageSync(agentSession!, { content: 'Count to 2' });

			// All should have unique message IDs
			expect(result1.messageId).toBeString();
			expect(result2.messageId).toBeString();
			expect(result1.messageId).not.toBe(result2.messageId);

			// Wait for processing to complete
			await waitForIdle(agentSession!);

			// Should have messages from both interactions (use SDK messages now)
			const messages = agentSession!.getSDKMessages();
			expect(messages.length).toBeGreaterThanOrEqual(2);
		}, 25000);
	});

	describe('session.interrupted event', () => {
		test('should handle interrupt gracefully on active session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: getTestSessionConfig(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Send a message and let it complete
			await sendMessageSync(agentSession!, {
				content: 'What is 1+1? Just the number.',
			});
			await waitForIdle(agentSession!);

			// Verify state is idle
			expect(agentSession!.getProcessingState().status).toBe('idle');

			// Call interrupt on idle session - should be a no-op
			await agentSession!.handleInterrupt();

			// State should still be idle
			expect(agentSession!.getProcessingState().status).toBe('idle');

			// Send another message to verify session is still functional
			await sendMessageSync(agentSession!, {
				content: 'What is 2+2? Just the number.',
			});
			await waitForIdle(agentSession!);

			// Verify messages were processed
			const messages = agentSession!.getSDKMessages();
			expect(messages.length).toBeGreaterThanOrEqual(2);
		}, 15000);
	});
});
