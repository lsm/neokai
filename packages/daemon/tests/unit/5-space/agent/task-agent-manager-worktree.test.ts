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
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { Space, SpaceWorkflow, SpaceWorkflowRun, SpaceTask } from '@neokai/shared';
import type { AgentProcessingState } from '@neokai/shared';
import type { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager.ts';

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

async function makeTask(taskManager: SpaceTaskManager): Promise<SpaceTask> {
	return taskManager.createTask({
		title: 'Test task',
		description: 'A test task',
		taskType: 'coding',
		status: 'open',
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
		getSharedRuntime: () => runtime,
		notifyGateDataChanged: async (_runId: string, _gateId: string) => {},
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
		db: mockDb as unknown as import('../../../../src/storage/database.ts').Database,
		sessionManager:
			mockSessionManager as unknown as import('../../../../src/lib/session/session-manager.ts').SessionManager,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		spaceRuntimeService:
			mockSpaceRuntimeService as unknown as import('../../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
		taskRepo,
		workflowRunRepo,
		daemonHub: daemonHub as unknown as import('../../../../src/lib/daemon-hub.ts').DaemonHub,
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

		test('worktree path stored in in-memory taskWorktreePaths map', async () => {
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

			// Worktree path is now stored in-memory (not in run config, which was removed in M71)
			expect(ctx.manager.getTaskWorktreePath(linkedTask.id)).toBe('/tmp/worktrees/test-task');
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
});
