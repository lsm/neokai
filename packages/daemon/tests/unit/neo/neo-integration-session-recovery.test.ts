/**
 * Session Health Check and Recovery Integration Tests
 *
 * Tests the NeoAgentManager's health-check and auto-recovery flows at the
 * runtime level (source='runtime'), which are distinct from the startup-level
 * flows already tested in neo-agent-manager-query-tools.test.ts.
 *
 * Covers:
 * - healthCheck({ source: 'runtime' }) with null session → auto-recovers via destroyAndRecreate()
 * - healthCheck({ source: 'runtime' }) with stuck in-flight session → auto-recovers
 * - healthCheck({ source: 'runtime' }) with cleaning-up session → auto-recovers
 * - healthCheck({ source: 'startup' }) does NOT auto-recover (returns false, provision handles it)
 * - After runtime recovery, getSession() returns a new healthy session
 * - provision() with activityLogger calls pruneOldEntries() even on the re-provision path
 * - clearSession() (user-requested) destroys old session and creates fresh one
 * - clearSession() leaves getSession() pointing at the new session
 *
 * Note: The startup health-check path through provision() (destroyAndRecreate on
 * stuck session) is covered separately in neo-agent-manager-query-tools.test.ts.
 * These tests focus on the RUNTIME health-check path called from neo.send before
 * each message.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
	NeoAgentManager,
	NEO_SESSION_ID,
	type NeoSessionManager,
	type NeoSettingsManager,
} from '../../../src/lib/neo/neo-agent-manager';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { NeoActivityLogger } from '../../../src/lib/neo/activity-logger';

// ---------------------------------------------------------------------------
// Helpers: mock session and managers
// ---------------------------------------------------------------------------

function makeSession(
	overrides: {
		processingStatus?: 'idle' | 'processing' | 'queued' | 'waiting_for_input';
		queryPromise?: Promise<void> | null;
		queryObject?: unknown;
		cleaningUp?: boolean;
	} = {}
): AgentSession {
	const {
		processingStatus = 'idle',
		queryPromise = null,
		queryObject = null,
		cleaningUp = false,
	} = overrides;

	return {
		getProcessingState: mock(() =>
			processingStatus === 'processing'
				? { status: 'processing', messageId: 'msg-1', phase: 'thinking' }
				: { status: processingStatus }
		),
		isCleaningUp: mock(() => cleaningUp),
		setRuntimeSystemPrompt: mock(() => undefined),
		setRuntimeModel: mock(() => undefined),
		setRuntimeMcpServers: mock(() => undefined),
		cleanup: mock(async () => undefined),
		queryPromise,
		queryObject,
	} as unknown as AgentSession;
}

/**
 * A session manager that can serve multiple sessions in order.
 * First call to getSessionAsync uses existingSession; subsequent calls
 * return sessions from the queue (one per createSession call).
 */
function makeSessionManager(
	opts: {
		existingSession?: AgentSession | null;
		createdSessions?: Array<AgentSession | null>;
		createdSession?: AgentSession | null;
	} = {}
): NeoSessionManager & { _createCalls: number } {
	const sessions = new Map<string, AgentSession | null>();
	let firstGet = true;
	const queue: Array<AgentSession | null> = opts.createdSessions
		? [...opts.createdSessions]
		: opts.createdSession !== undefined
			? [opts.createdSession]
			: [];

	const sm: NeoSessionManager & { _createCalls: number } = {
		_createCalls: 0,

		createSession: mock(async () => {
			sm._createCalls++;
			const next = queue.length > 0 ? queue.shift()! : makeSession();
			sessions.set(NEO_SESSION_ID, next);
			return NEO_SESSION_ID;
		}),

		getSessionAsync: mock(async (_id: string): Promise<AgentSession | null> => {
			if (firstGet) {
				firstGet = false;
				if (opts.existingSession !== undefined) {
					sessions.set(NEO_SESSION_ID, opts.existingSession);
				}
			}
			return sessions.get(NEO_SESSION_ID) ?? null;
		}),

		deleteSession: mock(async () => {
			sessions.delete(NEO_SESSION_ID);
		}),

		unregisterSession: mock(() => {}),
	};

	return sm;
}

function makeSettingsManager(): NeoSettingsManager {
	return {
		getGlobalSettings: mock(() => ({ neoSecurityMode: 'balanced', model: 'sonnet' })),
	};
}

function makeActivityLogger(pruneReturnValue = 0): NeoActivityLogger & { _pruneCalls: number } {
	return {
		_pruneCalls: 0,
		pruneOldEntries: mock(function (this: { _pruneCalls: number }) {
			this._pruneCalls++;
			return pruneReturnValue;
		}),
		logAction: mock(() => ({}) as ReturnType<NeoActivityLogger['logAction']>),
		getRecentActivity: mock(() => []),
		getLatestUndoable: mock(() => null),
		markUndone: mock(() => {}),
	} as unknown as NeoActivityLogger & { _pruneCalls: number };
}

// ---------------------------------------------------------------------------
// Tests: healthCheck({ source: 'runtime' }) — null session
// ---------------------------------------------------------------------------

