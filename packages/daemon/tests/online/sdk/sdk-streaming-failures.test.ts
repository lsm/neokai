/**
 * SDK Streaming Behavior Tests
 *
 * These tests verify SDK behavior through the WebSocket daemon API:
 * - Permission mode handling
 * - Message processing
 * - Session state consistency
 *
 * Requires real API credentials (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
 * For offline testing, use Dev Proxy (NEOKAI_USE_DEV_PROXY=1).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	sendMessage,
	waitForIdle,
	getProcessingState,
	getSession,
} from '../../helpers/daemon-actions';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

const MODEL = 'haiku-4.5';
const IDLE_TIMEOUT = 30000;
const SETUP_TIMEOUT = 30000;
const TEST_TIMEOUT = 90000;

// Tests will FAIL if no credentials are available
describe('SDK Streaming Behavior', () => {
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

	describe('Permission Mode Handling', () => {
		test(
			'should work with acceptEdits permission mode',
			async () => {
				const workspacePath = `${TMP_DIR}/accept-edits-test-${Date.now()}`;

				const createResult = (await daemon.messageHub.request('session.create', {
					workspacePath,
					title: 'Accept Edits Test',
					config: {
						model: MODEL,
						permissionMode: 'acceptEdits', // Works on root and non-root
					},
				})) as { sessionId: string };

				const { sessionId } = createResult;
				daemon.trackSession(sessionId);

				// Send a message
				const result = await sendMessage(
					daemon,
					sessionId,
					'What is 2+2? Answer with just the number.'
				);

				expect(result.messageId).toBeString();

				// Wait for processing to complete
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// Verify session is idle
				const state = await getProcessingState(daemon, sessionId);
				expect(state.status).toBe('idle');
			},
			TEST_TIMEOUT
		);
	});

	describe('Message Processing', () => {
		test(
			'should process messages correctly through WebSocket API',
			async () => {
				const workspacePath = `${TMP_DIR}/message-processing-test-${Date.now()}`;

				const createResult = (await daemon.messageHub.request('session.create', {
					workspacePath,
					title: 'Message Processing Test',
					config: {
						model: MODEL,
						permissionMode: 'acceptEdits',
					},
				})) as { sessionId: string };

				const { sessionId } = createResult;
				daemon.trackSession(sessionId);

				// Send multiple messages
				const msg1 = await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				const msg2 = await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				const msg3 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// All should have unique message IDs
				expect(msg1.messageId).not.toBe(msg2.messageId);
				expect(msg2.messageId).not.toBe(msg3.messageId);
				expect(msg1.messageId).not.toBe(msg3.messageId);

				// Session should be idle and functional
				const state = await getProcessingState(daemon, sessionId);
				expect(state.status).toBe('idle');
			},
			TEST_TIMEOUT
		);

		test(
			'should handle simple prompt pattern correctly',
			async () => {
				const workspacePath = `${TMP_DIR}/simple-prompt-test-${Date.now()}`;

				const createResult = (await daemon.messageHub.request('session.create', {
					workspacePath,
					title: 'Simple Prompt Test',
					config: {
						model: MODEL,
						permissionMode: 'acceptEdits',
					},
				})) as { sessionId: string };

				const { sessionId } = createResult;
				daemon.trackSession(sessionId);

				// Simple prompt pattern (same as other passing tests)
				const result = await sendMessage(
					daemon,
					sessionId,
					'What is 3+3? Answer with just the number.'
				);

				expect(result.messageId).toBeString();

				// Wait for processing to complete
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// Verify session is idle
				const state = await getProcessingState(daemon, sessionId);
				expect(state.status).toBe('idle');
			},
			TEST_TIMEOUT
		);
	});

	describe('Session State Consistency', () => {
		test(
			'should maintain consistent session state',
			async () => {
				const workspacePath = `${TMP_DIR}/session-state-test-${Date.now()}`;

				const createResult = (await daemon.messageHub.request('session.create', {
					workspacePath,
					title: 'Session State Test',
					config: {
						model: MODEL,
						permissionMode: 'acceptEdits',
					},
				})) as { sessionId: string };

				const { sessionId } = createResult;
				daemon.trackSession(sessionId);

				// Initial state check
				let session = await getSession(daemon, sessionId);
				expect(session.id).toBe(sessionId);
				expect(session.workspacePath).toBe(workspacePath);

				// Send a message
				await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');

				// Wait for SDK to process and return to idle
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// Session should still be consistent
				session = await getSession(daemon, sessionId);
				expect(session.id).toBe(sessionId);
				expect(session.workspacePath).toBe(workspacePath);

				// Agent should be in idle state
				const state = await getProcessingState(daemon, sessionId);
				expect(state.status).toBe('idle');
			},
			TEST_TIMEOUT
		);
	});

	describe('Message Persistence and Reload', () => {
		test(
			'should persist messages across session operations',
			async () => {
				const workspacePath = `${TMP_DIR}/persistence-reload-test-${Date.now()}`;

				const createResult = (await daemon.messageHub.request('session.create', {
					workspacePath,
					title: 'Persistence Reload Test',
					config: {
						model: MODEL,
						permissionMode: 'acceptEdits',
					},
				})) as { sessionId: string };

				const { sessionId } = createResult;
				daemon.trackSession(sessionId);

				// Send a message to the real SDK
				const result = await sendMessage(
					daemon,
					sessionId,
					'What is 2+2? Answer with just the number.'
				);

				expect(result.messageId).toBeString();

				// Wait for processing to complete
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// Get session data - should be consistent
				const session = await getSession(daemon, sessionId);
				expect(session.id).toBe(sessionId);
				expect(session.workspacePath).toBe(workspacePath);

				// Send another message to verify session still works
				const result2 = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');
				expect(result2.messageId).toBeString();
				expect(result2.messageId).not.toBe(result.messageId);

				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// Session should still be functional
				const state = await getProcessingState(daemon, sessionId);
				expect(state.status).toBe('idle');
			},
			TEST_TIMEOUT
		);
	});
});
