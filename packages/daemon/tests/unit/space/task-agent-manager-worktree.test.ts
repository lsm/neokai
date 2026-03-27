/**
 * Unit tests for TaskAgentManager × SpaceWorktreeManager integration (M4.3)
 *
 * Covers:
 *   - Worktree created at spawnTaskAgent() time
 *   - Worktree path stored in workflow run config
 *   - Sub-sessions (node agents) reuse the same worktree path
 *   - Completion marks worktree as completed (TTL path)
 *   - Cancellation removes worktree immediately
 *   - Rehydration restores worktree path from run config
 *   - cleanupOrphaned wires through SpaceWorktreeManager
 *   - TTL reaper removes expired worktrees
 *
 * Strategy: SpaceWorktreeManager is replaced with a controllable mock that
 * records calls and returns predictable paths.  Real SQLite DB is used for
 * space/task/workflow-run repositories. AgentSession.fromInit is spied on.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
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
import type { Space, SpaceWorkflow, SpaceWorkflowRun, SpaceTask } from '@neokai/shared';
import type { AgentProcessingState } from '@neokai/shared';
import type { SpaceWorktreeManager } from '../../../src/lib/space/managers/space-worktree-manager.ts';

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
	_workspacePath?: string;
}

function makeMockSession(
	sessionId: string,
	contextOverrides?: Record<string, unknown>
): MockAgentSession {
	const m: MockAgentSession = {
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
				m._enqueuedMessages.push({ id, msg });
			},
		},
	};
	return m;
}

// ---------------------------------------------------------------------------
// Mock SpaceWorktreeManager
// ---------------------------------------------------------------------------

interface MockWorktreeManager {
	createCalls: Array<{ spaceId: string; taskId: string; taskTitle: string; taskNumber: number }>;
	removeCalls: Array<{ spaceId: string; taskId: string }>;
	completedCalls: Array<{ spaceId: string; taskId: string }>;
	orphanedCleanupCalls: string[];
	reapCalls: number;
	/** Path returned by createTaskWorktree */
	worktreePath: string;
	/** If set, createTaskWorktree throws this error */
	createError?: Error;

	createTaskWorktree(
		spaceId: string,
		taskId: string,
		taskTitle: string,
		taskNumber: number
	): Promise<{ path: string; slug: string }>;
	removeTaskWorktree(spaceId: string, taskId: string): Promise<void>;
	markTaskWorktreeCompleted(spaceId: string, taskId: string): void;
	cleanupOrphaned(spaceId: string): Promise<void>;
	reapExpiredWorktrees(ttlMs?: number): Promise<void>;
	getTaskWorktreePath(spaceId: string, taskId: string): Promise<string | null>;
	listWorktrees(spaceId: string): Promise<[]>;
}

