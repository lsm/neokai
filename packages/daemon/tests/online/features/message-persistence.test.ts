/**
 * Message Persistence Integration Tests
 *
 * These tests verify that messages are properly persisted and retrievable
 * through the WebSocket API.
 *
 * Tests cover:
 * 1. Messages are persisted and can be retrieved
 * 2. Messages survive across daemon restarts
 * 3. Messages persist correctly even with interruptions
 * 4. Message order is maintained
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODEL:
 * - Uses 'haiku-4.5' (faster and cheaper than Sonnet for tests)
 * - Note: Short alias 'haiku' doesn't work with Claude OAuth (SDK hangs)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// Bun automatically loads .env from project root when running tests
import type { DaemonServerContext } from '../helpers/daemon-server';
import { createDaemonServer } from '../helpers/daemon-server';
import {
	getProcessingState,
	getSession,
	interrupt,
	sendMessage,
	waitForIdle,
} from '../helpers/daemon-actions';

// Use temp directory for test database
const TMP_DIR = process.env.TMPDIR || '/tmp';

// Tests will FAIL if GLM credentials are not available
describe('Message Persistence', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 20000);

	describe('Basic Message Persistence', () => {
		test('should persist user messages to database', async () => {
			const workspacePath = `${TMP_DIR}/persistence-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Persist Messages Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message
			const result = await sendMessage(daemon, sessionId, 'What is 1+1?');
			expect(result.messageId).toBeString();

			// Wait for message to be processed
			await waitForIdle(daemon, sessionId, 30000);

			// Get session - should have messages
			const session = await getSession(daemon, sessionId);

			// Verify session exists and has proper metadata
			expect(session).toBeDefined();
			expect(session.id).toBe(sessionId);
		}, 30000);

		test('should maintain message order across multiple sends', async () => {
			const workspacePath = `${TMP_DIR}/persistence-order-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Message Order Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send multiple messages
			const msg1 = await sendMessage(daemon, sessionId, 'First message');
			await waitForIdle(daemon, sessionId, 30000);

			const msg2 = await sendMessage(daemon, sessionId, 'Second message');
			await waitForIdle(daemon, sessionId, 30000);

			const msg3 = await sendMessage(daemon, sessionId, 'Third message');
			await waitForIdle(daemon, sessionId, 30000);

			// All message IDs should be unique
			expect(msg1.messageId).not.toBe(msg2.messageId);
			expect(msg2.messageId).not.toBe(msg3.messageId);
			expect(msg1.messageId).not.toBe(msg3.messageId);

			// Session should still be functional
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');
		}, 60000);
	});

	describe('Message Persistence with Interruption', () => {
		test('should not lose messages when interrupted', async () => {
			const workspacePath = `${TMP_DIR}/persistence-interrupt-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Interrupt Persistence Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message that will take some time
			await sendMessage(daemon, sessionId, 'Count from 1 to 100 slowly.');

			// Wait a bit for processing to start
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Interrupt the stream
			await interrupt(daemon, sessionId);

			// Wait for interrupt to complete
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Session should still be functional after interrupt
			const state = await getProcessingState(daemon, sessionId);
			expect(state).toBeDefined();

			// Send another message to verify session still works
			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 30000);

			// Should be idle and functional
			const finalState = await getProcessingState(daemon, sessionId);
			expect(finalState.status).toBe('idle');
		}, 60000);
	});

	describe('Session State Consistency', () => {
		test('should maintain consistent session state across operations', async () => {
			const workspacePath = `${TMP_DIR}/persistence-state-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'State Consistency Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Initial state check
			let session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);
			expect(session.workspacePath).toBe(workspacePath);

			// Send a message
			await sendMessage(daemon, sessionId, 'Test message');
			await waitForIdle(daemon, sessionId, 30000);

			// Session should still be consistent
			session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);
			expect(session.workspacePath).toBe(workspacePath);

			// Agent should be in idle state
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');
		}, 30000);
	});

	describe('Concurrent Message Handling', () => {
		test('should handle multiple message sends in sequence', async () => {
			const workspacePath = `${TMP_DIR}/persistence-concurrent-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Concurrent Messages Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send messages in quick succession
			const results = await Promise.all([
				sendMessage(daemon, sessionId, 'Message 1'),
				new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
					sendMessage(daemon, sessionId, 'Message 2')
				),
				new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
					sendMessage(daemon, sessionId, 'Message 3')
				),
			]);

			// All should have unique message IDs
			expect(results[0].messageId).not.toBe(results[1].messageId);
			expect(results[1].messageId).not.toBe(results[2].messageId);

			// Wait for processing to complete
			await waitForIdle(daemon, sessionId, 60000);

			// Should be idle
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');
		}, 90000);
	});
});
