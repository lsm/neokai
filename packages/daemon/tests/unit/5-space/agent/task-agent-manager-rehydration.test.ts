/**
 * Unit tests for TaskAgentManager.rehydrateSubSession() lazy rehydration
 *
 * Covers the on-demand rehydration path triggered by injectSubSessionMessage()
 * when a sub-session is not in the in-memory maps (ghost sub-session scenario
 * after a daemon restart).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { Space } from '@neokai/shared';
import type { AgentProcessingState } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Minimal in-process DaemonHub for tests
// ---------------------------------------------------------------------------

type EventHandler = (data: Record<string, unknown>) => void;

class TestDaemonHub {
	private listeners = new Map<string, Map<string, EventHandler>>();

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
	session: {
		id: string;
		context?: Record<string, unknown>;
		config: { mcpServers?: Record<string, unknown> };
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
	// Test control
	_processingState: AgentProcessingState;
	_sdkMessageCount: number;
	_startCalled: boolean;
	_cleanupCalled: boolean;
	_mcpServers: Record<string, unknown>;
	_enqueuedMessages: Array<{ id: string; msg: string }>;
}

function makeMockSession(sessionId: string): MockAgentSession {
	const m: MockAgentSession = {
		session: { id: sessionId, context: {}, config: { mcpServers: {} } },
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
			// Mirror the real AgentSession behaviour so ensureNodeAgentAttached's
			// `session.config.mcpServers` invariant check sees the merged map.
			this.session.config = { ...this.session.config, mcpServers: servers };
		},
		mergeRuntimeMcpServers(servers) {
			this._mcpServers = { ...this._mcpServers, ...servers };
			this.session.config = {
				...this.session.config,
				mcpServers: { ...(this.session.config.mcpServers ?? {}), ...servers },
			};
		},
		detachRuntimeMcpServer(name) {
			const updated = { ...this._mcpServers };
			delete updated[name];
			this._mcpServers = updated;
			const updatedCfg = { ...(this.session.config.mcpServers ?? {}) };
			delete updatedCfg[name];
			this.session.config = { ...this.session.config, mcpServers: updatedCfg };
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
			return `sdk-${sessionId}`;
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
// DB + test context helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	// Use in-memory SQLite — faster than file-based DB and avoids filesystem
	// I/O contention that caused beforeEach hook timeouts in CI.
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

interface TestCtx {
	bunDb: BunDatabase;
	spaceId: string;
	space: Space;
	agentId: string;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	taskManager: SpaceTaskManager;
	workflowManager: SpaceWorkflowManager;
	daemonHub: TestDaemonHub;
	sessionManagerDeleteCalls: string[];
	registeredSessions: string[];
	mockDb: {
		getSession: (id: string) => unknown;
		createSession: (session: unknown) => void;
		deleteSession: (id: string) => void;
		saveUserMessage: () => string;
		updateSession: () => void;
		getDatabase: () => BunDatabase;
	};
	manager: TaskAgentManager;
	createdSessions: Map<string, MockAgentSession>;
	fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;
}

function makeCtx(): TestCtx {
	const bunDb = makeDb();
	const spaceId = 'space-rehydration-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(bunDb, spaceId, workspacePath);

	const agentId = 'agent-coder-rehydration';
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
	const registeredSessions: string[] = [];
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
		// Task #85: legacy `deleteSession` has been removed from the real
		// `SessionManager`. Retained as a stub so any accidental call from
		// production code surfaces as a captured violation.
		deleteSession: async (sessionId: string) => {
			sessionManagerDeleteCalls.push(sessionId);
		},
		archiveSessionResources: async (_sessionId: string, _trigger: string) => {},
		deleteSessionResources: async (sessionId: string, _trigger: string) => {
			sessionManagerDeleteCalls.push(sessionId);
		},
		interruptInMemorySession: async (_sessionId: string) => {},
		registerSession: (agentSession: unknown) => {
			registeredSessions.push((agentSession as { session: { id: string } }).session.id);
		},
		getSessionFromDB: (sessionId: string) => {
			const row = mockDb.getSession(sessionId);
			return row ? ({ id: sessionId } as { id: string }) : null;
		},
	};

	// Spy on AgentSession.fromInit to return mock sessions
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
			const mockSession = makeMockSession(initTyped.sessionId);
			createdSessions.set(initTyped.sessionId, mockSession);
			mockDb.createSession({ id: initTyped.sessionId });
			return mockSession as unknown as AgentSession;
		}
	);

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
		nodeExecutionRepo,
	});

	return {
		bunDb,
		spaceId,
		space,
		agentId,
		taskRepo,
		workflowRunRepo,
		nodeExecutionRepo,
		taskManager,
		workflowManager,
		daemonHub,
		sessionManagerDeleteCalls,
		registeredSessions,
		mockDb,
		manager,
		createdSessions,
		fromInitSpy,
	};
}

// ---------------------------------------------------------------------------
// Helpers for seeding workflow run infrastructure
// ---------------------------------------------------------------------------

/**
 * Creates a workflow with one node (using workflowManager so agents are
 * properly stored in the node config), then inserts a workflow run.
 *
 * Returns the actual workflow ID and node ID as created by createWorkflow()
 * (the provided wfNodeId is used as the node's desired ID via the input param).
 */
