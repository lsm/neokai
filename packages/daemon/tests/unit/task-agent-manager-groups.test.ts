/**
 * Unit tests for TaskAgentManager — group persistence and event emission
 *
 * Covers:
 *   - spawnTaskAgent creates a group and emits spaceSessionGroup.created
 *   - Sub-session creation adds a member and emits spaceSessionGroup.memberAdded
 *   - Sub-session completion updates member status and emits spaceSessionGroup.memberUpdated
 *   - Sub-session failure sets member status to 'failed' and emits memberUpdated
 *   - Idempotency: spawning same task agent twice does not create duplicate groups
 *   - Cleanup: group state is consistent after cleanup
 *
 * Strategy:
 *   - SpaceSessionGroupRepository is **mocked** (call-recording spy objects) so we
 *     can assert exact method invocations and argument values.
 *   - DaemonHub is implemented as a minimal in-process event bus with an `emitted`
 *     array for easy event assertions.
 *   - Real SQLite DB is used only for space/task data (space_tasks, spaces tables).
 *   - AgentSession.fromInit() is spied upon to return controllable mock sessions.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../src/lib/agent/agent-session.ts';
import type { Space, SpaceTask, SpaceSessionGroup, SpaceSessionGroupMember } from '@neokai/shared';
import type { AgentProcessingState } from '@neokai/shared';
import type {
	CreateSessionGroupParams,
	UpdateSessionGroupParams,
	AddMemberParams,
} from '../../src/storage/repositories/space-session-group-repository.ts';
import type { SubSessionFactory } from '../../src/lib/space/tools/task-agent-tools.ts';
import type { AgentSessionInit } from '../../src/lib/agent/agent-session.ts';

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

	/** Return all emitted events matching the given name */
	eventsOf(name: string): Array<Record<string, unknown>> {
		return this.emitted.filter((e) => e.event === name).map((e) => e.data);
	}
}

// ---------------------------------------------------------------------------
// Mock SpaceSessionGroupRepository
// ---------------------------------------------------------------------------

interface MockGroupRepoCall {
	method: string;
	args: unknown[];
}

class MockSessionGroupRepository {
	/** All calls to any method, in invocation order */
	readonly calls: MockGroupRepoCall[] = [];

	// In-memory store so return values are consistent across calls
	private groups = new Map<string, SpaceSessionGroup>();
	private memberCounter = 0;
	private groupCounter = 0;

	private _recordCall(method: string, args: unknown[]): void {
		this.calls.push({ method, args });
	}

	/** Returns calls to a specific method */
	callsTo(method: string): MockGroupRepoCall[] {
		return this.calls.filter((c) => c.method === method);
	}

	/** Reset all recorded calls */
	resetCalls(): void {
		this.calls.length = 0;
	}