describe('healthCheck({ source: runtime }): null session → auto-recovery', () => {
	test('returns false when session is null', async () => {
		// existingSession not set (undefined) so firstGet does not overwrite the sessions map.
		// This simulates the manager never having been provisioned (session is null).
		const sm = makeSessionManager({ createdSession: makeSession() });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		// Do NOT call provision() — this.session is null

		const healthy = await mgr.healthCheck({ source: 'runtime' });
		expect(healthy).toBe(false);
	});

	test('destroyAndRecreate is called: createSession invoked for recovery', async () => {
		const freshSession = makeSession({ processingStatus: 'idle' });
		// existingSession not set so firstGet does not poison the map after createSession()
		const sm = makeSessionManager({ createdSession: freshSession });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.healthCheck({ source: 'runtime' });

		// createSession called once during recovery
		expect(sm._createCalls).toBe(1);
	});

	test('getSession() returns a new session after runtime recovery', async () => {
		const freshSession = makeSession({ processingStatus: 'idle' });
		const sm = makeSessionManager({ createdSession: freshSession });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.healthCheck({ source: 'runtime' });

		expect(mgr.getSession()).toBe(freshSession);
	});
});

// ---------------------------------------------------------------------------
// Tests: healthCheck({ source: 'runtime' }) — stuck session
// ---------------------------------------------------------------------------

describe('healthCheck({ source: runtime }): stuck session → auto-recovery', () => {
	test('returns false for session with stuck in-flight query', async () => {
		const stuckSession = makeSession({
			processingStatus: 'processing',
			queryPromise: new Promise(() => undefined),
			queryObject: null, // stuck: promise set but no queryObject
		});
		const freshSession = makeSession();
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [stuckSession, freshSession],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		// Provision sets stuckSession
		await mgr.provision();

		// Reset _createCalls after provision so we can count recovery-specific calls
		sm._createCalls = 0;

		// healthCheck at runtime (as called by neo.send before each message)
		const healthy = await mgr.healthCheck({ source: 'runtime' });
		expect(healthy).toBe(false);
		expect(sm._createCalls).toBe(1); // recovery created a fresh session
	});

	test('getSession() returns fresh session after stuck-session recovery', async () => {
		const stuckSession = makeSession({
			processingStatus: 'processing',
			queryPromise: new Promise(() => undefined),
			queryObject: null,
		});
		const freshSession = makeSession({ processingStatus: 'idle' });
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [stuckSession, freshSession],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.provision();
		await mgr.healthCheck({ source: 'runtime' });

		expect(mgr.getSession()).toBe(freshSession);
	});
});

// ---------------------------------------------------------------------------
// Tests: healthCheck({ source: 'runtime' }) — cleaning-up session
// ---------------------------------------------------------------------------

