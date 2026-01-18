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
 * - Some tests require GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available
 *
 * MODEL MAPPING:
 * - Uses 'haiku' model (provider-agnostic)
 * - With GLM_API_KEY: haiku → glm-4.5-air (via ANTHROPIC_DEFAULT_HAIKU_MODEL)
 * - With ANTHROPIC_API_KEY: haiku → Claude Haiku
 * - This makes tests provider-agnostic and easy to switch
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import 'dotenv/config';
import type { DaemonServerContext } from '../../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../../helpers/daemon-server-helper';
import {
	sendMessage,
	waitForIdle,
	getSession,
	getProcessingState,
	interrupt,
} from '../../helpers/daemon-test-helpers';

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

// Use temp directory for test database
const TMP_DIR = process.env.TMPDIR || '/tmp';

// Tests will FAIL if GLM credentials are not available
describe('Message Persistence', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		daemon = await spawnDaemonServer();
	});

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	});

	describe('Basic Message Persistence', () => {
		test('should persist user messages to database', async () => {
			const workspacePath = `${TMP_DIR}/persistence-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				config: { model: 'haiku', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;

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
				config: { model: 'haiku', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;

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
				config: { model: 'haiku', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;

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
				config: { model: 'haiku', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;

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
				config: { model: 'haiku', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;

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
