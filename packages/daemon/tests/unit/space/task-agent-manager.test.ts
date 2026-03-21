/**
 * Unit tests for TaskAgentManager
 *
 * Covers:
 *   - spawnTaskAgent: basic spawn, idempotency, concurrency guard
 *   - Session ID generation with monotonic suffix on collision
 *   - Sub-session creation via SubSessionFactory
 *   - Completion callback registration and firing
 *   - Sub-session completion propagation to Task Agent
 *   - Message injection (current_turn and next_turn)
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

	emit(event: string, data: Record<string, unknown>): void {
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
	}
}

// ---------------------------------------------------------------------------
// Mock AgentSession factory
// ---------------------------------------------------------------------------

interface MockAgentSession {
	session: { id: string; context?: Record<string, unknown> };
	getProcessingState: () => AgentProcessingState;
	getSDKMessageCount: () => number;
	setRuntimeMcpServers: (servers: Record<string, unknown>) => void;
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
		setRuntimeMcpServers(servers) {
			this._mcpServers = servers;
		},
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
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, Date.now(), Date.now());
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
	agentId: string;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
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
	};

	// Spy on AgentSession.fromInit to return mock sessions
	spyOn(AgentSession, 'fromInit').mockImplementation(
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
	});

	return {
		bunDb,
		dir,
		spaceId,
		space,
		agentId,
		taskRepo,
		workflowRunRepo,
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
				init as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit
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
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

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
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			expect(returnedId).toBe(subSessionId);
		});
	});

	// -----------------------------------------------------------------------
	// SubSessionFactory via spawnTaskAgent's MCP server config
	// -----------------------------------------------------------------------

	describe('SubSessionFactory (created via spawnTaskAgent)', () => {
		test('getProcessingState returns null for unknown session', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			// Access factory indirectly by testing getSubSession
			// The factory is wired into the MCP server; we test getProcessingState
			// by calling the public manager API
			const state = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			)
				.createSubSessionFactory(task.id)
				.getProcessingState('no-such-session');
			expect(state).toBeNull();
		});

		test('getProcessingState returns not-started for fresh session', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:s1`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			const factory = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(task.id);
			const state = factory.getProcessingState(subSessionId);
			// Session exists but has no SDK messages yet → not complete
			expect(state).not.toBeNull();
			expect(state!.isComplete).toBe(false);
		});

		test('getProcessingState returns complete when session has messages and is idle', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const subSessionId = `space:${ctx.spaceId}:task:${task.id}:step:s2`;
			await ctx.manager.createSubSession(task.id, subSessionId, {
				sessionId: subSessionId,
				workspacePath: '/tmp/ws',
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			// Simulate that the sub-session has processed messages
			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 5;
			subSession._processingState = { status: 'idle' } as AgentProcessingState;

			const factory = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(task.id);
			const state = factory.getProcessingState(subSessionId);
			expect(state!.isComplete).toBe(true);
			expect(state!.isProcessing).toBe(false);
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
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			let callbackFired = false;
			const factory = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(task.id);
			factory.onComplete(subSessionId, async () => {
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
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			let callCount = 0;
			const factory = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(task.id);
			factory.onComplete(subSessionId, async () => {
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
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

			let callbackFired = false;
			const factory = (
				ctx.manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(task.id);
			factory.onComplete(subSessionId, async () => {
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
			stepId: string,
			subSessionId: string
		): Promise<void> {
			return (
				manager as unknown as {
					handleSubSessionComplete: (
						taskId: string,
						stepId: string,
						subSessionId: string
					) => Promise<void>;
				}
			).handleSubSessionComplete(taskId, stepId, subSessionId);
		}

		test('marks matching step task as completed', async () => {
			// Seed a workflow, workflow step, and workflow run (needed to satisfy FK constraints)
			const wfRunId = 'wf-run-complete-test';
			const wfId = 'wf-id-complete-test';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_step_id, config, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '{}', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'Test WF', now, now);
			const stepId = 'step-complete-1';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_steps (id, workflow_id, name, description, order_index, created_at, updated_at)
           VALUES (?, ?, ?, '', 0, ?, ?)`
				)
				.run(stepId, wfId, 'Step 1', now, now);
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, current_step_id, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', null, ?, ?)`
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

			// Create the step task with matching workflowRunId, workflowStepId, taskAgentSessionId
			const subSessionId = `space:${ctx.spaceId}:task:${parentTask.id}:step:${stepId}`;
			const stepTask = await ctx.taskManager.createTask({
				title: 'Step task',
				description: 'A step task',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
				workflowStepId: stepId,
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

			// Step task should now be 'completed'
			const updated = ctx.taskRepo.getTask(stepTask.id);
			expect(updated?.status).toBe('completed');
		});

		test('injects [STEP_COMPLETE] notification into Task Agent session', async () => {
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

			// Task Agent should have received a [STEP_COMPLETE] message
			expect(taskAgentSession._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
			const lastMsg =
				taskAgentSession._enqueuedMessages[taskAgentSession._enqueuedMessages.length - 1];
			expect(lastMsg.msg).toContain('[STEP_COMPLETE]');
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
	});

	describe('injectMessageIntoSession — next_turn delivery', () => {
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

		test('saves with "saved" status and does not enqueue when session is processing', async () => {
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

			await callInjectMessage(ctx.manager, session, 'step done', 'next_turn');

			ctx.mockDb.saveUserMessage = originalSave;

			expect(savedStatuses).toEqual(['saved']);
			// No additional enqueue should have happened
			expect(session._enqueuedMessages.length).toBe(enqueuedBefore);
		});

		test('saves with "saved" status when session is waiting_for_input', async () => {
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

			await callInjectMessage(ctx.manager, session, 'step done', 'next_turn');

			ctx.mockDb.saveUserMessage = originalSave;

			expect(savedStatuses).toEqual(['saved']);
			// No additional enqueue should have happened
			expect(session._enqueuedMessages.length).toBe(enqueuedBefore);
		});

		test('saves with "saved" status when session is interrupted (next_turn deferred)', async () => {
			// 'interrupted' is included in isBusy for next_turn delivery.
			// A next_turn message to an interrupted session should be deferred, not sent
			// blindly — the session may restart on its own or receive a current_turn message.
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

			await callInjectMessage(ctx.manager, session, 'check in', 'next_turn');

			ctx.mockDb.saveUserMessage = originalSave;

			expect(savedStatuses).toEqual(['saved']);
			expect(session._enqueuedMessages.length).toBe(enqueuedBefore);
		});

		test('enqueues immediately for current_turn when session is interrupted (restartable)', async () => {
			// An interrupted session can accept a current_turn message: ensureQueryStarted
			// restarts the query and the message is enqueued normally.
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;

			session._processingState = { status: 'interrupted' } as AgentProcessingState;
			const msgsBefore = session._enqueuedMessages.length;

			await callInjectMessage(ctx.manager, session, 'restart signal', 'current_turn');

			expect(session._enqueuedMessages.length).toBeGreaterThan(msgsBefore);
		});

		test('enqueues immediately for next_turn when session is idle', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const session = ctx.createdSessions.get(sessionId)!;
			// session is idle by default

			const msgsBefore = session._enqueuedMessages.length;

			await callInjectMessage(ctx.manager, session, 'idle delivery', 'next_turn');

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
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);
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
			} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit);

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
});
