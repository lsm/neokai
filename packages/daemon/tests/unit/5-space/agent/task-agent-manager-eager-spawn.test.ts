/**
 * Unit tests for TaskAgentManager eager sub-session spawning.
 *
 * Background (M-eager / bug #84):
 *
 * Previously, node-agent sub-sessions were only created lazily when the
 * workflow activated a node.  Any daemon restart between the task-agent
 * kickoff and that activation would leave the node-agent SDK transcript
 * non-existent (sdkSessionId never captured), so the workflow effectively
 * restarted from scratch on rehydrate.
 *
 * The fix: at `spawnTaskAgent()` time, after the worktree is ready and
 * the task-agent SDK init is captured, eagerly create one AgentSession per
 * unique agent slot referenced by the workflow graph — `startStreamingQuery`
 * + `awaitSdkSessionCaptured`, no kickoff message.  When the workflow later
 * activates its first node, `createSubSession()` discovers the pre-spawned
 * session via the `eagerSubSessionIds` index and reuses it.
 *
 * These tests pin down the behaviour so the bug cannot regress.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { Space, SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';
import type { AgentProcessingState } from '@neokai/shared';
import type { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager.ts';

// ---------------------------------------------------------------------------
// Minimal in-process DaemonHub
// ---------------------------------------------------------------------------

type EventHandler = (data: Record<string, unknown>) => void;

class TestDaemonHub {
	private listeners = new Map<string, Map<string, EventHandler>>();
	readonly emitted: Array<{ event: string; data: Record<string, unknown> }> = [];

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
		this.emitted.push({ event, data });
		const sessionId = (data as { sessionId?: string }).sessionId;
		if (sessionId) {
			const key = `${event}:${sessionId}`;
			for (const handler of this.listeners.get(key)?.values() ?? []) handler(data);
		}
		for (const handler of this.listeners.get(`${event}:*`)?.values() ?? []) handler(data);
		return Promise.resolve();
	}
}

// ---------------------------------------------------------------------------
// Mock AgentSession
// ---------------------------------------------------------------------------

interface MockAgentSession {
	session: {
		id: string;
		context?: Record<string, unknown>;
		config?: { mcpServers?: Record<string, unknown> };
		type?: string;
	};
	getProcessingState: () => AgentProcessingState;
	getSDKMessageCount: () => number;
	getSessionData: () => { id: string; context?: Record<string, unknown> };
	setRuntimeMcpServers: (servers: Record<string, unknown>) => void;
	mergeRuntimeMcpServers: (servers: Record<string, unknown>) => void;
	detachRuntimeMcpServer: (name: string) => void;
	restartQuery: () => Promise<void>;
	setRuntimeSystemPrompt: (systemPrompt: unknown) => void;
	startStreamingQuery: () => Promise<void>;
	ensureQueryStarted: () => Promise<void>;
	awaitSdkSessionCaptured: (timeoutMs?: number) => Promise<string>;
	handleInterrupt: () => Promise<void>;
	cleanup: () => Promise<void>;
	messageQueue: { enqueueWithId: (id: string, msg: string) => Promise<void> };
	_startCalled: boolean;
	_sdkAwaited: boolean;
	_enqueuedMessages: Array<{ id: string; msg: string }>;
	_mcpServers: Record<string, unknown>;
}

function makeMockSession(
	sessionId: string,
	context: Record<string, unknown> = {}
): MockAgentSession {
	const m: MockAgentSession = {
		session: { id: sessionId, context, config: { mcpServers: {} } },
		_startCalled: false,
		_sdkAwaited: false,
		_enqueuedMessages: [],
		_mcpServers: {},

		getProcessingState() {
			return { status: 'idle' } as AgentProcessingState;
		},
		getSDKMessageCount() {
			return 0;
		},
		getSessionData() {
			return this.session;
		},
		setRuntimeMcpServers(servers) {
			this._mcpServers = servers;
			this.session.config = { ...(this.session.config ?? {}), mcpServers: servers };
		},
		mergeRuntimeMcpServers(servers) {
			this._mcpServers = { ...this._mcpServers, ...servers };
			this.session.config = {
				...(this.session.config ?? {}),
				mcpServers: { ...(this.session.config?.mcpServers ?? {}), ...servers },
			};
		},
		detachRuntimeMcpServer(name) {
			const updated = { ...this._mcpServers };
			delete updated[name];
			this._mcpServers = updated;
			const updatedCfg = { ...(this.session.config?.mcpServers ?? {}) };
			delete updatedCfg[name];
			this.session.config = { ...(this.session.config ?? {}), mcpServers: updatedCfg };
		},
		async restartQuery() {},
		setRuntimeSystemPrompt(_sp: unknown) {},
		async startStreamingQuery() {
			this._startCalled = true;
		},
		async ensureQueryStarted() {
			this._startCalled = true;
		},
		async awaitSdkSessionCaptured() {
			this._sdkAwaited = true;
			return `sdk-${sessionId}`;
		},
		async handleInterrupt() {},
		async cleanup() {},
		messageQueue: {
			async enqueueWithId(id: string, msg: string) {
				m._enqueuedMessages.push({ id, msg });
			},
		},
	};
	return m;
}

// ---------------------------------------------------------------------------
// Mock SpaceWorktreeManager (minimal, tracks storedTaskIds)
// ---------------------------------------------------------------------------

function makeMockWorktreeManager(worktreePath = '/tmp/worktrees/eager-test') {
	const stored = new Set<string>();
	return {
		stored,
		async createTaskWorktree(_spaceId: string, taskId: string) {
			stored.add(taskId);
			return { path: worktreePath, slug: 'eager-test-slug' };
		},
		async removeTaskWorktree(_spaceId: string, taskId: string) {
			stored.delete(taskId);
		},
		markTaskWorktreeCompleted() {},
		async cleanupOrphaned() {},
		async reapExpiredWorktrees() {},
		async getTaskWorktreePath(_spaceId: string, taskId: string) {
			return stored.has(taskId) ? worktreePath : null;
		},
		getTaskWorktreePathSync(_spaceId: string, taskId: string) {
			return stored.has(taskId) ? worktreePath : null;
		},
		async listWorktrees() {
			return [];
		},
	};
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
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

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
	bunDb: BunDatabase;
	spaceId: string;
	space: Space;
	coderAgentId: string;
	reviewerAgentId: string;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	taskManager: SpaceTaskManager;
	workflowManager: SpaceWorkflowManager;
	manager: TaskAgentManager;
	createdSessions: Map<string, MockAgentSession>;
	fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;
}

function makeCtx(): TestCtx {
	const bunDb = makeDb();
	const spaceId = 'space-eager-test';
	const workspacePath = '/tmp/test-workspace-eager';

	seedSpaceRow(bunDb, spaceId, workspacePath);

	const coderAgentId = 'agent-coder-eager';
	const reviewerAgentId = 'agent-reviewer-eager';
	seedAgentRow(bunDb, coderAgentId, spaceId);
	seedAgentRow(bunDb, reviewerAgentId, spaceId);

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
	const dbSessions = new Map<string, unknown>();

	const mockDb = {
		getSession: (id: string) => (dbSessions.has(id) ? dbSessions.get(id) : null),
		createSession: (session: unknown) => {
			dbSessions.set((session as { id: string }).id, session);
		},
		deleteSession: (id: string) => {
			dbSessions.delete(id);
		},
		saveUserMessage: () => 'msg-id',
		updateSession: () => {},
		getDatabase: () => bunDb,
	};

	const mockSpaceRuntimeService = {
		createOrGetRuntime: async () => runtime,
		getSharedRuntime: () => runtime,
		notifyGateDataChanged: async () => {},
	};

	const mockSessionManager = {
		deleteSession: async () => {},
		registerSession: () => {},
		getSessionFromDB: (sessionId: string) => {
			const row = mockDb.getSession(sessionId);
			return row ? ({ id: sessionId } as { id: string }) : null;
		},
	};

	const fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation((init: unknown) => {
		const initTyped = init as {
			sessionId: string;
			context?: Record<string, unknown>;
			type?: string;
		};
		const mockSession = makeMockSession(initTyped.sessionId, initTyped.context ?? {});
		mockSession.session.type = initTyped.type;
		createdSessions.set(initTyped.sessionId, mockSession);
		mockDb.createSession({ id: initTyped.sessionId, type: initTyped.type });
		return mockSession as unknown as AgentSession;
	});

	const worktreeManager = makeMockWorktreeManager();

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
		nodeExecutionRepo,
		daemonHub: daemonHub as unknown as import('../../../../src/lib/daemon-hub.ts').DaemonHub,
		messageHub: {} as unknown as import('@neokai/shared').MessageHub,
		getApiKey: async () => 'test-key',
		defaultModel: 'claude-sonnet-4-5-20250929',
		worktreeManager: worktreeManager as unknown as SpaceWorktreeManager,
	});

	return {
		bunDb,
		spaceId,
		space,
		coderAgentId,
		reviewerAgentId,
		taskRepo,
		workflowRunRepo,
		nodeExecutionRepo,
		taskManager,
		workflowManager,
		manager,
		createdSessions,
		fromInitSpy,
	};
}

/**
 * Creates a two-node workflow (coder → reviewer) and a workflow run, then
 * returns both so callers can drive `spawnTaskAgent`.
 */
