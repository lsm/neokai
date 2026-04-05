/**
 * Unit tests for Task Agent session lifecycle
 *
 * Covers the end-to-end lifecycle of Task Agent sessions:
 *   1. Session creation — context association, model resolution, MCP attachment
 *   2. Sub-session spawning — worktree forwarding, member info, NodeExecution update
 *   3. Session cleanup — worktree removal, completion callback cleanup, listener teardown
 *   4. Session association with task — taskAgentSessionId persistence, status promotion
 *   5. Cancellation — cancelBySessionId, handleSubSessionError
 *   6. ensureTaskAgentSession — open→in_progress promotion, kickoff:false option
 *
 * Strategy: AgentSession.fromInit() is spied upon to return controllable mock
 * sessions. Real SQLite DB is used for space/task repositories. DaemonHub is
 * implemented as a minimal in-process event bus.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../src/lib/agent/agent-session.ts';
import type { Space, SpaceTask, AgentProcessingState } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Minimal in-process DaemonHub for tests
// ---------------------------------------------------------------------------

type EventHandler = (data: Record<string, unknown>) => void;

class TestDaemonHub {
	private listeners = new Map<string, Map<string, EventHandler>>();
	readonly emitted: Array<{ event: string; data: Record<string, unknown> }> = [];

	on(event: string, handler: EventHandler, opts?: { sessionId?: string }): () => void {
		const key = opts?.sessionId ? `${event}:${opts.sessionId}` : `${event}:*`;
		if (!this.listeners.has(key)) {
			this.listeners.set(key, new Map());
		}
		const id = Math.random().toString(36).slice(2);
		this.listeners.get(key)!.set(id, handler);
		return () => {
			this.listeners.get(key)?.delete(id);
		};
	}

	emit(event: string, data: Record<string, unknown>): Promise<void> {
		this.emitted.push({ event, data });
		const sessionId = (data as { sessionId?: string }).sessionId;
		if (sessionId) {
			const key = `${event}:${sessionId}`;
			for (const handler of this.listeners.get(key)?.values() ?? []) {
				handler(data);
			}
		}
		for (const handler of this.listeners.get(`${event}:*`)?.values() ?? []) {
			handler(data);
		}
		return Promise.resolve();
	}
}

// ---------------------------------------------------------------------------
// Mock AgentSession factory
// ---------------------------------------------------------------------------

interface MockAgentSession {
	session: { id: string; context?: Record<string, unknown> };
	getProcessingState: () => AgentProcessingState;
	getSDKMessageCount: () => number;
	getSessionData: () => { id: string; context?: Record<string, unknown> };
	setRuntimeMcpServers: (servers: Record<string, unknown>) => void;
	setRuntimeSystemPrompt: (systemPrompt: unknown) => void;
	startStreamingQuery: () => Promise<void>;
	ensureQueryStarted: () => Promise<void>;
	handleInterrupt: () => Promise<void>;
	cleanup: () => Promise<void>;
	messageQueue: { enqueueWithId: (id: string, msg: string) => Promise<void> };
	_processingState: AgentProcessingState;
	_sdkMessageCount: number;
	_startCalled: boolean;
	_cleanupCalled: boolean;
	_mcpServers: Record<string, unknown>;
	_enqueuedMessages: Array<{ id: string; msg: string }>;
}

function makeMockSession(
	sessionId: string,
	contextOverrides?: Record<string, unknown>
): MockAgentSession {
	const mock: MockAgentSession = {
		session: { id: sessionId, context: contextOverrides ?? {} },
		_processingState: { status: 'idle' } as AgentProcessingState,
		_sdkMessageCount: 0,
		_startCalled: false,
		_cleanupCalled: false,
		_mcpServers: {},
		_enqueuedMessages: [],

		getProcessingState() {
			return this._processingState;
		},
		getSDKMessageCount() {
			return this._sdkMessageCount;
		},
		getSessionData() {
			return this.session;
		},
		setRuntimeMcpServers(servers) {
			this._mcpServers = servers;
		},
		setRuntimeSystemPrompt(_systemPrompt: unknown) {},
		async startStreamingQuery() {
			this._startCalled = true;
		},
		async ensureQueryStarted() {
			this._startCalled = true;
		},
		async handleInterrupt() {},
		async cleanup() {
			this._cleanupCalled = true;
		},
		messageQueue: {
			async enqueueWithId(id: string, msg: string) {
				mock._enqueuedMessages.push({ id, msg });
			},
		},
	};
	return mock;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-task-agent-lifecycle',
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

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

function makeSpace(spaceId: string, workspacePath = '/tmp/workspace'): Space {
	return {
		id: spaceId,
		slug: `space-${spaceId}`,
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

async function makeTask(
	taskManager: SpaceTaskManager,
	overrides?: Partial<SpaceTask>
): Promise<SpaceTask> {
	return taskManager.createTask({
		title: 'Test task',
		description: 'A test task',
		taskType: 'coding',
		status: 'open',
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Build test context
// ---------------------------------------------------------------------------

interface TestCtx {
	bunDb: BunDatabase;
	dir: string;
	spaceId: string;
	space: Space;
	agentId: string;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	taskManager: SpaceTaskManager;
	agentManager: SpaceAgentManager;
	workflowManager: SpaceWorkflowManager;
	spaceManager: SpaceManager;
	runtime: SpaceRuntime;
	daemonHub: TestDaemonHub;
	sessionManagerDeleteCalls: string[];
	mockDb: {
		getSession: (id: string) => unknown;
		createSession: (session: unknown) => void;
		deleteSession: (id: string) => void;
		saveUserMessage: (_sessionId: string, _msg: unknown, _status: string) => string;
		updateSession: () => void;
		getDatabase: () => BunDatabase;
	};
	manager: TaskAgentManager;
	createdSessions: Map<string, MockAgentSession>;
	fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;
}

function makeCtx(): TestCtx {
	const { db: bunDb, dir } = makeDb();
	const spaceId = 'space-tal-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(bunDb, spaceId, workspacePath);

	const agentId = 'agent-coder-tal';
	seedAgentRow(bunDb, agentId, spaceId);

	const agentRepo = new SpaceAgentRepository(bunDb);
	const agentManager = new SpaceAgentManager(agentRepo);
	const workflowRepo = new SpaceWorkflowRepository(bunDb);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);
	const workflowRunRepo = new SpaceWorkflowRunRepository(bunDb);
	const taskRepo = new SpaceTaskRepository(bunDb);
	const nodeExecutionRepo = new NodeExecutionRepository(bunDb);
	const spaceManager = new SpaceManager(bunDb);
	const taskManager = new SpaceTaskManager(bunDb, spaceId);
	const runtime = new SpaceRuntime({
		db: bunDb,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
		nodeExecutionRepo,
	});
	const daemonHub = new TestDaemonHub();
	const space = makeSpace(spaceId, workspacePath);

	const createdSessions = new Map<string, MockAgentSession>();
	const sessionManagerDeleteCalls: string[] = [];

	const dbSessions = new Map<string, unknown>();

	const mockDb = {
		getSession: (id: string) => (dbSessions.has(id) ? dbSessions.get(id) : null),
		createSession: (session: unknown) => {
			dbSessions.set((session as { id: string }).id, session);
		},
		deleteSession: (id: string) => {
			dbSessions.delete(id);
		},
		saveUserMessage: (_sessionId: string, _msg: unknown, _status: string) => 'msg-id',
		updateSession: () => {},
		getDatabase: () => bunDb,
	};

	const mockSpaceRuntimeService = {
		createOrGetRuntime: async (_spaceId: string) => runtime,
	};

	const mockSessionManager = {
		deleteSession: async (sessionId: string) => {
			sessionManagerDeleteCalls.push(sessionId);
		},
		registerSession: (_agentSession: unknown) => {},
		getSessionFromDB: (sessionId: string) => {
			const row = mockDb.getSession(sessionId);
			return row ? ({ id: sessionId } as { id: string }) : null;
		},
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
			const initTyped = init as { sessionId: string; context?: Record<string, unknown> };
			const mockSession = makeMockSession(initTyped.sessionId, initTyped.context);
			createdSessions.set(initTyped.sessionId, mockSession);
			mockDb.createSession({ id: initTyped.sessionId });
			return mockSession as unknown as AgentSession;
		}
	);

	const manager = new TaskAgentManager({
		db: mockDb as unknown as import('../../../src/storage/database.ts').Database,
		sessionManager:
			mockSessionManager as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		spaceRuntimeService:
			mockSpaceRuntimeService as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
		taskRepo,
		workflowRunRepo,
		daemonHub: daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
		messageHub: {} as unknown as import('@neokai/shared').MessageHub,
		getApiKey: async () => 'test-key',
		defaultModel: 'claude-sonnet-4-5-20250929',
		nodeExecutionRepo,
		gateDataRepo: {
			getFields: () => [],
			getData: () => ({}),
			setData: () => {},
		} as unknown as import('../../../src/storage/repositories/gate-data-repository.ts').GateDataRepository,
		channelCycleRepo: {
			getCycle: () => null,
			incrementCycle: () => {},
		} as unknown as import('../../../src/storage/repositories/channel-cycle-repository.ts').ChannelCycleRepository,
		skillsManager: {
			getEnabledSkills: () => [],
		} as unknown as import('../../../src/lib/skills-manager.ts').SkillsManager,
		appMcpServerRepo: {
			getById: () => null,
		} as unknown as import('../../../src/storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
	});

	return {
		bunDb,
		dir,
		spaceId,
		space,
		agentId,
		taskRepo,
		workflowRunRepo,
		nodeExecutionRepo,
		taskManager,
		agentManager,
		workflowManager,
		spaceManager,
		runtime,
		daemonHub,
		sessionManagerDeleteCalls,
		mockDb,
		manager,
		createdSessions,
		fromInitSpy,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task Agent Session Lifecycle', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.fromInitSpy.mockRestore();
		try {
			rmSync(ctx.dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	// =======================================================================
	// 1. Session creation — context association
	// =======================================================================

	describe('session creation — context association with task', () => {
		test('session context includes spaceId and taskId after spawn', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const session = ctx.createdSessions.get(sessionId)!;
			expect(session.session.context?.spaceId).toBe(ctx.spaceId);
			expect(session.session.context?.taskId).toBe(task.id);
		});

		test('session ID follows convention: space:${spaceId}:task:${taskId}', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(sessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
		});

		test('taskAgentSessionId is persisted on the SpaceTask after spawn', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const updatedTask = ctx.taskRepo.getTask(task.id);
			expect(updatedTask?.taskAgentSessionId).toBe(sessionId);
		});

		test('session is registered in SessionManager cache', async () => {
			const registerCalls: string[] = [];
			const origFromInit = ctx.fromInitSpy;

			// Re-create with a mock that captures registerSession calls
			const mockSessionManager = {
				deleteSession: async (sessionId: string) => {
					ctx.sessionManagerDeleteCalls.push(sessionId);
				},
				registerSession: (agentSession: unknown) => {
					const session = agentSession as { session: { id: string } };
					registerCalls.push(session.session.id);
				},
				getSessionFromDB: (sessionId: string) => {
					const row = ctx.mockDb.getSession(sessionId);
					return row ? ({ id: sessionId } as { id: string }) : null;
				},
			};

			// Create a new manager with the mock session manager
			const manager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../src/storage/database.ts').Database,
				sessionManager:
					mockSessionManager as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService: {
					createOrGetRuntime: async () => ctx.runtime,
				} as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub: ctx.daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				nodeExecutionRepo: new NodeExecutionRepository(ctx.bunDb),
				gateDataRepo:
					{} as unknown as import('../../../src/storage/repositories/gate-data-repository.ts').GateDataRepository,
				channelCycleRepo:
					{} as unknown as import('../../../src/storage/repositories/channel-cycle-repository.ts').ChannelCycleRepository,
				skillsManager: {} as unknown as import('../../../src/lib/skills-manager.ts').SkillsManager,
				appMcpServerRepo:
					{} as unknown as import('../../../src/storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
			});

			const task = await makeTask(ctx.taskManager);
			const sessionId = await manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(registerCalls).toContain(sessionId);
		});

		test('streaming query is started after session creation', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const session = ctx.createdSessions.get(sessionId)!;
			expect(session._startCalled).toBe(true);
		});
	});

	// =======================================================================
	// 2. Sub-session spawning — worktree forwarding
	// =======================================================================

	describe('sub-session spawning — worktree path forwarding', () => {
		test('sub-session inherits task worktree path when worktreeManager is configured', async () => {
			// Create a manager with a worktreeManager
			const createdWorktrees = new Map<string, string>();
			const mockWorktreeManager = {
				createTaskWorktree: async (spaceId: string, taskId: string) => {
					const path = `/worktrees/${spaceId}/${taskId}`;
					createdWorktrees.set(taskId, path);
					return { path, slug: `task-${taskId}` };
				},
				removeTaskWorktree: async () => {},
				markTaskWorktreeCompleted: () => {},
			};

			const manager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../src/storage/database.ts').Database,
				sessionManager: {
					deleteSession: async () => {},
					registerSession: () => {},
					getSessionFromDB: () => null,
				} as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService: {
					createOrGetRuntime: async () => ctx.runtime,
				} as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub: ctx.daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				worktreeManager:
					mockWorktreeManager as unknown as import('../../../src/lib/space/managers/space-worktree-manager.ts').SpaceWorktreeManager,
				nodeExecutionRepo: new NodeExecutionRepository(ctx.bunDb),
				gateDataRepo:
					{} as unknown as import('../../../src/storage/repositories/gate-data-repository.ts').GateDataRepository,
				channelCycleRepo:
					{} as unknown as import('../../../src/storage/repositories/channel-cycle-repository.ts').ChannelCycleRepository,
				skillsManager: {} as unknown as import('../../../src/lib/skills-manager.ts').SkillsManager,
				appMcpServerRepo:
					{} as unknown as import('../../../src/storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
			});

			const task = await makeTask(ctx.taskManager);
			await manager.spawnTaskAgent(task, ctx.space, null, null);

			// Worktree should have been created
			expect(createdWorktrees.has(task.id)).toBe(true);
			const worktreePath = createdWorktrees.get(task.id)!;
			expect(manager.getTaskWorktreePath(task.id)).toBe(worktreePath);
		});

		test('getTaskWorktreePath returns undefined when no worktreeManager configured', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.manager.getTaskWorktreePath(task.id)).toBeUndefined();
		});

		test('sub-session stored in subSessions map after creation', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-map`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			expect(ctx.manager.getSubSession(subSessionId)).toBeDefined();
		});

		test('sub-session registered in SessionManager cache', async () => {
			const registerCalls: string[] = [];
			const mockSessionManager = {
				deleteSession: async () => {},
				registerSession: (agentSession: unknown) => {
					const session = agentSession as { session: { id: string } };
					registerCalls.push(session.session.id);
				},
				getSessionFromDB: () => null,
			};

			const manager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../src/storage/database.ts').Database,
				sessionManager:
					mockSessionManager as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService: {
					createOrGetRuntime: async () => ctx.runtime,
				} as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub: ctx.daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				nodeExecutionRepo: new NodeExecutionRepository(ctx.bunDb),
				gateDataRepo:
					{} as unknown as import('../../../src/storage/repositories/gate-data-repository.ts').GateDataRepository,
				channelCycleRepo:
					{} as unknown as import('../../../src/storage/repositories/channel-cycle-repository.ts').ChannelCycleRepository,
				skillsManager: {} as unknown as import('../../../src/lib/skills-manager.ts').SkillsManager,
				appMcpServerRepo:
					{} as unknown as import('../../../src/storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
			});

			const task = await makeTask(ctx.taskManager);
			await manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-reg`;
			await manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			expect(registerCalls).toContain(subSessionId);
		});

		test('multiple sub-sessions for same task are stored independently', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subId1 = `space:${ctx.spaceId}:task:${task.id}:step:step-a`;
			const subId2 = `space:${ctx.spaceId}:task:${task.id}:step:step-b`;

			await ctx.manager.createSubSession(task.id, subId1, {
				sessionId: subId1,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			await ctx.manager.createSubSession(task.id, subId2, {
				sessionId: subId2,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			expect(ctx.manager.getSubSession(subId1)).toBeDefined();
			expect(ctx.manager.getSubSession(subId2)).toBeDefined();
			expect(ctx.manager.getSubSession(subId1)).not.toBe(ctx.manager.getSubSession(subId2));
		});
	});

	// =======================================================================
	// 3. Session cleanup on task completion
	// =======================================================================

	describe('session cleanup on task completion', () => {
		test('cleanup removes task worktree path from map', async () => {
			const removedWorktrees: string[] = [];
			const mockWorktreeManager = {
				createTaskWorktree: async (spaceId: string, taskId: string) => ({
					path: `/worktrees/${spaceId}/${taskId}`,
					slug: `task-${taskId}`,
				}),
				removeTaskWorktree: async (spaceId: string, taskId: string) => {
					removedWorktrees.push(`${spaceId}:${taskId}`);
				},
				markTaskWorktreeCompleted: (spaceId: string, taskId: string) => {
					// no-op
					void spaceId;
					void taskId;
				},
			};

			const manager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../src/storage/database.ts').Database,
				sessionManager: {
					deleteSession: async () => {},
					registerSession: () => {},
					getSessionFromDB: () => null,
				} as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService: {
					createOrGetRuntime: async () => ctx.runtime,
				} as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub: ctx.daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				worktreeManager:
					mockWorktreeManager as unknown as import('../../../src/lib/space/managers/space-worktree-manager.ts').SpaceWorktreeManager,
				nodeExecutionRepo: new NodeExecutionRepository(ctx.bunDb),
				gateDataRepo:
					{} as unknown as import('../../../src/storage/repositories/gate-data-repository.ts').GateDataRepository,
				channelCycleRepo:
					{} as unknown as import('../../../src/storage/repositories/channel-cycle-repository.ts').ChannelCycleRepository,
				skillsManager: {} as unknown as import('../../../src/lib/skills-manager.ts').SkillsManager,
				appMcpServerRepo:
					{} as unknown as import('../../../src/storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
			});

			const task = await makeTask(ctx.taskManager);
			await manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(manager.getTaskWorktreePath(task.id)).toBeDefined();

			await manager.cleanup(task.id, 'done');

			// Worktree path should be removed from map
			expect(manager.getTaskWorktreePath(task.id)).toBeUndefined();
		});

		test('cleanup with reason cancelled removes worktree', async () => {
			const removedWorktrees: string[] = [];
			const mockWorktreeManager = {
				createTaskWorktree: async (spaceId: string, taskId: string) => ({
					path: `/worktrees/${spaceId}/${taskId}`,
					slug: `task-${taskId}`,
				}),
				removeTaskWorktree: async (spaceId: string, taskId: string) => {
					removedWorktrees.push(`${spaceId}:${taskId}`);
				},
				markTaskWorktreeCompleted: () => {},
			};

			const manager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../src/storage/database.ts').Database,
				sessionManager: {
					deleteSession: async () => {},
					registerSession: () => {},
					getSessionFromDB: () => null,
				} as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService: {
					createOrGetRuntime: async () => ctx.runtime,
				} as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub: ctx.daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				worktreeManager:
					mockWorktreeManager as unknown as import('../../../src/lib/space/managers/space-worktree-manager.ts').SpaceWorktreeManager,
				nodeExecutionRepo: new NodeExecutionRepository(ctx.bunDb),
				gateDataRepo:
					{} as unknown as import('../../../src/storage/repositories/gate-data-repository.ts').GateDataRepository,
				channelCycleRepo:
					{} as unknown as import('../../../src/storage/repositories/channel-cycle-repository.ts').ChannelCycleRepository,
				skillsManager: {} as unknown as import('../../../src/lib/skills-manager.ts').SkillsManager,
				appMcpServerRepo:
					{} as unknown as import('../../../src/storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
			});

			const task = await makeTask(ctx.taskManager);
			await manager.spawnTaskAgent(task, ctx.space, null, null);
			await manager.cleanup(task.id, 'cancelled');

			expect(removedWorktrees).toContain(`${ctx.spaceId}:${task.id}`);
		});

		test('cleanup with reason done calls markTaskWorktreeCompleted', async () => {
			const completedWorktrees: string[] = [];
			const mockWorktreeManager = {
				createTaskWorktree: async (spaceId: string, taskId: string) => ({
					path: `/worktrees/${spaceId}/${taskId}`,
					slug: `task-${taskId}`,
				}),
				removeTaskWorktree: async () => {},
				markTaskWorktreeCompleted: (spaceId: string, taskId: string) => {
					completedWorktrees.push(`${spaceId}:${taskId}`);
				},
			};

			const manager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../src/storage/database.ts').Database,
				sessionManager: {
					deleteSession: async () => {},
					registerSession: () => {},
					getSessionFromDB: () => null,
				} as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService: {
					createOrGetRuntime: async () => ctx.runtime,
				} as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub: ctx.daemonHub as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				worktreeManager:
					mockWorktreeManager as unknown as import('../../../src/lib/space/managers/space-worktree-manager.ts').SpaceWorktreeManager,
				nodeExecutionRepo: new NodeExecutionRepository(ctx.bunDb),
				gateDataRepo:
					{} as unknown as import('../../../src/storage/repositories/gate-data-repository.ts').GateDataRepository,
				channelCycleRepo:
					{} as unknown as import('../../../src/storage/repositories/channel-cycle-repository.ts').ChannelCycleRepository,
				skillsManager: {} as unknown as import('../../../src/lib/skills-manager.ts').SkillsManager,
				appMcpServerRepo:
					{} as unknown as import('../../../src/storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
			});

			const task = await makeTask(ctx.taskManager);
			await manager.spawnTaskAgent(task, ctx.space, null, null);
			await manager.cleanup(task.id, 'done');

			expect(completedWorktrees).toContain(`${ctx.spaceId}:${task.id}`);
		});

		test('cleanup clears completion callbacks for sub-sessions', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:cb-cleanup`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			// Register a completion callback
			const factory = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(task.id);
			factory.onComplete(subSessionId, async () => {});

			// Emit an idle event before cleanup — callback should fire
			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 1;
			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});
			await new Promise((r) => setTimeout(r, 0));

			// Now create another sub-session and register callback, then cleanup
			const subSessionId2 = `space:${ctx.spaceId}:task:${task.id}:step:cb-cleanup-2`;
			await ctx.manager.createSubSession(task.id, subSessionId2, {
				sessionId: subSessionId2,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);
			factory.onComplete(subSessionId2, async () => {});

			await ctx.manager.cleanup(task.id);

			// After cleanup, the sub-session should be gone
			expect(ctx.manager.getSubSession(subSessionId2)).toBeUndefined();
		});

		test('cleanup deletes both task agent and sub-session DB records', async () => {
			const task = await makeTask(ctx.taskManager);
			const taskSessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:db-cleanup`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			await ctx.manager.cleanup(task.id);

			expect(ctx.sessionManagerDeleteCalls).toContain(taskSessionId);
			expect(ctx.sessionManagerDeleteCalls).toContain(subSessionId);
		});
	});

	// =======================================================================
	// 4. Session association with task — status promotion
	// =======================================================================

	describe('ensureTaskAgentSession — status promotion', () => {
		test('promotes open task to in_progress when session is created', async () => {
			const task = await makeTask(ctx.taskManager, { status: 'open' });
			const ensured = await ctx.manager.ensureTaskAgentSession(task.id);

			expect(ensured.status).toBe('in_progress');
		});

		test('does not change status of already in_progress task', async () => {
			const task = await makeTask(ctx.taskManager, { status: 'in_progress' });
			const ensured = await ctx.manager.ensureTaskAgentSession(task.id);

			expect(ensured.status).toBe('in_progress');
		});

		test('throws for non-existent task', async () => {
			await expect(ctx.manager.ensureTaskAgentSession('ghost-task')).rejects.toThrow(
				'Task not found'
			);
		});

		test('returns refreshed task with taskAgentSessionId set', async () => {
			const task = await makeTask(ctx.taskManager);
			const ensured = await ctx.manager.ensureTaskAgentSession(task.id);

			expect(ensured.taskAgentSessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
		});
	});

	// =======================================================================
	// 5. Cancellation — cancelBySessionId
	// =======================================================================

	describe('cancelBySessionId', () => {
		test('cancels a sub-session by its agent session ID', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:cancel-step`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			const subSession = ctx.createdSessions.get(subSessionId)!;
			expect(subSession._cleanupCalled).toBe(false);

			// cancelBySessionId is synchronous but internally calls stopAndDeleteSession asynchronously
			ctx.manager.cancelBySessionId(subSessionId);

			// Wait for async cleanup to complete
			await new Promise((r) => setTimeout(r, 50));

			expect(subSession._cleanupCalled).toBe(true);
			expect(ctx.sessionManagerDeleteCalls).toContain(subSessionId);
		});

		test('is a no-op for non-existent session ID', () => {
			// Should not throw
			expect(() => ctx.manager.cancelBySessionId('non-existent-session')).not.toThrow();
		});

		test('prevents double-cancel of same session', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:double-cancel`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			// Call cancelBySessionId twice — second should be a no-op
			ctx.manager.cancelBySessionId(subSessionId);
			ctx.manager.cancelBySessionId(subSessionId);

			await new Promise((r) => setTimeout(r, 50));

			// Session should only be deleted once (deleteSession called once)
			const deleteCount = ctx.sessionManagerDeleteCalls.filter((id) => id === subSessionId).length;
			expect(deleteCount).toBe(1);
		});
	});

	// =======================================================================
	// 6. Error handling — handleSubSessionError
	// =======================================================================

	describe('handleSubSessionError', () => {
		function callHandleSubSessionError(
			manager: TaskAgentManager,
			subSessionId: string,
			error: string
		): Promise<void> {
			return (
				manager as unknown as {
					handleSubSessionError: (subSessionId: string, error: string) => Promise<void>;
				}
			).handleSubSessionError(subSessionId, error);
		}

		test('injects [STEP_FAILED] notification into Task Agent session', async () => {
			const task = await makeTask(ctx.taskManager);
			const taskSessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const taskAgentSession = ctx.createdSessions.get(taskSessionId)!;
			const msgsBefore = taskAgentSession._enqueuedMessages.length;

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:error-step`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			await callHandleSubSessionError(ctx.manager, subSessionId, 'Agent crashed: OOM');

			expect(taskAgentSession._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
			const lastMsg =
				taskAgentSession._enqueuedMessages[taskAgentSession._enqueuedMessages.length - 1];
			expect(lastMsg.msg).toContain('[STEP_FAILED]');
			expect(lastMsg.msg).toContain('Agent crashed: OOM');
		});

		test('does not throw for unknown sub-session ID', async () => {
			// Should not throw even if the sub-session doesn't exist
			await expect(
				callHandleSubSessionError(ctx.manager, 'unknown-session-id', 'some error')
			).resolves.toBeUndefined();
		});

		test('marks step task as blocked when session error occurs', async () => {
			// Seed a workflow run
			const wfRunId = 'wf-run-error-test';
			const wfId = 'wf-id-error-test';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
	           VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'Error Test WF', now, now);
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
	           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			const parentTask = await ctx.taskManager.createTask({
				title: 'Parent task',
				description: 'Orchestrator',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
			});

			await ctx.manager.spawnTaskAgent(
				{ ...parentTask, workflowRunId: wfRunId },
				ctx.space,
				null,
				null
			);

			const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:step:error-step-2`;
			const stepTask = await ctx.taskManager.createTask({
				title: 'Error step task',
				description: 'A step that will error',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
				taskAgentSessionId: subSessionId,
			});

			await ctx.manager.createSubSession(parentTask.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			const nodeExecution = ctx.nodeExecutionRepo.create({
				workflowRunId: wfRunId,
				workflowNodeId: 'error-step-2',
				agentName: 'coder',
				agentSessionId: subSessionId,
				status: 'in_progress',
			});
			ctx.nodeExecutionRepo.update(nodeExecution.id, {
				agentSessionId: subSessionId,
				status: 'in_progress',
			});

			await callHandleSubSessionError(ctx.manager, subSessionId, 'Crashed');

			// Sub-session errors now mark node_execution as blocked (space_tasks are not mutated here).
			const updatedExecution = ctx.nodeExecutionRepo.getById(nodeExecution.id);
			expect(updatedExecution?.status).toBe('blocked');
			expect(updatedExecution?.result).toBe('Crashed');

			void stepTask;
		});
	});

	// =======================================================================
	// 7. kickoff option
	// =======================================================================

	describe('spawnTaskAgent — kickoff option', () => {
		test('kickoff:true injects initial message (default)', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null, {
				kickoff: true,
			});

			const session = ctx.createdSessions.get(sessionId)!;
			// With kickoff, at least one message should be enqueued (the initial context message)
			expect(session._enqueuedMessages.length).toBeGreaterThan(0);
		});

		test('kickoff:false does not inject initial message', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null, {
				kickoff: false,
			});

			const session = ctx.createdSessions.get(sessionId)!;
			// With kickoff:false, no initial message is injected
			expect(session._enqueuedMessages.length).toBe(0);
		});

		test('default kickoff is true', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const session = ctx.createdSessions.get(sessionId)!;
			expect(session._enqueuedMessages.length).toBeGreaterThan(0);
		});
	});

	// =======================================================================
	// 8. ensureTaskAgentSession — does not auto-attach workflows
	// =======================================================================

	describe('ensureTaskAgentSession — no workflow auto-attach', () => {
		test('keeps standalone task detached when no workflows exist', async () => {
			const task = await makeTask(ctx.taskManager, {
				title: 'Fix login bug',
				description: 'Fix the authentication bug',
			});
			const result = await ctx.manager.ensureTaskAgentSession(task.id);

			expect(result.workflowRunId).toBeUndefined();
		});

		test('keeps standalone task detached even when workflows exist', async () => {
			ctx.workflowManager.createWorkflow({
				spaceId: ctx.spaceId,
				name: 'Coding Workflow',
				description: 'A coding workflow',
				nodes: [
					{
						id: 'step-code',
						name: 'Code',
						agentId: ctx.agentId,
					},
				],
				startNodeId: 'step-code',
			});

			const task = await makeTask(ctx.taskManager, {
				title: 'Fix bug',
				description: 'Fix something',
			});
			const result = await ctx.manager.ensureTaskAgentSession(task.id);

			expect(result.workflowRunId).toBeUndefined();
		});
	});

	// =======================================================================
	// 9. Full lifecycle — spawn → sub-session → completion → cleanup
	// =======================================================================

	describe('full lifecycle: spawn → sub-session → completion → cleanup', () => {
		test('end-to-end: task agent session, sub-session, completion callback, and cleanup', async () => {
			// Step 1: Spawn task agent
			const task = await makeTask(ctx.taskManager);
			const taskSessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.manager.isTaskAgentAlive(task.id)).toBe(true);
			expect(ctx.taskRepo.getTask(task.id)?.taskAgentSessionId).toBe(taskSessionId);

			// Step 2: Create sub-session
			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:lifecycle-step`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			expect(ctx.manager.getSubSession(subSessionId)).toBeDefined();

			// Step 3: Simulate sub-session completion via DaemonHub event
			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 3;

			const factory = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(task.id);

			let completionFired = false;
			factory.onComplete(subSessionId, async () => {
				completionFired = true;
			});

			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});
			await new Promise((r) => setTimeout(r, 0));

			expect(completionFired).toBe(true);

			// Step 4: Cleanup
			await ctx.manager.cleanup(task.id);

			expect(ctx.manager.isTaskAgentAlive(task.id)).toBe(false);
			expect(ctx.manager.getTaskAgent(task.id)).toBeUndefined();
			expect(ctx.manager.getSubSession(subSessionId)).toBeUndefined();
			expect(ctx.sessionManagerDeleteCalls).toContain(taskSessionId);
			expect(ctx.sessionManagerDeleteCalls).toContain(subSessionId);
		});

		test('end-to-end: sub-session completion triggers [STEP_COMPLETE] notification with workflow run', async () => {
			// Seed a workflow run so handleSubSessionComplete can find the step task
			const wfRunId = 'wf-run-e2e-complete';
			const wfId = 'wf-id-e2e-complete';
			const stepId = 'step-e2e-complete';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
	           VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'E2E Complete WF', now, now);
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
	           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			// Create parent task with workflowRunId
			const parentTask = await makeTask(ctx.taskManager, {
				title: 'Parent task',
				status: 'in_progress',
				workflowRunId: wfRunId,
			});
			const taskSessionId = await ctx.manager.spawnTaskAgent(
				{ ...parentTask, workflowRunId: wfRunId },
				ctx.space,
				null,
				null
			);

			// Create step task with matching subSessionId
			const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:step:${stepId}`;
			const stepTask = await makeTask(ctx.taskManager, {
				title: 'Step task',
				status: 'in_progress',
				workflowRunId: wfRunId,
				taskAgentSessionId: subSessionId,
			});

			await ctx.manager.createSubSession(parentTask.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			// Directly call handleSubSessionComplete (normally triggered via MCP tool handler callback)
			await (
				ctx.manager as unknown as {
					handleSubSessionComplete: (
						taskId: string,
						stepId: string,
						subSessionId: string
					) => Promise<void>;
				}
			).handleSubSessionComplete(parentTask.id, stepId, subSessionId);

			// Step completion notifications are session-context only; step task status is runtime-driven.
			expect(ctx.taskRepo.getTask(stepTask.id)?.status).toBe('in_progress');

			// Task agent should receive [STEP_COMPLETE] notification
			const taskAgentSession = ctx.createdSessions.get(taskSessionId)!;
			const hasStepComplete = taskAgentSession._enqueuedMessages.some((m) =>
				m.msg.includes('[STEP_COMPLETE]')
			);
			expect(hasStepComplete).toBe(true);

			void stepTask;
		});
	});
});
