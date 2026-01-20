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
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../../helpers/daemon-server-helper';
import { sendMessage, waitForIdle, getSession } from '../../helpers/daemon-test-helpers';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Session Resume', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await spawnDaemonServer();
	});

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	});

	test('should maintain session consistency across multiple operations', async () => {
		const workspacePath = `${TMP_DIR}/session-resume-test-${Date.now()}`;

		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath,
			title: 'Session Resume Test',
			config: {
				model: 'haiku-4.5',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;

		// Initial session state
		let session = await getSession(daemon, sessionId);
		expect(session.id).toBe(sessionId);

		// Send first message
		await sendMessage(daemon, sessionId, 'First message');
		await waitForIdle(daemon, sessionId, 30000);

		// Verify session is still consistent
		session = await getSession(daemon, sessionId);
		expect(session.id).toBe(sessionId);

		// Send second message
		await sendMessage(daemon, sessionId, 'Second message');
		await waitForIdle(daemon, sessionId, 30000);

		// Session should still be consistent and functional
		session = await getSession(daemon, sessionId);
		expect(session.id).toBe(sessionId);
		expect(session.workspacePath).toBe(workspacePath);
	}, 60000);
});
