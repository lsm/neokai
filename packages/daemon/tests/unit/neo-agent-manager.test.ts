/**
 * Unit tests for NeoAgentManager
 *
 * Covers:
 * - provision(): first-run creates session
 * - provision(): restart re-attaches existing session and runs startup health-check
 * - provision(): startup health-check destroys and re-provisions a crashed session
 * - healthCheck(): healthy session returns true
 * - healthCheck(): null session returns false and triggers recovery (runtime)
 * - healthCheck(): stuck in-flight query detected and recovered (runtime)
 * - healthCheck(): cleaning-up session detected and recovered (runtime)
 * - cleanup(): delegates to AgentSession.cleanup()
 * - getSecurityMode(): reads from settings, defaults to 'balanced'
 * - getModel(): reads neoModel, falls back to model, then 'sonnet'
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { NeoAgentManager, NEO_SESSION_ID } from '../../src/lib/neo/neo-agent-manager';
import type { NeoSessionManager, NeoSettingsManager } from '../../src/lib/neo/neo-agent-manager';
import type { AgentSession } from '../../src/lib/agent/agent-session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProcessingStatus = 'idle' | 'processing' | 'queued' | 'waiting_for_input' | 'interrupted';

function makeSession(
	overrides: {
		processingStatus?: ProcessingStatus;
		isProcessingPhase?: 'thinking' | 'streaming' | 'initializing' | 'finalizing';
		queryPromise?: Promise<void> | null;
		queryObject?: unknown;
		cleaningUp?: boolean;
	} = {}
): AgentSession {
	const {
		processingStatus = 'idle',
		isProcessingPhase = 'thinking',
		queryPromise = null,
		queryObject = null,
		cleaningUp = false,
	} = overrides;

	return {
		getProcessingState: mock(() => {
			if (processingStatus === 'processing') {
				return { status: 'processing', messageId: 'msg-1', phase: isProcessingPhase };
			}
			return { status: processingStatus };
		}),
		isCleaningUp: mock(() => cleaningUp),
		setRuntimeSystemPrompt: mock(() => undefined),
		setRuntimeMcpServers: mock(() => undefined),
		cleanup: mock(async () => undefined),
		queryPromise,
		queryObject,
	} as unknown as AgentSession;
}

function makeSessionManager(
	opts: {
		existingSession?: AgentSession | null;
		/** Sessions to return from successive createSession() calls (one per call, in order). */
		createdSessions?: Array<AgentSession | null>;
		/** Convenience alias for a single created session (ignored when createdSessions is set). */
		createdSession?: AgentSession | null;
	} = {}
): NeoSessionManager & {
	_sessions: Map<string, AgentSession | null>;
	_createCalls: number;
	_deleteCalls: number;
	_unregisterCalls: number;
} {
	const sessions = new Map<string, AgentSession | null>();
	let getCallCount = 0;
	const sessionQueue: Array<AgentSession | null> = opts.createdSessions
		? [...opts.createdSessions]
		: opts.createdSession !== undefined
			? [opts.createdSession]
			: [];

	const sm = {
		_sessions: sessions,
		_createCalls: 0,
		_deleteCalls: 0,
		_unregisterCalls: 0,

		createSession: mock(async (_params: unknown) => {
			sm._createCalls++;
			// Pop the next session from the queue; fall back to a fresh makeSession().
			const next = sessionQueue.length > 0 ? sessionQueue.shift()! : makeSession();
			sessions.set(NEO_SESSION_ID, next);
			return NEO_SESSION_ID;
		}),

		getSessionAsync: mock(async (_id: string): Promise<AgentSession | null> => {
			// First call seeds with the "existing" (restart) session.
			if (getCallCount === 0) {
				getCallCount++;
				if (opts.existingSession !== undefined) {
					sessions.set(NEO_SESSION_ID, opts.existingSession);
				}
			}
			return sessions.get(NEO_SESSION_ID) ?? null;
		}),

		deleteSession: mock(async (_id: string) => {
			sm._deleteCalls++;
			sessions.delete(NEO_SESSION_ID);
		}),

		unregisterSession: mock((_id: string) => {
			sm._unregisterCalls++;
		}),
	};

	return sm;
}

