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
import { SpaceSessionGroupRepository } from '../../../src/storage/repositories/space-session-group-repository.ts';
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
	sessionGroupRepo: SpaceSessionGroupRepository;
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
	const sessionGroupRepo = new SpaceSessionGroupRepository(bunDb);
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
		registerSession: (_agentSession: unknown) => {
			// no-op: unit tests don't exercise cache registration
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
		sessionGroupRepo,
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
		sessionGroupRepo,
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

		test('creates a SpaceSessionGroup in DB with taskId set', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groups = ctx.sessionGroupRepo.getGroupsByTask(ctx.spaceId, task.id);
			expect(groups).toHaveLength(1);
			expect(groups[0].name).toBe(`task:${task.id}`);
			expect(groups[0].taskId).toBe(task.id);
			expect(groups[0].spaceId).toBe(ctx.spaceId);
			expect(groups[0].status).toBe('active');

			// The Task Agent session should be a member with role 'task-agent'
			expect(groups[0].members).toHaveLength(1);
			expect(groups[0].members[0].sessionId).toBe(sessionId);
			expect(groups[0].members[0].role).toBe('task-agent');
			expect(groups[0].members[0].status).toBe('active');
		});

		test('getTaskGroupId returns the group ID after spawn', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id);
			expect(groupId).toBeDefined();

			const group = ctx.sessionGroupRepo.getGroup(groupId!);
			expect(group).not.toBeNull();
			expect(group!.taskId).toBe(task.id);
		});

		test('cleanup removes taskGroupId from in-memory map and marks group completed', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			expect(groupId).toBeDefined();

			await ctx.manager.cleanup(task.id);

			// In-memory map cleared
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();

			// DB group marked completed
			const group = ctx.sessionGroupRepo.getGroup(groupId);
			expect(group?.status).toBe('completed');
		});

		test('spawn still succeeds when createGroup throws (non-fatal)', async () => {
			// Patch createGroup to throw
			const origCreate = ctx.sessionGroupRepo.createGroup.bind(ctx.sessionGroupRepo);
			let callCount = 0;
			ctx.sessionGroupRepo.createGroup = () => {
				callCount++;
				throw new Error('DB error');
			};

			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			// Task agent session created normally
			expect(sessionId).toBe(`space:${ctx.spaceId}:task:${task.id}`);
			expect(ctx.createdSessions.has(sessionId)).toBe(true);
			// Group not recorded since createGroup threw
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();
			// createGroup was called
			expect(callCount).toBe(1);

			// Restore
			ctx.sessionGroupRepo.createGroup = origCreate;
		});

		test('no orphaned group when addMember throws after createGroup succeeds', async () => {
			// Patch addMember to throw
			const origAdd = ctx.sessionGroupRepo.addMember.bind(ctx.sessionGroupRepo);
			ctx.sessionGroupRepo.addMember = () => {
				throw new Error('addMember error');
			};

			const task = await makeTask(ctx.taskManager);
			// Spawn still succeeds (non-fatal)
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			expect(sessionId).toBeDefined();

			// No group persisted (orphan was deleted)
			const groups = ctx.sessionGroupRepo.getGroupsByTask(ctx.spaceId, task.id);
			expect(groups).toHaveLength(0);
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();

			// Restore
			ctx.sessionGroupRepo.addMember = origAdd;
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
	// Sub-session group membership
	// -----------------------------------------------------------------------

	describe('sub-session group membership', () => {
		/** Helper: get the SubSessionFactory bound to a taskId via the private method */
		function getFactory(
			manager: TaskAgentManager,
			taskId: string
		): import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory {
			return (
				manager as unknown as {
					createSubSessionFactory: (
						taskId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(taskId);
		}

		test('sub-session is added as group member with correct role and agentId', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id);
			expect(groupId).toBeDefined();

			const subSessionId = `sub-session-member-test-${task.id}`;
			const factory = getFactory(ctx.manager, task.id);
			const actualId = await factory.create(
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			// The factory returns the session ID unchanged
			expect(actualId).toBe(subSessionId);

			// The group should now contain the sub-session as a member
			const group = ctx.sessionGroupRepo.getGroup(groupId!);
			const member = group?.members.find((m) => m.sessionId === subSessionId);
			expect(member).toBeDefined();
			expect(member?.agentId).toBe(ctx.agentId);
			expect(member?.role).toBe('coder');
			expect(member?.status).toBe('active');
		});

		test('multiple sub-sessions for same task all appear in the same group', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id);
			expect(groupId).toBeDefined();

			const factory = getFactory(ctx.manager, task.id);
			const subId1 = `sub-multi-1-${task.id}`;
			const subId2 = `sub-multi-2-${task.id}`;

			await factory.create(
				{
					sessionId: subId1,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);
			await factory.create(
				{
					sessionId: subId2,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'reviewer' }
			);

			const group = ctx.sessionGroupRepo.getGroup(groupId!);
			const subMembers = group?.members.filter((m) => [subId1, subId2].includes(m.sessionId));
			expect(subMembers?.length).toBe(2);

			// orderIndex should be incremental
			const indices = subMembers!.map((m) => m.orderIndex).sort((a, b) => a - b);
			expect(indices[0]).toBeLessThan(indices[1]);
		});

		test('member status transitions to completed when handleSubSessionComplete fires', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id);
			const factory = getFactory(ctx.manager, task.id);
			const subSessionId = `sub-complete-test-${task.id}`;

			await factory.create(
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			// Verify initial status is 'active'
			const beforeGroup = ctx.sessionGroupRepo.getGroup(groupId!);
			const memberBefore = beforeGroup?.members.find((m) => m.sessionId === subSessionId);
			expect(memberBefore?.status).toBe('active');

			// Call handleSubSessionComplete to trigger the status update
			await (
				ctx.manager as unknown as {
					handleSubSessionComplete: (
						taskId: string,
						stepId: string,
						subSessionId: string
					) => Promise<void>;
				}
			).handleSubSessionComplete(task.id, 'step-1', subSessionId);

			// Member status should now be 'completed'
			const afterGroup = ctx.sessionGroupRepo.getGroup(groupId!);
			const memberAfter = afterGroup?.members.find((m) => m.sessionId === subSessionId);
			expect(memberAfter?.status).toBe('completed');
		});

		test('member status transitions to failed on session.error event', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id);
			const factory = getFactory(ctx.manager, task.id);
			const subSessionId = `sub-error-test-${task.id}`;

			await factory.create(
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			// Register a completion callback so the error listener is set up
			factory.onComplete(subSessionId, async () => {});

			// Emit a session.error event
			ctx.daemonHub.emit('session.error', {
				sessionId: subSessionId,
				error: 'Fatal API error',
			});

			await new Promise((r) => setTimeout(r, 0));

			// Member status should now be 'failed'
			const group = ctx.sessionGroupRepo.getGroup(groupId!);
			const member = group?.members.find((m) => m.sessionId === subSessionId);
			expect(member?.status).toBe('failed');
		});

		test('idle event after session.error does not overwrite failed status with completed', async () => {
			// If session.error fires first (setting fired=true), a subsequent
			// session.updated → idle must NOT call handleSubSessionComplete.
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id);
			const factory = getFactory(ctx.manager, task.id);
			const subSessionId = `sub-error-then-idle-${task.id}`;

			await factory.create(
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			// Simulate that the sub-session has processed messages
			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 2;

			// Register a completion callback so listeners are set up
			let completionCallbackFired = false;
			factory.onComplete(subSessionId, async () => {
				completionCallbackFired = true;
			});

			// Emit session.error — sets fired=true and marks member as 'failed'
			ctx.daemonHub.emit('session.error', {
				sessionId: subSessionId,
				error: 'Fatal API error',
			});
			await new Promise((r) => setTimeout(r, 0));

			// Member should be 'failed'
			const groupAfterError = ctx.sessionGroupRepo.getGroup(groupId!);
			const memberAfterError = groupAfterError?.members.find((m) => m.sessionId === subSessionId);
			expect(memberAfterError?.status).toBe('failed');

			// Now emit idle — should NOT fire the completion callback or change the status
			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});
			await new Promise((r) => setTimeout(r, 0));

			// Completion callback must not have fired (fired guard blocked it)
			expect(completionCallbackFired).toBe(false);

			// Status must remain 'failed', not overwritten with 'completed'
			const groupAfterIdle = ctx.sessionGroupRepo.getGroup(groupId!);
			const memberAfterIdle = groupAfterIdle?.members.find((m) => m.sessionId === subSessionId);
			expect(memberAfterIdle?.status).toBe('failed');
		});

		test('addMember is non-fatal — sub-session is still created when group not found', async () => {
			// Create a task but do NOT spawn its Task Agent (so no group is created).
			const task = await makeTask(ctx.taskManager);

			// The factory is created directly without spawning the task agent,
			// meaning taskGroupIds will not have an entry for this task.
			const factory = getFactory(ctx.manager, task.id);
			const subSessionId = `sub-no-group-${task.id}`;

			// Should succeed without throwing even though there is no group
			await expect(
				factory.create(
					{
						sessionId: subSessionId,
						workspacePath: '/tmp/ws',
					} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
					{ agentId: ctx.agentId, role: 'coder' }
				)
			).resolves.toBe(subSessionId);
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
			status: 'in_progress' | 'needs_attention' = 'in_progress'
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
			const { task, agentSessionId } = await seedInProgressTask(ctx, 'needs_attention');

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
					`INSERT INTO space_workflows (id, space_id, name, description, start_step_id, config, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '{}', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF Reorient', now, now);
			const wfRunId = 'run-reorient-workflow';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, current_step_id, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', null, ?, ?)`
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
			// Workflow tasks should reference check_step_status to resume the workflow
			expect(msgs.some((m) => m.includes('check_step_status'))).toBe(true);
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
				status: 'completed',
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
			const { task: task2 } = await seedInProgressTask(ctx, 'needs_attention');

			await ctx.manager.rehydrate();

			expect(ctx.manager.getTaskAgent(task1.id)).toBeDefined();
			expect(ctx.manager.getTaskAgent(task2.id)).toBeDefined();
		});

		test('rebuilds subSessions map from workflow run step tasks', async () => {
			// Seed a workflow run so we can test sub-session map rebuild
			const wfId = 'wf-rehydrate-sub';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_step_id, config, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '{}', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF Rehydrate Sub', now, now);
			const stepId = 'step-rehydrate-1';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_steps (id, workflow_id, name, description, agent_id, order_index, config, created_at, updated_at)
           VALUES (?, ?, ?, '', ?, 0, null, ?, ?)`
				)
				.run(stepId, wfId, 'Step 1', ctx.agentId, now, now);
			const wfRunId = 'run-rehydrate-sub';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, current_step_id, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', null, ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			// Create main task for the run
			const mainTask = await ctx.taskManager.createTask({
				title: 'Main task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
			});
			const mainSessionId = `space:${ctx.spaceId}:task:${mainTask.id}`;
			ctx.taskRepo.updateTask(mainTask.id, { taskAgentSessionId: mainSessionId });
			ctx.mockDb.createSession({ id: mainSessionId, type: 'space_task_agent' });

			// Create a step task with a UUID sub-session
			const subSessionId = '550e8400-e29b-41d4-a716-sub-session-01';
			const stepTask = await ctx.taskManager.createTask({
				title: 'Step task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
				workflowStepId: stepId,
				taskAgentSessionId: subSessionId,
			});
			ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

			// Mock AgentSession.restore to return a session for the sub-session
			const restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
				const session = makeMockSession(sessionId);
				ctx.createdSessions.set(sessionId, session);
				return session as unknown as AgentSession;
			});

			await ctx.manager.rehydrate();

			// Sub-session should be in the subSessions map for the main task
			expect(ctx.manager.getSubSession(subSessionId)).toBeDefined();

			restoreSpy.mockRestore();
			// avoid unused var warning
			void stepTask;
		});

		test('does not restart streaming for sub-sessions during rehydration', async () => {
			// Sub-sessions in the map after rehydration should NOT have _startCalled = true
			// (they are stubs that the Task Agent will re-spawn as needed)
			const wfId = 'wf-rehydrate-no-start';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_step_id, config, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '{}', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF Sub No Start', now, now);
			const wfRunId = 'run-rehydrate-no-start';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, current_step_id, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', null, ?, ?)`
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

		test('step-agent MCP server is re-attached on rehydrated sub-sessions', async () => {
			// Seed a workflow run so sub-sessions are rebuilt
			const wfId = 'wf-rehydrate-step-mcp';
			const now = Date.now();
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflows (id, space_id, name, description, start_step_id, config, layout, created_at, updated_at)
           VALUES (?, ?, ?, '', null, '{}', '{}', ?, ?)`
				)
				.run(wfId, ctx.spaceId, 'WF Step MCP', now, now);
			const wfRunId = 'run-rehydrate-step-mcp';
			ctx.bunDb
				.prepare(
					`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, current_step_id, created_at, updated_at)
           VALUES (?, ?, ?, '', 'in_progress', null, ?, ?)`
				)
				.run(wfRunId, ctx.spaceId, wfId, now, now);

			const mainTask = await ctx.taskManager.createTask({
				title: 'Main task step-mcp',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
			});
			const mainSessionId = `space:${ctx.spaceId}:task:${mainTask.id}`;
			ctx.taskRepo.updateTask(mainTask.id, { taskAgentSessionId: mainSessionId });
			ctx.mockDb.createSession({ id: mainSessionId, type: 'space_task_agent' });

			// Create a sub-session task
			const subSessionId = '550e8400-e29b-41d4-a716-step-mcp-sub01';
			await ctx.taskManager.createTask({
				title: 'Sub task step-mcp',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
				workflowRunId: wfRunId,
				taskAgentSessionId: subSessionId,
			});
			ctx.mockDb.createSession({ id: subSessionId, type: 'worker' });

			// Create a group and add the sub-session as a member with role 'coder'
			const group = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${mainTask.id}`,
				taskId: mainTask.id,
			});
			ctx.sessionGroupRepo.addMember(group.id, mainSessionId, {
				role: 'task-agent',
				status: 'active',
				orderIndex: 0,
			});
			ctx.sessionGroupRepo.addMember(group.id, subSessionId, {
				role: 'coder',
				status: 'active',
				orderIndex: 1,
			});

			const restoreSpy = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
				const session = makeMockSession(sessionId);
				ctx.createdSessions.set(sessionId, session);
				return session as unknown as AgentSession;
			});

			await ctx.manager.rehydrate();

			// The rehydrated sub-session should have the step-agent MCP server attached
			const subSession = ctx.createdSessions.get(subSessionId)!;
			expect(subSession).toBeDefined();
			expect(Object.keys(subSession._mcpServers)).toContain('step-agent');

			restoreSpy.mockRestore();
		});

		test('taskGroupIds is restored from DB after rehydration', async () => {
			const { task } = await seedInProgressTask(ctx);

			// Seed a session group in the DB as if it was created during the original spawn
			const group = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${task.id}`,
				taskId: task.id,
			});

			await ctx.manager.rehydrate();

			// getTaskGroupId should return the persisted group ID
			expect(ctx.manager.getTaskGroupId(task.id)).toBe(group.id);
		});
	});

	// -----------------------------------------------------------------------
	// rehydrateGroupMaps — dedicated group map rebuild
	// -----------------------------------------------------------------------

	describe('rehydrateGroupMaps (via rehydrate)', () => {
		// Uses the scoped restore spy from the outer rehydrate describe so that
		// rehydrateTaskAgent() does not fail when restoring sessions. We reset
		// it here independently to keep tests self-contained.
		let restoreSpyScoped: ReturnType<typeof spyOn<typeof AgentSession, 'restore'>>;

		beforeEach(() => {
			restoreSpyScoped = spyOn(AgentSession, 'restore').mockImplementation((sessionId: string) => {
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

		test('rebuilds taskGroupIds map for multiple active groups on restart', async () => {
			// Simulate two tasks that each had a group created during a previous daemon run.
			// The in-memory map is empty (fresh manager, simulating daemon restart).
			const task1 = await ctx.taskManager.createTask({
				title: 'Task 1',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
			});
			const task2 = await ctx.taskManager.createTask({
				title: 'Task 2',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
			});

			const group1 = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${task1.id}`,
				taskId: task1.id,
			});
			const group2 = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${task2.id}`,
				taskId: task2.id,
			});

			// Before rehydrate: map is empty
			expect(ctx.manager.getTaskGroupId(task1.id)).toBeUndefined();
			expect(ctx.manager.getTaskGroupId(task2.id)).toBeUndefined();

			// rehydrate() calls rehydrateGroupMaps() internally
			await ctx.manager.rehydrate();

			// After rehydrate: both groups should be in the map
			expect(ctx.manager.getTaskGroupId(task1.id)).toBe(group1.id);
			expect(ctx.manager.getTaskGroupId(task2.id)).toBe(group2.id);
		});

		test('standalone groups (no taskId) are skipped without error', async () => {
			// A group with no task_id is a standalone group — nothing to map
			ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: 'standalone-group',
				// No taskId
			});

			// Should not throw
			await expect(ctx.manager.rehydrate()).resolves.toBeUndefined();
		});

		test('groups with no active members are still rehydrated', async () => {
			// A group that exists but has no members is still a valid group with a taskId
			const task = await ctx.taskManager.createTask({
				title: 'Empty group task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
			});
			const group = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${task.id}`,
				taskId: task.id,
			});
			// group has zero members (no addMember call)

			await ctx.manager.rehydrate();

			// Map should still be populated
			expect(ctx.manager.getTaskGroupId(task.id)).toBe(group.id);
		});

		test('completed groups are not included in the map', async () => {
			// A group marked 'completed' should NOT be rehydrated into the active map
			const task = await ctx.taskManager.createTask({
				title: 'Completed group task',
				description: '',
				taskType: 'coding',
				status: 'completed',
			});
			const group = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${task.id}`,
				taskId: task.id,
				status: 'completed',
			});
			void group;

			await ctx.manager.rehydrate();

			// Completed group should NOT appear in the map
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();
		});

		test('existing map entries are not overwritten by rehydrateGroupMaps', async () => {
			// If spawnTaskAgent() already populated taskGroupIds before rehydrate() runs,
			// the in-memory value takes precedence over the DB row.
			const task = await ctx.taskManager.createTask({
				title: 'Pre-spawned task',
				description: '',
				taskType: 'coding',
				status: 'in_progress',
			});

			// Spawn first — this creates the group and sets taskGroupIds
			const agentSessionId = `space:${ctx.spaceId}:task:${task.id}`;
			ctx.taskRepo.updateTask(task.id, { taskAgentSessionId: agentSessionId });
			ctx.mockDb.createSession({ id: agentSessionId, type: 'space_task_agent' });
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupIdAfterSpawn = ctx.manager.getTaskGroupId(task.id);
			expect(groupIdAfterSpawn).toBeDefined();

			// Create a second group for the same task (simulates stale DB row from old run)
			const staleGroup = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${task.id}:old`,
				taskId: task.id,
			});
			void staleGroup;

			// rehydrate() should not overwrite the already-set entry
			await ctx.manager.rehydrate();

			// Value should remain the one set by spawnTaskAgent, not the stale group
			expect(ctx.manager.getTaskGroupId(task.id)).toBe(groupIdAfterSpawn);
		});

		test('rehydrateGroupMaps is called even when no tasks need session rehydration', async () => {
			// All tasks are completed — no Task Agent sessions to restore.
			// But if there are active groups, the map should still be populated.
			const task = await ctx.taskManager.createTask({
				title: 'Active group, no session rehydration',
				description: '',
				taskType: 'coding',
				status: 'completed', // completed = not rehydrated as session
			});
			const group = ctx.sessionGroupRepo.createGroup({
				spaceId: ctx.spaceId,
				name: `task:${task.id}`,
				taskId: task.id,
				status: 'active', // group is still active (cleanup may have missed it)
			});

			await ctx.manager.rehydrate();

			// Group map should be populated even though the task session was not rehydrated
			expect(ctx.manager.getTaskGroupId(task.id)).toBe(group.id);
		});
	});

	// -----------------------------------------------------------------------
	// Event emission (Task 2.3)
	// -----------------------------------------------------------------------

	describe('event emission', () => {
		/** Helper: get the SubSessionFactory bound to a taskId via the private method */
		function getFactory(
			manager: TaskAgentManager,
			taskId: string
		): import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory {
			return (
				manager as unknown as {
					createSubSessionFactory: (
						taskId: string,
						spaceId: string
					) => import('../../../src/lib/space/tools/task-agent-tools.ts').SubSessionFactory;
				}
			).createSubSessionFactory(taskId, ctx.spaceId);
		}

		test('spaceSessionGroup.created emitted after spawnTaskAgent', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const events = ctx.daemonHub.emitted.filter((e) => e.event === 'spaceSessionGroup.created');
			expect(events.length).toBe(1);

			const payload = events[0].data as {
				sessionId: string;
				spaceId: string;
				taskId: string;
				group: { id: string; members: unknown[] };
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.spaceId).toBe(ctx.spaceId);
			expect(payload.taskId).toBe(task.id);
			expect(payload.group).toBeDefined();
			// Group should include the task-agent member
			expect(Array.isArray(payload.group.members)).toBe(true);
			expect(payload.group.members.length).toBeGreaterThan(0);
		});

		test('spaceSessionGroup.created uses space-specific channel', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const evt = ctx.daemonHub.emitted.find((e) => e.event === 'spaceSessionGroup.created');
			expect(evt?.data.sessionId).toBe(`space:${ctx.spaceId}`);
		});

		test('spaceSessionGroup.memberAdded emitted when sub-session is created', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id);
			const subSessionId = `sub-event-test-${task.id}`;
			await factory.create(
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			const events = ctx.daemonHub.emitted.filter(
				(e) => e.event === 'spaceSessionGroup.memberAdded'
			);
			expect(events.length).toBe(1);

			const payload = events[0].data as {
				sessionId: string;
				spaceId: string;
				groupId: string;
				member: { sessionId: string; role: string; agentId?: string; status: string };
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.spaceId).toBe(ctx.spaceId);
			expect(payload.groupId).toBe(ctx.manager.getTaskGroupId(task.id));
			expect(payload.member.sessionId).toBe(subSessionId);
			expect(payload.member.role).toBe('coder');
			expect(payload.member.agentId).toBe(ctx.agentId);
			expect(payload.member.status).toBe('active');
		});

		test('spaceSessionGroup.memberUpdated emitted when sub-session completes', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id);
			const subSessionId = `sub-complete-event-${task.id}`;
			await factory.create(
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			// Simulate completion via handleSubSessionComplete (private method)
			const handleComplete = (
				ctx.manager as unknown as {
					handleSubSessionComplete: (
						taskId: string,
						stepId: string,
						subSessionId: string
					) => Promise<void>;
				}
			).handleSubSessionComplete;
			await handleComplete.call(ctx.manager, task.id, 'step-1', subSessionId);

			const events = ctx.daemonHub.emitted.filter(
				(e) => e.event === 'spaceSessionGroup.memberUpdated'
			);
			expect(events.length).toBe(1);

			const payload = events[0].data as {
				sessionId: string;
				spaceId: string;
				groupId: string;
				memberId: string;
				member: { status: string };
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.spaceId).toBe(ctx.spaceId);
			expect(payload.member.status).toBe('completed');
		});

		test('spaceSessionGroup.memberUpdated emitted when sub-session errors', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id);
			const subSessionId = `sub-error-event-${task.id}`;
			await factory.create(
				{
					sessionId: subSessionId,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			// Register a completion callback to activate the session.error listener
			factory.onComplete(subSessionId, async () => {});

			// Simulate session error via DaemonHub event
			ctx.daemonHub.emit('session.error', {
				sessionId: subSessionId,
				error: 'test error',
			});

			// Wait a tick for the async handler to fire
			await new Promise((resolve) => setTimeout(resolve, 10));

			const events = ctx.daemonHub.emitted.filter(
				(e) => e.event === 'spaceSessionGroup.memberUpdated'
			);
			expect(events.length).toBe(1);

			const payload = events[0].data as {
				sessionId: string;
				spaceId: string;
				member: { status: string };
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.member.status).toBe('failed');
		});

		test('spaceSessionGroup.memberAdded uses space-specific channel', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id);
			await factory.create(
				{
					sessionId: `sub-channel-test-${task.id}`,
					workspacePath: '/tmp/ws',
				} as unknown as import('../../../src/lib/agent/agent-session.ts').AgentSessionInit,
				{ agentId: ctx.agentId, role: 'coder' }
			);

			const evt = ctx.daemonHub.emitted.find((e) => e.event === 'spaceSessionGroup.memberAdded');
			expect(evt?.data.sessionId).toBe(`space:${ctx.spaceId}`);
		});

		test('no spaceSessionGroup.created event when group creation fails', async () => {
			// Sabotage sessionGroupRepo.createGroup to throw
			let callCount = 0;
			ctx.sessionGroupRepo.createGroup = (..._args) => {
				callCount++;
				throw new Error('forced failure');
			};

			const task = await makeTask(ctx.taskManager);
			// Should not throw — group creation is non-fatal
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(callCount).toBe(1);
			const events = ctx.daemonHub.emitted.filter((e) => e.event === 'spaceSessionGroup.created');
			expect(events.length).toBe(0);
		});
	});
});