function seedWorkflowRun(ctx: TestCtx, wfRunId: string, _wfId: string, wfNodeId: string): void {
	const wf = ctx.workflowManager.createWorkflow({
		spaceId: ctx.spaceId,
		name: `WF ${_wfId}`,
		description: '',
		nodes: [
			{
				id: wfNodeId,
				name: `Node ${wfNodeId}`,
				agents: [{ agentId: ctx.agentId, name: 'coder' }],
			},
		],
		startNodeId: wfNodeId,
		tags: [],
		completionAutonomyLevel: 3,
	});
	const now = Date.now();
	ctx.bunDb
		.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
		)
		.run(wfRunId, ctx.spaceId, wf.id, now, now);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskAgentManager.rehydrateSubSession (lazy rehydration)', () => {
	let ctx: TestCtx;
	let restoreSpy: ReturnType<typeof spyOn<typeof AgentSession, 'restore'>>;

	beforeEach(() => {
		ctx = makeCtx();
		// Mock AgentSession.restore to return a mock session for any known DB session
		restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
			if (!ctx.mockDb.getSession(sessionId)) return null;
			const existing = ctx.createdSessions.get(sessionId);
			if (existing) return existing as unknown as AgentSession;
			const mockSession = makeMockSession(sessionId);
			ctx.createdSessions.set(sessionId, mockSession);
			return mockSession as unknown as AgentSession;
		});
	});

	afterEach(() => {
		ctx.fromInitSpy.mockRestore();
		restoreSpy.mockRestore();
	});

	test('injectSubSessionMessage rehydrates a ghost sub-session and delivers the message', async () => {
		const wfRunId = 'run-ghost-1';
		const wfId = 'wf-ghost-1';
		const nodeId = 'node-ghost-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		// Create the parent task linked to the workflow run
		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});
		const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
		ctx.taskRepo.updateTask(parentTask.id, {
			taskAgentSessionId,
			status: 'in_progress',
		});
		ctx.mockDb.createSession({ id: taskAgentSessionId, type: 'space_task_agent' });

		// Create a node execution row with an agentSessionId (simulates a sub-session created
		// before the daemon restarted)
		const ghostSubSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:ghost-exec-1`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, ghostSubSessionId);

		// Seed the sub-session in the mock DB (so AgentSession.restore() returns a session)
		ctx.mockDb.createSession({ id: ghostSubSessionId, type: 'worker' });

		// At this point the sub-session is NOT registered in the TaskAgentManager in-memory maps.
		// Calling injectSubSessionMessage should trigger lazy rehydration.
		await ctx.manager.injectSubSessionMessage(ghostSubSessionId, 'pick up where you left off');

		// The sub-session should now be in the in-memory maps
		expect(ctx.manager.getSubSession(ghostSubSessionId)).toBeDefined();

		// The session should have had streaming query restarted
		const rehydratedSession = ctx.createdSessions.get(ghostSubSessionId)!;
		expect(rehydratedSession).toBeDefined();
		expect(rehydratedSession._startCalled).toBe(true);

		// The message should have been delivered
		expect(rehydratedSession._enqueuedMessages.length).toBeGreaterThan(0);
		const lastMsg = rehydratedSession._enqueuedMessages.at(-1);
		expect(lastMsg?.msg).toBe('pick up where you left off');
	});

	test('rehydrated sub-session has node-agent MCP server attached', async () => {
		const wfRunId = 'run-mcp-attach-1';
		const wfId = 'wf-mcp-attach-1';
		const nodeId = 'node-mcp-attach-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task for MCP check',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});
		const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
		ctx.taskRepo.updateTask(parentTask.id, { taskAgentSessionId, status: 'in_progress' });
		ctx.mockDb.createSession({ id: taskAgentSessionId, type: 'space_task_agent' });

		const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:ghost-exec-mcp`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'reviewer',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, subSessionId);
		ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

		await ctx.manager.injectSubSessionMessage(subSessionId, 'resume review');

		const session = ctx.createdSessions.get(subSessionId)!;
		expect(Object.keys(session._mcpServers)).toContain('node-agent');
	});

	test('rehydrated sub-session is registered in SessionManager', async () => {
		const wfRunId = 'run-register-1';
		const wfId = 'wf-register-1';
		const nodeId = 'node-register-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task for registration check',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});
		const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
		ctx.taskRepo.updateTask(parentTask.id, { taskAgentSessionId, status: 'in_progress' });
		ctx.mockDb.createSession({ id: taskAgentSessionId, type: 'space_task_agent' });

		const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:ghost-exec-reg`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, subSessionId);
		ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

		await ctx.manager.injectSubSessionMessage(subSessionId, 'continue');

		// The session should be registered in the SessionManager via registerSession()
		expect(ctx.registeredSessions).toContain(subSessionId);
	});

	test('injectSubSessionMessage still throws when no NodeExecution found for the session ID', async () => {
		// No node_execution row pointing to this session ID exists in the DB
		// AND the session is not in the in-memory maps
		await expect(
			ctx.manager.injectSubSessionMessage('totally-unknown-session-id', 'hello')
		).rejects.toThrow('Sub-session not found');
	});

	test('injectSubSessionMessage throws when NodeExecution exists but session is not in DB', async () => {
		const wfRunId = 'run-no-db-session';
		const wfId = 'wf-no-db-session';
		const nodeId = 'node-no-db-session';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task - no DB session',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});
		const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
		ctx.taskRepo.updateTask(parentTask.id, { taskAgentSessionId, status: 'in_progress' });
		ctx.mockDb.createSession({ id: taskAgentSessionId, type: 'space_task_agent' });

		const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:ghost-no-db`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, subSessionId);

		// Intentionally do NOT seed the sub-session in mockDb — AgentSession.restore() will return null
		// restoreSpy returns null for sessions not in mockDb (see beforeEach)

		await expect(ctx.manager.injectSubSessionMessage(subSessionId, 'hello')).rejects.toThrow(
			'Sub-session not found'
		);
	});

	test('rehydration registers completion callback that fires on session idle', async () => {
		const wfRunId = 'run-callback-1';
		const wfId = 'wf-callback-1';
		const nodeId = 'node-callback-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task for callback check',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});

		// Spawn the task agent FIRST so spawnTaskAgent can claim the base session ID.
		// The ID that spawnTaskAgent generates becomes the task agent session's ID.
		const spawnedTaskAgentSessionId = await ctx.manager.spawnTaskAgent(
			parentTask,
			ctx.space,
			null,
			null
		);

		// Update the task's taskAgentSessionId to match what was spawned.
		ctx.taskRepo.updateTask(parentTask.id, {
			taskAgentSessionId: spawnedTaskAgentSessionId,
			status: 'in_progress',
		});

		const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:ghost-exec-cb`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, subSessionId);
		ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

		// Trigger lazy rehydration via message injection
		await ctx.manager.injectSubSessionMessage(subSessionId, 'continue work');

		// Simulate the sub-session completing: set SDK message count > 0, then emit idle
		const rehydratedSession = ctx.createdSessions.get(subSessionId)!;
		rehydratedSession._sdkMessageCount = 5;

		const taskAgentSession = ctx.createdSessions.get(spawnedTaskAgentSessionId)!;
		expect(taskAgentSession).toBeDefined();
		const msgsBefore = taskAgentSession._enqueuedMessages.length;

		ctx.daemonHub.emit('session.updated', {
			sessionId: subSessionId,
			processingState: { status: 'idle' },
		});

		// Allow async callbacks to flush
		await new Promise((r) => setTimeout(r, 0));

		// The task agent should have received a [NODE_COMPLETE] notification
		expect(taskAgentSession._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
		const lastMsg = taskAgentSession._enqueuedMessages.at(-1);
		expect(lastMsg?.msg).toContain('[NODE_COMPLETE]');
	});

	test('rehydrates same sub-session only once (second call uses in-memory map)', async () => {
		const wfRunId = 'run-idempotent-1';
		const wfId = 'wf-idempotent-1';
		const nodeId = 'node-idempotent-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task for idempotency check',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});
		const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
		ctx.taskRepo.updateTask(parentTask.id, { taskAgentSessionId, status: 'in_progress' });
		ctx.mockDb.createSession({ id: taskAgentSessionId, type: 'space_task_agent' });

		const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:ghost-exec-idem`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, subSessionId);
		ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

		// First call — triggers rehydration
		await ctx.manager.injectSubSessionMessage(subSessionId, 'first message');

		// Track how many times restore is called after the first rehydration
		let restoreCallsAfterFirst = 0;
		restoreSpy.mockImplementation((sessionId: string) => {
			restoreCallsAfterFirst++;
			if (!ctx.mockDb.getSession(sessionId)) return null;
			const existing = ctx.createdSessions.get(sessionId);
			if (existing) return existing as unknown as AgentSession;
			const mockSession = makeMockSession(sessionId);
			ctx.createdSessions.set(sessionId, mockSession);
			return mockSession as unknown as AgentSession;
		});

		// Second call — should use the in-memory index, not restore again
		await ctx.manager.injectSubSessionMessage(subSessionId, 'second message');

		expect(restoreCallsAfterFirst).toBe(0);

		// Both messages should be delivered
		const session = ctx.createdSessions.get(subSessionId)!;
		const messages = session._enqueuedMessages.map((m) => m.msg);
		expect(messages).toContain('first message');
		expect(messages).toContain('second message');
	});

	test('NodeExecutionRepository.getByAgentSessionId returns correct execution', () => {
		const wfRunId = 'run-repo-test';
		const wfId = 'wf-repo-test';
		const nodeId = 'node-repo-test';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'tester',
			agentId: null,
			status: 'in_progress',
		});
		const agentSessionId = 'session-for-repo-test';
		ctx.nodeExecutionRepo.updateSessionId(execution.id, agentSessionId);

		const found = ctx.nodeExecutionRepo.getByAgentSessionId(agentSessionId);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(execution.id);
		expect(found?.agentSessionId).toBe(agentSessionId);

		// Returns null for unknown session
		const notFound = ctx.nodeExecutionRepo.getByAgentSessionId('no-such-session');
		expect(notFound).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: TaskAgentManager.tryResumeNodeAgentSession (Task #70)
// ---------------------------------------------------------------------------

/**
 * Helper: build a TaskAgentManager that reuses all mocked dependencies from
 * `ctx` but also has a PendingAgentMessageRepository wired in.
 * Uses bracket-notation access to the private `config` field, which is
 * safe in test code because TypeScript's `private` is compile-time only.
 */
function makeManagerWithPendingRepo(
	ctx: TestCtx,
	pendingRepo: PendingAgentMessageRepository
): TaskAgentManager {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const existingConfig = (ctx.manager as any).config as Record<string, unknown>;
	return new TaskAgentManager({
		...existingConfig,
		pendingMessageRepo: pendingRepo,
	} as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
}

describe('TaskAgentManager.tryResumeNodeAgentSession', () => {
	let ctx: TestCtx;
	let restoreSpy: ReturnType<typeof spyOn<typeof AgentSession, 'restore'>>;

	beforeEach(() => {
		ctx = makeCtx();
		restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
			if (!ctx.mockDb.getSession(sessionId)) return null;
			const existing = ctx.createdSessions.get(sessionId);
			if (existing) return existing as unknown as AgentSession;
			const mockSession = makeMockSession(sessionId);
			ctx.createdSessions.set(sessionId, mockSession);
			return mockSession as unknown as AgentSession;
		});
	});

	afterEach(() => {
		ctx.fromInitSpy.mockRestore();
		restoreSpy.mockRestore();
	});

	test('is a no-op when pendingMessageRepo is not configured', async () => {
		// ctx.manager has no pendingMessageRepo — should return immediately without throwing
		const wfRunId = 'run-resume-noop-1';
		const wfId = 'wf-resume-noop-1';
		const nodeId = 'node-resume-noop-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		await expect(ctx.manager.tryResumeNodeAgentSession(wfRunId, 'coder')).resolves.toBeUndefined();

		// No restore or fromInit should have been called
		expect(restoreSpy).not.toHaveBeenCalled();
		expect(ctx.fromInitSpy).not.toHaveBeenCalled();
	});

	test('is a no-op when no NodeExecution with agentSessionId exists for the agent', async () => {
		const pendingRepo = new PendingAgentMessageRepository(ctx.bunDb);

		const wfRunId = 'run-resume-nosession-1';
		const wfId = 'wf-resume-nosession-1';
		const nodeId = 'node-resume-nosession-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		// Execution exists but has no agentSessionId (agent was declared but never spawned)
		ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			status: 'pending',
		});

		const manager = makeManagerWithPendingRepo(ctx, pendingRepo);
		await expect(manager.tryResumeNodeAgentSession(wfRunId, 'coder')).resolves.toBeUndefined();

		// No restore should have been triggered
		expect(restoreSpy).not.toHaveBeenCalled();
	});

	test('rehydrates session and flushes pending messages when session is not in memory', async () => {
		const pendingRepo = new PendingAgentMessageRepository(ctx.bunDb);

		const wfRunId = 'run-resume-rehydrate-1';
		const wfId = 'wf-resume-rehydrate-1';
		const nodeId = 'node-resume-rehydrate-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task for resume test',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});
		const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
		ctx.taskRepo.updateTask(parentTask.id, { taskAgentSessionId, status: 'in_progress' });
		ctx.mockDb.createSession({ id: taskAgentSessionId, type: 'space_task_agent' });

		const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:resume-exec-1`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, subSessionId);
		// Seed session in mock DB so AgentSession.restore() returns a session
		ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

		// Queue a pending message for the coder
		pendingRepo.enqueue({
			workflowRunId: wfRunId,
			spaceId: ctx.spaceId,
			taskId: parentTask.id,
			sourceAgentName: 'task-agent',
			targetKind: 'node_agent',
			targetAgentName: 'coder',
			message: 'resume and continue',
		});

		const manager = makeManagerWithPendingRepo(ctx, pendingRepo);

		// Session is NOT in memory — tryResumeNodeAgentSession should rehydrate it and flush
		await manager.tryResumeNodeAgentSession(wfRunId, 'coder');

		// restoreSpy must have been called to rehydrate the session (first arg is sessionId)
		expect(restoreSpy).toHaveBeenCalled();
		const restoreCalls = restoreSpy.mock.calls;
		expect(restoreCalls.some((args) => args[0] === subSessionId)).toBe(true);

		// flushPendingMessagesForTarget is called with `void` (fire-and-forget) inside
		// rehydrateSubSession. Yield to the event loop so the flush microtask chain completes
		// before we assert on its side-effects.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Pending message should have been delivered to the rehydrated session
		const rehydrated = ctx.createdSessions.get(subSessionId);
		expect(rehydrated).toBeDefined();
		const delivered = rehydrated!._enqueuedMessages.find((m) =>
			m.msg.includes('resume and continue')
		);
		expect(delivered).toBeDefined();

		// Queue should now be empty (markDelivered was called)
		const remaining = pendingRepo.listPendingForTarget(wfRunId, 'coder');
		expect(remaining).toHaveLength(0);
	});

	test('flushes pending messages directly (fast path) when session is already in memory', async () => {
		const pendingRepo = new PendingAgentMessageRepository(ctx.bunDb);

		const wfRunId = 'run-resume-live-1';
		const wfId = 'wf-resume-live-1';
		const nodeId = 'node-resume-live-1';
		seedWorkflowRun(ctx, wfRunId, wfId, nodeId);

		const parentTask = await ctx.taskManager.createTask({
			title: 'Parent task for live-session resume',
			description: '',
			taskType: 'coding',
			status: 'in_progress',
			workflowRunId: wfRunId,
		});
		const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
		ctx.taskRepo.updateTask(parentTask.id, { taskAgentSessionId, status: 'in_progress' });
		ctx.mockDb.createSession({ id: taskAgentSessionId, type: 'space_task_agent' });

		const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:resume-live-exec`;
		const execution = ctx.nodeExecutionRepo.create({
			workflowRunId: wfRunId,
			workflowNodeId: nodeId,
			agentName: 'reviewer',
			agentId: null,
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.updateSessionId(execution.id, subSessionId);
		ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

		const manager = makeManagerWithPendingRepo(ctx, pendingRepo);

		// Prime the session into memory by injecting a message (triggers rehydration)
		await manager.injectSubSessionMessage(subSessionId, 'initial injection');
		const rehydrateCallCount = restoreSpy.mock.calls.length;

		// Queue a pending message AFTER the session is in memory
		pendingRepo.enqueue({
			workflowRunId: wfRunId,
			spaceId: ctx.spaceId,
			taskId: parentTask.id,
			sourceAgentName: 'task-agent',
			targetKind: 'node_agent',
			targetAgentName: 'reviewer',
			message: 'fast path delivery',
		});

		// Call tryResumeNodeAgentSession — session IS in memory → fast path (no restore call)
		await manager.tryResumeNodeAgentSession(wfRunId, 'reviewer');

		// restoreSpy should NOT have been called again (fast path skips rehydration)
		expect(restoreSpy.mock.calls.length).toBe(rehydrateCallCount);

		// Pending message should have been flushed to the live session
		const remaining = pendingRepo.listPendingForTarget(wfRunId, 'reviewer');
		expect(remaining).toHaveLength(0);

		const session = ctx.createdSessions.get(subSessionId);
		const fastPathMsg = session?._enqueuedMessages.find((m) =>
			m.msg.includes('fast path delivery')
		);
		expect(fastPathMsg).toBeDefined();
	});
});
