/**
 * Agent Pipeline Tests
 *
 * Tests the full agent harness via WebSocket using mock SDK:
 * - Message flow: send → process → persist → query back
 * - State transitions: idle → processing → idle
 * - Multi-turn conversations
 * - Error result handling
 * - SDK message types (system init, tool use, result)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import {
	sendMessage,
	waitForIdle,
	getProcessingState,
	waitForSdkMessages,
} from '../../helpers/daemon-actions';
import {
	simpleTextResponse,
	errorResponse,
	sdkSystemInit,
	sdkAssistantText,
	sdkAssistantToolUse,
	sdkResultSuccess,
	sdkResultError,
} from '../../helpers/mock-sdk';

// Tests that send messages to mock SDK need longer timeout on CI
const TIMEOUT = 15000;

describe('Agent Pipeline', () => {
	let daemon: DaemonServerContext;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		// Save and override env for mock SDK (scoped to avoid leaking to other test files)
		for (const key of ['NEOKAI_AGENT_SDK_MOCK', 'ANTHROPIC_API_KEY', 'DEFAULT_PROVIDER']) {
			savedEnv[key] = process.env[key];
		}
		process.env.NEOKAI_AGENT_SDK_MOCK = 'true';
		process.env.ANTHROPIC_API_KEY = 'mock-key';
		delete process.env.DEFAULT_PROVIDER;

		daemon = await createDaemonServer();
	});

	afterEach(async () => {
		await daemon.waitForExit();

		// Restore original env
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	async function createSession(): Promise<string> {
		const { sessionId } = (await daemon.messageHub.request('session.create', {
			workspacePath: `/test/pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			title: 'Pipeline Test', // Skip title generation
		})) as { sessionId: string };
		daemon.trackSession(sessionId);
		return sessionId;
	}

	describe('basic message flow', () => {
		test(
			'should process response through full pipeline',
			async () => {
				daemon.mockControls?.setDefaultResponses(simpleTextResponse('Hello from mock SDK!'));
				const sessionId = await createSession();

				const { messageId } = await sendMessage(daemon, sessionId, 'Hi there');
				expect(messageId).toBeString();

				await waitForIdle(daemon, sessionId);

				// Verify messages were persisted and queryable via RPC
				const result = await waitForSdkMessages(daemon, sessionId, { minCount: 2 });

				expect(result.sdkMessages.length).toBeGreaterThanOrEqual(2);

				// Verify assistant message
				const assistantMsg = result.sdkMessages.find((m) => m.type === 'assistant');
				expect(assistantMsg).toBeDefined();
				const content = (assistantMsg!.message as { content: Array<{ text: string }> }).content;
				expect(content[0].text).toBe('Hello from mock SDK!');

				// Verify result message
				const resultMsg = result.sdkMessages.find((m) => m.type === 'result');
				expect(resultMsg).toBeDefined();
			},
			TIMEOUT
		);

		test(
			'should return to idle state after processing',
			async () => {
				const sessionId = await createSession();

				await sendMessage(daemon, sessionId, 'Do something');
				await waitForIdle(daemon, sessionId);

				const state = await getProcessingState(daemon, sessionId);
				expect(state.status).toBe('idle');
			},
			TIMEOUT
		);
	});

	describe('SDK message handling', () => {
		test(
			'should persist system init message',
			async () => {
				const sdkSessionId = 'sdk-session-' + Date.now();
				daemon.mockControls?.setDefaultResponses([
					sdkSystemInit({ sessionId: sdkSessionId }),
					sdkAssistantText('Hello'),
					sdkResultSuccess(),
				]);
				const sessionId = await createSession();

				await sendMessage(daemon, sessionId, 'Hi');
				await waitForIdle(daemon, sessionId);

				const result = await waitForSdkMessages(daemon, sessionId, { minCount: 2 });

				const systemMsg = result.sdkMessages.find((m) => m.type === 'system');
				expect(systemMsg).toBeDefined();
			},
			TIMEOUT
		);

		test(
			'should persist tool use messages',
			async () => {
				daemon.mockControls?.setDefaultResponses([
					sdkSystemInit(),
					sdkAssistantToolUse('Read', { file_path: '/test.ts' }),
					sdkResultSuccess(),
				]);
				const sessionId = await createSession();

				await sendMessage(daemon, sessionId, 'Read test.ts');
				await waitForIdle(daemon, sessionId);

				const result = await waitForSdkMessages(daemon, sessionId, { minCount: 2 });

				const toolMsg = result.sdkMessages.find(
					(m) =>
						m.type === 'assistant' &&
						(m.message as { content: Array<{ type: string }> }).content.some(
							(b) => b.type === 'tool_use'
						)
				);
				expect(toolMsg).toBeDefined();
			},
			TIMEOUT
		);
	});

	describe('error scenarios', () => {
		test('should handle error result and return to idle', async () => {
			daemon.mockControls?.setDefaultResponses(errorResponse('Something went wrong'));
			const sessionId = await createSession();

			await sendMessage(daemon, sessionId, 'Do something big');
			await waitForIdle(daemon, sessionId);

			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');
		}, 15000);
	});

	describe('multi-turn conversations', () => {
		test(
			'should handle sequential messages',
			async () => {
				let turnCount = 0;
				daemon.mockControls?.setDefaultResponses(() => {
					turnCount++;
					return simpleTextResponse(`Response ${turnCount}`);
				});
				const sessionId = await createSession();

				// First message
				await sendMessage(daemon, sessionId, 'First');
				await waitForIdle(daemon, sessionId);

				// Second message
				await sendMessage(daemon, sessionId, 'Second');
				await waitForIdle(daemon, sessionId);

				// Both responses should be queryable
				const result = await waitForSdkMessages(daemon, sessionId, { minCount: 4 });

				const assistantMsgs = result.sdkMessages.filter((m) => m.type === 'assistant');
				expect(assistantMsgs.length).toBe(2);
			},
			TIMEOUT
		);
	});

	describe('message query', () => {
		test(
			'should return persisted messages via message.sdkMessages',
			async () => {
				const sessionId = await createSession();

				await sendMessage(daemon, sessionId, 'Hi');
				await waitForIdle(daemon, sessionId);

				const result = await waitForSdkMessages(daemon, sessionId, { minCount: 2 });

				expect(result.sdkMessages.length).toBeGreaterThan(0);
				const types = result.sdkMessages.map((m: Record<string, unknown>) => m.type);
				expect(types).toContain('assistant');
			},
			TIMEOUT
		);
	});
});
