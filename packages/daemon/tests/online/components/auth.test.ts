/**
 * Authentication Integration Tests (API-dependent)
 *
 * Tests for authentication functionality that requires API credentials.
 * These tests verify that authenticated sessions work correctly.
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../helpers/daemon-server-helper';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Authentication Integration (API-dependent)', () => {
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

	describe('Session Creation with Auth', () => {
		test('should create session only if authenticated', async () => {
			const result = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-auth`,
				config: { model: 'haiku' }, // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
			})) as { sessionId: string };

			expect(result.sessionId).toBeString();

			// Verify session was created via RPC
			const sessionResult = (await daemon.messageHub.call('session.get', {
				sessionId: result.sessionId,
			})) as { session: Record<string, unknown> };

			expect(sessionResult.session).toBeDefined();
			expect(sessionResult.session.id).toBe(result.sessionId);
		});
	});
});
