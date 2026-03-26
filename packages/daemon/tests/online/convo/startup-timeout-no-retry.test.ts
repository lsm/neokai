/**
 * Startup Timeout Error Surfacing — No Retry Test
 *
 * Verifies that when the SDK startup times out:
 *   1. The error is surfaced via errorManager.handleError (visible in session state).
 *   2. No silent retry occurs — exactly one error, then session returns to idle.
 *   3. The error message contains actionable recovery hints for the user.
 *
 * Implementation note — module-level constant:
 *   STARTUP_TIMEOUT_MS in query-runner.ts is read once at process start, so it
 *   cannot be changed by mutating process.env after the process is running.
 *   This test forces DAEMON_TEST_SPAWN=true so a fresh child process loads the
 *   module with the env var already set to a very short value (10 ms).  The
 *   child process starts the SDK subprocess, which cannot possibly respond within
 *   10 ms, so the timeout fires reliably.
 *
 * MODES:
 *   - Dev Proxy (preferred, offline): NEOKAI_USE_DEV_PROXY=1
 *   - Real API: requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/convo/startup-timeout-no-retry.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState, waitForIdle } from '../../helpers/daemon-actions';

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
// Spawned daemon startup is slower than in-process; allow extra time.
const SETUP_TIMEOUT = IS_MOCK ? 20000 : 40000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 60000;
const IDLE_TIMEOUT = IS_MOCK ? 10000 : 20000;

// Timeout short enough that the SDK subprocess cannot respond in time.
// 10 ms is orders of magnitude below any realistic SDK startup latency.
const FORCED_STARTUP_TIMEOUT_MS = '10';

/**
 * Read the current session error directly from the `state.session` RPC.
 * Returns null if no error is set.
 */
async function getSessionError(
	daemon: DaemonServerContext,
	sessionId: string
): Promise<{ message: string; details?: unknown } | null> {
	const state = (await daemon.messageHub.request('state.session', {
		sessionId,
	})) as { error?: { message: string; details?: unknown } | null };
	return state.error ?? null;
}

describe('Startup Timeout Error Surfacing', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		// STARTUP_TIMEOUT_MS is a module-level constant in query-runner.ts — it is
		// captured once when the process starts.  We must spawn a fresh child
		// process so the env var is read at its module-load time.
		const origSpawn = process.env.DAEMON_TEST_SPAWN;
		const origTimeout = process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;

		process.env.DAEMON_TEST_SPAWN = 'true';
		process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = FORCED_STARTUP_TIMEOUT_MS;

		try {
			daemon = await createDaemonServer();
		} finally {
			// Restore parent-process env vars immediately; the child process has
			// already captured its own copy of the env at spawn time.
			if (origSpawn === undefined) {
				delete process.env.DAEMON_TEST_SPAWN;
			} else {
				process.env.DAEMON_TEST_SPAWN = origSpawn;
			}
			if (origTimeout === undefined) {
				delete process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;
			} else {
				process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = origTimeout;
			}
		}
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'should surface startup timeout error with actionable recovery hints',
		async () => {
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: process.cwd(),
				title: 'Startup Timeout Test',
				config: {
					model: 'haiku',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Subscribe to state.session events so we can count errors while
			// the query is running.  Events are scoped to the session channel.
			const errorEvents: Array<{ message: string }> = [];
			await daemon.messageHub.joinChannel(`session:${sessionId}`);

			const unsubscribe = daemon.messageHub.onEvent('state.session', (data: unknown) => {
				const state = data as {
					sessionInfo?: { id?: string };
					error?: { message: string } | null;
				};
				if (state.sessionInfo?.id !== sessionId) return;
				if (state.error) {
					errorEvents.push({ message: state.error.message });
				}
			});

			try {
				// Send a message — this kicks off query-runner.ts with STARTUP_TIMEOUT_MS=10.
				// The SDK subprocess cannot respond within 10 ms, so the startup timer fires,
				// aborts the query, and handleError() is called exactly once.
				await daemon.messageHub.request('message.send', {
					sessionId,
					content: 'Hello, please respond.',
				});

				// Wait for the session to return to idle (error → setIdle path in query-runner).
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// ── Assertion 1: session is idle ─────────────────────────────────────────
				const finalState = await getProcessingState(daemon, sessionId);
				expect(finalState.status).toBe('idle');

				// ── Assertion 2: error is visible in session state (handleError was called) ─
				// handleError() is called before setIdle(), so the error is already present
				// by the time waitForIdle() returns.  A single RPC read is sufficient here.
				const sessionError = await getSessionError(daemon, sessionId);
				expect(sessionError).not.toBeNull();

				// ── Assertion 3: error message has actionable recovery hints ──────────────
				// query-runner.ts builds this message in the isStartupTimeout branch:
				//   "The AI session failed to start (workspace: ...). Common causes: ..."
				const errorMsg = sessionError!.message;
				expect(errorMsg).toContain('failed to start');
				expect(errorMsg).toContain('Common causes');
				expect(errorMsg).toContain('NEOKAI_SDK_STARTUP_TIMEOUT_MS');
			} finally {
				unsubscribe();
			}
		},
		TEST_TIMEOUT
	);

	test(
		'should surface error exactly once without retry',
		async () => {
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: process.cwd(),
				title: 'No Retry Test',
				config: {
					model: 'haiku',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Track every error event emitted during the query lifetime.
			const errorEvents: Array<{ message: string }> = [];
			await daemon.messageHub.joinChannel(`session:${sessionId}`);

			const unsubscribe = daemon.messageHub.onEvent('state.session', (data: unknown) => {
				const state = data as {
					sessionInfo?: { id?: string };
					error?: { message: string } | null;
				};
				if (state.sessionInfo?.id !== sessionId) return;
				if (state.error) {
					errorEvents.push({ message: state.error.message });
				}
			});

			try {
				await daemon.messageHub.request('message.send', {
					sessionId,
					content: 'Say hi.',
				});

				// With no retry the session reaches idle in one pass.
				await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

				// ── Assertion 1: session is idle ──────────────────────────────────────────
				const finalState = await getProcessingState(daemon, sessionId);
				expect(finalState.status).toBe('idle');

				// ── Assertion 2: error count bounded — proves no retry occurred ──────────
				// Allow a brief extra window for any late-arriving duplicate events.
				await new Promise((resolve) => setTimeout(resolve, 300));

				// Fan-out analysis for a single timeout (no retry):
				//   1. errorManager.handleError() → daemonHub.emit('session.error')
				//      → StateManager.broadcastSessionStateChange()         [+1 event]
				//   2. catch-block stateManager.setIdle()
				//      → daemonHub.emit('session.updated')
				//      → StateManager.broadcastSessionStateChange()         [+1 event]
				//   3. finally-block stateManager.setIdle() (second call, same path) [+1 event]
				// Total: 3 error-state events for one timeout with no retry.
				//
				// If auto-recovery (removed in Task 2.1) were still present it would kick off
				// a second query attempt with the same 10 ms timeout, tripling the count to ≥ 6.
				// Asserting ≤ 5 therefore makes the "no retry" claim machine-verifiable.
				expect(errorEvents.length).toBeGreaterThan(0);
				expect(errorEvents.length).toBeLessThanOrEqual(5);

				// All emitted errors must be startup-timeout errors (not a different category).
				for (const ev of errorEvents) {
					expect(ev.message).toContain('failed to start');
				}
			} finally {
				unsubscribe();
			}
		},
		TEST_TIMEOUT
	);
});
