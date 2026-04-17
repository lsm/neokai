/**
 * Unit tests for TaskAgentManager
 *
 * Covers:
 *   - spawnTaskAgent: basic spawn, idempotency, concurrency guard
 *   - Session ID generation with monotonic suffix on collision
 *   - Completion callback registration and firing
 *   - Sub-session completion propagation to Task Agent
 *   - Message injection (immediate and defer)
 *   - isTaskAgentAlive detection
 *   - cleanup: stops sessions and removes DB records
 *   - Error handling
 *
 * Strategy: AgentSession.fromInit() is spied upon to return controllable mock
 * sessions. Real SQLite DB is used for space/task repositories. DaemonHub is
 * implemented as a minimal in-process event bus.
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
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import type { Space, SpaceWorkflow, SpaceWorkflowRun, SpaceTask } from '@neokai/shared';
import type { AgentProcessingState } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Minimal in-process DaemonHub for tests
// ---------------------------------------------------------------------------

type EventHandler = (data: Record<string, unknown>) => void;

class TestDaemonHub {
	private listeners = new Map<string, Map<string, EventHandler>>();
	/** Tracks all emitted events for assertion in tests */
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
		// Emit to session-specific listeners
		if (sessionId) {
			const key = `${event}:${sessionId}`;
			for (const handler of this.listeners.get(key)?.values() ?? []) {
				handler(data);
			}
		}
		// Emit to wildcard listeners
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
	// Test control
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
		'test-task-agent-manager',
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
		getSession: (id: string) => null;
		createSession: () => void;
		deleteSession: () => void;
		saveUserMessage: () => string;
		updateSession: () => void;
		getDatabase: () => BunDatabase;
	};
	manager: TaskAgentManager;
	createdSessions: Map<string, MockAgentSession>;
	fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;
}

