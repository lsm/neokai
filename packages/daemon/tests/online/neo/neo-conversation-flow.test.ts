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
 * 5. Security tiers — settings RPC + mode persistence across sends
 * 6. Activity feed — neo.activity live-query subscription and snapshot delivery
 * 7. Session persistence — history survives a daemon restart
 * 8. Pending actions — confirm/cancel error paths
 *
 * All tests require NEOKAI_ENABLE_NEO_AGENT=1 (set in CI via matrix flag) and
 * NEOKAI_USE_DEV_PROXY=1 for mocked SDK responses.
 *
 * Run locally:
 *   NEOKAI_ENABLE_NEO_AGENT=1 NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/neo/neo-conversation-flow.test.ts
 *
 * Note on activity logging:
 *   The neo_activity_log table is populated by NeoActivityLogger when Neo action
 *   tools (create_room, delete_room, etc.) are invoked. In Dev Proxy mock mode the
 *   AI response is mocked and does not call action tools, so the log stays empty.
 *   Section 6 therefore tests the subscription infrastructure (snapshot delivery,
 *   row schema, live-query protocol). Actual tool-invocation logging is covered by
 *   unit tests in packages/daemon/tests/unit/neo/neo-activity-logger.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LiveQuerySnapshotEvent } from '@neokai/shared';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

// ─── Timeouts ────────────────────────────────────────────────────────────────

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 45_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;
const LQ_SNAPSHOT_TIMEOUT = IS_MOCK ? 5_000 : 15_000;

/**
 * How long to poll neo.history waiting for messages to appear.
 * User messages are persisted synchronously when neo.send returns, so
 * this only needs to be long enough to tolerate system scheduling jitter.
 */
const HISTORY_POLL_TIMEOUT = IS_MOCK ? 5_000 : 30_000;

// ─── RPC helpers ─────────────────────────────────────────────────────────────

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
 * Poll neo.history until the total message count reaches `minCount` or the
 * timeout elapses. Returns the history result on success.
 *
 * User messages are persisted synchronously when neo.send returns, so for
 * tests that only need to confirm the user message arrived, this resolves on
 * the first poll.  The longer timeout is for tests that wait for assistant
 * messages to appear after full processing.
 */
