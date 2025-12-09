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
 * - Tests are skipped if credentials are not available
 * - Makes real API calls (costs money, uses rate limits)
 *
 * These tests run in parallel with other tests for faster CI execution.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import {
	createTestApp,
	createWebSocketWithFirstMessage,
	waitForWebSocketState,
	waitForWebSocketMessage,
	hasAnyCredentials,
} from '../test-utils';

describe('AgentSession SDK Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('handleMessageSend', () => {
		test.skipIf(!hasAnyCredentials())(
			'should send message and receive real SDK response',
			async () => {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
				});

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				expect(agentSession).toBeDefined();

				// Send a simple message
				const result = await agentSession!.handleMessageSend({
					content: 'What is 1+1? Answer with just the number.',
				});

				expect(result.messageId).toBeString();
				expect(result.messageId.length).toBeGreaterThan(0);

				// Wait a bit for processing to complete
				await Bun.sleep(5000);

				// Check that we received SDK messages
				const sdkMessages = agentSession!.getSDKMessages();
				expect(sdkMessages.length).toBeGreaterThan(0);

				// Verify state returned to idle after processing
				const state = agentSession!.getProcessingState();
				expect(state.status).toBe('idle');
			},
			30000 // 30 second timeout
		);

		test.skipIf(!hasAnyCredentials())(
			'should handle message with images',
			async () => {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
				});

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

				// 1x1 red pixel PNG
				const result = await agentSession!.handleMessageSend({
					content: 'What color is this image? Answer with just the color name.',
					images: [
						{
							media_type: 'image/png',
							data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
						},
					],
				});

				expect(result.messageId).toBeString();

				// Wait for processing
				await Bun.sleep(5000);

				// Verify we got a response
				const sdkMessages = agentSession!.getSDKMessages();
				expect(sdkMessages.length).toBeGreaterThan(0);
			},
			30000
		);
	});

	describe('enqueueMessage', () => {
		test.skipIf(!hasAnyCredentials())(
			'should enqueue multiple messages in sequence',
			async () => {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
				});

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

				// Send first message to start the query
				await agentSession!.handleMessageSend({
					content: 'What is 2+2? Just the number.',
				});

				// Wait for first message to complete
				await Bun.sleep(5000);

				// Enqueue second message
				const messageIdPromise = agentSession!.enqueueMessage('What is 3+3? Just the number.');

				// The promise should resolve with a message ID
				const messageId = await Promise.race([
					messageIdPromise,
					new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000)),
				]);

				expect(messageId).toBeString();
				expect(messageId.length).toBeGreaterThan(0);

				// Wait for second message to process
				await Bun.sleep(5000);

				// Verify both messages were processed
				const messages = agentSession!.getMessages();
				expect(messages.length).toBeGreaterThanOrEqual(2);
			},
			40000
		);
	});

	describe('handleInterrupt', () => {
		test.skipIf(!hasAnyCredentials())(
			'should interrupt ongoing processing',
			async () => {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
				});

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

				// Start a message that might take a while
				await agentSession!.handleMessageSend({
					content: 'List all files in the current directory.',
				});

				// Immediately interrupt
				await Bun.sleep(100);
				await agentSession!.handleInterrupt();

				// State should be idle after interrupt
				const state = agentSession!.getProcessingState();
				expect(state.status).toBe('idle');
			},
			20000
		);
	});

	describe('WebSocket SDK message events', () => {
		test.skipIf(!hasAnyCredentials())(
			'should broadcast sdk.message events via WebSocket',
			async () => {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
				});

				const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
				await waitForWebSocketState(ws, WebSocket.OPEN);
				await firstMessagePromise;

				// Subscribe to sdk.message events
				const subPromise = waitForWebSocketMessage(ws);
				ws.send(
					JSON.stringify({
						id: 'sub-sdk-1',
						type: 'SUBSCRIBE',
						method: 'sdk.message',
						sessionId,
						timestamp: new Date().toISOString(),
						version: '1.0.0',
					})
				);
				await subPromise;

				// Send a message to trigger SDK events
				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				await agentSession!.handleMessageSend({
					content: 'Say hello. Just respond "Hello".',
				});

				// Wait for SDK message event
				const sdkEvent = await waitForWebSocketMessage(ws, 10000);

				// Should receive an sdk.message event
				expect(sdkEvent.type).toBe('EVENT');
				expect(sdkEvent.method).toBe('sdk.message');
				expect(sdkEvent.data).toBeDefined();

				ws.close();
			},
			30000
		);
	});

	describe('State transitions', () => {
		test.skipIf(!hasAnyCredentials())(
			'should transition through processing states',
			async () => {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
				});

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

				// Initial state should be idle
				expect(agentSession!.getProcessingState().status).toBe('idle');

				// Send message
				await agentSession!.handleMessageSend({
					content: 'What is 5+5? Just the number.',
				});

				// State should be queued or processing (depending on timing)
				const stateAfterSend = agentSession!.getProcessingState();
				expect(['queued', 'processing', 'idle']).toContain(stateAfterSend.status);

				// Wait for completion
				await Bun.sleep(5000);

				// Should be back to idle
				const finalState = agentSession!.getProcessingState();
				expect(finalState.status).toBe('idle');
			},
			20000
		);

		test.skipIf(!hasAnyCredentials())(
			'should handle multiple messages in sequence',
			async () => {
				const sessionId = await ctx.sessionManager.createSession({
					workspacePath: process.cwd(),
				});

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

				// Send multiple messages
				const promise1 = agentSession!.handleMessageSend({ content: 'Count to 1' });
				await Bun.sleep(100);
				const promise2 = agentSession!.handleMessageSend({ content: 'Count to 2' });

				const results = await Promise.all([promise1, promise2]);

				// All should have unique message IDs
				expect(results[0].messageId).toBeString();
				expect(results[1].messageId).toBeString();
				expect(results[0].messageId).not.toBe(results[1].messageId);

				// Wait for processing to complete
				await Bun.sleep(8000);

				// Should have messages from both interactions
				const messages = agentSession!.getMessages();
				expect(messages.length).toBeGreaterThanOrEqual(2);
			},
			30000
		);
	});
});