function makeMockWorktreeManager(worktreePath = '/tmp/worktrees/test-task'): MockWorktreeManager {
	const m: MockWorktreeManager = {
		createCalls: [],
		removeCalls: [],
		completedCalls: [],
		orphanedCleanupCalls: [],
		reapCalls: 0,
		worktreePath,

		async createTaskWorktree(spaceId, taskId, taskTitle, taskNumber) {
			m.createCalls.push({ spaceId, taskId, taskTitle, taskNumber });
			if (m.createError) throw m.createError;
			return { path: m.worktreePath, slug: 'test-slug' };
		},
		async removeTaskWorktree(spaceId, taskId) {
			m.removeCalls.push({ spaceId, taskId });
		},
		markTaskWorktreeCompleted(spaceId, taskId) {
			m.completedCalls.push({ spaceId, taskId });
		},
		async cleanupOrphaned(spaceId) {
			m.orphanedCleanupCalls.push(spaceId);
		},
		async reapExpiredWorktrees(_ttlMs) {
			m.reapCalls++;
		},
		async getTaskWorktreePath(_spaceId, _taskId) {
			return m.worktreePath;
		},
		async listWorktrees(_spaceId) {
			return [];
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
		'test-tam-worktree',
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
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, 'coder', Date.now(), Date.now());
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

async function makeTask(taskManager: SpaceTaskManager): Promise<SpaceTask> {
	return taskManager.createTask({
		title: 'Test task',
		description: 'A test task',
		taskType: 'coding',
		status: 'pending',
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
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	workflowRepo: SpaceWorkflowRepository;
	taskManager: SpaceTaskManager;
	manager: TaskAgentManager;
	worktreeMock: MockWorktreeManager;
	createdSessions: Map<string, MockAgentSession>;
	fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;
	sessionManagerDeleteCalls: string[];
	/** Adds a fake session record to the in-memory DB mock so getSession() returns it */
	addDbSession: (id: string, type: string) => void;
}

function makeCtx(worktreePath = '/tmp/worktrees/test-task'): TestCtx {
	const { db: bunDb, dir } = makeDb();
	const spaceId = 'space-wt-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(bunDb, spaceId, workspacePath);

	const agentId = 'agent-coder-wt';
	seedAgentRow(bunDb, agentId, spaceId);

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
			const initTyped = init as {
				sessionId: string;
				context?: Record<string, unknown>;
				workspacePath?: string;
			};
			const mockSession = makeMockSession(initTyped.sessionId, initTyped.context);
			// Store the workspacePath so tests can assert it was set correctly
			mockSession._workspacePath = initTyped.workspacePath;
			createdSessions.set(initTyped.sessionId, mockSession);
			mockDb.createSession({ id: initTyped.sessionId });
			return mockSession as unknown as AgentSession;
		}
	);

	const worktreeMock = makeMockWorktreeManager(worktreePath);

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
		worktreeManager: worktreeMock as unknown as SpaceWorktreeManager,
	});

	return {
		bunDb,
		dir,
		spaceId,
		space,
		taskRepo,
		workflowRunRepo,
		workflowRepo,
		taskManager,
		manager,
		worktreeMock,
		createdSessions,
		fromInitSpy,
		sessionManagerDeleteCalls,
		addDbSession: (id: string, type: string) => {
			mockDb.createSession({ id, type });
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskAgentManager × SpaceWorktreeManager (M4.3)', () => {
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

	// -------------------------------------------------------------------------
	// Worktree creation at run start
	// -------------------------------------------------------------------------

	describe('worktree creation', () => {
		test('createTaskWorktree is called when spawnTaskAgent is called', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.worktreeMock.createCalls).toHaveLength(1);
			expect(ctx.worktreeMock.createCalls[0].taskId).toBe(task.id);
			expect(ctx.worktreeMock.createCalls[0].spaceId).toBe(ctx.spaceId);
		});

		test('task agent session uses worktree path as workspacePath', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const session = ctx.createdSessions.get(sessionId)!;
			expect(session._workspacePath).toBe('/tmp/worktrees/test-task');
		});

		test('getTaskWorktreePath returns the path after spawn', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.manager.getTaskWorktreePath(task.id)).toBe('/tmp/worktrees/test-task');
		});

		test('worktree path stored in workflow run config', async () => {
			const task = await makeTask(ctx.taskManager);

			// Create a workflow run so we can check config
			const workflowRun = ctx.workflowRunRepo.createRun({
				spaceId: ctx.spaceId,
				workflowId: 'workflow-test',
				title: 'Test run',
			});

			// Link the task to the workflow run
			ctx.taskRepo.updateTask(task.id, { workflowRunId: workflowRun.id });
			const linkedTask = ctx.taskRepo.getTask(task.id)!;

			await ctx.manager.spawnTaskAgent(linkedTask, ctx.space, null, workflowRun);

			const updatedRun = ctx.workflowRunRepo.getRun(workflowRun.id)!;
			expect(updatedRun.config?.worktreePath).toBe('/tmp/worktrees/test-task');
		});

		test('falls back to space workspacePath when worktreeManager creation fails', async () => {
			ctx.worktreeMock.createError = new Error('git worktree add failed');
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			// Should still succeed (fallback)
			expect(sessionId).toBeTruthy();

			// workspacePath should be the original space.workspacePath
			const session = ctx.createdSessions.get(sessionId)!;
			expect(session._workspacePath).toBe('/tmp/test-workspace');

			// In-memory path map should be empty (no path was stored)
			expect(ctx.manager.getTaskWorktreePath(task.id)).toBeUndefined();
		});

		test('worktree creation is idempotent — second spawn returns existing session', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			// createTaskWorktree only called once (idempotency from task-agent perspective)
			expect(ctx.worktreeMock.createCalls).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Worktree reuse across sub-sessions (node agents)
	// -------------------------------------------------------------------------

	describe('worktree reuse across node agents', () => {
		test('SubSessionFactory.create overrides workspacePath with worktree path', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			// Access the private factory method via type cast so we can invoke it directly.
			// This exercises the path-override logic in createSubSessionFactory() without
			// needing a full MCP server stack.
			type ManagerPrivate = {
				createSubSessionFactory(id: string): { create(init: object): Promise<string> };
			};
			const factory = (ctx.manager as unknown as ManagerPrivate).createSubSessionFactory(task.id);

			const subSessionId = `sub-factory-test-${task.id}`;
			const initWithOriginalPath = {
				sessionId: subSessionId,
				workspacePath: '/original-path', // must be overridden to '/tmp/worktrees/test-task'
				messages: [],
				type: 'space_task_node_agent',
				context: {},
			};
			await factory.create(initWithOriginalPath);

			// AgentSession.fromInit was called by createSubSession with effectiveInit that has
			// the worktree path, not /original-path.
			const subSession = ctx.createdSessions.get(subSessionId)!;
			expect(subSession).toBeDefined();
			expect(subSession._workspacePath).toBe('/tmp/worktrees/test-task');
		});

		test('createSubSession without worktree path preserves original workspacePath', async () => {
			// When no worktree exists for a task, the factory must not override the path.
			const task = await makeTask(ctx.taskManager);
			// Spawn without worktreeManager worktree path set (use a manager with no worktree mock)
			// by temporarily making the mock throw so the path is never stored.
			ctx.worktreeMock.createError = new Error('force fallback');
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			ctx.worktreeMock.createError = undefined;

			// No path in map — factory must leave workspacePath intact.
			type ManagerPrivate = {
				createSubSessionFactory(id: string): { create(init: object): Promise<string> };
			};
			const factory = (ctx.manager as unknown as ManagerPrivate).createSubSessionFactory(task.id);

			const subSessionId = `sub-nopath-${task.id}`;
			await factory.create({
				sessionId: subSessionId,
				workspacePath: '/keep-this',
				messages: [],
				type: 'space_task_node_agent',
				context: {},
			});

			const subSession = ctx.createdSessions.get(subSessionId)!;
			expect(subSession._workspacePath).toBe('/keep-this');
		});
	});

	// -------------------------------------------------------------------------
	// Completion lifecycle
	// -------------------------------------------------------------------------

	describe('completion lifecycle', () => {
		test('cleanup(completed) marks worktree as completed, does not remove it', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			await ctx.manager.cleanup(task.id, 'completed');

			expect(ctx.worktreeMock.completedCalls).toHaveLength(1);
			expect(ctx.worktreeMock.completedCalls[0].taskId).toBe(task.id);
			expect(ctx.worktreeMock.removeCalls).toHaveLength(0);
		});

		test('cleanup(cancelled) removes worktree immediately', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			await ctx.manager.cleanup(task.id, 'cancelled');

			expect(ctx.worktreeMock.removeCalls).toHaveLength(1);
			expect(ctx.worktreeMock.removeCalls[0].taskId).toBe(task.id);
			expect(ctx.worktreeMock.completedCalls).toHaveLength(0);
		});

		test('cleanup with no reason defaults to completed', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			await ctx.manager.cleanup(task.id);

			expect(ctx.worktreeMock.completedCalls).toHaveLength(1);
			expect(ctx.worktreeMock.removeCalls).toHaveLength(0);
		});

		test('worktree path removed from in-memory map after cleanup', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(ctx.manager.getTaskWorktreePath(task.id)).toBe('/tmp/worktrees/test-task');

			await ctx.manager.cleanup(task.id);

			expect(ctx.manager.getTaskWorktreePath(task.id)).toBeUndefined();
		});

		test('cleanup without worktreeManager does not throw', async () => {
			// Create manager without worktreeManager
			const { db: bunDb, dir } = makeDb();
			const spaceId2 = 'space-no-wt';
			seedSpaceRow(bunDb, spaceId2);
			const taskManager2 = new SpaceTaskManager(bunDb, spaceId2);
			const task2 = await taskManager2.createTask({
				title: 'No worktree task',
				description: '',
				taskType: 'coding',
				status: 'pending',
			});

			const dbSessions2 = new Map<string, unknown>();
			const mockDb2 = {
				getSession: (id: string) => dbSessions2.get(id) ?? null,
				createSession: (s: unknown) => dbSessions2.set((s as { id: string }).id, s),
				deleteSession: (id: string) => dbSessions2.delete(id),
				saveUserMessage: () => 'msg-id',
				updateSession: () => {},
				getDatabase: () => bunDb,
			};

			const agentRepo2 = new SpaceAgentRepository(bunDb);
			const agentManager2 = new SpaceAgentManager(agentRepo2);
			const workflowRepo2 = new SpaceWorkflowRepository(bunDb);
			const workflowManager2 = new SpaceWorkflowManager(workflowRepo2);
			const workflowRunRepo2 = new SpaceWorkflowRunRepository(bunDb);
			const taskRepo2 = new SpaceTaskRepository(bunDb);
			const spaceManager2 = new SpaceManager(bunDb);
			const runtime2 = new SpaceRuntime({
				db: bunDb,
				spaceManager: spaceManager2,
				spaceAgentManager: agentManager2,
				spaceWorkflowManager: workflowManager2,
				workflowRunRepo: workflowRunRepo2,
				taskRepo: taskRepo2,
			});
			const daemonHub2 = new TestDaemonHub();
			const mockSpaceRuntimeService2 = { createOrGetRuntime: async () => runtime2 };
			const mockSessionManager2 = {
				deleteSession: async () => {},
				registerSession: () => {},
			};

			const manager2 = new TaskAgentManager({
				db: mockDb2 as unknown as import('../../../src/storage/database.ts').Database,
				sessionManager:
					mockSessionManager2 as unknown as import('../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: spaceManager2,
				spaceAgentManager: agentManager2,
				spaceWorkflowManager: workflowManager2,
				spaceRuntimeService:
					mockSpaceRuntimeService2 as unknown as import('../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: taskRepo2,
				workflowRunRepo: workflowRunRepo2,
				daemonHub: daemonHub2 as unknown as import('../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				// No worktreeManager
			});

			const space2 = makeSpace(spaceId2);
			await manager2.spawnTaskAgent(task2, space2, null, null);
			// Should not throw — call directly and let bun:test surface any error
			await manager2.cleanup(task2.id);

			ctx.fromInitSpy.mockRestore(); // will be restored in afterEach but this saves redundancy
			rmSync(dir, { recursive: true, force: true });
		});
	});

	// -------------------------------------------------------------------------
	// TTL reaper and orphan cleanup
	// -------------------------------------------------------------------------

	describe('SpaceWorktreeRepository TTL reaper', () => {
		test('markCompleted sets completedAt and reapExpiredWorktrees removes expired records', () => {
			const { SpaceWorktreeRepository } =
				require('../../../src/storage/repositories/space-worktree-repository.ts') as typeof import('../../../src/storage/repositories/space-worktree-repository.ts');

			const { db: bunDb2, dir: dir2 } = makeDb();
			const spaceId2 = 'space-ttl-test';
			seedSpaceRow(bunDb2, spaceId2);

			// Insert a task row so FK constraint is satisfied
			bunDb2
				.prepare(
					`INSERT INTO space_tasks (id, space_id, title, description, task_type, status, task_number, created_at, updated_at)
				 VALUES ('task-ttl-1', ?, 'TTL task', '', 'coding', 'completed', 1, ?, ?)`
				)
				.run(spaceId2, Date.now(), Date.now());

			const repo = new SpaceWorktreeRepository(bunDb2);
			repo.create({
				spaceId: spaceId2,
				taskId: 'task-ttl-1',
				slug: 'ttl-slug',
				path: '/tmp/ttl-worktree',
			});

			// Mark as completed with a timestamp 8 days in the past
			const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
			const updated = repo.markCompleted(spaceId2, 'task-ttl-1', eightDaysAgo);
			expect(updated).toBe(true);

			const record = repo.getByTaskId(spaceId2, 'task-ttl-1');
			expect(record?.completedAt).toBe(eightDaysAgo);

			// listCompletedBefore should find this record (TTL = 7 days → cutoff = now - 7d)
			const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
			const expired = repo.listCompletedBefore(cutoff);
			expect(expired.length).toBe(1);
			expect(expired[0].taskId).toBe('task-ttl-1');

			// Should NOT find it if the cutoff is further in the past (i.e. TTL not yet elapsed)
			const notExpiredCutoff = eightDaysAgo - 1; // before completedAt
			const notExpired = repo.listCompletedBefore(notExpiredCutoff);
			expect(notExpired.length).toBe(0);

			rmSync(dir2, { recursive: true, force: true });
		});

		test('markCompleted is idempotent — second call returns false', () => {
			const { SpaceWorktreeRepository } =
				require('../../../src/storage/repositories/space-worktree-repository.ts') as typeof import('../../../src/storage/repositories/space-worktree-repository.ts');

			const { db: bunDb2, dir: dir2 } = makeDb();
			const spaceId2 = 'space-idem-test';
			seedSpaceRow(bunDb2, spaceId2);

			bunDb2
				.prepare(
					`INSERT INTO space_tasks (id, space_id, title, description, task_type, status, task_number, created_at, updated_at)
				 VALUES ('task-idem-1', ?, 'Idem task', '', 'coding', 'completed', 1, ?, ?)`
				)
				.run(spaceId2, Date.now(), Date.now());

			const repo = new SpaceWorktreeRepository(bunDb2);
			repo.create({
				spaceId: spaceId2,
				taskId: 'task-idem-1',
				slug: 'idem-slug',
				path: '/tmp/idem',
			});

			const first = repo.markCompleted(spaceId2, 'task-idem-1');
			expect(first).toBe(true);

			const second = repo.markCompleted(spaceId2, 'task-idem-1');
			expect(second).toBe(false); // already marked — WHERE completed_at IS NULL filters it out

			rmSync(dir2, { recursive: true, force: true });
		});

		test('SpaceWorktreeManager.reapExpiredWorktrees delegates to removeTaskWorktree', async () => {
			// Use real repository + mock removeTaskWorktree to verify delegation
			const { SpaceWorktreeRepository } =
				require('../../../src/storage/repositories/space-worktree-repository.ts') as typeof import('../../../src/storage/repositories/space-worktree-repository.ts');
			const { SpaceWorktreeManager } =
				require('../../../src/lib/space/managers/space-worktree-manager.ts') as typeof import('../../../src/lib/space/managers/space-worktree-manager.ts');

			const { db: bunDb2, dir: dir2 } = makeDb();
			const spaceId2 = 'space-reap-test';
			seedSpaceRow(bunDb2, spaceId2);

			bunDb2
				.prepare(
					`INSERT INTO space_tasks (id, space_id, title, description, task_type, status, task_number, created_at, updated_at)
				 VALUES ('task-reap-1', ?, 'Reap task', '', 'coding', 'completed', 1, ?, ?)`
				)
				.run(spaceId2, Date.now(), Date.now());

			const manager = new SpaceWorktreeManager(bunDb2);
			const repo = new SpaceWorktreeRepository(bunDb2);

			// Insert directly via repo to skip filesystem operations
			repo.create({
				spaceId: spaceId2,
				taskId: 'task-reap-1',
				slug: 'reap-slug',
				path: '/tmp/reap',
			});
			const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
			repo.markCompleted(spaceId2, 'task-reap-1', eightDaysAgo);

			// Spy on removeTaskWorktree to avoid real filesystem operations
			const removeSpy = spyOn(manager, 'removeTaskWorktree').mockResolvedValue(undefined);

			await manager.reapExpiredWorktrees();

			expect(removeSpy).toHaveBeenCalledWith(spaceId2, 'task-reap-1');
			removeSpy.mockRestore();

			rmSync(dir2, { recursive: true, force: true });
		});
	});

	// -------------------------------------------------------------------------
	// Rehydration restores worktree path
	// -------------------------------------------------------------------------

	describe('rehydration restores worktree path from run config', () => {
		test('rehydrate() reads worktreePath from run config and sets taskWorktreePaths', async () => {
			// Simulate a daemon restart: seed DB with an in-progress task whose
			// workflow run config already has a worktreePath stored by spawnTaskAgent.
			const sessionId = `session-rehydrate-${Date.now()}`;

			const task = await makeTask(ctx.taskManager);
			const workflowRun = ctx.workflowRunRepo.createRun({
				spaceId: ctx.spaceId,
				workflowId: 'workflow-rehydrate',
				title: 'Rehydrate run',
			});

			// Store worktreePath in run config (as spawnTaskAgent would have done).
			// Use '/tmp' — guaranteed to exist on disk so existsSync() passes.
			ctx.workflowRunRepo.updateRun(workflowRun.id, { config: { worktreePath: '/tmp' } });

			// Mark task as in_progress with a session id and workflow run link.
			ctx.taskRepo.updateTask(task.id, {
				status: 'in_progress',
				taskAgentSessionId: sessionId,
				workflowRunId: workflowRun.id,
			});

			// Seed the session in the mock DB so rehydrate() identifies it as a task-agent session.
			ctx.addDbSession(sessionId, 'space_task_agent');

			// Spy on AgentSession.restore so no real DB/SDK calls are made.
			const mockSession = makeMockSession(sessionId);
			const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(
				mockSession as unknown as AgentSession
			);

			try {
				await ctx.manager.rehydrate();
			} finally {
				restoreSpy.mockRestore();
			}

			// The critical assertion: rehydrateTaskAgent() should have read
			// workflowRun.config.worktreePath and called taskWorktreePaths.set(taskId, '/tmp').
			expect(ctx.manager.getTaskWorktreePath(task.id)).toBe('/tmp');
		});

		test('rehydrate() skips worktree path when stored path no longer exists on disk', async () => {
			const sessionId = `session-rehydrate-gone-${Date.now()}`;

			const task = await makeTask(ctx.taskManager);
			const workflowRun = ctx.workflowRunRepo.createRun({
				spaceId: ctx.spaceId,
				workflowId: 'workflow-rehydrate-gone',
				title: 'Rehydrate gone run',
			});

			// Use a path that definitely does not exist on disk.
			ctx.workflowRunRepo.updateRun(workflowRun.id, {
				config: { worktreePath: '/nonexistent/worktree/path/that/surely/does/not/exist' },
			});

			ctx.taskRepo.updateTask(task.id, {
				status: 'in_progress',
				taskAgentSessionId: sessionId,
				workflowRunId: workflowRun.id,
			});

			ctx.addDbSession(sessionId, 'space_task_agent');

			const mockSession = makeMockSession(sessionId);
			const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(
				mockSession as unknown as AgentSession
			);

			try {
				await ctx.manager.rehydrate();
			} finally {
				restoreSpy.mockRestore();
			}

			// Path did not exist on disk → not stored in the map (falls back to space.workspacePath).
			expect(ctx.manager.getTaskWorktreePath(task.id)).toBeUndefined();
		});
	});
});