describe('healthCheck({ source: runtime }): cleaning-up session → auto-recovery', () => {
	test('returns false for session that is cleaning up', async () => {
		const dyingSession = makeSession({ cleaningUp: true });
		const freshSession = makeSession();
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [dyingSession, freshSession],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.provision();

		sm._createCalls = 0;
		const healthy = await mgr.healthCheck({ source: 'runtime' });
		expect(healthy).toBe(false);
		expect(sm._createCalls).toBe(1);
	});

	test('fresh session is healthy after cleaning-up session recovery', async () => {
		const dyingSession = makeSession({ cleaningUp: true });
		const freshSession = makeSession({ processingStatus: 'idle', cleaningUp: false });
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [dyingSession, freshSession],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.provision();
		await mgr.healthCheck({ source: 'runtime' });

		// After recovery, healthCheck should return true for the fresh session
		const nowHealthy = await mgr.healthCheck({ source: 'runtime' });
		expect(nowHealthy).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: healthCheck({ source: 'startup' }) — does NOT auto-recover
// ---------------------------------------------------------------------------

describe('healthCheck({ source: startup }): does NOT trigger destroyAndRecreate', () => {
	test('returns false for null session without auto-recovery', async () => {
		const sm = makeSessionManager({ existingSession: null, createdSession: makeSession() });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		// Session is null, no provision called

		const healthy = await mgr.healthCheck({ source: 'startup' });
		expect(healthy).toBe(false);
		// No createSession called (startup path does NOT auto-recover)
		expect(sm._createCalls).toBe(0);
	});

	test('returns false for stuck session without auto-recovery', async () => {
		const stuckSession = makeSession({
			processingStatus: 'processing',
			queryPromise: new Promise(() => undefined),
			queryObject: null,
		});
		// Bypass provision by doing a minimal wiring
		const sm = makeSessionManager({ existingSession: null, createdSession: stuckSession });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		// Directly set session by provisioning then reconfiguring state
		await mgr.provision(); // This creates stuckSession as the session

		// Reset calls counter
		sm._createCalls = 0;

		const healthy = await mgr.healthCheck({ source: 'startup' });
		expect(healthy).toBe(false);
		// No createSession called (startup path returns false, caller handles recovery)
		expect(sm._createCalls).toBe(0);
	});

	test('returns true for a healthy idle session', async () => {
		const healthySession = makeSession({ processingStatus: 'idle' });
		const sm = makeSessionManager({ existingSession: null, createdSession: healthySession });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		await mgr.provision();

		const healthy = await mgr.healthCheck({ source: 'startup' });
		expect(healthy).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: healthCheck returns true for healthy sessions
// ---------------------------------------------------------------------------

describe('healthCheck: returns true for healthy sessions', () => {
	test('idle session is healthy (both startup and runtime)', async () => {
		const session = makeSession({ processingStatus: 'idle' });
		const sm = makeSessionManager({ existingSession: null, createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		await mgr.provision();

		expect(await mgr.healthCheck({ source: 'startup' })).toBe(true);
		expect(await mgr.healthCheck({ source: 'runtime' })).toBe(true);
	});

	test('processing session with queryObject is healthy (active query, not stuck)', async () => {
		// queryPromise set AND queryObject set = normal active processing, not stuck
		const activeSession = makeSession({
			processingStatus: 'processing',
			queryPromise: new Promise(() => undefined),
			queryObject: { someQuery: true }, // has queryObject = not stuck
		});
		const sm = makeSessionManager({ existingSession: null, createdSession: activeSession });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		await mgr.provision();

		// Should be healthy: processing with a valid queryObject
		const healthy = await mgr.healthCheck({ source: 'startup' });
		expect(healthy).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: clearSession() — user-initiated reset
// ---------------------------------------------------------------------------

describe('clearSession(): destroys old session and creates fresh one', () => {
	test('clearSession() replaces the session with a fresh one', async () => {
		const initialSession = makeSession();
		const freshSession = makeSession();
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [initialSession, freshSession],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.provision();
		expect(mgr.getSession()).toBe(initialSession);

		await mgr.clearSession();
		expect(mgr.getSession()).toBe(freshSession);
	});

	test('clearSession() calls cleanup() on the old session', async () => {
		const initialSession = makeSession();
		const freshSession = makeSession();
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [initialSession, freshSession],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.provision();
		await mgr.clearSession();

		// Initial session should have had cleanup called
		const cleanupCalls = (initialSession.cleanup as ReturnType<typeof mock>).mock.calls;
		expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);
	});

	test('clearSession() triggers createSession for the replacement', async () => {
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [makeSession(), makeSession()],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.provision();
		sm._createCalls = 0; // reset after provision

		await mgr.clearSession();
		expect(sm._createCalls).toBe(1);
	});

	test('getSession() is not null after clearSession()', async () => {
		const sm = makeSessionManager({
			existingSession: null,
			createdSessions: [makeSession(), makeSession()],
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		await mgr.provision();
		await mgr.clearSession();

		expect(mgr.getSession()).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: provision() with activityLogger — pruneOldEntries() called
// ---------------------------------------------------------------------------

describe('provision() calls activityLogger.pruneOldEntries()', () => {
	test('pruneOldEntries called once on first provision (fresh session)', async () => {
		const session = makeSession();
		const sm = makeSessionManager({ existingSession: null, createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		const logger = makeActivityLogger();

		mgr.setActivityLogger(logger);
		await mgr.provision();

		expect((logger.pruneOldEntries as ReturnType<typeof mock>).mock.calls.length).toBe(1);
	});

	test('pruneOldEntries called on restart provision (existing session, healthy)', async () => {
		const existingSession = makeSession({ processingStatus: 'idle' });
		const sm = makeSessionManager({ existingSession });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		const logger = makeActivityLogger();

		mgr.setActivityLogger(logger);
		await mgr.provision();

		expect((logger.pruneOldEntries as ReturnType<typeof mock>).mock.calls.length).toBe(1);
	});

	test('pruneOldEntries called on re-provision after unhealthy startup check', async () => {
		const stuckSession = makeSession({
			processingStatus: 'processing',
			queryPromise: new Promise(() => undefined),
			queryObject: null,
		});
		const freshSession = makeSession();
		const sm = makeSessionManager({
			existingSession: stuckSession,
			createdSession: freshSession,
		});
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		const logger = makeActivityLogger();

		mgr.setActivityLogger(logger);
		await mgr.provision();

		// pruneOldEntries called during provision() even through the destroyAndRecreate path
		expect((logger.pruneOldEntries as ReturnType<typeof mock>).mock.calls.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: cleanup() — graceful shutdown
// ---------------------------------------------------------------------------

describe('cleanup(): graceful shutdown', () => {
	test('cleanup() calls session.cleanup() and sets session to null', async () => {
		const session = makeSession();
		const sm = makeSessionManager({ existingSession: null, createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		await mgr.provision();

		await mgr.cleanup();

		expect(mgr.getSession()).toBeNull();
		const calls = (session.cleanup as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});

	test('cleanup() is a no-op when no session is provisioned', async () => {
		const sm = makeSessionManager({ existingSession: null, createdSession: makeSession() });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		// No provision() call
		await expect(mgr.cleanup()).resolves.toBeUndefined();
		expect(mgr.getSession()).toBeNull();
	});
});
