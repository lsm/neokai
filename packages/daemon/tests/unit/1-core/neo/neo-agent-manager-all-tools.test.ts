/**
 * Integration tests for NeoAgentManager combined query + action tools attachment.
 *
 * Covers:
 * - provision() with both setToolsConfig() + setActionToolsConfig() attaches both servers
 * - provision() with only setToolsConfig() attaches only neo-query server
 * - provision() with only setActionToolsConfig() (no query tools) is a no-op
 * - Both servers survive destroyAndRecreate() (startup health-check failure)
 * - Both servers are re-attached after clearSession()
 * - Action config set after query config — both present after provision()
 * - Registry servers are merged alongside both in-process servers
 * - In-process 'neo-action' wins on registry name collision
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { NeoAgentManager, NEO_SESSION_ID } from '../../../../src/lib/neo/neo-agent-manager';
import type {
	NeoSessionManager,
	NeoSettingsManager,
	NeoAppMcpManager,
} from '../../../../src/lib/neo/neo-agent-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
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
} from '../../../../src/lib/neo/tools/neo-query-tools';
import type {
	NeoActionToolsConfig,
	NeoActionRoomManager,
	NeoActionManagerFactory,
	NeoActionGoalManager,
	NeoActionTaskManager,
} from '../../../../src/lib/neo/tools/neo-action-tools';
import { PendingActionStore } from '../../../../src/lib/neo/security-tier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(
	overrides: {
		processingStatus?: 'idle' | 'processing' | 'queued' | 'waiting_for_input' | 'interrupted';
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

function makeSessionManager(
	opts: {
		existingSession?: AgentSession | null;
		createdSessions?: Array<AgentSession | null>;
		createdSession?: AgentSession | null;
	} = {}
): NeoSessionManager & { _createCalls: number } {
	const sessions = new Map<string, AgentSession | null>();
	let getCallCount = 0;
	const sessionQueue: Array<AgentSession | null> = opts.createdSessions
		? [...opts.createdSessions]
		: opts.createdSession !== undefined
			? [opts.createdSession]
			: [];

	const sm = {
		_createCalls: 0,

		createSession: mock(async () => {
			sm._createCalls++;
			const next = sessionQueue.length > 0 ? sessionQueue.shift()! : makeSession();
			sessions.set(NEO_SESSION_ID, next);
			return NEO_SESSION_ID;
		}),

		getSessionAsync: mock(async (_id: string): Promise<AgentSession | null> => {
			if (getCallCount === 0) {
				getCallCount++;
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

function makeMinimalQueryConfig(overrides: Partial<NeoToolsConfig> = {}): NeoToolsConfig {
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
		...overrides,
	};
}

function makeMinimalActionConfig(
	overrides: Partial<NeoActionToolsConfig> = {}
): NeoActionToolsConfig {
	const noopRoomManager: NeoActionRoomManager = {
		createRoom: mock(() => ({ id: 'r1', name: 'Room 1' }) as never),
		deleteRoom: mock(() => true),
		getRoom: mock(() => null),
		updateRoom: mock(() => null),
	};

	const noopGoalManager: NeoActionGoalManager = {
		createGoal: mock(async () => ({ id: 'g1', title: 'Goal 1' }) as never),
		getGoal: mock(async () => null),
		patchGoal: mock(async () => ({ id: 'g1', title: 'Goal 1' }) as never),
		updateGoalStatus: mock(async () => ({ id: 'g1', title: 'Goal 1' }) as never),
	};

	const noopTaskManager: NeoActionTaskManager = {
		createTask: mock(async () => ({ id: 't1', title: 'Task 1' }) as never),
		getTask: mock(async () => null),
		updateTaskFields: mock(async () => ({ id: 't1', title: 'Task 1' }) as never),
		setTaskStatus: mock(async () => ({ id: 't1', title: 'Task 1' }) as never),
	};

	const noopManagerFactory: NeoActionManagerFactory = {
		getGoalManager: mock(() => noopGoalManager),
		getTaskManager: mock(() => noopTaskManager),
	};

	return {
		roomManager: noopRoomManager,
		managerFactory: noopManagerFactory,
		pendingStore: new PendingActionStore(),
		getSecurityMode: () => 'balanced',
		...overrides,
	};
}

function makeAppMcpManager(configs: Record<string, McpServerConfig> = {}): NeoAppMcpManager {
	return {
		getEnabledMcpConfigs: mock(() => configs),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoAgentManager — combined query + action tools', () => {
	describe('setToolsConfig() + setActionToolsConfig() + provision()', () => {
		test('attaches both neo-query and neo-action servers when both configs are set', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalQueryConfig());
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('neo-action' in servers).toBe(true);
		});

		test('attaches only neo-query when only query config is set', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalQueryConfig());
			// No setActionToolsConfig()

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('neo-action' in servers).toBe(false);
		});

		test('is a no-op when only action config is set (no query config)', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			// Only action config, no query config
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();

			// Without toolsConfig, setRuntimeMcpServers should NOT be called
			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(0);
		});

		test('merges registry servers alongside both in-process servers', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			const registryServers: Record<string, McpServerConfig> = {
				'brave-search': { command: 'npx', args: ['-y', 'brave-search-mcp'] } as McpServerConfig,
			};
			mgr.setToolsConfig(makeMinimalQueryConfig(), makeAppMcpManager(registryServers));
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('neo-action' in servers).toBe(true);
			expect('brave-search' in servers).toBe(true);
		});

		test('in-process neo-action takes precedence over registry entry with same name', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			// Registry has an entry named 'neo-action' — should be overridden
			const registryNeoAction = {
				command: 'npx',
				args: ['-y', 'fake-neo-action'],
			} as McpServerConfig;
			const registryServers: Record<string, McpServerConfig> = {
				'neo-action': registryNeoAction,
			};
			mgr.setToolsConfig(makeMinimalQueryConfig(), makeAppMcpManager(registryServers));
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			// The in-process server should be an object (MCP server instance), not the registry entry
			expect(servers['neo-action']).not.toBe(registryNeoAction);
		});
	});

	describe('destroyAndRecreate path', () => {
		test('re-attaches both MCP servers on fresh session after health-check failure', async () => {
			const stuckSession = makeSession({
				processingStatus: 'processing',
				queryPromise: new Promise(() => undefined),
				queryObject: null,
			});
			const freshSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({
				existingSession: stuckSession,
				createdSession: freshSession,
			});
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalQueryConfig());
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();

			// Fresh session should have both servers
			const freshCalls = (freshSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(freshCalls.length).toBeGreaterThanOrEqual(1);
			const servers = freshCalls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('neo-action' in servers).toBe(true);
		});

		test('re-attaches both servers after clearSession()', async () => {
			const initialSession = makeSession();
			const freshSession = makeSession();
			const sm = makeSessionManager({
				existingSession: null,
				createdSessions: [initialSession, freshSession],
			});
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalQueryConfig());
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();
			await mgr.clearSession();

			// Both sessions should have both servers attached
			for (const session of [initialSession, freshSession]) {
				const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
				expect(calls.length).toBe(1);
				const servers = calls[0][0] as Record<string, McpServerConfig>;
				expect('neo-query' in servers).toBe(true);
				expect('neo-action' in servers).toBe(true);
			}
		});
	});

	describe('restart path', () => {
		test('re-attaches both servers to existing session on daemon restart', async () => {
			const existingSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({ existingSession });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalQueryConfig());
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();

			const calls = (existingSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('neo-action' in servers).toBe(true);
		});
	});

	describe('setActionToolsConfig() independence', () => {
		test('can be called after setToolsConfig() — both configs are honoured at provision()', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			// Typical call order in rpc-handlers/index.ts: query first, then action
			mgr.setToolsConfig(makeMinimalQueryConfig());
			mgr.setActionToolsConfig(makeMinimalActionConfig());

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('neo-action' in servers).toBe(true);
			expect(Object.keys(servers)).toHaveLength(2);
		});

		test('action config can be updated by calling setActionToolsConfig() again before provision()', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalQueryConfig());

			const firstConfig = makeMinimalActionConfig();
			const secondConfig = makeMinimalActionConfig();
			mgr.setActionToolsConfig(firstConfig);
			mgr.setActionToolsConfig(secondConfig); // second call wins

			await mgr.provision();

			// Still creates both servers — we just verify it doesn't throw and attaches them
			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('neo-action' in servers).toBe(true);
		});
	});
});