	createGroup(params: CreateSessionGroupParams): SpaceSessionGroup {
		this._recordCall('createGroup', [params]);
		const id = `mock-group-${++this.groupCounter}`;
		const group: SpaceSessionGroup = {
			id,
			spaceId: params.spaceId,
			name: params.name,
			description: params.description ?? null,
			workflowRunId: params.workflowRunId ?? null,
			currentStepId: params.currentStepId ?? null,
			taskId: params.taskId ?? null,
			status: params.status ?? 'active',
			members: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.groups.set(id, group);
		return group;
	}

	getGroup(id: string): SpaceSessionGroup | null {
		this._recordCall('getGroup', [id]);
		return this.groups.get(id) ?? null;
	}

	getGroupsByTask(_spaceId: string, taskId: string): SpaceSessionGroup[] {
		this._recordCall('getGroupsByTask', [_spaceId, taskId]);
		return Array.from(this.groups.values()).filter((g) => g.taskId === taskId);
	}

	addMember(groupId: string, sessionId: string, params: AddMemberParams): SpaceSessionGroupMember {
		this._recordCall('addMember', [groupId, sessionId, params]);
		const memberId = `mock-member-${++this.memberCounter}`;
		const member: SpaceSessionGroupMember = {
			id: memberId,
			groupId,
			sessionId,
			role: params.role,
			agentId: params.agentId ?? null,
			status: params.status ?? 'active',
			orderIndex: params.orderIndex ?? 0,
			createdAt: Date.now(),
		};
		const group = this.groups.get(groupId);
		if (group) {
			group.members.push(member);
		}
		return member;
	}

	getMemberCount(groupId: string): number {
		this._recordCall('getMemberCount', [groupId]);
		return this.groups.get(groupId)?.members.length ?? 0;
	}

	updateMemberStatus(
		memberId: string,
		status: 'active' | 'completed' | 'failed'
	): SpaceSessionGroupMember | null {
		this._recordCall('updateMemberStatus', [memberId, status]);
		for (const group of this.groups.values()) {
			const member = group.members.find((m) => m.id === memberId);
			if (member) {
				member.status = status;
				return member;
			}
		}
		return null;
	}

	updateGroup(id: string, params: UpdateSessionGroupParams): SpaceSessionGroup | null {
		this._recordCall('updateGroup', [id, params]);
		const group = this.groups.get(id);
		if (!group) return null;
		if (params.status !== undefined) group.status = params.status;
		if (params.name !== undefined) group.name = params.name;
		return group;
	}

	deleteGroup(id: string): void {
		this._recordCall('deleteGroup', [id]);
		this.groups.delete(id);
	}

	listActiveGroupsWithTaskId(): Array<{ id: string; taskId: string }> {
		this._recordCall('listActiveGroupsWithTaskId', []);
		return Array.from(this.groups.values())
			.filter((g) => g.status === 'active' && g.taskId != null)
			.map((g) => ({ id: g.id, taskId: g.taskId! }));
	}
}

// ---------------------------------------------------------------------------
// Mock AgentSession
// ---------------------------------------------------------------------------

interface MockAgentSession {
	session: { id: string; context?: Record<string, unknown> };
	getProcessingState: () => AgentProcessingState;
	getSDKMessageCount: () => number;
	getSessionData: () => { id: string };
	setRuntimeMcpServers: (servers: Record<string, unknown>) => void;
	setRuntimeSystemPrompt: (sp: unknown) => void;
	startStreamingQuery: () => Promise<void>;
	ensureQueryStarted: () => Promise<void>;
	handleInterrupt: () => Promise<void>;
	cleanup: () => Promise<void>;
	messageQueue: { enqueueWithId: (id: string, msg: string) => Promise<void> };
	_processingState: AgentProcessingState;
	_sdkMessageCount: number;
	_startCalled: boolean;
	_enqueuedMessages: Array<{ id: string; msg: string }>;
}

function makeMockSession(sessionId: string): MockAgentSession {
	const m: MockAgentSession = {
		session: { id: sessionId },
		_processingState: { status: 'idle' } as AgentProcessingState,
		_sdkMessageCount: 0,
		_startCalled: false,
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
		setRuntimeMcpServers(_s) {},
		setRuntimeSystemPrompt(_sp) {},
		async startStreamingQuery() {
			this._startCalled = true;
		},
		async ensureQueryStarted() {
			this._startCalled = true;
		},
		async handleInterrupt() {},
		async cleanup() {},
		messageQueue: {
			async enqueueWithId(id, msg) {
				m._enqueuedMessages.push({ id, msg });
			},
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
		'test-tam-groups',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, Date.now(), Date.now());
}

function makeSpace(spaceId: string): Space {
	return {
		id: spaceId,
		workspacePath: '/tmp/ws',
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

interface Ctx {
	dir: string;
	spaceId: string;
	space: Space;
	taskManager: SpaceTaskManager;
	taskRepo: SpaceTaskRepository;
	daemonHub: TestDaemonHub;
	groupRepo: MockSessionGroupRepository;
	manager: TaskAgentManager;
	createdSessions: Map<string, MockAgentSession>;
	fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;
}

function makeCtx(): Ctx {
	const { db: bunDb, dir } = makeDb();
	const spaceId = 'space-tam-groups';

	seedSpace(bunDb, spaceId);

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

	// Mock DB that the manager uses for session lifecycle (not task/agent repos)
	const dbSessions = new Map<string, unknown>();
	const mockDb = {
		getSession: (id: string) => dbSessions.get(id) ?? null,
		createSession: (s: unknown) => {
			dbSessions.set((s as { id: string }).id, s);
		},
		deleteSession: (id: string) => {
			dbSessions.delete(id);
		},
		saveUserMessage: (_sid: string, _msg: unknown, _status: string) => 'msg-id',
		updateSession: () => {},
		getDatabase: () => bunDb,
	};

	const sessionManagerDeleteCalls: string[] = [];
	const mockSessionManager = {
		deleteSession: async (id: string) => {
			sessionManagerDeleteCalls.push(id);
		},
		registerSession: (_s: unknown) => {},
	};

	const mockSpaceRuntimeService = {
		createOrGetRuntime: async (_sid: string) => runtime,
	};

	const groupRepo = new MockSessionGroupRepository();
	const createdSessions = new Map<string, MockAgentSession>();

	const fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation(
		(init: unknown, ..._rest: unknown[]) => {
			const { sessionId, context } = init as {
				sessionId: string;
				context?: Record<string, unknown>;
			};
			const mock = makeMockSession(sessionId);
			if (context) mock.session.context = context;
			createdSessions.set(sessionId, mock);
			mockDb.createSession({ id: sessionId });
			return mock as unknown as AgentSession;
		}
	);

	const manager = new TaskAgentManager({
		db: mockDb as unknown as import('../../src/storage/database.ts').Database,
		sessionManager:
			mockSessionManager as unknown as import('../../src/lib/session/session-manager.ts').SessionManager,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		spaceRuntimeService:
			mockSpaceRuntimeService as unknown as import('../../src/lib/space/runtime/space-runtime-service.ts').SpaceRuntimeService,
		taskRepo,
		workflowRunRepo,
		daemonHub: daemonHub as unknown as import('../../src/lib/daemon-hub.ts').DaemonHub,
		messageHub: {} as unknown as import('@neokai/shared').MessageHub,
		getApiKey: async () => 'test-key',
		defaultModel: 'claude-sonnet-4-5-20250929',
		sessionGroupRepo:
			groupRepo as unknown as import('../../src/storage/repositories/space-session-group-repository.ts').SpaceSessionGroupRepository,
	});

	return {
		dir,
		spaceId,
		space,
		taskManager,
		taskRepo,
		daemonHub,
		groupRepo,
		manager,
		createdSessions,
		fromInitSpy,
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

/** Get the SubSessionFactory bound to a taskId from the private method */
function getFactory(manager: TaskAgentManager, taskId: string, spaceId: string): SubSessionFactory {
	return (
		manager as unknown as {
			createSubSessionFactory: (taskId: string, spaceId: string) => SubSessionFactory;
		}
	).createSubSessionFactory(taskId, spaceId);
}

/** Call the private handleSubSessionComplete method */
function callHandleComplete(
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskAgentManager — group persistence and events', () => {
	let ctx: Ctx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.fromInitSpy.mockRestore();
		try {
			rmSync(ctx.dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// -----------------------------------------------------------------------
	// spawnTaskAgent creates group
	// -----------------------------------------------------------------------

	describe('spawnTaskAgent — group creation', () => {
		test('calls createGroup with correct spaceId, name, and taskId', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const createCalls = ctx.groupRepo.callsTo('createGroup');
			expect(createCalls.length).toBe(1);

			const params = createCalls[0].args[0] as CreateSessionGroupParams;
			expect(params.spaceId).toBe(ctx.spaceId);
			expect(params.name).toBe(`task:${task.id}`);
			expect(params.taskId).toBe(task.id);
		});

		test('calls addMember to add the Task Agent as a member with role task-agent', async () => {
			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const addCalls = ctx.groupRepo.callsTo('addMember');
			expect(addCalls.length).toBe(1);

			const [groupId, memberSessionId, params] = addCalls[0].args as [
				string,
				string,
				AddMemberParams,
			];
			expect(typeof groupId).toBe('string');
			expect(memberSessionId).toBe(sessionId);
			expect(params.role).toBe('task-agent');
			expect(params.status).toBe('active');
		});

		test('stores group ID in taskGroupIds map', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id);
			expect(groupId).toBeDefined();
			expect(typeof groupId).toBe('string');
		});

		test('emits spaceSessionGroup.created with correct payload', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const events = ctx.daemonHub.eventsOf('spaceSessionGroup.created');
			expect(events.length).toBe(1);

			const payload = events[0] as {
				sessionId: string;
				spaceId: string;
				taskId: string;
				group: SpaceSessionGroup;
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.spaceId).toBe(ctx.spaceId);
			expect(payload.taskId).toBe(task.id);
			expect(payload.group).toBeDefined();
			expect(payload.group.taskId).toBe(task.id);
		});

		test('emitted spaceSessionGroup.created group includes the task-agent member', async () => {
			const task = await makeTask(ctx.taskManager);
			const taskAgentSessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const events = ctx.daemonHub.eventsOf('spaceSessionGroup.created');
			const group = (events[0] as { group: SpaceSessionGroup }).group;

			expect(Array.isArray(group.members)).toBe(true);
			const taskAgentMember = group.members.find((m) => m.sessionId === taskAgentSessionId);
			expect(taskAgentMember).toBeDefined();
			expect(taskAgentMember!.role).toBe('task-agent');
			expect(taskAgentMember!.status).toBe('active');
		});

		test('spawn still succeeds (non-fatal) when createGroup throws', async () => {
			// Sabotage createGroup
			let createCallCount = 0;
			ctx.groupRepo.createGroup = (...args: unknown[]) => {
				createCallCount++;
				ctx.groupRepo.calls.push({ method: 'createGroup', args });
				throw new Error('DB failure');
			};

			const task = await makeTask(ctx.taskManager);
			const sessionId = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(sessionId).toBeDefined();
			expect(ctx.createdSessions.has(sessionId)).toBe(true);
			expect(createCallCount).toBe(1);
			// No group, no event
			expect(ctx.daemonHub.eventsOf('spaceSessionGroup.created').length).toBe(0);
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();
		});

		test('orphaned group is deleted when addMember throws after createGroup', async () => {
			// Patch addMember to throw after recording the call
			const origAddMember = ctx.groupRepo.addMember.bind(ctx.groupRepo);
			let addMemberCallCount = 0;
			ctx.groupRepo.addMember = (...args: unknown[]) => {
				addMemberCallCount++;
				ctx.groupRepo.calls.push({ method: 'addMember', args });
				throw new Error('addMember failure');
			};

			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(addMemberCallCount).toBe(1);
			// deleteGroup should have been called once to clean up the orphan
			const deleteCalls = ctx.groupRepo.callsTo('deleteGroup');
			expect(deleteCalls.length).toBe(1);
			// No event emitted because addMember failed before emit
			expect(ctx.daemonHub.eventsOf('spaceSessionGroup.created').length).toBe(0);
			// No group in memory map
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();

			void origAddMember; // prevent unused-var warning
		});

		test('no spaceSessionGroup.created event when createGroup throws', async () => {
			ctx.groupRepo.createGroup = (...args: unknown[]) => {
				ctx.groupRepo.calls.push({ method: 'createGroup', args });
				throw new Error('forced');
			};

			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.daemonHub.eventsOf('spaceSessionGroup.created').length).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Idempotency: spawning same task agent twice does not duplicate groups
	// -----------------------------------------------------------------------

	describe('idempotency', () => {
		test('second spawnTaskAgent call returns same session ID', async () => {
			const task = await makeTask(ctx.taskManager);
			const id1 = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			const id2 = await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(id1).toBe(id2);
		});

		test('second spawnTaskAgent call does not call createGroup again', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			ctx.groupRepo.resetCalls();

			// Second spawn — should return immediately from idempotency guard
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.groupRepo.callsTo('createGroup').length).toBe(0);
		});

		test('second spawnTaskAgent call does not emit a second spaceSessionGroup.created', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.daemonHub.eventsOf('spaceSessionGroup.created').length).toBe(1);
		});

		test('spawning two different tasks creates two separate groups', async () => {
			const task1 = await makeTask(ctx.taskManager);
			const task2 = await makeTask(ctx.taskManager);

			await ctx.manager.spawnTaskAgent(task1, ctx.space, null, null);
			await ctx.manager.spawnTaskAgent(task2, ctx.space, null, null);

			const groupId1 = ctx.manager.getTaskGroupId(task1.id);
			const groupId2 = ctx.manager.getTaskGroupId(task2.id);

			expect(groupId1).toBeDefined();
			expect(groupId2).toBeDefined();
			expect(groupId1).not.toBe(groupId2);
			expect(ctx.groupRepo.callsTo('createGroup').length).toBe(2);
			expect(ctx.daemonHub.eventsOf('spaceSessionGroup.created').length).toBe(2);
		});
	});

	// -----------------------------------------------------------------------
	// Sub-session creation adds a member
	// -----------------------------------------------------------------------

	describe('sub-session creation — addMember', () => {
		test('creates sub-session as group member with provided role and agentId', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			ctx.groupRepo.resetCalls();

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-member-test-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ agentId: 'agent-001', role: 'coder' }
			);

			const addCalls = ctx.groupRepo.callsTo('addMember');
			expect(addCalls.length).toBe(1);

			const [groupId, ssId, params] = addCalls[0].args as [string, string, AddMemberParams];
			expect(ssId).toBe(subSessionId);
			expect(params.role).toBe('coder');
			expect(params.agentId).toBe('agent-001');
			expect(params.status).toBe('active');
			expect(typeof groupId).toBe('string');
		});

		test('uses getMemberCount for orderIndex to prevent race conditions', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			ctx.groupRepo.resetCalls();

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			await factory.create(
				{
					sessionId: `sub-oi-1-${task.id}`,
					workspacePath: '/tmp/ws',
				} as AgentSessionInit,
				{ role: 'coder' }
			);

			// getMemberCount should have been called before addMember
			const getMemberCountCalls = ctx.groupRepo.callsTo('getMemberCount');
			const addMemberCalls = ctx.groupRepo.callsTo('addMember');
			expect(getMemberCountCalls.length).toBe(1);
			expect(addMemberCalls.length).toBe(1);

			// The orderIndex in addMember should match what getMemberCount returned
			const addParams = addMemberCalls[0].args[2] as AddMemberParams;
			expect(typeof addParams.orderIndex).toBe('number');
		});

		test('multiple sub-sessions get incremental orderIndex values', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);
			ctx.groupRepo.resetCalls();

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			await factory.create(
				{ sessionId: `sub-oi-a-${task.id}`, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);
			await factory.create(
				{ sessionId: `sub-oi-b-${task.id}`, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'reviewer' }
			);

			const addCalls = ctx.groupRepo.callsTo('addMember');
			expect(addCalls.length).toBe(2);

			const idx0 = (addCalls[0].args[2] as AddMemberParams).orderIndex ?? 0;
			const idx1 = (addCalls[1].args[2] as AddMemberParams).orderIndex ?? 0;
			expect(idx1).toBeGreaterThan(idx0);
		});