function makeSettingsManager(
	settings: { neoSecurityMode?: string; neoModel?: string; model?: string } = {}
): NeoSettingsManager {
	return {
		getGlobalSettings: mock(() => settings),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoAgentManager', () => {
	describe('provision()', () => {
		test('first run: creates session when none exists in DB', async () => {
			const sm = makeSessionManager({ existingSession: null });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await mgr.provision();

			expect(sm._createCalls).toBe(1);
			expect(mgr.getSession()).not.toBeNull();
		});

		test('first run: throws if session cannot be retrieved after creation', async () => {
			// getSessionAsync always returns null — simulates a DB write failure.
			const sm = makeSessionManager({ existingSession: null, createdSession: null });
			// Override to always return null after creation too.
			sm.getSessionAsync = mock(async () => null);
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await expect(mgr.provision()).rejects.toThrow(/Failed to get AgentSession/);
		});

		test('restart: re-attaches existing session without re-creating', async () => {
			const existingSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({ existingSession });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await mgr.provision();

			expect(sm._createCalls).toBe(0);
			expect(mgr.getSession()).toBe(existingSession);
		});

		test('restart: applies runtime system prompt to re-attached session', async () => {
			const existingSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({ existingSession });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await mgr.provision();

			expect(existingSession.setRuntimeSystemPrompt).toHaveBeenCalledTimes(1);
			const prompt = (existingSession.setRuntimeSystemPrompt as ReturnType<typeof mock>).mock
				.calls[0][0] as string;
			expect(typeof prompt).toBe('string');
			expect(prompt.length).toBeGreaterThan(100);
		});

		test('startup health-check: destroys and re-provisions a stuck session', async () => {
			// Session has an in-flight query (stuck state): queryPromise set but queryObject null.
			const stuckSession = makeSession({
				processingStatus: 'processing',
				queryPromise: new Promise(() => undefined), // never resolves
				queryObject: null,
			});
			const freshSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({
				existingSession: stuckSession,
				createdSession: freshSession,
			});
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await mgr.provision();

			// Should have cleaned up the stuck session and created a fresh one.
			expect(stuckSession.cleanup).toHaveBeenCalledTimes(1);
			expect(sm._deleteCalls).toBe(1);
			expect(sm._createCalls).toBe(1);
			expect(mgr.getSession()).toBe(freshSession);
		});

		test('startup health-check: destroys and re-provisions a cleaning-up session', async () => {
			const stalledSession = makeSession({ cleaningUp: true });
			const freshSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({
				existingSession: stalledSession,
				createdSession: freshSession,
			});
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await mgr.provision();

			expect(sm._createCalls).toBe(1);
			expect(mgr.getSession()).toBe(freshSession);
		});

		test('startup health-check: passes for a healthy idle session', async () => {
			const healthySession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({ existingSession: healthySession });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await mgr.provision();

			// No destroy/recreate — same session remains.
			expect(sm._createCalls).toBe(0);
			expect(sm._deleteCalls).toBe(0);
			expect(mgr.getSession()).toBe(healthySession);
		});
	});

	describe('healthCheck()', () => {
		test('returns true for a healthy idle session', async () => {
			const session = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({ existingSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			await mgr.provision();

			const healthy = await mgr.healthCheck({ source: 'runtime' });

			expect(healthy).toBe(true);
		});

		test('returns false and auto-recovers when session is null (runtime)', async () => {
			const sm = makeSessionManager({ existingSession: null });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			// Provision to create initial session.
			await mgr.provision();
			// Force null session to simulate a memory corruption scenario.
			// @ts-expect-error — accessing private field for test purposes
			mgr.session = null;

			const healthy = await mgr.healthCheck({ source: 'runtime' });

			expect(healthy).toBe(false);
			// Recovery should have created a fresh session.
			expect(sm._createCalls).toBe(2);
		});

		test('returns false for stuck in-flight query (runtime) and recovers', async () => {
			const stuckSession = makeSession({
				processingStatus: 'processing',
				queryPromise: new Promise(() => undefined),
				queryObject: null,
			});
			const freshSession = makeSession({ processingStatus: 'idle' });
			// First createSession (from provision) returns stuckSession;
			// second (from destroyAndRecreate in healthCheck) returns freshSession.
			const sm = makeSessionManager({
				existingSession: null,
				createdSessions: [stuckSession, freshSession],
			});
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			await mgr.provision();

			const healthy = await mgr.healthCheck({ source: 'runtime' });

			expect(healthy).toBe(false);
			expect(mgr.getSession()).toBe(freshSession);
		});

		test('returns false for cleaning-up session (runtime) and recovers', async () => {
			const stalledSession = makeSession({ cleaningUp: true });
			const freshSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({
				existingSession: null,
				createdSessions: [stalledSession, freshSession],
			});
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			await mgr.provision();

			const healthy = await mgr.healthCheck({ source: 'runtime' });

			expect(healthy).toBe(false);
			expect(mgr.getSession()).toBe(freshSession);
		});

		test('startup source: returns false but does NOT auto-recover', async () => {
			const stuckSession = makeSession({
				processingStatus: 'processing',
				queryPromise: new Promise(() => undefined),
				queryObject: null,
			});
			const sm = makeSessionManager({ existingSession: stuckSession });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			// Manually put the session in place without calling provision() to avoid
			// the automatic startup health-check recovery.
			// @ts-expect-error — accessing private field for test purposes
			mgr.session = stuckSession;

			const healthy = await mgr.healthCheck({ source: 'startup' });

			expect(healthy).toBe(false);
			// Startup mode does NOT auto-recover — that is the caller's (provision's) job.
			expect(sm._createCalls).toBe(0);
			expect(sm._deleteCalls).toBe(0);
		});
	});

	describe('cleanup()', () => {
		test('delegates to AgentSession.cleanup()', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			await mgr.provision();

			await mgr.cleanup();

			expect(session.cleanup).toHaveBeenCalledTimes(1);
			expect(mgr.getSession()).toBeNull();
		});

		test('is idempotent when no session is active', async () => {
			const mgr = new NeoAgentManager(makeSessionManager(), makeSettingsManager());

			// Should not throw.
			await mgr.cleanup();
			await mgr.cleanup();
		});
	});

	describe('getSecurityMode()', () => {
		test('returns balanced by default when neoSecurityMode is not set', () => {
			const mgr = new NeoAgentManager(makeSessionManager(), makeSettingsManager({}));
			expect(mgr.getSecurityMode()).toBe('balanced');
		});

		test('returns the configured security mode', () => {
			const mgr = new NeoAgentManager(
				makeSessionManager(),
				makeSettingsManager({ neoSecurityMode: 'conservative' })
			);
			expect(mgr.getSecurityMode()).toBe('conservative');
		});

		test('ignores unknown security mode values and returns balanced', () => {
			const mgr = new NeoAgentManager(
				makeSessionManager(),
				makeSettingsManager({ neoSecurityMode: 'unknown-mode' })
			);
			expect(mgr.getSecurityMode()).toBe('balanced');
		});
	});

	describe('getModel()', () => {
		test('returns neoModel when set', () => {
			const mgr = new NeoAgentManager(
				makeSessionManager(),
				makeSettingsManager({ neoModel: 'claude-opus-4', model: 'sonnet' })
			);
			expect(mgr.getModel()).toBe('claude-opus-4');
		});

		test('falls back to global model when neoModel is not set', () => {
			const mgr = new NeoAgentManager(
				makeSessionManager(),
				makeSettingsManager({ model: 'haiku' })
			);
			expect(mgr.getModel()).toBe('haiku');
		});

		test('falls back to sonnet when neither neoModel nor model is set', () => {
			const mgr = new NeoAgentManager(makeSessionManager(), makeSettingsManager({}));
			expect(mgr.getModel()).toBe('sonnet');
		});
	});

	describe('system prompt', () => {
		test('includes security mode instructions in provisioned session prompt', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager({ neoSecurityMode: 'autonomous' }));

			await mgr.provision();

			const calls = (session.setRuntimeSystemPrompt as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			const prompt = calls[0][0] as string;
			expect(prompt).toContain('Autonomous');
		});

		test('uses balanced section when neoSecurityMode is not set', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager({}));

			await mgr.provision();

			const calls = (session.setRuntimeSystemPrompt as ReturnType<typeof mock>).mock.calls;
			const prompt = calls[0][0] as string;
			expect(prompt).toContain('Balanced');
		});
	});
});
