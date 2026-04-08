/**
 * Integration tests: db-query MCP server wired into NeoAgentManager sessions.
 *
 * Covers:
 * - NeoAgentManager with setDbPath() includes 'db-query' key in setRuntimeMcpServers
 * - NeoAgentManager cleanup() calls close() on the db-query server without error
 * - createDbQueryMcpServer can be created, queried, and closed end-to-end
 * - db-query server scoped as 'global' includes correct tool descriptions
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Re-declare the SDK mock so db-query integration tests are insulated from
// test-order-dependent overrides in other suites.
mock.module('@anthropic-ai/claude-agent-sdk', () => {
	class MockMcpServer {
		readonly _registeredTools: Record<string, object> = {};

		connect(): void {}
		disconnect(): void {}
	}

	let toolBatch: Array<{ name: string; def: object }> = [];

	function tool(name: string, description: string, inputSchema: unknown, handler: unknown): object {
		const def = { name, description, inputSchema, handler };
		toolBatch.push({ name, def });
		return def;
	}

	return {
		query: mock(async () => ({ interrupt: () => {} })),
		interrupt: mock(async () => {}),
		supportedModels: mock(async () => {
			throw new Error('SDK unavailable in unit test');
		}),
		createSdkMcpServer: mock((options: { name: string; version?: string; tools?: unknown[] }) => {
			const server = new MockMcpServer();
			for (const { name, def } of toolBatch) {
				server._registeredTools[name] = def;
			}
			if (Object.keys(server._registeredTools).length === 0 && Array.isArray(options.tools)) {
				for (const candidate of options.tools) {
					const toolDef = candidate as { name?: string };
					if (toolDef.name) {
						server._registeredTools[toolDef.name] = candidate as object;
					}
				}
			}
			toolBatch = [];

			return {
				type: 'sdk' as const,
				name: options.name,
				version: options.version ?? '1.0.0',
				tools: options.tools ?? [],
				instance: server,
			};
		}),
		tool,
	};
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createDbQueryMcpServer } from '../../../../src/lib/db-query/tools.ts';
import { NeoAgentManager, NEO_SESSION_ID } from '../../../../src/lib/neo/neo-agent-manager.ts';
import type {
	NeoSessionManager,
	NeoSettingsManager,
} from '../../../../src/lib/neo/neo-agent-manager.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
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
} from '../../../../src/lib/neo/tools/neo-query-tools.ts';

// ---------------------------------------------------------------------------
// Shared temp-db setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;

function setupTempDb(extraSetup?: (db: Database) => void): void {
	tmpDir = mkdtempSync(join(tmpdir(), 'neokai-db-query-session-'));
	dbPath = join(tmpDir, 'test.db');
	const db = new Database(dbPath);
	db.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, config TEXT)');
	db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, restrictions TEXT)');
	if (extraSetup) extraSetup(db);
	db.close();
}

function teardownTempDb(): void {
	rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Helpers — minimal stubs mirroring neo-agent-manager-all-tools.test.ts
// ---------------------------------------------------------------------------

function makeSession(): AgentSession {
	return {
		getProcessingState: mock(() => ({ status: 'idle' })),
		isCleaningUp: mock(() => false),
		setRuntimeSystemPrompt: mock(() => undefined),
		setRuntimeModel: mock(() => undefined),
		setRuntimeMcpServers: mock(() => undefined),
		cleanup: mock(async () => undefined),
		queryPromise: null,
		queryObject: null,
	} as unknown as AgentSession;
}

function makeSessionManager(createdSession?: AgentSession): NeoSessionManager {
	const sessions = new Map<string, AgentSession | null>();
	let getCallCount = 0;

	return {
		createSession: mock(async () => {
			sessions.set(NEO_SESSION_ID, createdSession ?? makeSession());
			return NEO_SESSION_ID;
		}),
		getSessionAsync: mock(async (_id: string): Promise<AgentSession | null> => {
			if (getCallCount === 0) {
				getCallCount++;
				return null; // no pre-existing session — first run
			}
			return sessions.get(NEO_SESSION_ID) ?? null;
		}),
		deleteSession: mock(async (_id: string) => {
			sessions.delete(NEO_SESSION_ID);
		}),
		unregisterSession: mock((_id: string) => {}),
	};
}

function makeSettingsManager(): NeoSettingsManager {
	return {
		getGlobalSettings: mock(() => ({ neoSecurityMode: 'balanced', model: 'sonnet' })),
	};
}

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

// ---------------------------------------------------------------------------
// Tests: NeoAgentManager + db-query server wiring
// ---------------------------------------------------------------------------

describe('db-query session integration — NeoAgentManager', () => {
	beforeEach(() => {
		setupTempDb();
	});

	afterEach(() => {
		teardownTempDb();
	});

	it('setDbPath() causes db-query key to appear in setRuntimeMcpServers when toolsConfig is set', async () => {
		const session = makeSession();
		const mgr = new NeoAgentManager(makeSessionManager(session), makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		mgr.setDbPath(dbPath);

		await mgr.provision();

		const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBe(1);
		const servers = calls[0][0] as Record<string, McpServerConfig>;
		expect('db-query' in servers).toBe(true);
	});

	it('db-query key is absent from setRuntimeMcpServers when setDbPath() is not called', async () => {
		const session = makeSession();
		const mgr = new NeoAgentManager(makeSessionManager(session), makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		// Deliberately omit setDbPath()

		await mgr.provision();

		const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBe(1);
		const servers = calls[0][0] as Record<string, McpServerConfig>;
		expect('db-query' in servers).toBe(false);
	});

	it('cleanup() closes the db-query server connection without error', async () => {
		const session = makeSession();
		const mgr = new NeoAgentManager(makeSessionManager(session), makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		mgr.setDbPath(dbPath);

		await mgr.provision();

		// Should not throw — db-query server's close() is called internally.
		await expect(mgr.cleanup()).resolves.toBeUndefined();
		expect(mgr.getSession()).toBeNull();
	});

	it('cleanup() is safe to call twice (idempotent — db-query server already closed)', async () => {
		const session = makeSession();
		const mgr = new NeoAgentManager(makeSessionManager(session), makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		mgr.setDbPath(dbPath);

		await mgr.provision();
		await mgr.cleanup();

		// Second cleanup is safe (no db-query server to close, session is null).
		await expect(mgr.cleanup()).resolves.toBeUndefined();
	});

	it('neo-query server coexists with db-query server in setRuntimeMcpServers', async () => {
		const session = makeSession();
		const mgr = new NeoAgentManager(makeSessionManager(session), makeSettingsManager());
		mgr.setToolsConfig(makeMinimalQueryConfig());
		mgr.setDbPath(dbPath);

		await mgr.provision();

		const calls = (session.setRuntimeMcpServers as ReturnType<typeof mock>).mock.calls;
		const servers = calls[0][0] as Record<string, McpServerConfig>;
		expect('neo-query' in servers).toBe(true);
		expect('db-query' in servers).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: createDbQueryMcpServer end-to-end
// ---------------------------------------------------------------------------

describe('db-query session integration — createDbQueryMcpServer end-to-end', () => {
	beforeEach(() => {
		setupTempDb((db) => {
			db.exec("INSERT INTO rooms VALUES ('r1', 'Main Room', null)");
		});
	});

	afterEach(() => {
		teardownTempDb();
	});

	it('creates a server with type sdk and name db-query', () => {
		const server = createDbQueryMcpServer({
			dbPath,
			scopeType: 'global',
			scopeValue: '',
		});

		expect(server.type).toBe('sdk');
		expect(server.name).toBe('db-query');

		server.close();
	});

	it('registers db_query, db_list_tables, and db_describe_table tools', () => {
		const server = createDbQueryMcpServer({
			dbPath,
			scopeType: 'global',
			scopeValue: '',
		});

		expect(server.instance._registeredTools).toHaveProperty('db_query');
		expect(server.instance._registeredTools).toHaveProperty('db_list_tables');
		expect(server.instance._registeredTools).toHaveProperty('db_describe_table');

		server.close();
	});

	it('db_query handler returns data from the database', async () => {
		const server = createDbQueryMcpServer({
			dbPath,
			scopeType: 'global',
			scopeValue: '',
		});

		const handler = (
			server.instance._registeredTools.db_query as {
				handler: (args: { sql: string }) => Promise<{ content: Array<{ text: string }> }>;
			}
		).handler;

		const result = await handler({ sql: 'SELECT id, name FROM rooms' });
		const data = JSON.parse(result.content[0].text);
		expect(data.rows).toHaveLength(1);
		expect(data.rows[0].id).toBe('r1');
		expect(data.rows[0].name).toBe('Main Room');

		server.close();
	});

	it('db_query handler rejects non-SELECT statements', async () => {
		const server = createDbQueryMcpServer({
			dbPath,
			scopeType: 'global',
			scopeValue: '',
		});

		const handler = (
			server.instance._registeredTools.db_query as {
				handler: (args: { sql: string }) => Promise<{ content: Array<{ text: string }> }>;
			}
		).handler;

		const result = await handler({ sql: "INSERT INTO rooms VALUES ('r2', 'Bad', null)" });
		// The error response is a text content with error message.
		expect(result.content[0].text).toContain('SELECT');

		server.close();
	});

	it('close() releases the database connection without error', () => {
		const server = createDbQueryMcpServer({
			dbPath,
			scopeType: 'global',
			scopeValue: '',
		});

		expect(() => server.close()).not.toThrow();
	});

	it('global scope db_query tool description mentions global scope', () => {
		const server = createDbQueryMcpServer({
			dbPath,
			scopeType: 'global',
			scopeValue: '',
		});

		const queryTool = server.instance._registeredTools.db_query as { description: string };
		expect(queryTool.description).toContain('global scope');

		server.close();
	});
});
