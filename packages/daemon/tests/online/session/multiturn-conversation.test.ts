/**
 * Multi-Turn Conversation Tests
 *
 * These tests verify that AgentSession correctly handles multi-turn conversations:
 * - Context retention across turns
 * - Sequential message processing
 * - SDK message persistence
 * - Processing state transitions
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY or ANTHROPIC_API_KEY
 * - Uses 'haiku' model which auto-maps to glm-4.5-air when GLM_API_KEY is set
 * - Makes real API calls (costs money, uses rate limits)
 *
 * These tests run in parallel with other tests for faster CI execution.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../test-utils';
import { sendMessageSync } from '../../helpers/test-message-sender';
import { waitForIdle } from '../../helpers/test-wait-for-idle';

// Check for API credentials (GLM, Claude Code OAuth, or Anthropic)
const HAS_API_KEY = !!(
	process.env.GLM_API_KEY ||
	process.env.ZHIPU_API_KEY ||
	process.env.CLAUDE_CODE_OAUTH_TOKEN ||
	process.env.ANTHROPIC_API_KEY
);

/**
 * CRITICAL: Restore any mocks before running these tests.
 * This prevents mock leakage from unit tests that mock the SDK.
 */
describe.skipIf(!HAS_API_KEY)('Multi-Turn Conversation', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(
		async () => {
			if (ctx) {
				await ctx.cleanup();
			}
		},
		{ timeout: 30000 }
	); // 30s timeout for cleanup (slower API + subprocess exit)

	test('should handle multi-turn conversation with context retention', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
			config: {
				model: 'haiku',
				permissionMode: 'acceptEdits',
			},
		});

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		expect(agentSession).toBeDefined();

		// Turn 1: Ask for a number to remember
		const result1 = await sendMessageSync(agentSession!, {
			content: 'Remember the number 42 for me. Just reply "Got it, I will remember 42."',
		});
		expect(result1.messageId).toBeString();

		await waitForIdle(agentSession!, 30000);

		// Turn 2: Ask what the number was (tests context retention)
		const result2 = await sendMessageSync(agentSession!, {
			content: 'What number did I ask you to remember? Just reply with the number.',
		});
		expect(result2.messageId).toBeString();
		expect(result2.messageId).not.toBe(result1.messageId);

		await waitForIdle(agentSession!, 30000);

		// Verify context was retained - check SDK messages contain the number 42 in response
		const sdkMessages = agentSession!.getSDKMessages();
		expect(sdkMessages.length).toBeGreaterThan(0);

		// Find the last assistant message (should contain "42")
		// SDK messages have structure { type: 'assistant', message: { role: 'assistant', ... } }
		const assistantMessages = sdkMessages.filter((m) => m.type === 'assistant');
		expect(assistantMessages.length).toBeGreaterThan(0);

		// The last response should mention 42
		const lastAssistant = assistantMessages[assistantMessages.length - 1] as {
			message: { content: Array<{ type: string; text: string }> };
		};
		const lastResponseText = lastAssistant.message.content
			.filter((c) => c.type === 'text')
			.map((c) => c.text)
			.join('');
		expect(lastResponseText).toContain('42');

		// Turn 3: Do a simple calculation using the remembered number
		const result3 = await sendMessageSync(agentSession!, {
			content: 'Multiply the number you remembered by 2. Just reply with the result.',
		});
		expect(result3.messageId).toBeString();
		expect(result3.messageId).not.toBe(result1.messageId);
		expect(result3.messageId).not.toBe(result2.messageId);

		await waitForIdle(agentSession!, 30000);

		// Verify we have SDK messages from all turns
		const finalMessages = agentSession!.getSDKMessages();
		expect(finalMessages.length).toBeGreaterThan(3); // At least 3 user + 3 assistant messages

		// Verify state is idle after all turns
		const finalState = agentSession!.getProcessingState();
		expect(finalState.status).toBe('idle');
	}, 90000); // 90 second timeout for 3 API calls

	test('should handle multi-turn conversation with code analysis', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
			config: {
				model: 'haiku',
				permissionMode: 'acceptEdits',
			},
		});

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

		// Turn 1: Provide code context
		await sendMessageSync(agentSession!, {
			content: 'I will show you a TypeScript function. Just reply "Ready, show me the code."',
		});
		await waitForIdle(agentSession!, 30000);

		// Turn 2: Show actual code
		await sendMessageSync(agentSession!, {
			content:
				'Here is the code:\n\n```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nWhat does this function do? Answer in one sentence.',
		});
		await waitForIdle(agentSession!, 30000);

		// Verify we got a response about the function
		const sdkMessages = agentSession!.getSDKMessages();
		const assistantMessages = sdkMessages.filter((m) => m.type === 'assistant');
		expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

		// Turn 3: Ask follow-up about the code
		await sendMessageSync(agentSession!, {
			content: 'What are the parameter types? Just list them separated by commas.',
		});
		await waitForIdle(agentSession!, 30000);

		// Verify we have more messages
		const finalMessages = agentSession!.getSDKMessages();
		expect(finalMessages.length).toBeGreaterThan(sdkMessages.length);

		// Final state should be idle
		const finalState = agentSession!.getProcessingState();
		expect(finalState.status).toBe('idle');
	}, 90000);

	test('should handle rapid successive messages correctly', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
			config: {
				model: 'haiku',
				permissionMode: 'acceptEdits',
			},
		});

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

		// Send three simple messages in quick succession
		// They should be queued and processed sequentially
		const msg1 = await sendMessageSync(agentSession!, {
			content: 'First message: Say "One".',
		});
		await waitForIdle(agentSession!, 30000);

		const msg2 = await sendMessageSync(agentSession!, {
			content: 'Second message: Say "Two".',
		});
		await waitForIdle(agentSession!, 30000);

		const msg3 = await sendMessageSync(agentSession!, {
			content: 'Third message: Say "Three".',
		});
		await waitForIdle(agentSession!, 30000);

		// All message IDs should be unique
		expect(msg1.messageId).not.toBe(msg2.messageId);
		expect(msg2.messageId).not.toBe(msg3.messageId);
		expect(msg1.messageId).not.toBe(msg3.messageId);

		// Verify all messages were processed
		const sdkMessages = agentSession!.getSDKMessages();
		expect(sdkMessages.length).toBeGreaterThan(0);

		// Count user and assistant messages
		const userMessages = sdkMessages.filter((m) => m.type === 'user');
		const assistantMessages = sdkMessages.filter((m) => m.type === 'assistant');

		// Should have 3 user messages and 3 assistant responses
		expect(userMessages.length).toBeGreaterThanOrEqual(3);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(3);

		// State should be idle
		const finalState = agentSession!.getProcessingState();
		expect(finalState.status).toBe('idle');
	}, 60000); // 60 second timeout for 3 sequential API calls

	describe('WebSocket multi-turn events', () => {
		test('should broadcast SDK messages for each turn via WebSocket', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: {
					model: 'haiku',
					permissionMode: 'acceptEdits',
				},
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe to state.sdkMessages.delta events
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

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Turn 1
			const event1Promise = waitForWebSocketMessage(ws, 15000);
			await sendMessageSync(agentSession!, {
				content: 'Say "Hello turn 1". Just that phrase.',
			});
			const event1 = (await event1Promise) as Record<string, unknown>;
			expect(event1.type).toBe('EVENT');
			expect(event1.method).toBe('state.sdkMessages.delta');

			await waitForIdle(agentSession!, 30000);

			// Turn 2
			const event2Promise = waitForWebSocketMessage(ws, 15000);
			await sendMessageSync(agentSession!, {
				content: 'Say "Hello turn 2". Just that phrase.',
			});
			const event2 = (await event2Promise) as Record<string, unknown>;
			expect(event2.type).toBe('EVENT');
			expect(event2.method).toBe('state.sdkMessages.delta');

			await waitForIdle(agentSession!, 30000);

			ws.close();

			// Verify we got responses for both turns
			const sdkMessages = agentSession!.getSDKMessages();
			expect(sdkMessages.length).toBeGreaterThan(2);
		}, 120000);
	});

	describe('Processing state transitions across turns', () => {
		test('should correctly transition through states for each turn', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
				config: {
					model: 'haiku',
					permissionMode: 'acceptEdits',
				},
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Track states through 3 turns
			for (let i = 1; i <= 3; i++) {
				// Initial state should be idle
				const initialState = agentSession!.getProcessingState();
				expect(initialState.status).toBe('idle');

				// Send message
				await sendMessageSync(agentSession!, {
					content: `Turn ${i}: Say "Done". Just that word.`,
				});

				// State should change from idle
				const processingState = agentSession!.getProcessingState();
				expect(['queued', 'processing']).toContain(processingState.status);

				// Wait for completion
				await waitForIdle(agentSession!, 30000);

				// Should be back to idle
				const finalState = agentSession!.getProcessingState();
				expect(finalState.status).toBe('idle');
			}

			// Verify all messages were processed
			const sdkMessages = agentSession!.getSDKMessages();
			expect(sdkMessages.length).toBeGreaterThan(0);
		}, 120000);
	});
});
