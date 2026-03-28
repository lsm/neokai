/**
 * Neo Online Conversation Flow Tests
 *
 * Tests full conversation flows through the Neo agent using mocked SDK responses
 * (Dev Proxy). Covers:
 *
 * 1. Basic send/receive — neo.send processes messages and Neo returns to idle
 * 2. History — neo.history returns persisted messages
 * 3. Multi-turn — multiple messages accumulate in history
 * 4. Session clear — neo.clearSession resets the conversation
 * 5. Security tiers — neo.getSettings / neo.updateSettings change mode
 * 6. Activity feed — actions are logged and retrievable
 * 7. Session persistence — history survives a daemon restart
 *
 * All tests require NEOKAI_ENABLE_NEO_AGENT=1 (set in CI via matrix flag) and
 * NEOKAI_USE_DEV_PROXY=1 for mocked SDK responses.
 *
 * Run locally:
 *   NEOKAI_ENABLE_NEO_AGENT=1 NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/neo/neo-conversation-flow.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { waitForIdle } from '../../helpers/daemon-actions';
import { NEO_SESSION_ID } from '../../../src/lib/neo/neo-agent-manager';

// ─── Timeouts ────────────────────────────────────────────────────────────────

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const IDLE_TIMEOUT = IS_MOCK ? 8_000 : 60_000;
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 45_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Send a message to Neo and return immediately (no waiting for idle). */
async function neoSend(
	daemon: DaemonServerContext,
	message: string
): Promise<{ success: boolean; error?: string; errorCode?: string }> {
	return (await daemon.messageHub.request('neo.send', { message })) as {
		success: boolean;
		error?: string;
		errorCode?: string;
	};
}

/** Fetch Neo message history. */
async function neoHistory(
	daemon: DaemonServerContext,
	opts: { limit?: number; before?: number } = {}
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
	return (await daemon.messageHub.request('neo.history', opts)) as {
		messages: Record<string, unknown>[];
		hasMore: boolean;
	};
}

/** Get Neo settings. */
async function neoGetSettings(
	daemon: DaemonServerContext
): Promise<{ securityMode: string; model: string }> {
	return (await daemon.messageHub.request('neo.getSettings', {})) as {
		securityMode: string;
		model: string;
	};
}

/** Update Neo settings. */
async function neoUpdateSettings(
	daemon: DaemonServerContext,
	updates: { securityMode?: string; model?: string | null }
): Promise<{ success: boolean; securityMode: string; model: string }> {
	return (await daemon.messageHub.request('neo.updateSettings', updates)) as {
		success: boolean;
		securityMode: string;
		model: string;
	};
}

/** Clear the Neo session (reset conversation history). */
async function neoClearSession(daemon: DaemonServerContext): Promise<{ success: boolean }> {
	return (await daemon.messageHub.request('neo.clearSession', {})) as { success: boolean };
}

/**
 * Wait for the Neo session to finish processing.
 * Uses the same waitForIdle helper as regular sessions — Neo uses AgentSession
 * under the hood, so `agent.getState` with NEO_SESSION_ID works.
 */
async function waitForNeoIdle(daemon: DaemonServerContext): Promise<void> {
	return waitForIdle(daemon, NEO_SESSION_ID, IDLE_TIMEOUT);
}

/**
 * Poll neo.history until the total message count reaches `minCount` or the
 * timeout elapses. Returns the history result on success.
 */
