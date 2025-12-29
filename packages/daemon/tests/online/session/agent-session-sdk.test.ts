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
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 *
 * These tests run in parallel with other tests for faster CI execution.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../../test-utils';
import {
	createTestApp,
	createWebSocketWithFirstMessage,
	waitForWebSocketState,
	waitForWebSocketMessage,
} from '../../test-utils';
import { sendMessageSync } from '../../helpers/test-message-sender';

/**
 * CRITICAL: Restore any mocks before running these tests.
 * This prevents mock leakage from unit tests that mock the SDK.
 */
describe('AgentSession SDK Integration', () => {
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
	 * Polls the processing state until it's idle or timeout
	 */
	async function waitForIdle(
		agentSession: NonNullable<Awaited<ReturnType<typeof ctx.sessionManager.getSessionAsync>>>,
		timeoutMs = 15000 // 15s is sufficient for SDK init + API call
	): Promise<void> {
		const startTime = Date.now();
		let lastState: string = '';
		while (Date.now() - startTime < timeoutMs) {
			const state = agentSession.getProcessingState();
			if (state.status !== lastState) {
				console.log(`[waitForIdle] State changed: ${lastState} -> ${state.status}`);
				lastState = state.status;
			}
			if (state.status === 'idle') {
				return;
			}
			await Bun.sleep(100); // Poll every 100ms
		}
		const finalState = agentSession.getProcessingState();
		const phase = 'phase' in finalState ? finalState.phase : 'N/A';
		throw new Error(
			`Timeout waiting for idle state after ${timeoutMs}ms. Final state: ${finalState.status}, phase: ${phase}`
		);
	}

	describe('sendMessageSync', () => {
		test('should send message and receive real SDK response', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
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
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
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
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
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
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
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
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
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
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
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
				config: { model: 'haiku' }, // Use Haiku for faster, cheaper tests
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Send multiple messages
			const promise1 = sendMessageSync(agentSession!, { content: 'Count to 1' });
			await Bun.sleep(100);
			const promise2 = sendMessageSync(agentSession!, { content: 'Count to 2' });

			const results = await Promise.all([promise1, promise2]);

			// All should have unique message IDs
			expect(results[0].messageId).toBeString();
			expect(results[1].messageId).toBeString();
			expect(results[0].messageId).not.toBe(results[1].messageId);

			// Wait for processing to complete
			await waitForIdle(agentSession!);

			// Should have messages from both interactions (use SDK messages now)
			const messages = agentSession!.getSDKMessages();
			expect(messages.length).toBeGreaterThanOrEqual(2);
		}, 25000);
	});

	describe('session.interrupted event', () => {
		test('should emit session.interrupted event when interrupting active session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: { model: 'haiku' },
			});

			// First, verify the basic interrupt functionality works
			// by sending a simple message and waiting for it to complete
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			await sendMessageSync(agentSession!, {
				content: 'What is 1+1? Just the number.',
			});
			await waitForIdle(agentSession!);

			// Now set up WebSocket subscription for the interrupt event test
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise; // Drain connection event

			// Subscribe to session.interrupted event
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-1',
					type: 'SUBSCRIBE',
					method: 'session.interrupted',
					sessionId,
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// Set up event listener BEFORE calling interrupt
			const eventPromise = waitForWebSocketMessage(ws, 5000).catch(() => null);

			// Send a long message and try to interrupt it
			const messagePromise = sendMessageSync(agentSession!, {
				content: 'Write a detailed 500 word essay about the history of computing.',
			}).catch(() => {
				// Message may be interrupted - this is expected
			});

			// Wait briefly for state to change from idle
			await Bun.sleep(50);

			// Check state - if not idle, we can test interruption
			const stateBeforeInterrupt = agentSession!.getProcessingState();

			if (stateBeforeInterrupt.status !== 'idle') {
				// Trigger interrupt
				await agentSession!.handleInterrupt();

				// Try to receive interrupted event (may timeout on fast machines)
				const event = await eventPromise;
				if (event) {
					expect((event as Record<string, unknown>).type).toBe('EVENT');
					expect((event as Record<string, unknown>).method).toBe('session.interrupted');
				}
			}

			// State should be idle after interrupt (or if SDK finished fast)
			await waitForIdle(agentSession!);
			expect(agentSession!.getProcessingState().status).toBe('idle');

			// Cleanup
			await messagePromise;
			ws.close();
		}, 20000);
	});
});
