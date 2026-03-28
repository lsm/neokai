/**
 * Integration tests for NeoAgentManager query tools attachment.
 *
 * Covers:
 * - provision() with setToolsConfig() calls setRuntimeMcpServers() with neo-query server
 * - provision() without setToolsConfig() does NOT call setRuntimeMcpServers()
 * - Registry MCP servers are merged with the in-process neo-query server
 * - In-process 'neo-query' takes precedence on name collision with registry entry
 * - MCP tools are re-attached after destroyAndRecreate() (startup health-check failure)
 * - clearSession() re-attaches MCP tools on the fresh session
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { NeoAgentManager, NEO_SESSION_ID } from '../../../src/lib/neo/neo-agent-manager';
import type {
	NeoSessionManager,
	NeoSettingsManager,
	NeoAppMcpManager,
} from '../../../src/lib/neo/neo-agent-manager';
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

function makeMinimalToolsConfig(overrides: Partial<NeoToolsConfig> = {}): NeoToolsConfig {
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

function makeAppMcpManager(configs: Record<string, McpServerConfig> = {}): NeoAppMcpManager {
	return {
		getEnabledMcpConfigs: mock(() => configs),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoAgentManager — query tools attachment', () => {
	describe('setToolsConfig() + provision()', () => {
		test('attaches neo-query MCP server when toolsConfig is set before provision()', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalToolsConfig());

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
		});

		test('does NOT call setRuntimeMcpServers when toolsConfig is not set', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			// No setToolsConfig() call

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(0);
		});

		test('merges registry MCP servers with neo-query server', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			const registryServers: Record<string, McpServerConfig> = {
				'brave-search': { command: 'npx', args: ['-y', 'brave-search-mcp'] } as McpServerConfig,
				'fetch-mcp': { command: 'npx', args: ['-y', 'fetch-mcp'] } as McpServerConfig,
			};
			mgr.setToolsConfig(makeMinimalToolsConfig(), makeAppMcpManager(registryServers));

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			expect('neo-query' in servers).toBe(true);
			expect('brave-search' in servers).toBe(true);
			expect('fetch-mcp' in servers).toBe(true);
		});

		test('in-process neo-query takes precedence over registry entry with same name', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());

			// Registry has an entry named 'neo-query' — should be overridden
			const registryNeoQuery = {
				command: 'npx',
				args: ['-y', 'fake-neo-query'],
			} as McpServerConfig;
			const registryServers: Record<string, McpServerConfig> = {
				'neo-query': registryNeoQuery,
			};
			mgr.setToolsConfig(makeMinimalToolsConfig(), makeAppMcpManager(registryServers));

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			// The in-process server should be an object (MCP server instance), not the registry entry
			expect(servers['neo-query']).not.toBe(registryNeoQuery);
		});

		test('works without appMcpManager — only neo-query server is set', async () => {
			const session = makeSession();
			const sm = makeSessionManager({ existingSession: null, createdSession: session });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			// No appMcpManager passed
			mgr.setToolsConfig(makeMinimalToolsConfig());

			await mgr.provision();

			const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			const servers = calls[0][0] as Record<string, McpServerConfig>;
			const keys = Object.keys(servers);
			expect(keys).toEqual(['neo-query']);
		});
	});

	describe('destroyAndRecreate path', () => {
		test('re-attaches MCP tools on fresh session after startup health-check failure', async () => {
			// Stuck session from previous daemon run → destroyAndRecreate() fires
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
			mgr.setToolsConfig(makeMinimalToolsConfig());

			await mgr.provision();

			// Stuck session should not have setRuntimeMcpServers called (it was never healthy)
			expect((stuckSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls.length).toBe(
				0
			);
			// Fresh session has applyRuntimeConfig() called twice: once inside destroyAndRecreate()
			// and once at the end of provision(). Both calls should include neo-query.
			const freshCalls = (freshSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(freshCalls.length).toBeGreaterThanOrEqual(1);
			expect('neo-query' in (freshCalls[0][0] as Record<string, McpServerConfig>)).toBe(true);
		});

		test('re-attaches MCP tools after clearSession()', async () => {
			const initialSession = makeSession();
			const freshSession = makeSession();
			const sm = makeSessionManager({
				existingSession: null,
				createdSessions: [initialSession, freshSession],
			});
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalToolsConfig());

			await mgr.provision();
			await mgr.clearSession();

			// Both sessions should have had setRuntimeMcpServers called
			expect(
				(initialSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls.length
			).toBe(1);
			expect((freshSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls.length).toBe(
				1
			);
		});
	});

	describe('restart path', () => {
		test('re-attaches MCP tools to existing session on daemon restart', async () => {
			const existingSession = makeSession({ processingStatus: 'idle' });
			const sm = makeSessionManager({ existingSession });
			const mgr = new NeoAgentManager(sm, makeSettingsManager());
			mgr.setToolsConfig(makeMinimalToolsConfig());

			await mgr.provision();

			const calls = (existingSession.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
			expect(calls.length).toBe(1);
			expect('neo-query' in (calls[0][0] as Record<string, McpServerConfig>)).toBe(true);
		});
	});
});