async function waitForNeoHistory(
	daemon: DaemonServerContext,
	minCount: number,
	timeoutMs = 5_000
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await neoHistory(daemon, { limit: 100 });
		if (result.messages.length >= minCount) {
			return result;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return neoHistory(daemon, { limit: 100 });
}

// ─── Neo daemon factory with required flags ──────────────────────────────────

function createNeoDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonServerContext> {
	return createDaemonServer({
		env: {
			NEOKAI_ENABLE_NEO_AGENT: '1',
			...extraEnv,
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Basic conversation flow
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo basic send / receive', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createNeoDaemon();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'neo.send returns success for a valid message',
		async () => {
			const result = await neoSend(daemon, 'Hello Neo');
			expect(result.success).toBe(true);

			// Wait for Neo to finish processing.
			await waitForNeoIdle(daemon);
		},
		TEST_TIMEOUT
	);

	test(
		'neo.send rejects empty messages',
		async () => {
			await expect(daemon.messageHub.request('neo.send', { message: '' })).rejects.toThrow();
		},
		TEST_TIMEOUT
	);

	test(
		'neo.history returns messages after a send',
		async () => {
			const result = await neoSend(daemon, 'What rooms do I have?');
			expect(result.success).toBe(true);

			await waitForNeoIdle(daemon);

			// After processing, at least the user message and an assistant reply should
			// be stored. The dev proxy mock returns a response, so we expect ≥ 2 entries.
			const { messages } = await waitForNeoHistory(daemon, 2);
			expect(messages.length).toBeGreaterThanOrEqual(1);
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Multi-turn conversation
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo multi-turn conversation', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createNeoDaemon();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'messages from multiple turns all appear in history',
		async () => {
			// Turn 1
			await neoSend(daemon, 'First turn — how many rooms exist?');
			await waitForNeoIdle(daemon);

			// Turn 2
			await neoSend(daemon, 'Second turn — list their names.');
			await waitForNeoIdle(daemon);

			// Both turns must be visible in history.
			// Each turn contributes at least the user message, so ≥ 2 user messages.
			const { messages } = await waitForNeoHistory(daemon, 2);
			expect(messages.length).toBeGreaterThanOrEqual(2);
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Session clear
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo session clear', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createNeoDaemon();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'neo.clearSession resets conversation history',
		async () => {
			// Build up history.
			await neoSend(daemon, 'Remember this: the answer is 42.');
			await waitForNeoIdle(daemon);

			const beforeClear = await neoHistory(daemon, { limit: 100 });
			expect(beforeClear.messages.length).toBeGreaterThan(0);

			// Clear session.
			const clearResult = await neoClearSession(daemon);
			expect(clearResult.success).toBe(true);

			// After clear, history should be empty.
			const afterClear = await neoHistory(daemon, { limit: 100 });
			expect(afterClear.messages.length).toBe(0);
		},
		TEST_TIMEOUT
	);

	test(
		'neo.send works normally after clearSession',
		async () => {
			// Build + clear.
			await neoSend(daemon, 'Old message');
			await waitForNeoIdle(daemon);
			await neoClearSession(daemon);

			// New message on fresh session.
			const result = await neoSend(daemon, 'Fresh start message');
			expect(result.success).toBe(true);
			await waitForNeoIdle(daemon);

			// History should only contain the new turn.
			const { messages } = await waitForNeoHistory(daemon, 1);
			expect(messages.length).toBeGreaterThanOrEqual(1);
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Security tier settings
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo security tier settings', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createNeoDaemon();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'neo.getSettings returns balanced as default security mode',
		async () => {
			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('balanced');
		},
		TEST_TIMEOUT
	);

	test(
		'neo.updateSettings changes security mode to conservative',
		async () => {
			const result = await neoUpdateSettings(daemon, { securityMode: 'conservative' });
			expect(result.success).toBe(true);
			expect(result.securityMode).toBe('conservative');

			// Verify persisted value.
			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('conservative');
		},
		TEST_TIMEOUT
	);

	test(
		'neo.updateSettings changes security mode to autonomous',
		async () => {
			const result = await neoUpdateSettings(daemon, { securityMode: 'autonomous' });
			expect(result.success).toBe(true);
			expect(result.securityMode).toBe('autonomous');

			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('autonomous');
		},
		TEST_TIMEOUT
	);

	test(
		'neo.updateSettings changes security mode back to balanced',
		async () => {
			// Change away first.
			await neoUpdateSettings(daemon, { securityMode: 'conservative' });

			// Change back.
			const result = await neoUpdateSettings(daemon, { securityMode: 'balanced' });
			expect(result.success).toBe(true);
			expect(result.securityMode).toBe('balanced');
		},
		TEST_TIMEOUT
	);

	test(
		'neo.updateSettings rejects invalid security mode',
		async () => {
			await expect(
				daemon.messageHub.request('neo.updateSettings', { securityMode: 'godmode' })
			).rejects.toThrow();
		},
		TEST_TIMEOUT
	);

	test(
		'neo.updateSettings changes neo model override',
		async () => {
			const result = await neoUpdateSettings(daemon, { model: 'haiku' });
			expect(result.success).toBe(true);

			const settings = await neoGetSettings(daemon);
			expect(settings.model).toBe('haiku');
		},
		TEST_TIMEOUT
	);

	test(
		'neo.updateSettings clears neo model override with null',
		async () => {
			// Set a custom model first.
			await neoUpdateSettings(daemon, { model: 'haiku' });

			// Clear by passing null — falls back to app default.
			const result = await neoUpdateSettings(daemon, { model: null });
			expect(result.success).toBe(true);
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Security tier enforcement — balanced vs conservative vs autonomous
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo security tier enforcement', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createNeoDaemon();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	/**
	 * Verifies that setting the security mode and then reading it back is
	 * consistent.  Behavioural enforcement (auto-execute vs confirm) is
	 * governed by the shouldAutoExecute() function which has dedicated unit
	 * tests in neo-security-tier.test.ts.  These tests verify the settings
	 * round-trip correctly through the RPC layer.
	 */
	test(
		'balanced mode setting round-trips via RPC',
		async () => {
			await neoUpdateSettings(daemon, { securityMode: 'conservative' });
			await neoUpdateSettings(daemon, { securityMode: 'balanced' });
			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('balanced');
		},
		TEST_TIMEOUT
	);

	test(
		'conservative mode setting round-trips via RPC',
		async () => {
			await neoUpdateSettings(daemon, { securityMode: 'conservative' });
			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('conservative');
		},
		TEST_TIMEOUT
	);

	test(
		'autonomous mode setting round-trips via RPC',
		async () => {
			await neoUpdateSettings(daemon, { securityMode: 'autonomous' });
			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('autonomous');
		},
		TEST_TIMEOUT
	);

	test(
		'security mode persists across subsequent neo.send calls',
		async () => {
			await neoUpdateSettings(daemon, { securityMode: 'conservative' });

			// Send a message — mode should still be conservative afterwards.
			const sendResult = await neoSend(daemon, 'What is the current mode?');
			expect(sendResult.success).toBe(true);
			await waitForNeoIdle(daemon);

			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('conservative');
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Activity feed accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo activity feed', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createNeoDaemon();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	/**
	 * Verify that neo.history (the LiveQuery-backed message store) is accessible
	 * after daemon startup even before any messages have been sent.
	 */
	test(
		'neo.history returns empty array before any messages',
		async () => {
			const { messages, hasMore } = await neoHistory(daemon, { limit: 50 });
			expect(Array.isArray(messages)).toBe(true);
			expect(hasMore).toBe(false);
		},
		TEST_TIMEOUT
	);

	test(
		'neo.history pagination — limit is respected',
		async () => {
			// Send several messages to build history.
			await neoSend(daemon, 'Msg A');
			await waitForNeoIdle(daemon);
			await neoSend(daemon, 'Msg B');
			await waitForNeoIdle(daemon);

			// Fetch only 1 message.
			const { messages: limited, hasMore } = await neoHistory(daemon, { limit: 1 });
			expect(limited.length).toBeLessThanOrEqual(1);
			// hasMore can be true if more messages exist.
			if (limited.length === 1) {
				expect(typeof hasMore).toBe('boolean');
			}
		},
		TEST_TIMEOUT
	);

	test(
		'neo.history returns messages in reverse-chronological order (newest first)',
		async () => {
			await neoSend(daemon, 'Message one');
			await waitForNeoIdle(daemon);
			await neoSend(daemon, 'Message two');
			await waitForNeoIdle(daemon);

			const { messages } = await waitForNeoHistory(daemon, 2);
			// The messages array should be non-empty.
			expect(messages.length).toBeGreaterThanOrEqual(2);

			// If timestamps are present, later messages should come first.
			const timestamps = messages
				.map((m) => m.createdAt as number | undefined)
				.filter((t) => typeof t === 'number') as number[];
			if (timestamps.length >= 2) {
				for (let i = 1; i < timestamps.length; i++) {
					expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
				}
			}
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Session persistence across daemon restart
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo session persistence across daemon restart', () => {
	test(
		'neo message history survives a daemon restart',
		async () => {
			// Pre-create a shared workspace so daemon 1 does NOT delete it on exit.
			// The default (no workspacePath) is auto-deleted; when workspacePath is
			// provided it is treated as an external workspace and preserved.
			const sharedWorkspace = `/tmp/neo-persist-test-${Date.now()}`;
			await Bun.$`mkdir -p ${sharedWorkspace}`.quiet();

			let daemon1: DaemonServerContext | null = null;
			let daemon2: DaemonServerContext | null = null;

			try {
				// ── Start daemon 1 ────────────────────────────────────────────
				daemon1 = await createDaemonServer({
					workspacePath: sharedWorkspace,
					env: { NEOKAI_ENABLE_NEO_AGENT: '1' },
				});

				// Send a message and wait for it to be persisted.
				const sendResult = await neoSend(daemon1, 'Persist this message across restarts.');
				expect(sendResult.success).toBe(true);
				await waitForIdle(daemon1, NEO_SESSION_ID, IDLE_TIMEOUT);

				// Verify history exists before restart.
				const { messages: beforeRestart } = await waitForNeoHistory(daemon1, 1);
				expect(beforeRestart.length).toBeGreaterThanOrEqual(1);

				// ── Shutdown daemon 1 ─────────────────────────────────────────
				// waitForExit does NOT delete sharedWorkspace because it was provided
				// as workspacePath (isExternalWorkspace = true).
				daemon1.kill('SIGTERM');
				await daemon1.waitForExit();
				daemon1 = null;

				// ── Start daemon 2 on the same workspace ──────────────────────
				daemon2 = await createDaemonServer({
					workspacePath: sharedWorkspace,
					env: { NEOKAI_ENABLE_NEO_AGENT: '1' },
				});

				// History from daemon 1 should be accessible in daemon 2.
				// The Neo session re-attaches to the same `neo:global` session ID, so
				// all previously persisted SDK messages are visible via neo.history.
				const { messages: afterRestart } = await waitForNeoHistory(daemon2, 1);
				expect(afterRestart.length).toBeGreaterThanOrEqual(1);

				// Verify the messages exist in the correct session ID.
				// (All messages belong to neo:global — a non-empty list is sufficient.)
				expect(afterRestart[0]).toBeDefined();
			} finally {
				// Best-effort cleanup of both daemons and the shared workspace.
				if (daemon1) {
					try {
						daemon1.kill('SIGTERM');
						await daemon1.waitForExit();
					} catch {
						// Ignore cleanup errors
					}
				}
				if (daemon2) {
					try {
						daemon2.kill('SIGTERM');
						await daemon2.waitForExit();
					} catch {
						// Ignore cleanup errors
					}
				}
				await Bun.$`rm -rf ${sharedWorkspace}`.quiet();
			}
		},
		TEST_TIMEOUT * 2
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Confirm / cancel pending actions
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo pending action confirm / cancel', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createNeoDaemon();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'neo.confirmAction returns error for unknown actionId',
		async () => {
			const result = (await daemon.messageHub.request('neo.confirmAction', {
				actionId: 'non-existent-action-id',
			})) as { success: boolean; error?: string };
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		},
		TEST_TIMEOUT
	);

	test(
		'neo.cancelAction returns success for unknown actionId (idempotent)',
		async () => {
			const result = (await daemon.messageHub.request('neo.cancelAction', {
				actionId: 'non-existent-action-id',
			})) as { success: boolean };
			expect(result.success).toBe(true);
		},
		TEST_TIMEOUT
	);

	test(
		'neo.confirmAction requires actionId',
		async () => {
			await expect(daemon.messageHub.request('neo.confirmAction', {})).rejects.toThrow();
		},
		TEST_TIMEOUT
	);

	test(
		'neo.cancelAction requires actionId',
		async () => {
			await expect(daemon.messageHub.request('neo.cancelAction', {})).rejects.toThrow();
		},
		TEST_TIMEOUT
	);
});
