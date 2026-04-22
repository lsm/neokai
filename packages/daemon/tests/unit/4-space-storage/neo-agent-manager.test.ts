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
 * - setDbPath(): wires db-query server into setRuntimeMcpServers
 * - cleanup(): closes db-query server
 * - destroyAndRecreate(): closes old db-query server and creates new one
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { NeoAgentManager, NEO_SESSION_ID } from '../../../src/lib/neo/neo-agent-manager';
import type { NeoSessionManager, NeoSettingsManager } from '../../../src/lib/neo/neo-agent-manager';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { McpServerConfig } from '@neokai/shared';
import type {
	NeoToolsConfig,
	NeoQueryRoomManager,
	NeoQueryGoalRepository,
	NeoQueryTaskRepository,
	NeoQuerySessionManager,
	NeoQuerySettingsManager,
	NeoQueryAuthManager,
	NeoQueryMcpServerRepository,
	NeoQuerySkillsManager,
	NeoQuerySpaceManager,
	NeoQuerySpaceAgentManager,
	NeoQuerySpaceWorkflowManager,
	NeoQueryWorkflowRunRepository,
	NeoQuerySpaceTaskRepository,
} from '../../../src/lib/neo/tools/neo-query-tools';

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
		setRuntimeModel: mock(() => undefined),
		setRuntimeMcpServers: mock(() => undefined),
		cleanup: mock(async () => undefined),
		queryPromise,
		queryObject,
	} as unknown as AgentSession;
}

