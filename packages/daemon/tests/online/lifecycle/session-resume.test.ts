/**
 * Session Resume Integration Tests
 *
 * Session resume functionality is now tested in:
 * - sdk-streaming-failures.test.ts - SDK session ID capture and persistence
 * - agent-session-sdk.test.ts - Session state across operations
 * - message-persistence.test.ts - Message persistence across operations
 *
 * The session resume feature ensures that when a session is reloaded,
 * the SDK session ID is preserved to allow continuous conversation.
 *
 * Requires real API credentials (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
 * For offline testing, use Dev Proxy (NEOKAI_USE_DEV_PROXY=1).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getSession, sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

const MODEL = 'haiku-4.5';
const IDLE_TIMEOUT = 45000;
const SETUP_TIMEOUT = 30000;
const TEST_TIMEOUT = 90000;

describe('Session Resume', () => {
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
		'should maintain session consistency across multiple operations',
		async () => {
			const workspacePath = `${TMP_DIR}/session-resume-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath,
				title: 'Session Resume Test',
				config: {
					model: MODEL,
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Initial session state
			let session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);

			// Send first message
			await sendMessage(daemon, sessionId, 'First message');
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// Verify session is still consistent
			session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);

			// Send second message
			await sendMessage(daemon, sessionId, 'Second message');
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			// Session should still be consistent and functional
			session = await getSession(daemon, sessionId);
			expect(session.id).toBe(sessionId);
			expect(session.workspacePath).toBe(workspacePath);
		},
		TEST_TIMEOUT
	);
});
