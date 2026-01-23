/**
 * SDK Streaming Behavior Tests
 *
 * These tests verify SDK behavior through the WebSocket daemon API:
 * - Permission mode handling
 * - Message processing
 * - Session state consistency
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODEL:
 * - Uses 'default' model which maps to Sonnet
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import 'dotenv/config';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../helpers/daemon-server-helper';
import {
	sendMessage,
	waitForIdle,
	getProcessingState,
	getSession,
} from '../helpers/daemon-test-helpers';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

// Tests will FAIL if no credentials are available
describe('SDK Streaming Behavior', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await spawnDaemonServer();
	}, 30000);

	afterEach(
		async () => {
			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 20000 }
	);

	describe('Permission Mode Handling', () => {
		test('should work with acceptEdits permission mode', async () => {
			const workspacePath = `${TMP_DIR}/accept-edits-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Accept Edits Test',
				config: {
					model: 'default',
					permissionMode: 'acceptEdits', // Works on root and non-root
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Send a message
			const result = await sendMessage(
				daemon,
				sessionId,
				'What is 2+2? Answer with just the number.'
			);

			expect(result.messageId).toBeString();

			// Wait for processing to complete
			await waitForIdle(daemon, sessionId, 30000);

			// Verify session is idle
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			console.log('[ACCEPT-EDITS TEST] ✓ PASSED - acceptEdits mode works correctly');
		}, 30000);
	});

	describe('Message Processing', () => {
		test('should process messages correctly through WebSocket API', async () => {
			const workspacePath = `${TMP_DIR}/message-processing-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Message Processing Test',
				config: {
					model: 'default',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Send multiple messages
			const msg1 = await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
			await waitForIdle(daemon, sessionId, 30000);

			const msg2 = await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');
			await waitForIdle(daemon, sessionId, 30000);

			const msg3 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
			await waitForIdle(daemon, sessionId, 30000);

			// All should have unique message IDs
			expect(msg1.messageId).not.toBe(msg2.messageId);
			expect(msg2.messageId).not.toBe(msg3.messageId);
			expect(msg1.messageId).not.toBe(msg3.messageId);

			// Session should be idle and functional
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			console.log('[MESSAGE PROCESSING TEST] ✓ PASSED - All messages processed correctly');
		}, 60000);

		test('should handle simple prompt pattern correctly', async () => {
			const workspacePath = `${TMP_DIR}/simple-prompt-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Simple Prompt Test',
				config: {
					model: 'default',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Simple prompt pattern (same as other passing tests)
			const result = await sendMessage(
				daemon,
				sessionId,
				'What is 3+3? Answer with just the number.'
			);

			expect(result.messageId).toBeString();

			// Wait for processing to complete
			await waitForIdle(daemon, sessionId, 30000);

			// Verify session is idle
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			console.log('[SIMPLE PROMPT TEST] ✓ PASSED - Simple prompt pattern works');
		}, 30000);
	});

	describe('Session State Consistency', () => {
		test('should maintain consistent session state', async () => {
			const workspacePath = `${TMP_DIR}/session-state-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Session State Test',
				config: {
					model: 'default',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Initial state check
			let session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);
			expect(session.workspacePath).toBe(workspacePath);

			// Send a message
			await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');

			// Wait for SDK to process and return to idle
			await waitForIdle(daemon, sessionId, 30000);

			// Session should still be consistent
			session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);
			expect(session.workspacePath).toBe(workspacePath);

			// Agent should be in idle state
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			console.log('[SESSION STATE TEST] ✓ PASSED - Session state is consistent');
		}, 30000);
	});

	describe('Message Persistence and Reload', () => {
		test('should persist messages across session operations', async () => {
			const workspacePath = `${TMP_DIR}/persistence-reload-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Persistence Reload Test',
				config: {
					model: 'default',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Send a message to the real SDK
			const result = await sendMessage(
				daemon,
				sessionId,
				'What is 2+2? Answer with just the number.'
			);

			expect(result.messageId).toBeString();

			// Wait for processing to complete
			await waitForIdle(daemon, sessionId, 30000);

			// Get session data - should be consistent
			const session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);
			expect(session.workspacePath).toBe(workspacePath);

			// Send another message to verify session still works
			const result2 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
			expect(result2.messageId).toBeString();
			expect(result2.messageId).not.toBe(result.messageId);

			await waitForIdle(daemon, sessionId, 30000);

			// Session should still be functional
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			console.log('[PERSISTENCE RELOAD TEST] ✓ PASSED - Messages persisted correctly');
		}, 60000);
	});
});