function makeSessionManager(
	opts: {
		existingSession?: AgentSession | null;
		/**
		 * Sessions returned to the Neo runtime, in order, on successive
		 * `getSessionAsync` rehydration calls that happen *after* an
		 * `interruptInMemorySession` tear-down. This mimics the real-world
		 * behaviour where the in-memory SDK session is refreshed from the
		 * still-present DB row.
		 */
		createdSessions?: Array<AgentSession | null>;
		/** Convenience alias for a single rehydrated session (ignored when createdSessions is set). */
		createdSession?: AgentSession | null;
	} = {}
): NeoSessionManager & {
	_sessions: Map<string, AgentSession | null>;
	_createCalls: number;
	/**
	 * Task #85: Neo recovery is a non-UI caller and therefore may never
	 * invoke delete primitives. `_interruptCalls` tracks the only sanctioned
	 * stop path (`SessionManager.interruptInMemorySession`).
	 */
	_interruptCalls: number;
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
		_interruptCalls: 0,
		_unregisterCalls: 0,

		createSession: mock(async (_params: unknown) => {
			sm._createCalls++;
			// Called only when the Neo DB row is missing. Fall back to a
			// fresh in-memory session unless the queue still has an entry.
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

		interruptInMemorySession: mock(async (_id: string) => {
			sm._interruptCalls++;
			// Simulate the real `interruptInMemorySession`: it drops the
			// in-memory AgentSession but PRESERVES the DB row. The next
			// `getSessionAsync` rehydrates a fresh `AgentSession` from that
			// preserved DB row, which we represent by popping from the
			// sessionQueue. If nothing is queued we drop to null to force
			// `createSession` (the explicit "DB row gone" recovery path).
			const next = sessionQueue.shift();
			if (next !== undefined) {
				sessions.set(NEO_SESSION_ID, next);
			} else {
				sessions.delete(NEO_SESSION_ID);
			}
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

			// Task #85: recovery MUST NOT delete the Neo DB row. The old
			// `deleteSession` + `createSession` sequence is replaced by a
			// single `interruptInMemorySession` + rehydrate. The fresh
			// AgentSession comes from the rehydration path, not from a new
			// DB row. (The concrete SessionManager implementation calls
			// AgentSession.cleanup inside interruptInMemorySession; the
			// mock doesn't simulate that internal detail — we verify the
			// delegation via _interruptCalls instead.)
			expect(sm._interruptCalls).toBe(1);
			expect(sm._createCalls).toBe(0);
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

			// Task #85: recovery drops the in-memory session via
			// interruptInMemorySession and rehydrates from the preserved DB
			// row — no createSession call, no DB-row deletion.
			expect(sm._interruptCalls).toBe(1);
			expect(sm._createCalls).toBe(0);
			expect(mgr.getSession()).toBe(freshSession);
		});

		test('startup health-check: passes for a healthy idle session', async () => {
			const healthySession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({ existingSession: healthySession });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			await mgr.provision();

			// No destroy/recreate — same session remains.
			expect(sm._createCalls).toBe(0);
			expect(sm._interruptCalls).toBe(0);
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
			expect(sm._interruptCalls).toBe(0);
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

	describe('applyRuntimeConfig()', () => {
		test('sets model on session from neoModel setting', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(
				sm,
				makeSettingsManager({ neoModel: 'claude-opus-4', model: 'sonnet' })
			);

			await mgr.provision();

			const calls = (session.setRuntimeModel as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			expect(calls[0][0]).toBe('claude-opus-4');
		});

		test('falls back to global model when neoModel is absent', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager({ model: 'haiku' }));

			await mgr.provision();

			const calls = (session.setRuntimeModel as ReturnType<typeof mock>).mock.calls;
			expect(calls[0][0]).toBe('haiku');
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

// ---------------------------------------------------------------------------
// Helpers for db-query integration tests
// ---------------------------------------------------------------------------

function makeMinimalQueryConfig(): NeoToolsConfig {
	const noopRoomManager: NeoQueryRoomManager = {
		listRooms: () => [],
		getRoom: () => null,
		getRoomOverview: () => null,
	};
	const noopGoalRepo: NeoQueryGoalRepository = {
		listGoals: () => [],
		getGoal: () => null,
		listExecutions: () => [],
	};
	const noopTaskRepo: NeoQueryTaskRepository = {
		listTasks: () => [],
		getTask: () => null,
	};
	const noopSessionManager: NeoQuerySessionManager = {
		getActiveSessions: () => 0,
		listSessions: () => [],
	};
	const noopSettingsManager: NeoQuerySettingsManager = {
		getGlobalSettings: () =>
			({
				settingSources: [],
				model: 'sonnet',
				permissionMode: 'default',
				thinkingLevel: 'none',
				autoScroll: true,
				coordinatorMode: false,
				maxConcurrentWorkers: 3,
				neoSecurityMode: 'balanced',
				neoModel: null,
				showArchived: false,
				fallbackModels: [],
				disabledMcpServers: [],
			}) as ReturnType<NeoQuerySettingsManager['getGlobalSettings']>,
	};
	const noopAuthManager: NeoQueryAuthManager = {
		getAuthStatus: async () => ({
			isAuthenticated: false,
			method: 'none',
			source: 'env' as const,
		}),
	};
	const noopMcpRepo: NeoQueryMcpServerRepository = {
		list: () => [],
		get: () => null,
	};
	const noopSkillsManager: NeoQuerySkillsManager = {
		listSkills: () => [],
		getSkill: () => null,
	};
	const noopSpaceManager: NeoQuerySpaceManager = {
		listSpaces: () => [],
		getSpace: () => null,
	};
	const noopSpaceAgentManager: NeoQuerySpaceAgentManager = {
		listBySpaceId: () => [],
	};
	const noopSpaceWorkflowManager: NeoQuerySpaceWorkflowManager = {
		listWorkflows: () => [],
	};
	const noopWorkflowRunRepo: NeoQueryWorkflowRunRepository = {
		listBySpace: () => [],
	};
	const noopSpaceTaskRepo: NeoQuerySpaceTaskRepository = {
		listBySpace: () => [],
		listByStatus: () => [],
	};

	return {
		roomManager: noopRoomManager,
		goalRepository: noopGoalRepo,
		taskRepository: noopTaskRepo,
		sessionManager: noopSessionManager,
		settingsManager: noopSettingsManager,
		authManager: noopAuthManager,
		mcpServerRepository: noopMcpRepo,
		skillsManager: noopSkillsManager,
		workspaceRoot: '/workspace',
		appVersion: '0.1.1',
		startedAt: Date.now() - 1_000,
		spaceManager: noopSpaceManager,
		spaceAgentManager: noopSpaceAgentManager,
		spaceWorkflowManager: noopSpaceWorkflowManager,
		workflowRunRepository: noopWorkflowRunRepo,
		spaceTaskRepository: noopSpaceTaskRepo,
	};
}

function makeDbSessionManager(
	opts: { createdSession?: AgentSession | null } = {}
): NeoSessionManager & { _createCalls: number; _interruptCalls: number } {
	const sessions = new Map<string, AgentSession | null>();
	let getCallCount = 0;
	const sessionQueue: Array<AgentSession | null> =
		opts.createdSession !== undefined ? [opts.createdSession] : [];

	const sm = {
		_createCalls: 0,
		_interruptCalls: 0,

		createSession: mock(async () => {
			sm._createCalls++;
			const next = sessionQueue.length > 0 ? sessionQueue.shift()! : makeSession();
			sessions.set(NEO_SESSION_ID, next);
			return NEO_SESSION_ID;
		}),

		getSessionAsync: mock(async (_id: string): Promise<AgentSession | null> => {
			if (getCallCount === 0) {
				getCallCount++;
			}
			return sessions.get(NEO_SESSION_ID) ?? null;
		}),

		// Task #85: daemon-internal recovery may only drop the in-memory
		// SDK subprocess. The mock pops the next queued AgentSession to
		// simulate rehydration from the still-preserved DB row.
		interruptInMemorySession: mock(async (_id: string) => {
			sm._interruptCalls++;
			const next = sessionQueue.shift();
			if (next !== undefined) {
				sessions.set(NEO_SESSION_ID, next);
			} else {
				sessions.delete(NEO_SESSION_ID);
			}
		}),

		unregisterSession: mock((_id: string) => {}),
	};

	return sm;
}

// ---------------------------------------------------------------------------
// db-query MCP server integration tests
// ---------------------------------------------------------------------------

describe('NeoAgentManager — setDbPath() / db-query server', () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'neokai-test-'));
		dbPath = join(tmpDir, 'test.db');
		// Create a minimal SQLite database so createDbQueryMcpServer can open it.
		const initDb = new Database(dbPath);
		initDb.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, config TEXT)');
		initDb.close();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('when setDbPath() is called and toolsConfig is set, db-query key appears in setRuntimeMcpServers', async () => {
		const session = makeSession();
		const sm = makeDbSessionManager({ createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		mgr.setDbPath(dbPath);

		await mgr.provision();

		const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBe(1);
		const servers = calls[0][0] as Record<string, McpServerConfig>;
		expect('db-query' in servers).toBe(true);
	});

	test('when setDbPath() is NOT called, db-query key is absent from setRuntimeMcpServers', async () => {
		const session = makeSession();
		const sm = makeDbSessionManager({ createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		// No setDbPath() call

		await mgr.provision();

		const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBe(1);
		const servers = calls[0][0] as Record<string, McpServerConfig>;
		expect('db-query' in servers).toBe(false);
	});

	test('cleanup() closes the db-query server (no error)', async () => {
		const session = makeSession();
		const sm = makeDbSessionManager({ createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		mgr.setDbPath(dbPath);

		await mgr.provision();

		// cleanup() should not throw even though db-query server holds an open connection.
		await expect(mgr.cleanup()).resolves.toBeUndefined();
		// Session should be cleared after cleanup.
		expect(mgr.getSession()).toBeNull();
	});

	test('destroyAndRecreate via clearSession() closes old db-query server and creates a new one', async () => {
		const firstSession = makeSession();
		const secondSession = makeSession();
		// Use the makeSessionManager that supports multiple sessions in order.
		const sessions = new Map<string, AgentSession | null>();
		let getCallCount = 0;
		const sessionQueue = [firstSession, secondSession];
		const sm: NeoSessionManager = {
			createSession: mock(async () => {
				const next = sessionQueue.shift() ?? makeSession();
				sessions.set(NEO_SESSION_ID, next);
				return NEO_SESSION_ID;
			}),
			getSessionAsync: mock(async () => {
				if (getCallCount === 0) {
					getCallCount++;
					return null; // first call → no existing session → create
				}
				return sessions.get(NEO_SESSION_ID) ?? null;
			}),
			// Task #85: clearSession() is a daemon-internal reset and must
			// only drop the in-memory SDK subprocess. Pop the next queued
			// session to simulate rehydration from the preserved DB row.
			interruptInMemorySession: mock(async () => {
				const next = sessionQueue.shift();
				if (next !== undefined) {
					sessions.set(NEO_SESSION_ID, next);
				} else {
					sessions.delete(NEO_SESSION_ID);
				}
			}),
			unregisterSession: mock(() => {}),
		};

		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		mgr.setDbPath(dbPath);

		// Provision creates firstSession with a db-query server.
		await mgr.provision();
		expect(mgr.getSession()).toBe(firstSession);

		const firstCalls = (firstSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		expect(firstCalls.length).toBe(1);
		const firstServers = firstCalls[0][0] as Record<string, McpServerConfig>;
		expect('db-query' in firstServers).toBe(true);

		// clearSession() destroys firstSession and provisions secondSession with a fresh db-query server.
		await mgr.clearSession();
		expect(mgr.getSession()).toBe(secondSession);

		const secondCalls = (secondSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		expect(secondCalls.length).toBe(1);
		const secondServers = secondCalls[0][0] as Record<string, McpServerConfig>;
		expect('db-query' in secondServers).toBe(true);

		// Cleanup should not throw (old server is already closed, new one gets closed now).
		await expect(mgr.cleanup()).resolves.toBeUndefined();
	});

	test('when toolsConfig is not set, setDbPath() alone does NOT call setRuntimeMcpServers', async () => {
		const session = makeSession();
		const sm = makeDbSessionManager({ createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		// Only setDbPath(), no setToolsConfig()
		mgr.setDbPath(dbPath);

		await mgr.provision();

		// attachTools() is a no-op when toolsConfig is null, so setRuntimeMcpServers is never called.
		const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBe(0);
	});
});