function seedTwoNodeWorkflow(ctx: TestCtx): {
	workflow: SpaceWorkflow;
	workflowRun: SpaceWorkflowRun;
} {
	const workflow = ctx.workflowManager.createWorkflow({
		spaceId: ctx.spaceId,
		name: 'Coding workflow',
		description: '',
		nodes: [
			{
				id: 'node-coding',
				name: 'Coding',
				agents: [{ agentId: ctx.coderAgentId, name: 'coder' }],
			},
			{
				id: 'node-review',
				name: 'Review',
				agents: [{ agentId: ctx.reviewerAgentId, name: 'reviewer' }],
			},
		],
		startNodeId: 'node-coding',
		tags: [],
		completionAutonomyLevel: 3,
	});
	const now = Date.now();
	const runId = `run-eager-${Math.random().toString(36).slice(2, 8)}`;
	ctx.bunDb
		.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
		)
		.run(runId, ctx.spaceId, workflow.id, now, now);
	const workflowRun = ctx.workflowRunRepo.getRun(runId)!;
	return { workflow, workflowRun };
}

async function makeTaskLinked(ctx: TestCtx, workflowRun: SpaceWorkflowRun): Promise<SpaceTask> {
	const task = await ctx.taskManager.createTask({
		title: 'Test task with workflow',
		description: 'Eager spawn test',
		taskType: 'coding',
		status: 'open',
		workflowRunId: workflowRun.id,
	});
	ctx.taskRepo.updateTask(task.id, { workflowRunId: workflowRun.id });
	return ctx.taskRepo.getTask(task.id)!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskAgentManager — eager sub-session spawning', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.fromInitSpy.mockRestore();
	});

	test('spawns one sub-session per distinct agent slot when a workflow is provided', async () => {
		const { workflow, workflowRun } = seedTwoNodeWorkflow(ctx);
		const task = await makeTaskLinked(ctx, workflowRun);

		const taskAgentSessionId = await ctx.manager.spawnTaskAgent(
			task,
			ctx.space,
			workflow,
			workflowRun
		);

		// Task-agent session always exists.
		expect(ctx.createdSessions.has(taskAgentSessionId)).toBe(true);

		// Eager node-agent sessions: one for "coder", one for "reviewer".
		const coderSessionId = `space:${ctx.spaceId}:task:${task.id}:agent:coder`;
		const reviewerSessionId = `space:${ctx.spaceId}:task:${task.id}:agent:reviewer`;
		expect(ctx.createdSessions.has(coderSessionId)).toBe(true);
		expect(ctx.createdSessions.has(reviewerSessionId)).toBe(true);
	});

	test('awaits sdk-session capture on each eager sub-session (no restart window)', async () => {
		const { workflow, workflowRun } = seedTwoNodeWorkflow(ctx);
		const task = await makeTaskLinked(ctx, workflowRun);

		await ctx.manager.spawnTaskAgent(task, ctx.space, workflow, workflowRun);

		const coderSession = ctx.createdSessions.get(
			`space:${ctx.spaceId}:task:${task.id}:agent:coder`
		)!;
		const reviewerSession = ctx.createdSessions.get(
			`space:${ctx.spaceId}:task:${task.id}:agent:reviewer`
		)!;

		// Eager sessions must have started streaming and awaited sdkSessionId
		// capture — this is the whole point of eager spawn.
		expect(coderSession._startCalled).toBe(true);
		expect(coderSession._sdkAwaited).toBe(true);
		expect(reviewerSession._startCalled).toBe(true);
		expect(reviewerSession._sdkAwaited).toBe(true);
	});

	test('does NOT inject a kickoff message into eager sub-sessions', async () => {
		const { workflow, workflowRun } = seedTwoNodeWorkflow(ctx);
		const task = await makeTaskLinked(ctx, workflowRun);

		await ctx.manager.spawnTaskAgent(task, ctx.space, workflow, workflowRun);

		const coderSession = ctx.createdSessions.get(
			`space:${ctx.spaceId}:task:${task.id}:agent:coder`
		)!;
		const reviewerSession = ctx.createdSessions.get(
			`space:${ctx.spaceId}:task:${task.id}:agent:reviewer`
		)!;

		// Eager sub-sessions sit idle until the workflow activates their node —
		// no user-facing kickoff message should have been enqueued.
		expect(coderSession._enqueuedMessages).toEqual([]);
		expect(reviewerSession._enqueuedMessages).toEqual([]);
	});

	test('deduplicates agent slots that appear on multiple nodes (one session per name)', async () => {
		// Build a workflow where the same agent slot name appears on two nodes.
		// Only one eager session should be pre-spawned (first-occurrence wins).
		const workflow = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Dup-slot workflow',
			description: '',
			nodes: [
				{
					id: 'node-a',
					name: 'A',
					agents: [{ agentId: ctx.coderAgentId, name: 'coder' }],
				},
				{
					id: 'node-b',
					name: 'B',
					agents: [{ agentId: ctx.coderAgentId, name: 'coder' }],
				},
			],
			startNodeId: 'node-a',
			tags: [],
			completionAutonomyLevel: 3,
		});
		const now = Date.now();
		const runId = 'run-dedup';
		ctx.bunDb
			.prepare(
				`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
			)
			.run(runId, ctx.spaceId, workflow.id, now, now);
		const workflowRun = ctx.workflowRunRepo.getRun(runId)!;
		const task = await makeTaskLinked(ctx, workflowRun);

		await ctx.manager.spawnTaskAgent(task, ctx.space, workflow, workflowRun);

		// Count sessions whose id looks like `...:agent:coder`.
		const agentSessionIds = Array.from(ctx.createdSessions.keys()).filter((id) =>
			id.includes(':agent:coder')
		);
		expect(agentSessionIds).toHaveLength(1);
	});

	test('does NOT eagerly spawn when no workflow is provided (standalone task)', async () => {
		const task = await ctx.taskManager.createTask({
			title: 'Standalone',
			description: '',
			taskType: 'coding',
			status: 'open',
		});

		const taskAgentSessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

		// Task agent exists; no eager node-agent sessions should have been created.
		expect(ctx.createdSessions.has(taskAgentSessionId)).toBe(true);
		const agentSlotSessions = Array.from(ctx.createdSessions.keys()).filter((id) =>
			id.includes(':agent:')
		);
		expect(agentSlotSessions).toHaveLength(0);
	});

	test('awaits sdk-session capture on the task-agent itself', async () => {
		const task = await ctx.taskManager.createTask({
			title: 'Standalone',
			description: '',
			taskType: 'coding',
			status: 'open',
		});
		const taskAgentSessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

		const taskAgent = ctx.createdSessions.get(taskAgentSessionId)!;
		expect(taskAgent._startCalled).toBe(true);
		expect(taskAgent._sdkAwaited).toBe(true);
	});

	test('eager sessions are registered in subSessions map so getSubSession finds them', async () => {
		const { workflow, workflowRun } = seedTwoNodeWorkflow(ctx);
		const task = await makeTaskLinked(ctx, workflowRun);

		await ctx.manager.spawnTaskAgent(task, ctx.space, workflow, workflowRun);

		const coderSessionId = `space:${ctx.spaceId}:task:${task.id}:agent:coder`;
		const reviewerSessionId = `space:${ctx.spaceId}:task:${task.id}:agent:reviewer`;

		// Both eager sessions must be discoverable via the public getter — that
		// is how `createSubSession`'s reuse path finds them when the workflow
		// activates a node later.
		expect(ctx.manager.getSubSession(coderSessionId)).toBeDefined();
		expect(ctx.manager.getSubSession(reviewerSessionId)).toBeDefined();
	});

	test('eager index maps agent names → eager session IDs for createSubSession reuse', async () => {
		const { workflow, workflowRun } = seedTwoNodeWorkflow(ctx);
		const task = await makeTaskLinked(ctx, workflowRun);

		await ctx.manager.spawnTaskAgent(task, ctx.space, workflow, workflowRun);

		// The reuse path in createSubSession reads from this private index.
		// Asserting its contents pins the contract: one entry per slot name.
		const eagerIndex = (
			ctx.manager as unknown as {
				eagerSubSessionIds: Map<string, Map<string, string>>;
			}
		).eagerSubSessionIds.get(task.id);

		expect(eagerIndex).toBeDefined();
		expect(eagerIndex!.get('coder')).toBe(`space:${ctx.spaceId}:task:${task.id}:agent:coder`);
		expect(eagerIndex!.get('reviewer')).toBe(`space:${ctx.spaceId}:task:${task.id}:agent:reviewer`);
	});
});

// ---------------------------------------------------------------------------
// getTaskWorktreePath fallback to DB
// ---------------------------------------------------------------------------

describe('TaskAgentManager.getTaskWorktreePath — DB fallback', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.fromInitSpy.mockRestore();
	});

	test('hits in-memory cache on the fast path after spawn', async () => {
		const { workflow, workflowRun } = seedTwoNodeWorkflow(ctx);
		const task = await makeTaskLinked(ctx, workflowRun);

		await ctx.manager.spawnTaskAgent(task, ctx.space, workflow, workflowRun);

		// Directly after spawn, the in-memory cache is populated.
		expect(ctx.manager.getTaskWorktreePath(task.id)).toBe('/tmp/worktrees/eager-test');
	});

	test('falls back to DB read when the in-memory cache is empty', async () => {
		const { workflow, workflowRun } = seedTwoNodeWorkflow(ctx);
		const task = await makeTaskLinked(ctx, workflowRun);

		await ctx.manager.spawnTaskAgent(task, ctx.space, workflow, workflowRun);

		// Simulate a process restart: wipe the in-memory cache.
		// (Access via the private field for test purposes — matches how the
		// rehydration path would find an empty map after daemon boot.)
		(
			ctx.manager as unknown as { taskWorktreePaths: Map<string, string> }
		).taskWorktreePaths.clear();

		// The DB-backed worktree record is still there, so the sync fallback
		// should produce the path and warm the cache.
		expect(ctx.manager.getTaskWorktreePath(task.id)).toBe('/tmp/worktrees/eager-test');
		// Verify it was re-cached for the next call.
		expect(
			(ctx.manager as unknown as { taskWorktreePaths: Map<string, string> }).taskWorktreePaths.get(
				task.id
			)
		).toBe('/tmp/worktrees/eager-test');
	});

	test('returns undefined when neither cache nor DB has a record', () => {
		// Task doesn't exist in repo; fallback returns undefined.
		expect(ctx.manager.getTaskWorktreePath('unknown-task-id')).toBeUndefined();
	});
});