		test('emits spaceSessionGroup.memberAdded with correct payload', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-evt-member-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ agentId: 'agent-xyz', role: 'reviewer' }
			);

			const events = ctx.daemonHub.eventsOf('spaceSessionGroup.memberAdded');
			expect(events.length).toBe(1);

			const payload = events[0] as {
				sessionId: string;
				spaceId: string;
				groupId: string;
				member: SpaceSessionGroupMember;
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.spaceId).toBe(ctx.spaceId);
			expect(payload.groupId).toBe(ctx.manager.getTaskGroupId(task.id));
			expect(payload.member.sessionId).toBe(subSessionId);
			expect(payload.member.role).toBe('reviewer');
			expect(payload.member.agentId).toBe('agent-xyz');
			expect(payload.member.status).toBe('active');
		});

		test('addMember failure is non-fatal — sub-session still created', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			// spawnTaskAgent already completed — now patch addMember to throw for sub-sessions
			ctx.groupRepo.addMember = (...args: unknown[]) => {
				ctx.groupRepo.calls.push({ method: 'addMember', args });
				throw new Error('addMember error on sub-session');
			};

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-nonfatal-${task.id}`;
			const result = await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			// Sub-session was still created despite addMember failing
			expect(result).toBe(subSessionId);
			expect(ctx.createdSessions.has(subSessionId)).toBe(true);
			// No memberAdded event because addMember threw before emit
			expect(ctx.daemonHub.eventsOf('spaceSessionGroup.memberAdded').length).toBe(0);
		});

		test('no memberAdded event when no group exists for task', async () => {
			// Create factory without spawning task agent → no group
			const task = await makeTask(ctx.taskManager);
			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);

			await factory.create(
				{ sessionId: `sub-nogroup-${task.id}`, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			// addMember should not have been called (no group to add to)
			expect(ctx.groupRepo.callsTo('addMember').length).toBe(0);
			expect(ctx.daemonHub.eventsOf('spaceSessionGroup.memberAdded').length).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Sub-session completion updates member status
	// -----------------------------------------------------------------------

	describe('sub-session completion — memberUpdated', () => {
		test('handleSubSessionComplete calls updateMemberStatus with "completed"', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-complete-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ agentId: 'agent-coder', role: 'coder' }
			);

			ctx.groupRepo.resetCalls();
			await callHandleComplete(ctx.manager, task.id, 'step-1', subSessionId);

			const updateCalls = ctx.groupRepo.callsTo('updateMemberStatus');
			expect(updateCalls.length).toBe(1);

			const [memberId, status] = updateCalls[0].args as [string, string];
			expect(typeof memberId).toBe('string');
			expect(status).toBe('completed');
		});

		test('emits spaceSessionGroup.memberUpdated with completed status', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-upd-complete-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			await callHandleComplete(ctx.manager, task.id, 'step-1', subSessionId);

			const events = ctx.daemonHub.eventsOf('spaceSessionGroup.memberUpdated');
			expect(events.length).toBe(1);

			const payload = events[0] as {
				sessionId: string;
				spaceId: string;
				groupId: string;
				memberId: string;
				member: SpaceSessionGroupMember;
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.spaceId).toBe(ctx.spaceId);
			expect(payload.member.status).toBe('completed');
			expect(typeof payload.memberId).toBe('string');
		});

		test('member status in mock repo is updated to completed', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-status-complete-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			// Verify initial status
			const before = ctx.groupRepo
				.getGroup(groupId)
				?.members.find((m) => m.sessionId === subSessionId);
			expect(before?.status).toBe('active');

			await callHandleComplete(ctx.manager, task.id, 'step-1', subSessionId);

			// Verify final status
			const after = ctx.groupRepo
				.getGroup(groupId)
				?.members.find((m) => m.sessionId === subSessionId);
			expect(after?.status).toBe('completed');
		});

		test('handleSubSessionComplete with unknown sub-session does not throw', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			await expect(
				callHandleComplete(ctx.manager, task.id, 'step-x', 'no-such-session')
			).resolves.toBeUndefined();

			// No updateMemberStatus called for unknown session
			expect(ctx.groupRepo.callsTo('updateMemberStatus').length).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Sub-session failure sets member status to 'failed'
	// -----------------------------------------------------------------------

	describe('sub-session failure — failed status', () => {
		test('session.error event calls updateMemberStatus with "failed"', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-fail-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			// Register a completion callback to activate the session.error listener
			factory.onComplete(subSessionId, async () => {});

			ctx.groupRepo.resetCalls();
			ctx.daemonHub.emit('session.error', { sessionId: subSessionId, error: 'fatal' });
			await new Promise((r) => setTimeout(r, 10));

			const updateCalls = ctx.groupRepo.callsTo('updateMemberStatus');
			expect(updateCalls.length).toBe(1);
			expect(updateCalls[0].args[1]).toBe('failed');
		});

		test('member status in mock repo is updated to failed after session.error', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-fail-status-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			factory.onComplete(subSessionId, async () => {});

			ctx.daemonHub.emit('session.error', { sessionId: subSessionId, error: 'fatal' });
			await new Promise((r) => setTimeout(r, 10));

			const member = ctx.groupRepo
				.getGroup(groupId)
				?.members.find((m) => m.sessionId === subSessionId);
			expect(member?.status).toBe('failed');
		});

		test('emits spaceSessionGroup.memberUpdated with failed status', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-fail-evt-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			factory.onComplete(subSessionId, async () => {});
			ctx.daemonHub.emit('session.error', { sessionId: subSessionId, error: 'fatal' });
			await new Promise((r) => setTimeout(r, 10));

			const events = ctx.daemonHub.eventsOf('spaceSessionGroup.memberUpdated');
			expect(events.length).toBe(1);

			const payload = events[0] as {
				sessionId: string;
				member: { status: string };
			};
			expect(payload.sessionId).toBe(`space:${ctx.spaceId}`);
			expect(payload.member.status).toBe('failed');
		});

		test('session.error fires only once (fired guard prevents double-update)', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-fail-once-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			factory.onComplete(subSessionId, async () => {});

			ctx.groupRepo.resetCalls();
			// Emit error twice
			ctx.daemonHub.emit('session.error', { sessionId: subSessionId, error: 'fatal' });
			ctx.daemonHub.emit('session.error', { sessionId: subSessionId, error: 'fatal again' });
			await new Promise((r) => setTimeout(r, 10));

			// updateMemberStatus should only be called once (fired guard)
			expect(ctx.groupRepo.callsTo('updateMemberStatus').length).toBe(1);
		});

		test('idle event after session.error does not overwrite failed status', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-fail-then-idle-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			// Simulate session having processed messages
			const subSession = ctx.createdSessions.get(subSessionId)!;
			subSession._sdkMessageCount = 2;

			let completionFired = false;
			factory.onComplete(subSessionId, async () => {
				completionFired = true;
			});

			// Error first → sets fired=true
			ctx.daemonHub.emit('session.error', { sessionId: subSessionId, error: 'fatal' });
			await new Promise((r) => setTimeout(r, 10));

			ctx.groupRepo.resetCalls();

			// Then idle — must NOT trigger updateMemberStatus('completed') or completion callback
			ctx.daemonHub.emit('session.updated', {
				sessionId: subSessionId,
				processingState: { status: 'idle' },
			});
			await new Promise((r) => setTimeout(r, 10));

			expect(completionFired).toBe(false);
			expect(ctx.groupRepo.callsTo('updateMemberStatus').length).toBe(0);

			// Status must still be 'failed'
			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			const member = ctx.groupRepo
				.getGroup(groupId)
				?.members.find((m) => m.sessionId === subSessionId);
			expect(member?.status).toBe('failed');
		});
	});

	// -----------------------------------------------------------------------
	// Cleanup — consistent group state
	// -----------------------------------------------------------------------

	describe('cleanup — group state consistency', () => {
		test('cleanup calls updateGroup with status completed', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			ctx.groupRepo.resetCalls();

			await ctx.manager.cleanup(task.id);

			const updateCalls = ctx.groupRepo.callsTo('updateGroup');
			expect(updateCalls.length).toBe(1);

			const [calledGroupId, params] = updateCalls[0].args as [string, UpdateSessionGroupParams];
			expect(calledGroupId).toBe(groupId);
			expect(params.status).toBe('completed');
		});

		test('cleanup removes taskGroupId from in-memory map', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			expect(ctx.manager.getTaskGroupId(task.id)).toBeDefined();

			await ctx.manager.cleanup(task.id);

			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();
		});

		test('group status in mock repo is completed after cleanup', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			expect(ctx.groupRepo.getGroup(groupId)?.status).toBe('active');

			await ctx.manager.cleanup(task.id);

			expect(ctx.groupRepo.getGroup(groupId)?.status).toBe('completed');
		});

		test('cleanup with no group does not call updateGroup', async () => {
			const task = await makeTask(ctx.taskManager);
			// Do NOT spawn task agent → no group

			await ctx.manager.cleanup(task.id);

			expect(ctx.groupRepo.callsTo('updateGroup').length).toBe(0);
		});

		test('cleanup clears subSessionMemberIds for sub-sessions', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);
			const subSessionId = `sub-cleanup-${task.id}`;
			await factory.create(
				{ sessionId: subSessionId, workspacePath: '/tmp/ws' } as AgentSessionInit,
				{ role: 'coder' }
			);

			await ctx.manager.cleanup(task.id);

			// After cleanup, handleSubSessionComplete for the cleaned-up session should
			// not call updateMemberStatus (memberId was cleared)
			ctx.groupRepo.resetCalls();
			await callHandleComplete(ctx.manager, task.id, 'step-1', subSessionId);

			expect(ctx.groupRepo.callsTo('updateMemberStatus').length).toBe(0);
		});

		test('updateGroup failure during cleanup is non-fatal', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			// Sabotage updateGroup
			ctx.groupRepo.updateGroup = (...args: unknown[]) => {
				ctx.groupRepo.calls.push({ method: 'updateGroup', args });
				throw new Error('updateGroup failure');
			};

			// cleanup should not throw even when updateGroup fails
			await expect(ctx.manager.cleanup(task.id)).resolves.toBeUndefined();

			// taskGroupIds map should still be cleared
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// Full lifecycle: create → add members → complete/fail
	// -----------------------------------------------------------------------

	describe('full lifecycle', () => {
		test('create group → add two sub-sessions → complete both → verify all calls', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);

			const subId1 = `sub-life-1-${task.id}`;
			const subId2 = `sub-life-2-${task.id}`;

			await factory.create({ sessionId: subId1, workspacePath: '/tmp/ws' } as AgentSessionInit, {
				agentId: 'agent-a',
				role: 'coder',
			});
			await factory.create({ sessionId: subId2, workspacePath: '/tmp/ws' } as AgentSessionInit, {
				agentId: 'agent-b',
				role: 'reviewer',
			});

			// Both members are active
			const groupMid = ctx.groupRepo.getGroup(groupId)!;
			const activeBefore = groupMid.members.filter(
				(m) => [subId1, subId2].includes(m.sessionId) && m.status === 'active'
			);
			expect(activeBefore.length).toBe(2);

			// Complete both
			await callHandleComplete(ctx.manager, task.id, 'step-1', subId1);
			await callHandleComplete(ctx.manager, task.id, 'step-2', subId2);

			// Verify both are completed in the repo
			const groupFinal = ctx.groupRepo.getGroup(groupId)!;
			const sub1Member = groupFinal.members.find((m) => m.sessionId === subId1);
			const sub2Member = groupFinal.members.find((m) => m.sessionId === subId2);
			expect(sub1Member?.status).toBe('completed');
			expect(sub2Member?.status).toBe('completed');

			// Two memberUpdated events (one per completion)
			const updatedEvts = ctx.daemonHub.eventsOf('spaceSessionGroup.memberUpdated');
			expect(updatedEvts.length).toBe(2);
			const statuses = updatedEvts.map((e) => (e.member as SpaceSessionGroupMember).status);
			expect(statuses.every((s) => s === 'completed')).toBe(true);

			// Cleanup
			await ctx.manager.cleanup(task.id);

			expect(ctx.groupRepo.getGroup(groupId)?.status).toBe('completed');
			expect(ctx.manager.getTaskGroupId(task.id)).toBeUndefined();
		});

		test('create group → add sub-session → fail → verify failed status', async () => {
			const task = await makeTask(ctx.taskManager);
			await ctx.manager.spawnTaskAgent(task, ctx.space, null, null);

			const groupId = ctx.manager.getTaskGroupId(task.id)!;
			const factory = getFactory(ctx.manager, task.id, ctx.spaceId);

			const subId = `sub-fail-lifecycle-${task.id}`;
			await factory.create({ sessionId: subId, workspacePath: '/tmp/ws' } as AgentSessionInit, {
				role: 'coder',
			});

			factory.onComplete(subId, async () => {});

			ctx.daemonHub.emit('session.error', { sessionId: subId, error: 'fatal error' });
			await new Promise((r) => setTimeout(r, 10));

			const member = ctx.groupRepo.getGroup(groupId)?.members.find((m) => m.sessionId === subId);
			expect(member?.status).toBe('failed');

			// Cleanup still marks group as completed
			await ctx.manager.cleanup(task.id);
			expect(ctx.groupRepo.getGroup(groupId)?.status).toBe('completed');
		});
	});
});
