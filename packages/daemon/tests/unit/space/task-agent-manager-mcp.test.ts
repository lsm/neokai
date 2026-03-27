/**
 * Tests for TaskAgentManager + AppMcpLifecycleManager integration (Task 3.4).
 * Also covers ChannelResolver injection into node agent MCP servers (Task 3.3).
 *
 * Verifies that:
 * 1. Task agent sessions receive registry-sourced MCP servers merged into their
 *    setRuntimeMcpServers() call alongside the in-process task-agent server.
 * 2. The in-process task-agent server always takes precedence over registry entries
 *    on name collision.
 * 3. The merged map is complete — registry entries are not dropped.
 * 4. appMcpManager is optional — omitting it does not throw; task-agent server is
 *    still injected.
 * 5. Multiple registry servers are all included in the merged map.
 * 6. buildNodeAgentMcpServerForSession creates a ChannelResolver from the workflow
 *    run config and injects it into the node agent MCP server config (Task 3.3).
 */

import { describe, test, expect, afterEach, spyOn, beforeEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../src/lib/agent/agent-session.ts';
import * as nodeAgentToolsModule from '../../../src/lib/space/tools/node-agent-tools.ts';
import type { Space, SpaceTask, McpServerConfig, ResolvedChannel } from '@neokai/shared';
import type { AgentProcessingState } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Minimal in-process DaemonHub
// ---------------------------------------------------------------------------

type EventHandler = (data: Record<string, unknown>) => void;

class TestDaemonHub {
	private listeners = new Map<string, Map<string, EventHandler>>();

	on(event: string, handler: EventHandler, opts?: { sessionId?: string }): () => void {
		const key = opts?.sessionId ? `${event}:${opts.sessionId}` : `${event}:*`;
		if (!this.listeners.has(key)) this.listeners.set(key, new Map());
		const id = Math.random().toString(36).slice(2);
		this.listeners.get(key)!.set(id, handler);
		return () => {
			this.listeners.get(key)?.delete(id);
		};
	}

	emit(event: string, data: Record<string, unknown>): Promise<void> {
		const sessionId = (data as { sessionId?: string }).sessionId;
		if (sessionId) {
			for (const h of this.listeners.get(`${event}:${sessionId}`)?.values() ?? []) h(data);
		}
		for (const h of this.listeners.get(`${event}:*`)?.values() ?? []) h(data);
		return Promise.resolve();
	}
}

// ---------------------------------------------------------------------------
// Mock AgentSession
// ---------------------------------------------------------------------------

interface MockAgentSession {
	session: { id: string };
	getProcessingState: () => AgentProcessingState;
	setRuntimeMcpServers: (servers: Record<string, unknown>) => void;
	setRuntimeSystemPrompt: (sp: unknown) => void;
	startStreamingQuery: () => Promise<void>;
	ensureQueryStarted: () => Promise<void>;
	handleInterrupt: () => Promise<void>;
	cleanup: () => Promise<void>;
	messageQueue: { enqueueWithId: (id: string, msg: string) => Promise<void> };
	_mcpServers: Record<string, unknown>;
}

function makeMockSession(sessionId: string): MockAgentSession {
	const m: MockAgentSession = {
		session: { id: sessionId },
		_mcpServers: {},
		getProcessingState: () => ({ status: 'idle' }) as AgentProcessingState,
		setRuntimeMcpServers(servers) {
			m._mcpServers = servers;
		},
		setRuntimeSystemPrompt(_sp: unknown) {},
		async startStreamingQuery() {},
		async ensureQueryStarted() {},
		async handleInterrupt() {},
		async cleanup() {},
		messageQueue: {
			async enqueueWithId(_id: string, _msg: string) {},
		},
	};
	return m;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-tam-mcp',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function makeSpace(spaceId: string, workspacePath = '/tmp/workspace'): Space {
	return {
		id: spaceId,
		workspacePath,
		name: `Space ${spaceId}`,
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Build TaskAgentManager with optional appMcpManager
// ---------------------------------------------------------------------------

function buildManager(opts: {
	registryMcpServers?: Record<string, McpServerConfig>;
	hasAppMcpManager?: boolean;
}): {
	manager: TaskAgentManager;
	createdSessions: Map<string, MockAgentSession>;
	fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;
	bunDb: BunDatabase;
	dir: string;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	space: Space;
	/** Seed a session in the mock DB (used to simulate sessions that existed before restart). */
	seedSession: (id: string, type: string) => void;
} {
	const { registryMcpServers = {}, hasAppMcpManager = true } = opts;
	const { db: bunDb, dir } = makeDb();
	const spaceId = 'space-mcp-test';
	seedSpaceRow(bunDb, spaceId);

	const agentRepo = new SpaceAgentRepository(bunDb);
	const agentManager = new SpaceAgentManager(agentRepo);
	const workflowRepo = new SpaceWorkflowRepository(bunDb);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);
	const workflowRunRepo = new SpaceWorkflowRunRepository(bunDb);
	const taskRepo = new SpaceTaskRepository(bunDb);
	const spaceManager = new SpaceManager(bunDb);
	const taskManager = new SpaceTaskManager(bunDb, spaceId);
	const runtime = new SpaceRuntime({
		db: bunDb,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
	});
	const daemonHub = new TestDaemonHub();
	const space = makeSpace(spaceId);

	const createdSessions = new Map<string, MockAgentSession>();
	const dbSessions = new Map<string, unknown>();

	const mockDb = {
		getSession: (id: string) => (dbSessions.has(id) ? dbSessions.get(id) : null),
		createSession: (session: unknown) => {
			dbSessions.set((session as { id: string }).id, session);
		},
		deleteSession: (id: string) => dbSessions.delete(id),
		saveUserMessage: () => 'msg-id',
		updateSession: () => {},
		getDatabase: () => bunDb,
	};

	const fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation(
		(
			init: unknown,
			_db: unknown,
			_hub: unknown,
			_dHub: unknown,
			_key: unknown,
			_model: unknown
		) => {
			const { sessionId } = init as { sessionId: string };
			const mockSession = makeMockSession(sessionId);
			createdSessions.set(sessionId, mockSession);
			mockDb.createSession({ id: sessionId, type: 'space_task_agent' });
			return mockSession as unknown as AgentSession;
		}
	);

	const appMcpManager = hasAppMcpManager
		? { getEnabledMcpConfigs: () => registryMcpServers }
		: undefined;

	const manager = new TaskAgentManager({
		db: mockDb as unknown as import('../../../src/storage/database.ts').Database,
		sessionManager: {
			deleteSession: async () => {},
			registerSession: () => {},
		} as unknown as import('../../../src/lib/session-manager.ts').SessionManager,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		spaceRuntimeService: {
			createOrGetRuntime: async (_spaceId: string) => runtime,
		} as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
		taskRepo,
		workflowRunRepo,
		daemonHub: daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
		messageHub: {} as unknown as import('@neokai/shared').MessageHub,
		getApiKey: async () => 'test-key',
		defaultModel: 'claude-sonnet-4-5-20250929',
		appMcpManager: appMcpManager as never,
	});

	return {
		manager,
		createdSessions,
		fromInitSpy,
		bunDb,
		dir,
		taskRepo,
		taskManager,
		space,
		seedSession: (id: string, type: string) => {
			mockDb.createSession({ id, type });
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskAgentManager — registry MCP merge (Task 3.4)', () => {
	const spies: Array<{ mockRestore: () => void }> = [];
	const dirs: string[] = [];

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		for (const dir of dirs.splice(0)) {
			try {
				rmSync(dir, { recursive: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	test('task agent session receives registry MCP servers merged with task-agent server', async () => {
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-cmd' };
		const { manager, createdSessions, fromInitSpy, dir, taskManager, space } = buildManager({
			registryMcpServers: { 'registry-mcp': registryServer },
		});
		spies.push(fromInitSpy);
		dirs.push(dir);

		const task = await taskManager.createTask({
			title: 'Test task',
			description: 'desc',
			taskType: 'coding',
			status: 'pending',
		});

		await manager.spawnTaskAgent(task, space, null, null);

		// Find the created session — it will be the task agent session
		const sessions = [...createdSessions.values()];
		expect(sessions.length).toBeGreaterThan(0);
		const taskAgentSession = sessions[0]!;

		const mcpServers = taskAgentSession._mcpServers;
		// Must have both registry server and in-process task-agent server
		expect(mcpServers['registry-mcp']).toBeDefined();
		expect(mcpServers['task-agent']).toBeDefined();
	});

	test('in-process task-agent server takes precedence over registry entry with same name', async () => {
		// A registry entry named 'task-agent' should NOT override the in-process server.
		const impostor: McpServerConfig = { type: 'stdio', command: 'impostor-cmd' };
		const { manager, createdSessions, fromInitSpy, dir, taskManager, space } = buildManager({
			registryMcpServers: { 'task-agent': impostor },
		});
		spies.push(fromInitSpy);
		dirs.push(dir);

		const task = await taskManager.createTask({
			title: 'Collision task',
			description: 'desc',
			taskType: 'coding',
			status: 'pending',
		});

		await manager.spawnTaskAgent(task, space, null, null);

		const session = [...createdSessions.values()][0]!;
		const mcpServers = session._mcpServers;
		// The task-agent entry must be the real MCP server object, not the registry impostor
		const taskAgentServer = mcpServers['task-agent'] as McpServerConfig & { command?: string };
		// The impostor has command: 'impostor-cmd'; real server won't have that property
		expect(taskAgentServer.command).not.toBe('impostor-cmd');
	});

	test('merged map contains all registry servers — none are dropped', async () => {
		const serverA: McpServerConfig = { type: 'stdio', command: 'server-a' };
		const serverB: McpServerConfig = { type: 'stdio', command: 'server-b' };
		const { manager, createdSessions, fromInitSpy, dir, taskManager, space } = buildManager({
			registryMcpServers: { 'mcp-a': serverA, 'mcp-b': serverB },
		});
		spies.push(fromInitSpy);
		dirs.push(dir);

		const task = await taskManager.createTask({
			title: 'Multi-registry task',
			description: 'desc',
			taskType: 'coding',
			status: 'pending',
		});

		await manager.spawnTaskAgent(task, space, null, null);

		const session = [...createdSessions.values()][0]!;
		const mcpServers = session._mcpServers;
		expect(mcpServers['mcp-a']).toBeDefined();
		expect(mcpServers['mcp-b']).toBeDefined();
		expect(mcpServers['task-agent']).toBeDefined();
	});

	test('works without appMcpManager — task-agent server is still injected', async () => {
		const { manager, createdSessions, fromInitSpy, dir, taskManager, space } = buildManager({
			hasAppMcpManager: false,
		});
		spies.push(fromInitSpy);
		dirs.push(dir);

		const task = await taskManager.createTask({
			title: 'No registry task',
			description: 'desc',
			taskType: 'coding',
			status: 'pending',
		});

		await manager.spawnTaskAgent(task, space, null, null);

		const session = [...createdSessions.values()][0]!;
		const mcpServers = session._mcpServers;
		// task-agent server must still be present even without appMcpManager
		expect(mcpServers['task-agent']).toBeDefined();
	});

	test('works with empty registry — task-agent server is still injected', async () => {
		const { manager, createdSessions, fromInitSpy, dir, taskManager, space } = buildManager({
			registryMcpServers: {},
		});
		spies.push(fromInitSpy);
		dirs.push(dir);

		const task = await taskManager.createTask({
			title: 'Empty registry task',
			description: 'desc',
			taskType: 'coding',
			status: 'pending',
		});

		await manager.spawnTaskAgent(task, space, null, null);

		const session = [...createdSessions.values()][0]!;
		const mcpServers = session._mcpServers;
		expect(mcpServers['task-agent']).toBeDefined();
		// Only the task-agent server should be present
		expect(Object.keys(mcpServers)).toEqual(['task-agent']);
	});
});

// ---------------------------------------------------------------------------
// Rehydration tests — registry MCP merge on daemon restart (P1 fix)
// ---------------------------------------------------------------------------

describe('TaskAgentManager.rehydrate — registry MCP merge (Task 3.4)', () => {
	const spies: Array<{ mockRestore: () => void }> = [];
	const dirs: string[] = [];

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		for (const dir of dirs.splice(0)) {
			try {
				rmSync(dir, { recursive: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('rehydrated task agent session receives registry MCP servers alongside task-agent server', async () => {
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-cmd' };
		const { manager, createdSessions, fromInitSpy, bunDb, dir, taskManager, space, seedSession } =
			buildManager({ registryMcpServers: { 'registry-mcp': registryServer } });
		spies.push(fromInitSpy);
		dirs.push(dir);

		// Create a task that was in progress before the daemon restart
		const task = await taskManager.createTask({
			title: 'Rehydration task',
			description: 'desc',
			taskType: 'coding',
			status: 'in_progress',
		});
		const agentSessionId = `space:${space.id}:task:${task.id}`;

		// Persist session ID on task (simulates state after first spawnTaskAgent)
		bunDb
			.prepare(`UPDATE space_tasks SET task_agent_session_id = ?, updated_at = ? WHERE id = ?`)
			.run(agentSessionId, Date.now(), task.id);

		// Seed a mock DB record for the session so rehydrate filter passes type check
		seedSession(agentSessionId, 'space_task_agent');

		// Spy on AgentSession.restore (used by rehydrateTaskAgent, unlike spawnTaskAgent)
		const agentSessionModule = await import('../../../src/lib/agent/agent-session.ts');
		const restoreSpy = spyOn(agentSessionModule.AgentSession, 'restore').mockImplementation(
			(sessionId: string) => {
				const mockSession = makeMockSession(sessionId);
				createdSessions.set(sessionId, mockSession);
				return mockSession as unknown as AgentSession;
			}
		);
		spies.push(restoreSpy);

		await manager.rehydrate();

		const session = createdSessions.get(agentSessionId);
		expect(session).toBeDefined();
		const mcpServers = session!._mcpServers;
		expect(mcpServers['registry-mcp']).toBeDefined();
		expect(mcpServers['task-agent']).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// ChannelResolver injection into node agent MCP servers (Task 3.3)
// ---------------------------------------------------------------------------

/**
 * Helper: seed a workflow run with resolved channels in the run config.
 * Returns the workflow run ID.
 */
function seedWorkflowRunWithChannels(
	bunDb: BunDatabase,
	spaceId: string,
	channels: ResolvedChannel[]
): string {
	const workflowRepo = new SpaceWorkflowRepository(bunDb);
	const workflow = workflowRepo.createWorkflow({
		spaceId,
		name: 'Test Workflow',
		description: '',
		nodes: [],
		transitions: [],
		startNodeId: '',
		rules: [],
	});
	const runRepo = new SpaceWorkflowRunRepository(bunDb);
	const run = runRepo.createRun({
		spaceId,
		workflowId: workflow.id,
		title: 'Test Run',
	});
	if (channels.length > 0) {
		runRepo.updateRun(run.id, { config: { _resolvedChannels: channels } });
	}
	return run.id;
}

function makeResolvedChannel(
	fromRole: string,
	toRole: string,
	isHubSpoke = false
): ResolvedChannel {
	return {
		fromRole,
		toRole,
		fromAgentId: `agent-${fromRole}`,
		toAgentId: `agent-${toRole}`,
		direction: 'one-way',
		isHubSpoke,
	};
}

describe('TaskAgentManager — ChannelResolver injection (Task 3.3)', () => {
	const spies: Array<{ mockRestore: () => void }> = [];
	const dirs: string[] = [];

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		for (const dir of dirs.splice(0)) {
			try {
				rmSync(dir, { recursive: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('buildNodeAgentMcpServerForSession injects ChannelResolver with declared channels', () => {
		const { manager, fromInitSpy, bunDb, dir, space } = buildManager({});
		spies.push(fromInitSpy);
		dirs.push(dir);

		// Seed a workflow run with a channel
		const workflowRunId = seedWorkflowRunWithChannels(bunDb, space.id, [
			makeResolvedChannel('coder', 'reviewer'),
		]);

		// Spy on createNodeAgentMcpServer to capture the config it receives
		let capturedConfig: Record<string, unknown> | null = null;
		const mcpServerSpy = spyOn(nodeAgentToolsModule, 'createNodeAgentMcpServer').mockImplementation(
			(config) => {
				capturedConfig = config as unknown as Record<string, unknown>;
				// Return minimal stub
				return { server: {}, cleanup: () => {} } as unknown as ReturnType<
					typeof nodeAgentToolsModule.createNodeAgentMcpServer
				>;
			}
		);
		spies.push(mcpServerSpy);

		// Call the private method directly via cast
		const mgr = manager as unknown as {
			buildNodeAgentMcpServerForSession(
				taskId: string,
				subSessionId: string,
				role: string,
				spaceId: string,
				workflowRunId: string
			): unknown;
		};
		mgr.buildNodeAgentMcpServerForSession(
			'task-1',
			'sub-session-1',
			'coder',
			space.id,
			workflowRunId
		);

		expect(capturedConfig).not.toBeNull();
		// channelResolver must be present and have the declared channel
		const resolver = (
			capturedConfig as { channelResolver: { canSend: (a: string, b: string) => boolean } }
		).channelResolver;
		expect(resolver).toBeDefined();
		expect(resolver.canSend('coder', 'reviewer')).toBe(true);
		expect(resolver.canSend('reviewer', 'coder')).toBe(false);
	});

	test('buildNodeAgentMcpServerForSession injects empty ChannelResolver when run has no channels', () => {
		const { manager, fromInitSpy, bunDb, dir, space } = buildManager({});
		spies.push(fromInitSpy);
		dirs.push(dir);

		// Seed a workflow run with NO channels
		const workflowRunId = seedWorkflowRunWithChannels(bunDb, space.id, []);

		let capturedConfig: Record<string, unknown> | null = null;
		const mcpServerSpy = spyOn(nodeAgentToolsModule, 'createNodeAgentMcpServer').mockImplementation(
			(config) => {
				capturedConfig = config as unknown as Record<string, unknown>;
				return { server: {}, cleanup: () => {} } as unknown as ReturnType<
					typeof nodeAgentToolsModule.createNodeAgentMcpServer
				>;
			}
		);
		spies.push(mcpServerSpy);

		const mgr = manager as unknown as {
			buildNodeAgentMcpServerForSession(
				taskId: string,
				subSessionId: string,
				role: string,
				spaceId: string,
				workflowRunId: string
			): unknown;
		};
		mgr.buildNodeAgentMcpServerForSession(
			'task-1',
			'sub-session-1',
			'coder',
			space.id,
			workflowRunId
		);

		expect(capturedConfig).not.toBeNull();
		const resolver = (capturedConfig as { channelResolver: { isEmpty: () => boolean } })
			.channelResolver;
		expect(resolver).toBeDefined();
		expect(resolver.isEmpty()).toBe(true);
	});

	test('buildNodeAgentMcpServerForSession injects empty ChannelResolver when workflowRunId is empty', () => {
		const { manager, fromInitSpy, dir, space } = buildManager({});
		spies.push(fromInitSpy);
		dirs.push(dir);

		let capturedConfig: Record<string, unknown> | null = null;
		const mcpServerSpy = spyOn(nodeAgentToolsModule, 'createNodeAgentMcpServer').mockImplementation(
			(config) => {
				capturedConfig = config as unknown as Record<string, unknown>;
				return { server: {}, cleanup: () => {} } as unknown as ReturnType<
					typeof nodeAgentToolsModule.createNodeAgentMcpServer
				>;
			}
		);
		spies.push(mcpServerSpy);

		const mgr = manager as unknown as {
			buildNodeAgentMcpServerForSession(
				taskId: string,
				subSessionId: string,
				role: string,
				spaceId: string,
				workflowRunId: string
			): unknown;
		};
		// Empty workflowRunId — no run will be found
		mgr.buildNodeAgentMcpServerForSession('task-1', 'sub-session-1', 'coder', space.id, '');

		expect(capturedConfig).not.toBeNull();
		const resolver = (capturedConfig as { channelResolver: { isEmpty: () => boolean } })
			.channelResolver;
		expect(resolver).toBeDefined();
		expect(resolver.isEmpty()).toBe(true);
	});

	test('buildNodeAgentMcpServerForSession passes correct mySessionId, myRole, and taskId', () => {
		const { manager, fromInitSpy, dir, space } = buildManager({});
		spies.push(fromInitSpy);
		dirs.push(dir);

		let capturedConfig: Record<string, unknown> | null = null;
		const mcpServerSpy = spyOn(nodeAgentToolsModule, 'createNodeAgentMcpServer').mockImplementation(
			(config) => {
				capturedConfig = config as unknown as Record<string, unknown>;
				return { server: {}, cleanup: () => {} } as unknown as ReturnType<
					typeof nodeAgentToolsModule.createNodeAgentMcpServer
				>;
			}
		);
		spies.push(mcpServerSpy);

		const mgr = manager as unknown as {
			buildNodeAgentMcpServerForSession(
				taskId: string,
				subSessionId: string,
				role: string,
				spaceId: string,
				workflowRunId: string
			): unknown;
		};
		mgr.buildNodeAgentMcpServerForSession(
			'my-task-id',
			'my-sub-session-id',
			'reviewer',
			space.id,
			''
		);

		expect(capturedConfig).not.toBeNull();
		expect(capturedConfig!['mySessionId']).toBe('my-sub-session-id');
		expect(capturedConfig!['myRole']).toBe('reviewer');
		expect(capturedConfig!['taskId']).toBe('my-task-id');
	});
});
