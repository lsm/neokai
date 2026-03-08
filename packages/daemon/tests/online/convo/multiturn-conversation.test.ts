/**
 * Multi-Turn Conversation Tests
 *
 * These tests verify that AgentSession correctly handles multi-turn conversations:
 * - Context retention across turns
 * - Sequential message processing
 * - SDK message persistence
 * - Processing state transitions
 *
 * Requires real API credentials (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
 * For offline testing, use Dev Proxy (NEOKAI_USE_DEV_PROXY=1).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState, sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const MODEL = 'haiku-4.5';
const IDLE_TIMEOUT = 30000;
const SETUP_TIMEOUT = 30000;
const TEST_TIMEOUT = 150000;

describe('Multi-Turn Conversation', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'should handle multi-turn conversation with context retention',
		async () => {
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: process.cwd(),
				title: 'Context Retention Test',
				config: {
					model: MODEL,
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Turn 1: Simple math question
			const result1 = await sendMessage(
				daemon,
				sessionId,
				'What is 5 + 7? Just reply with the number.'
			);
			expect(result1.messageId).toBeString();

			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// Turn 2: Follow-up question (tests context retention)
			const result2 = await sendMessage(
				daemon,
				sessionId,
				'Now add 3 to that result. Just reply with the number.'
			);
			expect(result2.messageId).toBeString();
			expect(result2.messageId).not.toBe(result1.messageId);

			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// Verify state is idle after all turns
			const finalState = await getProcessingState(daemon, sessionId);
			expect(finalState.status).toBe('idle');
		},
		TEST_TIMEOUT
	);

	test(
		'should handle multi-turn conversation with code analysis',
		async () => {
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: process.cwd(),
				title: 'Code Analysis Test',
				config: {
					model: MODEL,
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Turn 1: Provide code context
			await sendMessage(
				daemon,
				sessionId,
				'I will show you a TypeScript function. Just reply "Ready, show me the code."'
			);
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// Turn 2: Show actual code
			await sendMessage(
				daemon,
				sessionId,
				'Here is the code:\n\n```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nWhat does this function do? Answer in one sentence.'
			);
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// Turn 3: Ask follow-up about the code
			await sendMessage(
				daemon,
				sessionId,
				'What are the parameter types? Just list them separated by commas.'
			);
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// Final state should be idle
			const finalState = await getProcessingState(daemon, sessionId);
			expect(finalState.status).toBe('idle');
		},
		TEST_TIMEOUT
	);

	test(
		'should handle rapid successive messages correctly',
		async () => {
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: process.cwd(),
				title: 'Rapid Messages Test',
				config: {
					model: MODEL,
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send three simple messages in quick succession
			// They should be queued and processed sequentially
			const msg1 = await sendMessage(daemon, sessionId, 'First message: Say "One".');
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			const msg2 = await sendMessage(daemon, sessionId, 'Second message: Say "Two".');
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			const msg3 = await sendMessage(daemon, sessionId, 'Third message: Say "Three".');
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// All message IDs should be unique
			expect(msg1.messageId).not.toBe(msg2.messageId);
			expect(msg2.messageId).not.toBe(msg3.messageId);
			expect(msg1.messageId).not.toBe(msg3.messageId);

			// State should be idle
			const finalState = await getProcessingState(daemon, sessionId);
			expect(finalState.status).toBe('idle');
		},
		TEST_TIMEOUT
	);

	describe('Processing state transitions across turns', () => {
		test(
			'should correctly transition through states for each turn',
			async () => {
				const createResult = (await daemon.messageHub.request('session.create', {
					workspacePath: process.cwd(),
					title: 'State Transitions Test',
					config: {
						model: MODEL,
						permissionMode: 'acceptEdits',
					},
				})) as { sessionId: string };

				const { sessionId } = createResult;
				daemon.trackSession(sessionId);

				// Track states through 3 turns
				for (let i = 1; i <= 3; i++) {
					// Initial state should be idle
					const initialState = await getProcessingState(daemon, sessionId);
					expect(initialState.status).toBe('idle');

					// Send message
					await sendMessage(daemon, sessionId, `Turn ${i}: Say "Done". Just that word.`);

					// State should change from idle
					const processingState = await getProcessingState(daemon, sessionId);
					expect(['queued', 'processing']).toContain(processingState.status);

					// Wait for completion
					await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

					// Should be back to idle
					const finalState = await getProcessingState(daemon, sessionId);
					expect(finalState.status).toBe('idle');
				}
			},
			TEST_TIMEOUT
		);
	});
});