function makeCtx(): TestCtx {
	const { db: bunDb, dir } = makeDb();
	const spaceId = 'space-tam-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(bunDb, spaceId, workspacePath);

	const agentId = 'agent-coder-tam';
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

	// Track session creation and deleted sessions
	const createdSessions = new Map<string, MockAgentSession>();
	const sessionManagerDeleteCalls: string[] = [];

	// Track DB sessions created (to simulate fromInit check)
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
		registerSession: (_agentSession: unknown) => {
			// no-op: unit tests don't exercise cache registration
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
			const mockSession = makeMockSession(initTyped.sessionId, initTyped.context);
			createdSessions.set(initTyped.sessionId, mockSession);
			// Also track in DB
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

describe('TaskAgentManager', () => {
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

	// -----------------------------------------------------------------------
	// spawnTaskAgent — basic spawn
	// -----------------------------------------------------------------------

	describe('spawnTaskAgent', () => {
		test('creates Task Agent session and returns session ID', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(sessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
			expect(ctx.createdSessions.has(sessionId)).toBe(true);
		});

		test('starts streaming query after creation', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const session = ctx.createdSessions.get(sessionId)!;
			expect(session._startCalled).toBe(true);
		});

		test('sets MCP server on the session', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const session = ctx.createdSessions.get(sessionId)!;
			expect(Object.keys(session._mcpServers)).toContain('task-agent');
		});

		test('persists taskAgentSessionId on the SpaceTask', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const updatedTask = ctx.taskRepo.getTask(task.id);
			expect(updatedTask?.taskAgentSessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
		});

		test('injects initial message into session', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const session = ctx.createdSessions.get(sessionId)!;
			// Session should have had a message enqueued
			expect(session._enqueuedMessages.length).toBeGreaterThan(0);
		});
	});

	// -----------------------------------------------------------------------
	// ensureTaskAgentSession
	// -----------------------------------------------------------------------

	describe('ensureTaskAgentSession', () => {
		test('keeps standalone behavior when space has no workflows', async () => {
			const task = await makeTask(ctx.taskManager);
			const ensured = await ctx.manager.ensureTaskAgentSession(task.id);

			expect(ensured.workflowRunId).toBeUndefined();
			expect(ensured.taskAgentSessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
		});

		test('does not auto-attach workflow when workflows exist', async () => {
			const fallbackStepId = 'step-fallback';
			ctx.workflowManager.createWorkflow({
				spaceId: ctx.spaceId,
				name: 'Fallback Coding Workflow',
				description: 'Default coding path',
				nodes: [
					{
						id: fallbackStepId,
						name: 'Coding',
						agentId: ctx.agentId,
					},
				],
				startNodeId: fallbackStepId,
				tags: ['default'],
			});

			const task = await makeTask(ctx.taskManager);
			const ensured = await ctx.manager.ensureTaskAgentSession(task.id);

			expect(ensured.workflowRunId).toBeUndefined();
			expect(ensured.taskAgentSessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
		});

		test('rehydrates a persisted Task Agent session when in-memory map is empty', async () => {
			const task = await makeTask(ctx.taskManager);
			const persistedSessionId = `space:${ctx.spaceId}:task:${task.id}`;

			ctx.taskRepo.updateTask(task.id, {
				taskAgentSessionId: persistedSessionId,
				status: 'in_progress',
			});
			ctx.mockDb.createSession({ id: persistedSessionId, type: 'space_task_agent' });

			const restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
				if (sessionId !== persistedSessionId) return null;
				const restored = makeMockSession(sessionId);
				ctx.createdSessions.set(sessionId, restored);
				return restored as unknown as AgentSession;
			});

			const ensured = await ctx.manager.ensureTaskAgentSession(task.id);
			const restoredSession = ctx.createdSessions.get(persistedSessionId);

			expect(ensured.taskAgentSessionId).toBe(persistedSessionId);
			expect(ctx.manager.getTaskAgent(task.id)).toBeDefined();
			expect(restoredSession?._startCalled).toBe(true);

			restoreSpy.mockRestore();
		});
	});

	// -----------------------------------------------------------------------
	// spawnTaskAgent — idempotency
	// -----------------------------------------------------------------------

	describe('spawnTaskAgent — idempotency', () => {
		test('returns same session ID on second call', async () => {
			const task = await makeTask(ctx.taskManager);
			const id1 = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const id2 = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(id1).toBe(id2);
		});

		test('only creates one session on second call', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const countBefore = ctx.createdSessions.size;
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.createdSessions.size).toBe(countBefore);
		});
	});

	// -----------------------------------------------------------------------
	// Session ID collision handling
	// -----------------------------------------------------------------------

	describe('session ID generation', () => {
		test('uses base ID when no collision', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(sessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
		});

		test('appends monotonic suffix when base ID already in DB', async () => {
			const task = await makeTask(ctx.taskManager);
			const baseId = `space:${ctx.spaceId}:task:${task.id}`;

			// Pre-create the base ID in the mock DB to simulate restart collision
			ctx.mockDb.createSession({ id: baseId });

			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(sessionId).toBe(`${baseId}:1`);
		});
	});

	// -----------------------------------------------------------------------
	// Spawning tasks guard
	// -----------------------------------------------------------------------

	describe('spawningTasks concurrency guard', () => {
		test('isSpawning returns false for untracked task', () => {
			expect(ctx.manager.isSpawning('non-existent-task')).toBe(false);
		});

		test('isSpawning is false after spawn completes', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(ctx.manager.isSpawning(task.id)).toBe(false);
		});

		test('concurrent spawns return the same session ID and create only one session', async () => {
			// Two concurrent calls for the same task — the second should wait for the
			// first to finish (via the setInterval polling loop) and return the same ID.
			const task = await makeTask(ctx.taskManager);
			const sessionsBefore = ctx.createdSessions.size;

			const [id1, id2] = await Promise.all([
				ctx.manager.spawnTaskAgent(task, ctx.space, null, null),
				ctx.manager.spawnTaskAgent(task, ctx.space, null, null),
			]);

			expect(id1).toBe(id2);
			// Only one AgentSession should have been created
			expect(ctx.createdSessions.size).toBe(sessionsBefore + 1);
		});
	});

	// -----------------------------------------------------------------------
	// isTaskAgentAlive
	// -----------------------------------------------------------------------

	describe('isTaskAgentAlive', () => {
		test('returns false for non-existent task', () => {
			expect(ctx.manager.isTaskAgentAlive('no-such-task')).toBe(false);
		});

		test('returns true after successful spawn', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(ctx.manager.isTaskAgentAlive(task.id)).toBe(true);
		});

		test('returns true when session is idle', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;
			session._processingState = { status: 'idle' } as AgentProcessingState;
			expect(ctx.manager.isTaskAgentAlive(task.id)).toBe(true);
		});

		test('returns true when session is processing', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;
			session._processingState = { status: 'processing' } as AgentProcessingState;
			expect(ctx.manager.isTaskAgentAlive(task.id)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// getTaskAgent / getSubSession
	// -----------------------------------------------------------------------

	describe('getTaskAgent', () => {
		test('returns undefined for unknown task', () => {
			expect(ctx.manager.getTaskAgent('no-task')).toBeUndefined();
		});

		test('returns session after spawn', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(ctx.manager.getTaskAgent(task.id)).toBeDefined();
		});
	});

	describe('getSubSession', () => {
		test('returns undefined for unknown session', () => {
			expect(ctx.manager.getSubSession('no-session')).toBeUndefined();
		});

		test('returns sub-session after createSubSession', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const init = {
				sessionId: `space:${ctx.spaceId}:task:${task.id}:step:step-1`,
				workspacePath: '/tmp/ws',
				systemPrompt: { prompt: 'test' },
				features: {
					rewind: false,
					worktree: false,
					coordinator: false,
					archive: false,
					sessionInfo: false,
				},
				type: 'space_task_agent' as const,
				context: {},
			};
			await ctx.manager.createSubSession(
				task.id,
				init.sessionId,
				init as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit
			);
			expect(ctx.manager.getSubSession(init.sessionId)).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// createSubSession
	// -----------------------------------------------------------------------

	describe('createSubSession', () => {
		test('creates session and starts streaming query', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-42`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			const subSession = ctx.createdSessions.get(subSessionId)!;
			expect(subSession).toBeDefined();
			expect(subSession._startCalled).toBe(true);
		});

		test('returns the provided session ID', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-99`;
			const returnedId = await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			expect(returnedId).toBe(subSessionId);
		});

		test('reuses existing session when same agent name is called a second time', async () => {
			// Seed a workflow run so listByWorkflowRun can return prior NodeExecution rows.
			// Note: node_executions has a UNIQUE(workflow_run_id, workflow_node_id, agent_name)
			// constraint, so there is only ever ONE NodeExecution per (run, node, agent).
			// Re-execution of the same node reuses the same NodeExecution row; createSubSession
			// detects the pre-existing agentSessionId on that row and skips creating a new session.
			const wfId = 'wf-reuse-session';
			const wfRunId = 'run-reuse-session';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
         VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF Reuse', now, now);
			const stepId = 'step-reuse-1';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_nodes (id, workflow_id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?)`
				)
				.run(stepId, wfId, 'Step 1', now, now);
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			const parentTask = await ctx.taskManager.createTask({
				title: 'Reuse task',
				description: '',
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

			// First execution: create the single NodeExecution row for (run, node, coder).
			const exec = ctx.nodeExecutionRepo.create({
				workflowRunId: wfRunId,
				workflowNodeId: stepId,
				agentName: 'coder',
				agentId: ctx.agentId,
				status: 'in_progress',
			});
			const subSessionId1 = `space:${ctx.spaceId}:task:${parentTask.id}:exec:${exec.id}`;
			const returned1 = await ctx.manager.createSubSession(
				parentTask.id,
				subSessionId1,
				{
					sessionId: subSessionId1,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, agentName: 'coder', nodeId: stepId }
			);
			expect(returned1).toBe(subSessionId1);
			const sessionsBefore = ctx.createdSessions.size;

			// Second execution: same NodeExecution row, different desired session ID.
			// The UNIQUE constraint means the runtime would call createOrIgnore (existing row
			// returned unchanged). createSubSession should detect agentSessionId is already set
			// and reuse the first session without spawning a new one.
			const subSessionId2 = `space:${ctx.spaceId}:task:${parentTask.id}:exec:${exec.id}:2`;
			const returned2 = await ctx.manager.createSubSession(
				parentTask.id,
				subSessionId2,
				{
					sessionId: subSessionId2,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, agentName: 'coder', nodeId: stepId }
			);

			// Should have returned the original session ID, not created a new one.
			expect(returned2).toBe(subSessionId1);
			expect(ctx.createdSessions.size).toBe(sessionsBefore);
		});

		test('second createSubSession for same agent clears stale callbacks before registering new one', async () => {
			// Seed workflow run — same pattern as the reuse test above.
			const wfId = 'wf-cb-clear';
			const wfRunId = 'run-cb-clear';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
         VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF CB Clear', now, now);
			const stepId = 'step-cb-clear';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_nodes (id, workflow_id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?)`
				)
				.run(stepId, wfId, 'Step CB', now, now);
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			const parentTask = await ctx.taskManager.createTask({
				title: 'CB clear task',
				description: '',
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

			// First execution: single NodeExecution row for (run, node, coder).
			const exec = ctx.nodeExecutionRepo.create({
				workflowRunId: wfRunId,
				workflowNodeId: stepId,
				agentName: 'coder',
				agentId: ctx.agentId,
				status: 'in_progress',
			});
			const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:${exec.id}`;
			await ctx.manager.createSubSession(
				parentTask.id,
				subSessionId,
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, agentName: 'coder', nodeId: stepId }
			);

			// Manually add a stale extra callback to simulate what rehydrateSubSession would add
			// (rehydrateSubSession registers a callback with the OLD nodeId).
			let staleCallbackFired = false;
			ctx.manager.registerCompletionCallback(subSessionId, async () => {
				staleCallbackFired = true;
			});

			// Second createSubSession call for the same agent (re-execution of the node).
			// Should clear stale callbacks before registering the new one.
			const subSessionId2 = `space:${ctx.spaceId}:task:${parentTask.id}:exec:${exec.id}:2`;
			await ctx.manager.createSubSession(
				parentTask.id,
				subSessionId2,
				{
					sessionId: subSessionId2,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, agentName: 'coder', nodeId: stepId }
			);

			// Fire the idle event to trigger callbacks
			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 3;

			const taskAgentSessionId = `space:${ctx.spaceId}:task:${parentTask.id}`;
			const taskAgentSession = ctx.createdSessions.get(taskAgentSessionId)!;
			const msgsBefore = taskAgentSession._enqueuedMessages.length;

			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});
			await new Promise((r) => setTimeout(r, 0));

			// The stale callback registered between the two createSubSession calls should
			// have been cleared by the second createSubSession, so it must NOT have fired.
			expect(staleCallbackFired).toBe(false);
			// The new callback (handleSubSessionComplete) should have fired — injecting NODE_COMPLETE
			expect(taskAgentSession._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
		});

		test('preserves init mcpServers when app MCP registry servers are injected', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const configRef = ctx.manager as unknown as {
				config: {
					appMcpManager?: {
						getEnabledMcpConfigs: () => Record<string, unknown>;
					};
				};
			};
			configRef.config.appMcpManager = {
				getEnabledMcpConfigs: () => ({
					'registry-mcp': {
						type: 'stdio',
						command: 'echo',
						args: ['ok'],
					},
				}),
			};

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-merge-mcp`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
				mcpServers: {
					'node-agent': {
						type: 'local',
						path: '/tmp/node-agent-mcp',
					},
				},
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			const subSession = ctx.createdSessions.get(subSessionId)!;
			expect(subSession._mcpServers['node-agent']).toBeDefined();
			expect(subSession._mcpServers['registry-mcp']).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// Completion callback registration
	// -----------------------------------------------------------------------

	describe('completion callbacks', () => {
		test('onComplete fires when DaemonHub emits session.updated with idle status', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-fire`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			let callbackFired = false;
			ctx.manager.registerCompletionCallback(subSessionId, async () => {
				callbackFired = true;
			});

			// Simulate the sub-session having done some work
			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 3;

			// Emit idle event to trigger callback
			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});

			// Give async callbacks time to run
			await new Promise((r) => setTimeout(r, 0));
			expect(callbackFired).toBe(true);
		});

		test('onComplete fires at most once even if idle emitted multiple times', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-once`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			let callCount = 0;
			ctx.manager.registerCompletionCallback(subSessionId, async () => {
				callCount++;
			});

			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 1;

			// Emit idle twice
			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});
			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});

			await new Promise((r) => setTimeout(r, 0));
			expect(callCount).toBe(1);
		});

		test('onComplete does not fire for session with no SDK messages (not started yet)', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:step-nostart`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			let callbackFired = false;
			ctx.manager.registerCompletionCallback(subSessionId, async () => {
				callbackFired = true;
			});

			// Sub-session has 0 SDK messages — should NOT trigger
			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});

			await new Promise((r) => setTimeout(r, 0));
			expect(callbackFired).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// handleSubSessionComplete — downstream effects
	// -----------------------------------------------------------------------

	describe('handleSubSessionComplete', () => {
		/** Helper to call the private method directly via type cast */
		function callHandleSubSessionComplete(
			manager: TaskAgentManager,
			taskId: string,
			nodeId: string,
			subSessionId: string
		): Promise<void> {
			return (
				manager as unknown as {
					handleSubSessionComplete: (
						taskId: string,
						nodeId: string,
						subSessionId: string
					) => Promise<void>;
				}
			).handleSubSessionComplete(taskId, nodeId, subSessionId);
		}

		test('does not mutate step task status directly (runtime owns progression)', async () => {
			// Seed a workflow, workflow step, and workflow run (needed to satisfy FK constraints)
			const wfRunId = 'wf-run-complete-test';
			const wfId = 'wf-id-complete-test';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'Test WF', now, now);
			const stepId = 'step-complete-1';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_nodes (id, workflow_id, name, description, created_at, updated_at)
           VALUES (?, ?, ?, '', ?, ?)`
				)
				.run(stepId, wfId, 'Step 1', now, now);
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			// Create parent task with a workflow run ID
			const parentTask = await ctx.taskManager.createTask({
				title: 'Parent task',
				description: 'Orchestrator task',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
			});

			// Create the step task with matching workflowRunId, workflowNodeId, taskAgentSessionId
			const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:step:${stepId}`;
			const stepTask = await ctx.taskManager.createTask({
				title: 'Step task',
				description: 'A step task',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
				workflowNodeId: stepId,
				taskAgentSessionId: subSessionId,
			});

			// Spawn the Task Agent so getSpaceIdForTask and taskAgentSessions work
			await ctx.manager.spawnTaskAgent(
				{ ...parentTask, workflowRunId: wfRunId },
				ctx.space,
				null,
				null
			);

			await callHandleSubSessionComplete(ctx.manager, parentTask.id, stepId, subSessionId);

			// Step status remains runtime-driven; handleSubSessionComplete only notifies.
			const updated = ctx.taskRepo.getTask(stepTask.id);
			expect(updated?.status).toBe('in_progress');
		});

		test('injects [NODE_COMPLETE] notification into Task Agent session', async () => {
			const stepId = 'step-notify-1';
			const parentTask = await ctx.taskManager.createTask({
				title: 'Parent task',
				description: 'Orchestrator task',
				taskType: 'coding',
				status: 'in_progress',
			});

			const taskAgentSessionId = await ctx.manager.spawnTaskAgent(
				parentTask,
				ctx.space,
				null,
				null
			);
			const taskAgentSession = ctx.createdSessions.get(taskAgentSessionId)!;
			const msgsBefore = taskAgentSession._enqueuedMessages.length;

			await callHandleSubSessionComplete(
				ctx.manager,
				parentTask.id,
				stepId,
				`space:${ctx.spaceId}:task:${parentTask.id}:step:${stepId}`
			);

			// Task Agent should have received a [NODE_COMPLETE] message
			expect(taskAgentSession._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
			const lastMsg =
				taskAgentSession._enqueuedMessages[taskAgentSession._enqueuedMessages.length - 1];
			expect(lastMsg.msg).toContain('[NODE_COMPLETE]');
			expect(lastMsg.msg).toContain(stepId);
		});

		test('does not throw when no matching step task exists', async () => {
			const parentTask = await ctx.taskManager.createTask({
				title: 'Parent task',
				description: 'Orchestrator task',
				taskType: 'coding',
				status: 'in_progress',
			});
			await ctx.manager.spawnTaskAgent(parentTask, ctx.space, null, null);

			// Should not throw even with no matching step task
			await expect(
				callHandleSubSessionComplete(ctx.manager, parentTask.id, 'nonexistent-step', 'session-xyz')
			).resolves.toBeUndefined();
		});

		test('auto-transitions execution to idle when session completes normally', async () => {
			// Seed the workflow run row first so FK constraints are satisfied
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run('run-auto-idle', ctx.spaceId, 'wf-seed', now, now);

			// Create parentTask WITH the workflowRunId so handleSubSessionComplete can look up the execution
			const parentTask = await ctx.taskManager.createTask({
				title: 'Workflow task',
				description: 'Drive coding',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: 'run-auto-idle',
			});

			const execution = ctx.nodeExecutionRepo.create({
				workflowRunId: 'run-auto-idle',
				workflowNodeId: 'coding-node',
				agentName: 'coder',
				agentId: ctx.agentId,
				status: 'in_progress',
			});

			const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:exec:${execution.id}`;
			// createSubSession sets agentSessionId on the matching NodeExecution when parentTask has workflowRunId
			await ctx.manager.createSubSession(
				parentTask.id,
				subSessionId,
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{
					agentId: ctx.agentId,
					agentName: 'coder',
					nodeId: 'coding-node',
				}
			);

			await callHandleSubSessionComplete(ctx.manager, parentTask.id, 'coding-node', subSessionId);

			// Session completion automatically transitions in_progress → idle (no tool call required)
			const after = ctx.nodeExecutionRepo.getById(execution.id);
			expect(after?.status).toBe('idle');
		});
	});

	// -----------------------------------------------------------------------
	// Message injection
	// -----------------------------------------------------------------------

	describe('injectTaskAgentMessage', () => {
		test('throws for unknown task', async () => {
			await expect(ctx.manager.injectTaskAgentMessage('no-task', 'hello')).rejects.toThrow(
				'Task Agent session not found'
			);
		});

		test('enqueues message into session queue', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;
			const messagesBefore = session._enqueuedMessages.length;

			await ctx.manager.injectTaskAgentMessage(task.id, 'Hello Task Agent!');

			expect(session._enqueuedMessages.length).toBeGreaterThan(messagesBefore);
			const lastMsg = session._enqueuedMessages[session._enqueuedMessages.length - 1];
			expect(lastMsg.msg).toBe('Hello Task Agent!');
		});

		test('lazily restores persisted session before injecting a message', async () => {
			const task = await makeTask(ctx.taskManager);
			const persistedSessionId = `space:${ctx.spaceId}:task:${task.id}`;

			ctx.taskRepo.updateTask(task.id, {
				taskAgentSessionId: persistedSessionId,
				status: 'in_progress',
			});
			ctx.mockDb.createSession({ id: persistedSessionId, type: 'space_task_agent' });

			const restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
				if (sessionId !== persistedSessionId) return null;
				const restored = makeMockSession(sessionId);
				ctx.createdSessions.set(sessionId, restored);
				return restored as unknown as AgentSession;
			});

			await expect(
				ctx.manager.injectTaskAgentMessage(task.id, 'resume work')
			).resolves.toBeUndefined();

			const session = ctx.createdSessions.get(persistedSessionId);
			expect(session?._startCalled).toBe(true);
			expect(session?._enqueuedMessages.at(-1)?.msg).toBe('resume work');

			restoreSpy.mockRestore();
		});
	});

	describe('injectMessageIntoSession — defer delivery', () => {
		/** Helper to call the private method directly */
		function callInjectMessage(
			manager: TaskAgentManager,
			session: unknown,
			message: string,
			deliveryMode?: string
		): Promise<void> {
			return (
				manager as unknown as {
					injectMessageIntoSession: (
						session: unknown,
						message: string,
						deliveryMode?: string
					) => Promise<void>;
				}
			).injectMessageIntoSession(session, message, deliveryMode);
		}

		test('saves with "deferred" status and does not enqueue when session is processing', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;

			// Put session into busy state
			session._processingState = { status: 'processing' } as AgentProcessingState;

			const savedStatuses: string[] = [];
			const enqueuedBefore = session._enqueuedMessages.length;
			const originalSave = ctx.mockDb.saveUserMessage;
			ctx.mockDb.saveUserMessage = (
				_sid: string,
				_msg: unknown,
				status: string
			): ReturnType<typeof ctx.mockDb.saveUserMessage> => {
				savedStatuses.push(status);
				return 'msg-id';
			};

			await callInjectMessage(ctx.manager, session, 'step done', 'defer');

			ctx.mockDb.saveUserMessage = originalSave;

			expect(savedStatuses).toEqual(['deferred']);
			// No additional enqueue should have happened
			expect(session._enqueuedMessages.length).toBe(enqueuedBefore);
		});

		test('saves with "deferred" status when session is waiting_for_input', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;

			// Session is blocked on a human-input gate
			session._processingState = {
				status: 'waiting_for_input',
			} as AgentProcessingState;

			const savedStatuses: string[] = [];
			const enqueuedBefore = session._enqueuedMessages.length;
			const originalSave = ctx.mockDb.saveUserMessage;
			ctx.mockDb.saveUserMessage = (
				_sid: string,
				_msg: unknown,
				status: string
			): ReturnType<typeof ctx.mockDb.saveUserMessage> => {
				savedStatuses.push(status);
				return 'msg-id';
			};

			await callInjectMessage(ctx.manager, session, 'step done', 'defer');

			ctx.mockDb.saveUserMessage = originalSave;

			expect(savedStatuses).toEqual(['deferred']);
			// No additional enqueue should have happened
			expect(session._enqueuedMessages.length).toBe(enqueuedBefore);
		});

		test('saves with "deferred" status when session is interrupted (defer deferred)', async () => {
			// 'interrupted' is included in isBusy for defer delivery.
			// A defer message to an interrupted session should be deferred, not sent
			// blindly — the session may restart on its own or receive a immediate message.
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;

			session._processingState = { status: 'interrupted' } as AgentProcessingState;

			const savedStatuses: string[] = [];
			const enqueuedBefore = session._enqueuedMessages.length;
			const originalSave = ctx.mockDb.saveUserMessage;
			ctx.mockDb.saveUserMessage = (
				_sid: string,
				_msg: unknown,
				status: string
			): ReturnType<typeof ctx.mockDb.saveUserMessage> => {
				savedStatuses.push(status);
				return 'msg-id';
			};

			await callInjectMessage(ctx.manager, session, 'check in', 'defer');

			ctx.mockDb.saveUserMessage = originalSave;

			expect(savedStatuses).toEqual(['deferred']);
			expect(session._enqueuedMessages.length).toBe(enqueuedBefore);
		});

		test('enqueues immediately for immediate when session is interrupted (restartable)', async () => {
			// An interrupted session can accept a immediate message: ensureQueryStarted
			// restarts the query and the message is enqueued normally.
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;

			session._processingState = { status: 'interrupted' } as AgentProcessingState;
			const msgsBefore = session._enqueuedMessages.length;

			await callInjectMessage(ctx.manager, session, 'restart signal', 'immediate');

			expect(session._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
		});

		test('enqueues immediately for defer when session is idle', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;
			// session is idle by default

			const msgsBefore = session._enqueuedMessages.length;

			await callInjectMessage(ctx.manager, session, 'idle delivery', 'defer');

			expect(session._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
		});
	});

	describe('injectSubSessionMessage', () => {
		test('throws for unknown sub-session', async () => {
			await expect(ctx.manager.injectSubSessionMessage('no-such-session', 'msg')).rejects.toThrow(
				'Sub-session not found'
			);
		});

		test('enqueues message into sub-session queue', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:inject-step`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);
			const subSession = ctx.createdSessions.get(subSessionId)!;
			const before = subSession._enqueuedMessages.length;

			await ctx.manager.injectSubSessionMessage(subSessionId, 'Work on it!');

			expect(subSession._enqueuedMessages.length).toBeGreaterThan(before);
		});
	});

	// -----------------------------------------------------------------------
	// Cleanup
	// -----------------------------------------------------------------------

	describe('cleanup', () => {
		test('removes Task Agent session from map', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(ctx.manager.getTaskAgent(task.id)).toBeDefined();

			await ctx.manager.cleanup(task.id);
			expect(ctx.manager.getTaskAgent(task.id)).toBeUndefined();
		});

		test('marks task agent session as cleaned up', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;

			await ctx.manager.cleanup(task.id);
			expect(session._cleanupCalled).toBe(true);
		});

		test('calls SessionManager.deleteSession for task agent session', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			await ctx.manager.cleanup(task.id);
			expect(ctx.sessionManagerDeleteCalls).toContain(sessionId);
		});

		test('also cleans up sub-sessions', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:cleanup-step`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			await ctx.manager.cleanup(task.id);

			expect(ctx.manager.getSubSession(subSessionId)).toBeUndefined();
			expect(ctx.sessionManagerDeleteCalls).toContain(subSessionId);
		});

		test('no-op cleanup for task with no sessions', async () => {
			// Should not throw
			await expect(ctx.manager.cleanup('ghost-task')).resolves.toBeUndefined();
		});

		test('session alive check returns false after cleanup', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			await ctx.manager.cleanup(task.id);
			expect(ctx.manager.isTaskAgentAlive(task.id)).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	describe('error handling', () => {
		test('removes from spawningTasks set on error', async () => {
			// Make AgentSession.fromInit throw
			spyOn(AgentSession, 'fromInit').mockImplementationOnce(() => {
				throw new Error('SDK init failed');
			});

			const task = await makeTask(ctx.taskManager);
			await expect(ctx.manager.spawnTaskAgent(task, ctx.space, null, null)).rejects.toThrow(
				'SDK init failed'
			);

			expect(ctx.manager.isSpawning(task.id)).toBe(false);
		});

		test('cleanupAll stops all active task agent sessions', async () => {
			const task1 = await makeTask(ctx.taskManager);
			const task2 = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task1, ctx.space, null, null);
			await ctx.manager.spawnTaskAgent(task2, ctx.space, null, null);

			expect(ctx.manager.isTaskAgentAlive(task1.id)).toBe(true);
			expect(ctx.manager.isTaskAgentAlive(task2.id)).toBe(true);

			await ctx.manager.cleanupAll();

			expect(ctx.manager.isTaskAgentAlive(task1.id)).toBe(false);
			expect(ctx.manager.isTaskAgentAlive(task2.id)).toBe(false);
		});

		test('cleanupAll is a no-op when no sessions are active', async () => {
			// Should not throw
			await expect(ctx.manager.cleanupAll()).resolves.toBeUndefined();
		});

		test('can retry spawn after error', async () => {
			// First call throws
			const fromInitSpy = spyOn(AgentSession, 'fromInit')
				.mockImplementationOnce(() => {
					throw new Error('Transient error');
				})
				.mockImplementation(
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
						ctx.createdSessions.set(initTyped.sessionId, mockSession);
						ctx.mockDb.createSession({ id: initTyped.sessionId });
						return mockSession as unknown as AgentSession;
					}
				);

			const task = await makeTask(ctx.taskManager);

			// First attempt fails
			await expect(ctx.manager.spawnTaskAgent(task, ctx.space, null, null)).rejects.toThrow(
				'Transient error'
			);

			// Second attempt succeeds
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(sessionId).toBeDefined();

			fromInitSpy.mockRestore();
		});
	});

	// -----------------------------------------------------------------------
	// rehydrate — session restoration on daemon restart
	// -----------------------------------------------------------------------

	describe('rehydrate', () => {
		// Scoped spy for AgentSession.restore — only active inside this describe block.
		// rehydrateTaskAgent() uses restore() (not fromInit()) to reload persisted sessions.
		// We restore the spy after each test so it does not leak into other test files.
		let restoreSpyScoped: ReturnType<typeof spyOn<typeof AgentSession, 'restore'>>;

		beforeEach(() => {
			restoreSpyScoped = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
				// Only restore if the session exists in the mock DB
				if (!ctx.mockDb.getSession(sessionId)) return null;
				const existing = ctx.createdSessions.get(sessionId);
				if (existing) return existing as unknown as AgentSession;
				const mockSession = makeMockSession(sessionId);
				ctx.createdSessions.set(sessionId, mockSession);
				return mockSession as unknown as AgentSession;
			});
		});

		afterEach(() => {
			restoreSpyScoped.mockRestore();
		});

		/**
		 * Helper: seed a task with status in_progress and a pre-existing task agent session.
		 * The session is stored in the mock DB with `type: 'space_task_agent'` so the
		 * rehydrate filter correctly identifies it.
		 */
		async function seedInProgressTask(
			c: TestCtx,
			status: 'in_progress' | 'blocked' = 'in_progress'
		) {
			const task = await c.taskManager.createTask({
				title: 'Rehydrate test task',
				description: 'A task that was in progress before restart',
				taskType: 'coding',
				status,
			});

			const agentSessionId = `space:${c.spaceId}:task:${task.id}`;

			// Persist the session ID on the task
			c.taskRepo.updateTask(task.id, { taskAgentSessionId: agentSessionId });

			// Seed the session in the mock DB with type: 'space_task_agent'
			c.mockDb.createSession({ id: agentSessionId, type: 'space_task_agent' });

			return { task, agentSessionId };
		}

		test('restores Task Agent session for an in_progress task', async () => {
			const { task, agentSessionId } = await seedInProgressTask(ctx);

			await ctx.manager.rehydrate();

			expect(ctx.manager.getTaskAgent(task.id)).toBeDefined();
			expect(ctx.createdSessions.has(agentSessionId)).toBe(true);
		});

		test('restores Task Agent session for a needs_attention task', async () => {
			const { task, agentSessionId } = await seedInProgressTask(ctx, 'blocked');

			await ctx.manager.rehydrate();

			expect(ctx.manager.getTaskAgent(task.id)).toBeDefined();
			expect(ctx.createdSessions.has(agentSessionId)).toBe(true);
		});

		test('rehydrated session has streaming query restarted', async () => {
			const { agentSessionId } = await seedInProgressTask(ctx);

			await ctx.manager.rehydrate();

			const session = ctx.createdSessions.get(agentSessionId)!;
			expect(session._startCalled).toBe(true);
		});

		test('re-orientation message is injected after rehydration (standalone task)', async () => {
			// Standalone task has no workflowRunId — re-orientation uses generic resume message
			const { agentSessionId } = await seedInProgressTask(ctx);

			await ctx.manager.rehydrate();

			const session = ctx.createdSessions.get(agentSessionId)!;
			// At least one message enqueued (the re-orientation message)
			expect(session._enqueuedMessages.length).toBeGreaterThan(0);
			const msgs = session._enqueuedMessages.map((m) => m.msg);
			expect(msgs.some((m) => m.includes('resuming after a daemon restart'))).toBe(true);
			// Standalone tasks get a generic re-orientation — no check_step_status reference
			expect(msgs.some((m) => m.includes('check_step_status'))).toBe(false);
			expect(msgs.some((m) => m.includes('current task status'))).toBe(true);
		});

		test('re-orientation message for workflow task contains check_step_status', async () => {
			// Seed a workflow run
			const wfId = 'wf-reorient-workflow';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF Reorient', now, now);
			const wfRunId = 'run-reorient-workflow';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			const task = await ctx.taskManager.createTask({
				title: 'Workflow task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
			});
			const agentSessionId = `space:${ctx.spaceId}:task:${task.id}`;
			ctx.taskRepo.updateTask(task.id, { taskAgentSessionId: agentSessionId });
			ctx.mockDb.createSession({ id: agentSessionId, type: 'space_task_agent' });

			await ctx.manager.rehydrate();

			const session = ctx.createdSessions.get(agentSessionId)!;
			expect(session._enqueuedMessages.length).toBeGreaterThan(0);
			const msgs = session._enqueuedMessages.map((m) => m.msg);
			expect(msgs.some((m) => m.includes('resuming after a daemon restart'))).toBe(true);
			// Workflow tasks should reference event-driven orchestration to resume
			expect(
				msgs.some((m) => m.includes('event-driven mode') || m.includes('continue orchestration'))
			).toBe(true);
		});

		test('restore returning null skips task and does not add to map', async () => {
			// Seed task whose session is in the mock DB (so filter passes) but restore returns null
			const task = await ctx.taskManager.createTask({
				title: 'Restore-null task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
			});
			const agentSessionId = `space:${ctx.spaceId}:task:${task.id}`;
			ctx.taskRepo.updateTask(task.id, { taskAgentSessionId: agentSessionId });
			ctx.mockDb.createSession({ id: agentSessionId, type: 'space_task_agent' });

			// Override restore to return null for this session only
			const restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
				if (sessionId === agentSessionId) return null;
				// Fallback for any other session
				if (!ctx.mockDb.getSession(sessionId)) return null;
				const mockSession = makeMockSession(sessionId);
				ctx.createdSessions.set(sessionId, mockSession);
				return mockSession as unknown as AgentSession;
			});

			const sessionsBefore = ctx.createdSessions.size;
			await ctx.manager.rehydrate();

			// Task agent should NOT have been added to the map
			expect(ctx.manager.getTaskAgent(task.id)).toBeUndefined();
			// No new sessions should have been created for this task
			expect(ctx.createdSessions.has(agentSessionId)).toBe(false);
			expect(ctx.createdSessions.size).toBe(sessionsBefore);

			restoreSpy.mockRestore();
		});

		test('MCP server is re-attached on rehydrated session', async () => {
			const { agentSessionId } = await seedInProgressTask(ctx);

			await ctx.manager.rehydrate();

			const session = ctx.createdSessions.get(agentSessionId)!;
			expect(Object.keys(session._mcpServers)).toContain('task-agent');
		});

		test('tasks without taskAgentSessionId are skipped', async () => {
			// Create a task with no session ID set
			const task = await ctx.taskManager.createTask({
				title: 'No session task',
				description: 'Should be skipped',
				taskType: 'coding',
				status: 'in_progress',
			});

			const sessionsBefore = ctx.createdSessions.size;
			await ctx.manager.rehydrate();

			expect(ctx.manager.getTaskAgent(task.id)).toBeUndefined();
			expect(ctx.createdSessions.size).toBe(sessionsBefore);
		});

		test('completed/cancelled tasks are not rehydrated', async () => {
			const completedTask = await ctx.taskManager.createTask({
				title: 'Completed task',
				description: '',
				taskType: 'coding',
				status: 'done',
			});
			const agentSessionId = `space:${ctx.spaceId}:task:${completedTask.id}`;
			ctx.taskRepo.updateTask(completedTask.id, { taskAgentSessionId: agentSessionId });
			ctx.mockDb.createSession({ id: agentSessionId, type: 'space_task_agent' });

			const cancelledTask = await ctx.taskManager.createTask({
				title: 'Cancelled task',
				description: '',
				taskType: 'coding',
				status: 'cancelled',
			});
			const agentSessionId2 = `space:${ctx.spaceId}:task:${cancelledTask.id}`;
			ctx.taskRepo.updateTask(cancelledTask.id, { taskAgentSessionId: agentSessionId2 });
			ctx.mockDb.createSession({ id: agentSessionId2, type: 'space_task_agent' });

			await ctx.manager.rehydrate();

			expect(ctx.manager.getTaskAgent(completedTask.id)).toBeUndefined();
			expect(ctx.manager.getTaskAgent(cancelledTask.id)).toBeUndefined();
		});

		test('sub-session tasks (UUID session IDs) are not rehydrated as Task Agents', async () => {
			// A step task has a UUID sub-session ID — should NOT be treated as a Task Agent
			const stepTask = await ctx.taskManager.createTask({
				title: 'Step task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
			});
			const uuidSubSessionId = '550e8400-e29b-41d4-a716-446655440000';
			ctx.taskRepo.updateTask(stepTask.id, { taskAgentSessionId: uuidSubSessionId });
			// Session has type 'worker', not 'space_task_agent'
			ctx.mockDb.createSession({ id: uuidSubSessionId, type: 'worker' });

			await ctx.manager.rehydrate();

			expect(ctx.manager.getTaskAgent(stepTask.id)).toBeUndefined();
		});

		test('skips if Task Agent session is already in the map (idempotent)', async () => {
			const { task } = await seedInProgressTask(ctx);

			// Spawn first
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const sessionsAfterSpawn = ctx.createdSessions.size;

			// Rehydrate should see the task already in map and skip
			await ctx.manager.rehydrate();

			expect(ctx.createdSessions.size).toBe(sessionsAfterSpawn);
		});

		test('rehydrates multiple tasks independently', async () => {
			const { task: task1 } = await seedInProgressTask(ctx);
			const { task: task2 } = await seedInProgressTask(ctx, 'blocked');

			await ctx.manager.rehydrate();

			expect(ctx.manager.getTaskAgent(task1.id)).toBeDefined();
			expect(ctx.manager.getTaskAgent(task2.id)).toBeDefined();
		});

		test('does not restart streaming for sub-sessions during rehydration', async () => {
			// Sub-sessions in the map after rehydration should NOT have _startCalled = true
			// (they are stubs that the Task Agent will re-spawn as needed)
			const wfId = 'wf-rehydrate-no-start';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF Sub No Start', now, now);
			const wfRunId = 'run-rehydrate-no-start';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			const mainTask = await ctx.taskManager.createTask({
				title: 'Main task no-start',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
			});
			const mainSessionId = `space:${ctx.spaceId}:task:${mainTask.id}`;
			ctx.taskRepo.updateTask(mainTask.id, { taskAgentSessionId: mainSessionId });
			ctx.mockDb.createSession({ id: mainSessionId, type: 'space_task_agent' });

			const subSessionId = '550e8400-e29b-41d4-a716-nostart-sub-01';
			await ctx.taskManager.createTask({
				title: 'Sub task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
				taskAgentSessionId: subSessionId,
			});
			ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

			const restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
				const session = makeMockSession(sessionId);
				ctx.createdSessions.set(sessionId, session);
				return session as unknown as AgentSession;
			});

			await ctx.manager.rehydrate();

			// The sub-session stub should NOT have startStreamingQuery called
			const subSession = ctx.createdSessions.get(subSessionId);
			if (subSession) {
				expect(subSession._startCalled).toBe(false);
			}

			restoreSpy.mockRestore();
		});
	});

	// -----------------------------------------------------------------------
	// flushPendingMessagesForSpaceAgent
	// -----------------------------------------------------------------------

	describe('flushPendingMessagesForSpaceAgent', () => {
		test('delivers queued Space Agent message via spaceAgentInjector', async () => {
			const { db: testDb, dir: testDir } = makeDb();
			const testSpaceId = 'space-flush-sa';
			const testRunId = 'run-flush-sa';
			const testWfId = 'wf-flush-sa';
			const now = Date.now();

			seedSpaceRow(testDb, testSpaceId);
			testDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(testWfId, testSpaceId, 'Test WF', now, now);
			testDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(testRunId, testSpaceId, testWfId, now, now);

			const pendingRepo = new PendingAgentMessageRepository(testDb);
			pendingRepo.enqueue({
				workflowRunId: testRunId,
				spaceId: testSpaceId,
				targetKind: 'space_agent',
				targetAgentName: 'space-agent',
				message: 'escalation: please review task',
			});

			const injectedCalls: string[] = [];
			const flushManager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../../src/storage/database.ts').Database,
				sessionManager: ctx.manager[
					'config' as unknown as keyof typeof ctx.manager
				] as unknown as import('../../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService:
					{} as unknown as import('../../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub:
					ctx.daemonHub as unknown as import('../../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				nodeExecutionRepo: ctx.nodeExecutionRepo,
				pendingMessageRepo: pendingRepo,
				spaceAgentInjector: async (_sid: string, msg: string) => {
					injectedCalls.push(msg);
				},
			} as unknown as import('../../../../src/lib/space/runtime/task-agent-manager.ts').TaskAgentManagerConfig);

			await flushManager.flushPendingMessagesForSpaceAgent(testSpaceId, testRunId);

			expect(injectedCalls).toHaveLength(1);
			expect(injectedCalls[0]).toContain('escalation: please review task');

			// Row should be marked delivered
			const rows = pendingRepo.listAllForRun(testRunId);
			expect(rows).toHaveLength(1);
			expect(rows[0].status).toBe('delivered');

			try {
				rmSync(testDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		});

		test('no-op when pendingMessageRepo is absent', async () => {
			// ctx.manager has no pendingMessageRepo — should resolve without throwing
			await expect(
				ctx.manager.flushPendingMessagesForSpaceAgent(ctx.spaceId, 'any-run')
			).resolves.toBeUndefined();
		});

		test('no-op when there are no pending Space Agent messages', async () => {
			const { db: testDb, dir: testDir } = makeDb();
			const testSpaceId = 'space-flush-empty';
			const testRunId = 'run-flush-empty';
			const testWfId = 'wf-flush-empty';
			const now = Date.now();

			seedSpaceRow(testDb, testSpaceId);
			testDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '[]', '{}', ?, ?)`
				)
				.run(testWfId, testSpaceId, 'Test WF', now, now);
			testDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', ?, ?)`
				)
				.run(testRunId, testSpaceId, testWfId, now, now);

			const pendingRepo = new PendingAgentMessageRepository(testDb);
			let injectorCalled = false;

			const emptyManager = new TaskAgentManager({
				db: ctx.mockDb as unknown as import('../../../../src/storage/database.ts').Database,
				sessionManager: ctx.manager[
					'config' as unknown as keyof typeof ctx.manager
				] as unknown as import('../../../../src/lib/session/session-manager.ts').SessionManager,
				spaceManager: ctx.spaceManager,
				spaceAgentManager: ctx.agentManager,
				spaceWorkflowManager: ctx.workflowManager,
				spaceRuntimeService:
					{} as unknown as import('../../../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
				taskRepo: ctx.taskRepo,
				workflowRunRepo: ctx.workflowRunRepo,
				daemonHub:
					ctx.daemonHub as unknown as import('../../../../src/lib/daemon-hub.ts').DaemonHub,
				messageHub: {} as unknown as import('@neokai/shared').MessageHub,
				getApiKey: async () => 'test-key',
				defaultModel: 'claude-sonnet-4-5-20250929',
				nodeExecutionRepo: ctx.nodeExecutionRepo,
				pendingMessageRepo: pendingRepo,
				spaceAgentInjector: async () => {
					injectorCalled = true;
				},
			} as unknown as import('../../../../src/lib/space/runtime/task-agent-manager.ts').TaskAgentManagerConfig);

			await emptyManager.flushPendingMessagesForSpaceAgent(testSpaceId, testRunId);
			expect(injectorCalled).toBe(false);

			try {
				rmSync(testDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		});
	});
});