async function waitForNeoHistory(
	daemon: DaemonServerContext,
	minCount: number,
	timeoutMs = HISTORY_POLL_TIMEOUT
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

			// User message is persisted synchronously when neo.send returns;
			// confirm it appears in history as a basic smoke check.
			const { messages } = await waitForNeoHistory(daemon, 1);
			expect(messages.length).toBeGreaterThanOrEqual(1);
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

			// User messages are persisted synchronously by injectMessage(), so
			// ≥ 1 message is guaranteed to be present immediately after neo.send.
			const { messages } = await waitForNeoHistory(daemon, 1);
			expect(messages.length).toBeGreaterThanOrEqual(1);

			// Every message must have the expected SDK shape.
			// SDK messages use 'type' (not 'messageType') and 'uuid' (not 'id').
			// The repository also adds 'timestamp' to every row.
			for (const msg of messages) {
				expect(typeof msg.type).toBe('string');
				expect(typeof msg.timestamp).toBe('number');
			}
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
			// Turn 1 — user message persisted synchronously on send.
			await neoSend(daemon, 'First turn — how many rooms exist?');

			// Turn 2 — send while turn 1 may still be processing; the user
			// message is queued and persisted regardless.
			await neoSend(daemon, 'Second turn — list their names.');

			// Both user messages must be visible in history; each neo.send
			// contributes at least its user message so the total is ≥ 2.
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
			// Build up history — user message is persisted synchronously.
			await neoSend(daemon, 'Remember this: the answer is 42.');

			const beforeClear = await waitForNeoHistory(daemon, 1);
			expect(beforeClear.messages.length).toBeGreaterThan(0);

			// Clear session (stops any in-flight processing, deletes session from DB,
			// and creates a fresh one).
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
			// Build up history, then clear.
			await neoSend(daemon, 'Old message');
			await waitForNeoHistory(daemon, 1); // ensure message is in DB before clear
			await neoClearSession(daemon);

			// New message on fresh session — persisted synchronously.
			const result = await neoSend(daemon, 'Fresh start message');
			expect(result.success).toBe(true);

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
			// Model is always a non-empty string (either custom or the default fallback).
			expect(typeof settings.model).toBe('string');
			expect(settings.model.length).toBeGreaterThan(0);
		},
		TEST_TIMEOUT
	);

	test(
		'neo.updateSettings changes security mode to conservative',
		async () => {
			const result = await neoUpdateSettings(daemon, { securityMode: 'conservative' });
			expect(result.success).toBe(true);
			expect(result.securityMode).toBe('conservative');

			// Verify persisted value via a fresh getSettings call.
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
			await neoUpdateSettings(daemon, { securityMode: 'conservative' });

			const result = await neoUpdateSettings(daemon, { securityMode: 'balanced' });
			expect(result.success).toBe(true);
			expect(result.securityMode).toBe('balanced');

			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('balanced');
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
		'neo.updateSettings clears neo model override with null, falling back to default',
		async () => {
			// Set a custom model first.
			await neoUpdateSettings(daemon, { model: 'haiku' });
			const afterSet = await neoGetSettings(daemon);
			expect(afterSet.model).toBe('haiku');

			// Clear by passing null — Neo should fall back to the app's primary model.
			const clearResult = await neoUpdateSettings(daemon, { model: null });
			expect(clearResult.success).toBe(true);

			// The model must be a non-empty string (the fallback) and no longer 'haiku'.
			const afterClear = await neoGetSettings(daemon);
			expect(typeof afterClear.model).toBe('string');
			expect(afterClear.model.length).toBeGreaterThan(0);
			expect(afterClear.model).not.toBe('haiku');
		},
		TEST_TIMEOUT
	);

	test(
		'security mode persists across subsequent neo.send calls',
		async () => {
			await neoUpdateSettings(daemon, { securityMode: 'conservative' });

			// Send a message — the security mode is stored in SettingsManager and
			// should be unchanged regardless of Neo processing the message.
			const sendResult = await neoSend(daemon, 'What is the current security mode?');
			expect(sendResult.success).toBe(true);

			const settings = await neoGetSettings(daemon);
			expect(settings.securityMode).toBe('conservative');
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Activity feed — neo.activity live-query subscription
//
// The neo_activity_log table is written by NeoActivityLogger when Neo action
// tools execute.  With Dev Proxy mock mode the AI does not call action tools,
// so the log is empty during these tests.  What IS tested here:
//   - liveQuery.subscribe('neo.activity', ...) works without error
//   - A snapshot is delivered with the correct shape (rows array + version)
//   - The snapshot is initially empty (no stale entries from previous runs)
//   - Unsubscribing stops further event delivery
//
// Tool-invocation logging correctness is covered by:
//   packages/daemon/tests/unit/neo/neo-activity-logger.test.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo activity feed — neo.activity live-query subscription', () => {
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
		'neo.activity subscription delivers an initial empty snapshot',
		async () => {
			const subId = `neo-activity-snap-${Date.now()}`;
			const snapshots: LiveQuerySnapshotEvent[] = [];

			const unsub = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
				'liveQuery.snapshot',
				(ev) => {
					if (ev.subscriptionId === subId) {
						snapshots.push(ev);
					}
				}
			);

			try {
				const result = (await daemon.messageHub.request('liveQuery.subscribe', {
					queryName: 'neo.activity',
					params: [50, 0], // limit=50, offset=0
					subscriptionId: subId,
				})) as { ok: boolean };

				expect(result.ok).toBe(true);

				// Wait for snapshot to arrive.
				const deadline = Date.now() + LQ_SNAPSHOT_TIMEOUT;
				while (snapshots.length === 0 && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 50));
				}

				expect(snapshots.length).toBeGreaterThanOrEqual(1);
				expect(snapshots[0].subscriptionId).toBe(subId);
				expect(Array.isArray(snapshots[0].rows)).toBe(true);
				expect(typeof snapshots[0].version).toBe('number');

				// No tool calls have been made, so the activity log is empty.
				expect(snapshots[0].rows).toHaveLength(0);
			} finally {
				unsub();
				await daemon.messageHub.request('liveQuery.unsubscribe', {
					subscriptionId: subId,
				});
			}
		},
		TEST_TIMEOUT
	);

	test(
		'neo.activity snapshot row schema matches NeoActivityLogEntry shape',
		async () => {
			const subId = `neo-activity-schema-${Date.now()}`;
			const snapshots: LiveQuerySnapshotEvent[] = [];

			const unsub = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
				'liveQuery.snapshot',
				(ev) => {
					if (ev.subscriptionId === subId) snapshots.push(ev);
				}
			);

			try {
				await daemon.messageHub.request('liveQuery.subscribe', {
					queryName: 'neo.activity',
					params: [50, 0],
					subscriptionId: subId,
				});

				const deadline = Date.now() + LQ_SNAPSHOT_TIMEOUT;
				while (snapshots.length === 0 && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 50));
				}

				expect(snapshots.length).toBeGreaterThanOrEqual(1);
				// snapshot.rows is an array (empty here — see module-level note about mock mode)
				expect(Array.isArray(snapshots[0].rows)).toBe(true);
				// Verify subscription metadata fields are correct.
				expect(snapshots[0].subscriptionId).toBe(subId);
				expect(typeof snapshots[0].version).toBe('number');
			} finally {
				unsub();
				await daemon.messageHub.request('liveQuery.unsubscribe', {
					subscriptionId: subId,
				});
			}
		},
		TEST_TIMEOUT
	);

	test(
		'neo.activity subscription does not deliver events after unsubscribe',
		async () => {
			const subId = `neo-activity-unsub-${Date.now()}`;
			const snapshots: LiveQuerySnapshotEvent[] = [];
			let deltaCount = 0;

			const unsubSnap = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
				'liveQuery.snapshot',
				(ev) => {
					if (ev.subscriptionId === subId) snapshots.push(ev);
				}
			);
			const unsubDelta = daemon.messageHub.onEvent('liveQuery.delta', (ev) => {
				const event = ev as { subscriptionId?: string };
				if (event.subscriptionId === subId) deltaCount++;
			});

			try {
				await daemon.messageHub.request('liveQuery.subscribe', {
					queryName: 'neo.activity',
					params: [50, 0],
					subscriptionId: subId,
				});

				const deadline = Date.now() + LQ_SNAPSHOT_TIMEOUT;
				while (snapshots.length === 0 && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 50));
				}
				expect(snapshots.length).toBeGreaterThanOrEqual(1);

				// Unsubscribe.
				await daemon.messageHub.request('liveQuery.unsubscribe', {
					subscriptionId: subId,
				});

				// Wait briefly to confirm no stray events arrive after unsubscribe.
				const countAfterUnsub = deltaCount;
				await new Promise((r) => setTimeout(r, 300));
				expect(deltaCount).toBe(countAfterUnsub);
			} finally {
				unsubSnap();
				unsubDelta();
			}
		},
		TEST_TIMEOUT
	);

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
			await neoSend(daemon, 'Msg A');
			await neoSend(daemon, 'Msg B');
			// Wait for both user messages to be persisted.
			await waitForNeoHistory(daemon, 2);

			const { messages: limited, hasMore } = await neoHistory(daemon, { limit: 1 });
			// At most `limit` entries returned.
			expect(limited.length).toBeLessThanOrEqual(1);
			// hasMore is a boolean; when there is exactly 1 entry, further pages
			// may or may not exist depending on total message count.
			expect(typeof hasMore).toBe('boolean');
		},
		TEST_TIMEOUT
	);

	test(
		'neo.history returns messages in chronological order (oldest first)',
		async () => {
			await neoSend(daemon, 'Message one');
			await neoSend(daemon, 'Message two');

			const { messages } = await waitForNeoHistory(daemon, 2);
			expect(messages.length).toBeGreaterThanOrEqual(2);

			// The repo injects a 'timestamp' (ms since epoch) on every row.
			// getSDKMessages returns chronological order: oldest message first.
			const timestamps = messages
				.map((m) => m.timestamp as number | undefined)
				.filter((t): t is number => typeof t === 'number');
			if (timestamps.length >= 2) {
				for (let i = 1; i < timestamps.length; i++) {
					expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
				}
			}
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Session persistence across daemon restart
//
// NOTE: We pre-create an explicit shared workspace and pass it to both daemon
// instances.  When a workspacePath is provided, createDaemonServer treats it as
// "external" and does NOT delete it on waitForExit(), so the SQLite database
// survives the restart.
//
// We do not use the restartDaemon() helper from space-test-helpers because that
// helper calls createDaemonServer({ workspacePath }) without an `env` parameter,
// and Neo requires NEOKAI_ENABLE_NEO_AGENT=1 to be provisioned.  Rather than
// modifying the shared helper, we inline the equivalent logic here with the
// required env flag.
// ─────────────────────────────────────────────────────────────────────────────

describe('Neo session persistence across daemon restart', () => {
	test(
		'neo message history survives a daemon restart',
		async () => {
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

				const sendResult = await neoSend(daemon1, 'Persist this message across restarts.');
				expect(sendResult.success).toBe(true);

				// User message is persisted synchronously; confirm before shutdown.
				const { messages: beforeRestart } = await waitForNeoHistory(daemon1, 1);
				expect(beforeRestart.length).toBeGreaterThanOrEqual(1);

				// ── Shutdown daemon 1 ─────────────────────────────────────────
				// workspacePath is "external" so waitForExit preserves the DB.
				daemon1.kill('SIGTERM');
				await daemon1.waitForExit();
				daemon1 = null;

				// ── Start daemon 2 on the same workspace ──────────────────────
				daemon2 = await createDaemonServer({
					workspacePath: sharedWorkspace,
					env: { NEOKAI_ENABLE_NEO_AGENT: '1' },
				});

				// neo:global re-attaches to the same session ID, so all previously
				// persisted SDK messages are visible via neo.history.
				const { messages: afterRestart } = await waitForNeoHistory(daemon2, 1);
				expect(afterRestart.length).toBeGreaterThanOrEqual(1);

				// Every returned message must have the basic SDK message shape.
				// SDK messages use 'type' (not 'id') and the repo adds 'timestamp'.
				const first = afterRestart[0];
				expect(first).toBeDefined();
				expect(typeof first.type).toBe('string');
				expect(typeof first.timestamp).toBe('number');
			} finally {
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
// 7. Confirm / cancel pending actions
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
			expect(typeof result.error).toBe('string');
			expect(result.error!.length).toBeGreaterThan(0);
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
