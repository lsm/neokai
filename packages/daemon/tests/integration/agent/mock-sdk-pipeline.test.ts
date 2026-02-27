/**
 * Mock SDK Pipeline Integration Tests
 *
 * Tests the full agent harness (message handling, state management, persistence,
 * broadcasting) using scripted SDK messages instead of real API calls.
 *
 * These tests run in milliseconds vs seconds for online tests, and require
 * no API credentials.
 *
 * NOTE: Test code is intentionally identical to what online tests look like.
 * The mock is installed once in beforeEach via installAutoMock() — individual
 * tests never reference mock helpers directly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp, callRPCHandler, type TestContext } from '../../helpers/test-app';
import {
	installAutoMock,
	waitForIdle,
	simpleTextResponse,
	errorResponse,
	sdkSystemInit,
	sdkAssistantText,
	sdkAssistantToolUse,
	sdkResultSuccess,
	sdkResultError,
	type MockControls,
} from '../../helpers/mock-sdk';

describe('Mock SDK Pipeline', () => {
	let ctx: TestContext;
	let mock: MockControls;

	beforeEach(async () => {
		ctx = await createTestApp();
		mock = installAutoMock(ctx, simpleTextResponse('Mock response'));
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	async function createSession(overrides?: Record<string, unknown>): Promise<string> {
		const result = await callRPCHandler<{ sessionId: string }>(ctx.messageHub, 'session.create', {
			workspacePath: ctx.workspacePath,
			// Provide a title to skip auto-title generation (avoids real SDK API call)
			title: 'Mock Test Session',
			...overrides,
		});
		return result.sessionId;
	}

	async function sendMessage(sessionId: string, content: string): Promise<{ messageId: string }> {
		return await callRPCHandler<{ messageId: string }>(ctx.messageHub, 'message.send', {
			sessionId,
			content,
		});
	}

	describe('basic message flow', () => {
		test('should process response through full pipeline', async () => {
			mock.setDefaultResponses(simpleTextResponse('Hello from mock SDK!'));
			const sessionId = await createSession();

			// Send message — triggers the full pipeline
			const { messageId } = await sendMessage(sessionId, 'Hi there');
			expect(messageId).toBeString();

			// Wait for processing to complete
			await waitForIdle(ctx.sessionManager, sessionId);

			// Verify SDK messages were persisted to DB
			const { messages } = ctx.db.getSDKMessages(sessionId);
			expect(messages.length).toBeGreaterThanOrEqual(2); // system init + assistant + result

			// Verify assistant message content
			const assistantMsg = messages.find((m) => m.type === 'assistant');
			expect(assistantMsg).toBeDefined();
			expect((assistantMsg!.message as { content: Array<{ text: string }> }).content[0].text).toBe(
				'Hello from mock SDK!'
			);

			// Verify result message
			const resultMsg = messages.find((m) => m.type === 'result');
			expect(resultMsg).toBeDefined();
		});

		test('should return to idle state after processing', async () => {
			const sessionId = await createSession();

			await sendMessage(sessionId, 'Do something');
			await waitForIdle(ctx.sessionManager, sessionId);

			// Verify processing state is idle via RPC (same path clients use)
			const { state } = await callRPCHandler<{ state: { status: string } }>(
				ctx.messageHub,
				'agent.getState',
				{ sessionId }
			);
			expect(state.status).toBe('idle');
		});
	});

	describe('SDK message handling', () => {
		test('should persist system init with SDK session ID', async () => {
			const sdkSessionId = 'sdk-session-' + Date.now();
			mock.setDefaultResponses([
				sdkSystemInit({ sessionId: sdkSessionId }),
				sdkAssistantText('Hello'),
				sdkResultSuccess(),
			]);
			const sessionId = await createSession();

			await sendMessage(sessionId, 'Hi');
			await waitForIdle(ctx.sessionManager, sessionId);

			// Verify system init was saved
			const { messages } = ctx.db.getSDKMessages(sessionId);
			const systemMsg = messages.find((m) => m.type === 'system');
			expect(systemMsg).toBeDefined();
		});

		test('should track tool calls in session metadata', async () => {
			mock.setDefaultResponses([
				sdkSystemInit(),
				sdkAssistantToolUse('Read', { file_path: '/test.ts' }),
				sdkResultSuccess(),
			]);
			const sessionId = await createSession();

			await sendMessage(sessionId, 'Read test.ts');
			await waitForIdle(ctx.sessionManager, sessionId);

			// Verify tool call was tracked
			const { messages } = ctx.db.getSDKMessages(sessionId);
			const toolMsg = messages.find(
				(m) =>
					m.type === 'assistant' &&
					(m.message as { content: Array<{ type: string }> }).content.some(
						(b) => b.type === 'tool_use'
					)
			);
			expect(toolMsg).toBeDefined();
		});
	});

	describe('error scenarios', () => {
		test('should handle error result messages', async () => {
			mock.setDefaultResponses([
				sdkSystemInit(),
				sdkResultError('error_max_turns', 'Max turns reached'),
			]);
			const sessionId = await createSession();

			await sendMessage(sessionId, 'Do something big');
			await waitForIdle(ctx.sessionManager, sessionId);

			// Session should still be usable
			const { state } = await callRPCHandler<{ state: { status: string } }>(
				ctx.messageHub,
				'agent.getState',
				{ sessionId }
			);
			expect(state.status).toBe('idle');
		});
	});

	describe('multi-turn conversations', () => {
		test('should handle sequential messages', async () => {
			let turnCount = 0;
			mock.setDefaultResponses(() => {
				turnCount++;
				return simpleTextResponse(`Response ${turnCount}`);
			});
			const sessionId = await createSession();

			// First message
			await sendMessage(sessionId, 'First');
			await waitForIdle(ctx.sessionManager, sessionId);

			// Second message
			await sendMessage(sessionId, 'Second');
			await waitForIdle(ctx.sessionManager, sessionId);

			// Both responses should be in the DB
			const { messages } = ctx.db.getSDKMessages(sessionId);
			const assistantMsgs = messages.filter((m) => m.type === 'assistant');
			expect(assistantMsgs.length).toBe(2);
		});
	});

	describe('MessageHub broadcasting', () => {
		test('should persist messages that can be queried back', async () => {
			const sessionId = await createSession();

			await sendMessage(sessionId, 'Hi');
			await waitForIdle(ctx.sessionManager, sessionId);

			// Query back the messages via RPC (same path clients use)
			const result = await callRPCHandler<{
				sdkMessages: Array<{ type: string }>;
				hasMore: boolean;
			}>(ctx.messageHub, 'message.sdkMessages', { sessionId });

			expect(result.sdkMessages.length).toBeGreaterThan(0);
			const types = result.sdkMessages.map((m) => m.type);
			expect(types).toContain('assistant');
		});
	});
});
