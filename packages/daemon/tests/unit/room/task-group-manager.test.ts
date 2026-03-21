import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	TaskGroupManager,
	type SessionFactory,
	type WorkerConfig,
} from '../../../src/lib/room/runtime/task-group-manager';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { SessionObserver } from '../../../src/lib/room/state/session-observer';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';
import type { LeaderToolCallbacks } from '../../../src/lib/room/agents/leader-agent';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

// Mock DaemonHub
function createMockDaemonHub() {
	const handlers = new Map<string, Map<string | undefined, Array<(data: unknown) => void>>>();
	return {
		on(
			event: string,
			handler: (data: unknown) => void,
			options?: { sessionId?: string }
		): () => void {
			if (!handlers.has(event)) {
				handlers.set(event, new Map());
			}
			const eventHandlers = handlers.get(event)!;
			const key = options?.sessionId;
			if (!eventHandlers.has(key)) {
				eventHandlers.set(key, []);
			}
			eventHandlers.get(key)!.push(handler);
			return () => {
				const list = eventHandlers.get(key);
				if (list) {
					const idx = list.indexOf(handler);
					if (idx !== -1) list.splice(idx, 1);
				}
			};
		},
	};
}

// Mock SessionFactory
function createMockSessionFactory(
	initialLiveSessions: string[] = [],
	options?: { restoreSessionFails?: boolean }
) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const liveSessions = new Set<string>(initialLiveSessions);
	const removedWorktrees: string[] = [];
	return {
		calls,
		liveSessions,
		removedWorktrees,
		async createAndStartSession(init: unknown, role: string) {
			calls.push({ method: 'createAndStartSession', args: [init, role] });
			const sessionId =
				typeof init === 'object' && init !== null && 'sessionId' in init
					? ((init as { sessionId?: string }).sessionId ?? null)
					: null;
			if (sessionId) liveSessions.add(sessionId);
		},
		async injectMessage(
			sessionId: string,
			message: string,
			opts?: { deliveryMode?: 'current_turn' | 'next_turn' }
		) {
			calls.push({ method: 'injectMessage', args: [sessionId, message, opts] });
		},
		hasSession(sessionId: string) {
			return liveSessions.has(sessionId);
		},
		async answerQuestion(_sessionId: string, _answer: string) {
			return false;
		},
		async createWorktree(_basePath: string, sessionId: string, _branchName?: string) {
			// Return a synthetic worktree path so isolation enforcement passes in tests
			return `/tmp/worktrees/${sessionId}`;
		},
		async removeWorktree(workspacePath: string) {
			calls.push({ method: 'removeWorktree', args: [workspacePath] });
			removedWorktrees.push(workspacePath);
			return true;
		},
		async restoreSession(sessionId: string) {
			calls.push({ method: 'restoreSession', args: [sessionId] });
			// If restore fails (simulating session not in DB), don't add to liveSessions
			if (options?.restoreSessionFails) {
				return false;
			}
			liveSessions.add(sessionId);
			return true;
		},
		async startSession(sessionId: string) {
			calls.push({ method: 'startSession', args: [sessionId] });
			return true;
		},
		setSessionMcpServers(_sessionId: string, _mcpServers: Record<string, unknown>) {
			return true;
		},
	} satisfies SessionFactory & {
		calls: Array<{ method: string; args: unknown[] }>;
		liveSessions: Set<string>;
		removedWorktrees: string[];
	};
}

function createMockLeaderCallbacks(): LeaderToolCallbacks {
	return {
		async sendToWorker() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
		async completeTask() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
		async failTask() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
		async replanGoal() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
		async submitForReview() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
	};
}

function makeRoom(): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeGoal(db: Database): RoomGoal {
	const now = Date.now();
	db.prepare(
		`INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'goal-1',
		'room-1',
		'Health check',
		'Add health endpoint',
		'active',
		'normal',
		0,
		'[]',
		'{}',
		now,
		now
	);
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Health check',
		description: 'Add health endpoint',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		createdAt: now,
		updatedAt: now,
	};
}

function makeDefaultWorkerConfig(): WorkerConfig {
	return {
		role: 'coder',
		initFactory: (workerSessionId) => ({
			sessionId: workerSessionId,
			workspacePath: '/workspace',
			systemPrompt: 'test',
			type: 'coder',
			model: 'claude-sonnet-4-5-20250929',
		}),
		taskMessage: 'Test task: Add health endpoint\n\nBegin working on this task.',
	};
}

describe('TaskGroupManager', () => {
	let db: Database;
	let groupRepo: SessionGroupRepository;
	let observer: SessionObserver;
	let taskManager: TaskManager;
	let goalManager: GoalManager;
	let sessionFactory: ReturnType<typeof createMockSessionFactory>;
	let manager: TaskGroupManager;
	const room = makeRoom();

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE goals (
				id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
				priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]', metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0, goal_review_attempts INTEGER DEFAULT 0,
				mission_type TEXT NOT NULL DEFAULT 'one_shot'
					CHECK(mission_type IN ('one_shot', 'measurable', 'recurring')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised'
					CHECK(autonomy_level IN ('supervised', 'semi_autonomous')),
				schedule TEXT,
				schedule_paused INTEGER NOT NULL DEFAULT 0,
				next_run_at INTEGER,
				structured_metrics TEXT,
				max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
				max_planning_attempts INTEGER NOT NULL DEFAULT 5,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
		replan_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
				description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER,
				current_step TEXT, result TEXT, error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				created_by_task_id TEXT,
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				updated_at INTEGER
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY, group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_worker',
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL, completed_at INTEGER
			);
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
			CREATE TABLE task_group_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				payload_json TEXT,
				created_at INTEGER NOT NULL
			);
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${Date.now()}, ${Date.now()});
		`);

		const mockHub = createMockDaemonHub();
		groupRepo = new SessionGroupRepository(db as never);
		observer = new SessionObserver(mockHub as unknown as DaemonHub);
		taskManager = new TaskManager(db as never, 'room-1');
		goalManager = new GoalManager(db as never, 'room-1');
		sessionFactory = createMockSessionFactory();

		const room = makeRoom();
		manager = new TaskGroupManager({
			groupRepo,
			sessionObserver: observer,
			taskManager,
			goalManager,
			sessionFactory,
			workspacePath: '/workspace',
			getRoom: (roomId) => (roomId === 'room-1' ? room : null),
			getTask: (taskId) => taskManager.getTask(taskId),
			getGoal: (goalId) => goalManager.getGoal(goalId),
		});
	});

	afterEach(() => {
		observer.dispose();
		db.close();
	});

	async function createTask(): Promise<NeoTask> {
		return taskManager.createTask({
			title: 'Add health endpoint',
			description: 'GET /health returning 200',
		});
	}

	describe('spawn', () => {
		it('should create a session group record', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			expect(group).toBeDefined();
			expect(group.taskId).toBe(task.id);
			expect(group.submittedForReview).toBe(false);
			expect(group.feedbackIteration).toBe(0);
		});

		it('should create both Worker and Leader sessions eagerly', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const workerCalls = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'coder'
			);
			const leaderCalls = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			);
			// Both worker and leader start immediately — eager initialization
			expect(workerCalls).toHaveLength(1);
			expect(leaderCalls).toHaveLength(1);
		});

		it('should set task to in_progress', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const updated = await taskManager.getTask(task.id);
			expect(updated!.status).toBe('in_progress');
		});

		it('should observe both worker and leader session IDs', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			expect(observer.isObserving(group.workerSessionId)).toBe(true);
			// Leader session is created eagerly alongside the worker, so it is observed immediately.
			expect(observer.isObserving(group.leaderSessionId)).toBe(true);
		});

		it('should persist deferred leader bootstrap config in group metadata', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				{
					...makeDefaultWorkerConfig(),
					leaderTaskContext: 'Goal context for leader',
				},
				'code_review'
			);

			const persisted = groupRepo.getGroup(group.id)!;
			expect(persisted.deferredLeader).toEqual({
				roomId: room.id,
				goalId: goal.id,
				reviewContext: 'code_review',
				leaderTaskContext: 'Goal context for leader',
				eagerlyCreated: true,
			});
		});

		it('should persist null goalId in deferred leader config for goal-free tasks', async () => {
			const task = await createTask();
			const callbacks = createMockLeaderCallbacks();

			const group = await manager.spawn(
				room,
				task,
				null, // no goal
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const persisted = groupRepo.getGroup(group.id)!;
			expect(persisted.deferredLeader?.goalId).toBeNull();
		});

		it('should register worker observer before injecting the initial message', async () => {
			// Regression test: verifies the race-condition fix where the worker could
			// complete before the observer was registered, causing the terminal event to
			// be missed entirely. The observer must be set up BEFORE injectMessage() fires.
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			// Track call order
			const callOrder: string[] = [];
			const trackingFactory = {
				...sessionFactory,
				async createAndStartSession(init: unknown, role: string) {
					callOrder.push(`createAndStartSession:${role}`);
					await sessionFactory.createAndStartSession(init, role);
				},
				async injectMessage(
					sessionId: string,
					message: string,
					opts?: { deliveryMode?: 'current_turn' | 'next_turn' }
				) {
					callOrder.push(`injectMessage:${sessionId.split(':')[0]}`);
					await sessionFactory.injectMessage(sessionId, message, opts);
				},
			};

			const trackingManager = new TaskGroupManager({
				groupRepo,
				sessionObserver: observer,
				taskManager,
				goalManager,
				sessionFactory: trackingFactory,
				workspacePath: '/workspace',
				getRoom: (roomId) => (roomId === 'room-1' ? room : null),
				getTask: (taskId) => taskManager.getTask(taskId),
				getGoal: (goalId) => goalManager.getGoal(goalId),
			});

			let observerRegisteredBeforeInject = false;
			const onWorkerTerminal = () => {};
			const onLeaderTerminal = () => {};

			// Monkey-patch observer.observe to record when worker is registered
			const origObserve = observer.observe.bind(observer);
			let workerObserverRegistered = false;
			observer.observe = (sessionId: string, cb: unknown) => {
				if (sessionId.startsWith('coder:')) {
					workerObserverRegistered = true;
				}
				return origObserve(sessionId, cb as Parameters<typeof origObserve>[1]);
			};

			// Monkey-patch injectMessage to check if worker observer was registered before inject
			const origInject = trackingFactory.injectMessage.bind(trackingFactory);
			trackingFactory.injectMessage = async (
				sessionId: string,
				message: string,
				opts?: { deliveryMode?: 'current_turn' | 'next_turn' }
			) => {
				if (sessionId.startsWith('coder:')) {
					observerRegisteredBeforeInject = workerObserverRegistered;
				}
				return origInject(sessionId, message, opts);
			};

			await trackingManager.spawn(
				room,
				task,
				goal,
				onWorkerTerminal,
				onLeaderTerminal,
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Restore observer
			observer.observe = origObserve;

			expect(observerRegisteredBeforeInject).toBe(true);
		});
	});

	describe('routeWorkerToLeader', () => {
		it('should inject message into Leader session', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.routeWorkerToLeader(group.id, 'Worker output here', (_groupId) => callbacks);

			const injectCalls = sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
			);
			expect(injectCalls).toHaveLength(1);
			expect(injectCalls[0].args[1]).toBe('Worker output here');
		});

		it('should update group state to awaiting_leader', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const updated = await manager.routeWorkerToLeader(
				group.id,
				'Worker output',
				(_groupId) => callbacks
			);

			expect(updated!.submittedForReview).toBe(false);
		});

		it('should reset leader contract violations', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Manually set violations
			groupRepo.updateLeaderContractViolations(group.id, 1, 'turn-1', group.version);

			const afterRoute = await manager.routeWorkerToLeader(
				group.id,
				'Output',
				(_groupId) => callbacks
			);

			expect(afterRoute!.leaderContractViolations).toBe(0);
		});

		it('should return null for non-existent group', async () => {
			const result = await manager.routeWorkerToLeader('nonexistent', 'output', () =>
				createMockLeaderCallbacks()
			);
			expect(result).toBeNull();
		});

		it('should recover lazy leader creation after manager restart from persisted metadata', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				{
					...makeDefaultWorkerConfig(),
					leaderTaskContext: 'Persisted context',
				},
				'code_review'
			);

			// Simulate daemon restart: new session factory with only worker restored in cache,
			// and a new manager instance (no in-memory state).
			const restartedFactory = createMockSessionFactory([group.workerSessionId]);
			const restartedManager = new TaskGroupManager({
				groupRepo,
				sessionObserver: observer,
				taskManager,
				goalManager,
				sessionFactory: restartedFactory,
				workspacePath: '/workspace',
				getRoom: (roomId) => (roomId === 'room-1' ? room : null),
				getTask: (taskId) => taskManager.getTask(taskId),
				getGoal: (goalId) => goalManager.getGoal(goalId),
			});

			const updated = await restartedManager.routeWorkerToLeader(
				group.id,
				'Worker output after restart',
				(_groupId) => callbacks
			);

			expect(updated).not.toBeNull();
			expect(updated!.submittedForReview).toBe(false);

			const leaderStartCalls = restartedFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			);
			expect(leaderStartCalls).toHaveLength(1);

			const leaderInjectCalls = restartedFactory.calls.filter(
				(c) => c.method === 'injectMessage' && c.args[0] === group.leaderSessionId
			);
			expect(leaderInjectCalls).toHaveLength(1);
			expect(leaderInjectCalls[0].args[1]).toBe(
				'Persisted context\n\n---\n\nWorker output after restart'
			);

			const refreshed = groupRepo.getGroup(group.id)!;
			expect(refreshed.deferredLeader).toBeNull();
		});

		it('should create leader session for a goal-free task (goalId is null)', async () => {
			const task = await createTask();
			const callbacks = createMockLeaderCallbacks();

			// Spawn with null goal — task has no linked goal
			const group = await manager.spawn(
				room,
				task,
				null,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Leader config should store null goalId
			const persisted = groupRepo.getGroup(group.id)!;
			expect(persisted.deferredLeader?.goalId).toBeNull();

			// Leader session is created eagerly in spawn()
			const leaderCallsAfterSpawn = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			);
			expect(leaderCallsAfterSpawn).toHaveLength(1);

			// Routing worker to leader should succeed — leader session already exists
			const result = await manager.routeWorkerToLeader(
				group.id,
				'Worker output for goal-free task',
				(_groupId) => callbacks
			);

			expect(result).not.toBeNull();

			// No additional leader creation — leader was already created in spawn()
			const leaderCallsAfterRoute = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'leader'
			);
			expect(leaderCallsAfterRoute).toHaveLength(1);

			// Task should not be failed (leader creation succeeded without a goal)
			const updatedTask = await taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
		});

		it('should fail when leader session is missing and deferred metadata is absent', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Corrupt/clear persisted deferred config and simulate no leader in cache.
			groupRepo.setDeferredLeader(group.id, null);
			const coldFactory = createMockSessionFactory([group.workerSessionId]);
			const coldManager = new TaskGroupManager({
				groupRepo,
				sessionObserver: observer,
				taskManager,
				goalManager,
				sessionFactory: coldFactory,
				workspacePath: '/workspace',
				getRoom: (roomId) => (roomId === 'room-1' ? room : null),
				getTask: (taskId) => taskManager.getTask(taskId),
				getGoal: (goalId) => goalManager.getGoal(goalId),
			});

			const result = await coldManager.routeWorkerToLeader(
				group.id,
				'output',
				(_groupId) => callbacks
			);
			expect(result).toBeNull();

			const failedTask = await taskManager.getTask(task.id);
			expect(failedTask!.status).toBe('needs_attention');
			expect(failedTask!.error).toContain('Leader session lost during restart');
		});
	});

	describe('routeLeaderToWorker', () => {
		it('should inject message into Worker session', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// First route to Leader so group is in awaiting_leader state
			await manager.routeWorkerToLeader(group.id, 'Worker output', (_groupId) => callbacks);

			await manager.routeLeaderToWorker(group.id, 'Fix the tests');

			const feedbackCalls = sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.workerSessionId &&
					c.args[1] === 'Fix the tests'
			);
			expect(feedbackCalls).toHaveLength(1);
		});

		it('should update group state to awaiting_worker and increment iteration', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.routeWorkerToLeader(group.id, 'Output', (_groupId) => callbacks);
			const updated = await manager.routeLeaderToWorker(group.id, 'Feedback');

			expect(updated!.submittedForReview).toBe(false);
			expect(updated!.feedbackIteration).toBe(1);
		});

		it('should restore dead worker session before routing feedback', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			// Create a factory with the worker already in live sessions (normal spawn behavior)
			const factory = createMockSessionFactory([]);
			// Create a new manager with the factory
			const testManager = new TaskGroupManager({
				groupRepo,
				sessionObserver: observer,
				taskManager,
				goalManager,
				sessionFactory: factory,
				workspacePath: '/workspace',
				getRoom: (roomId) => (roomId === 'room-1' ? room : null),
				getTask: (taskId) => taskManager.getTask(taskId),
				getGoal: (goalId) => goalManager.getGoal(goalId),
			});

			const group = await testManager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// First route to Leader so group is in awaiting_leader state
			await testManager.routeWorkerToLeader(group.id, 'Worker output', (_groupId) => callbacks);

			// Simulate worker session dying (e.g., after daemon restart or eviction)
			// Remove worker from live sessions to simulate dead session
			factory.liveSessions.delete(group.workerSessionId);

			// Verify worker session is not in cache
			expect(factory.hasSession(group.workerSessionId)).toBe(false);

			// Now route leader feedback back to worker
			await testManager.routeLeaderToWorker(group.id, 'Fix the tests');

			// Verify session was restored before injecting message
			const restoreCalls = factory.calls.filter(
				(c) => c.method === 'restoreSession' && c.args[0] === group.workerSessionId
			);
			expect(restoreCalls).toHaveLength(1);

			// injectMessage lazily starts the SDK query, no explicit startSession needed
			const injectCalls = factory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.workerSessionId &&
					c.args[1] === 'Fix the tests'
			);
			expect(injectCalls).toHaveLength(1);
		});

		it('should fail group when worker session restore fails', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			// Create a factory that fails restoreSession (simulating session not in DB)
			const failFactory = createMockSessionFactory([], { restoreSessionFails: true });
			const failManager = new TaskGroupManager({
				groupRepo,
				sessionObserver: observer,
				taskManager,
				goalManager,
				sessionFactory: failFactory,
				workspacePath: '/workspace',
				getRoom: (roomId) => (roomId === 'room-1' ? room : null),
				getTask: (taskId) => taskManager.getTask(taskId),
				getGoal: (goalId) => goalManager.getGoal(goalId),
			});

			const group = await failManager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// First route to Leader so group is in awaiting_leader state
			await failManager.routeWorkerToLeader(group.id, 'Worker output', (_groupId) => callbacks);

			// Simulate worker session dying (not in cache)
			failFactory.liveSessions.delete(group.workerSessionId);

			// Verify worker session is not in cache
			expect(failFactory.hasSession(group.workerSessionId)).toBe(false);

			// Now route leader feedback back to worker - should fail gracefully
			const result = await failManager.routeLeaderToWorker(group.id, 'Fix the tests');

			// Verify restore was attempted
			const restoreCalls = failFactory.calls.filter(
				(c) => c.method === 'restoreSession' && c.args[0] === group.workerSessionId
			);
			expect(restoreCalls).toHaveLength(1);

			// Verify group was failed instead of throwing
			expect(result).toBeNull();

			// Verify task is marked as needs_attention (failTask sets this status)
			const failedTask = await taskManager.getTask(task.id);
			expect(failedTask!.status).toBe('needs_attention');
			expect(failedTask!.error).toContain('Worker session lost during restart');
		});
	});

	describe('complete', () => {
		it('should complete the group and task', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const updated = await manager.complete(group.id, 'All done');

			expect(updated!.completedAt).toBeDefined();

			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('completed');
			expect(taskResult!.result).toBe('All done');
		});

		it('should stop observing sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.complete(group.id, 'Done');

			expect(observer.isObserving(group.workerSessionId)).toBe(false);
			expect(observer.isObserving(group.leaderSessionId)).toBe(false);
		});

		it('should return null for non-existent group', async () => {
			const result = await manager.complete('nonexistent', 'Done');
			expect(result).toBeNull();
		});
	});

	describe('fail', () => {
		it('should fail the group and task', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const updated = await manager.fail(group.id, 'Cannot complete');

			expect(updated!.completedAt).toBeDefined();

			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('needs_attention');
		});

		it('should stop observing sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.fail(group.id, 'Failed');

			expect(observer.isObserving(group.workerSessionId)).toBe(false);
			expect(observer.isObserving(group.leaderSessionId)).toBe(false);
		});
	});

	describe('escalateToHumanReview', () => {
		it('should set group to awaiting_human and task to review', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const updated = await manager.escalateToHumanReview(group.id, 'Max iterations reached');

			expect(updated!.submittedForReview).toBe(true);

			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('review');
		});

		it('should keep both sessions observed so human can resume later', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Trigger first review round so leader session is created and observed
			await manager.routeWorkerToLeader(group.id, 'Worker output', (_groupId) => callbacks);

			await manager.escalateToHumanReview(group.id, 'Max iterations');

			// Both sessions must remain observed for resumeWorkerFromHuman to work
			expect(observer.isObserving(group.workerSessionId)).toBe(true);
			expect(observer.isObserving(group.leaderSessionId)).toBe(true);
		});

		it('should return null for unknown group', async () => {
			const result = await manager.escalateToHumanReview('nonexistent-group', 'reason');
			expect(result).toBeNull();
		});
	});

	describe('cancel', () => {
		it('should fail the group and mark the task with cancelled status (not needs_attention)', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			const updated = await manager.cancel(group.id);

			// Group becomes terminal and the underlying task status is 'cancelled'
			// (semantically distinct from 'needs_attention').
			expect(updated!.completedAt).not.toBeNull();
			const cancelledTask = await taskManager.getTask(task.id);
			expect(cancelledTask?.status).toBe('cancelled');
		});
	});

	describe('worktree cleanup', () => {
		it('should NOT cleanup worktree on task completion (preserved for reactivation)', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.complete(group.id, 'All done');

			// Worktree should NOT be cleaned up on completion — preserved for reactivation
			expect(sessionFactory.removedWorktrees).not.toContain(group.workspacePath);
			const removeWorktreeCalls = sessionFactory.calls.filter((c) => c.method === 'removeWorktree');
			expect(removeWorktreeCalls).toHaveLength(0);
		});

		it('should NOT cleanup worktree on task failure (kept for debugging)', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.fail(group.id, 'Task failed');

			// Worktree should NOT be cleaned up on failure - kept for debugging
			expect(sessionFactory.removedWorktrees).not.toContain(group.workspacePath);
		});

		it('should cleanup worktree on archiveGroup (even for needs_attention tasks)', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// First fail the group
			await manager.fail(group.id, 'Task failed');

			// Worktree should still exist
			expect(sessionFactory.removedWorktrees).not.toContain(group.workspacePath);

			// Now archive the group
			await manager.archiveGroup(group.id);

			// Now worktree should be cleaned up
			expect(sessionFactory.removedWorktrees).toContain(group.workspacePath);
		});

		it('should NOT cleanup worktree on task cancellation (preserved for reactivation)', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.cancel(group.id);

			// Worktree should NOT be cleaned up on cancellation — preserved for reactivation
			expect(sessionFactory.removedWorktrees).not.toContain(group.workspacePath);
		});

		it('should NOT cleanup worktree when terminating a non-terminal group (preserved for reactivation)', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			await manager.terminateGroup(group.id);

			// Worktree should NOT be cleaned up on termination — preserved for reactivation
			expect(sessionFactory.removedWorktrees).not.toContain(group.workspacePath);
			const removeWorktreeCalls = sessionFactory.calls.filter((c) => c.method === 'removeWorktree');
			expect(removeWorktreeCalls).toHaveLength(0);
		});

		it('should NOT cleanup worktree when terminating an already-terminal group', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// First complete the group (making it terminal)
			await manager.complete(group.id, 'Done');
			sessionFactory.calls.length = 0; // Reset call tracking

			// Now terminate the already-terminal group
			await manager.terminateGroup(group.id);

			// Worktree should NOT be cleaned up — only archiveGroup() cleans up
			const removeWorktreeCalls = sessionFactory.calls.filter((c) => c.method === 'removeWorktree');
			expect(removeWorktreeCalls).toHaveLength(0);
		});

		it('should cleanup worktree ONLY via archiveGroup after completion', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Complete — no cleanup
			await manager.complete(group.id, 'All done');
			expect(sessionFactory.removedWorktrees).toHaveLength(0);

			// Archive — cleanup happens
			await manager.archiveGroup(group.id);
			expect(sessionFactory.removedWorktrees).toContain(group.workspacePath);
		});

		it('should cleanup worktree ONLY via archiveGroup after cancellation', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();
			const group = await manager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Cancel — no cleanup
			await manager.cancel(group.id);
			expect(sessionFactory.removedWorktrees).toHaveLength(0);

			// Archive — cleanup happens
			await manager.archiveGroup(group.id);
			expect(sessionFactory.removedWorktrees).toContain(group.workspacePath);
		});

		it('should not cleanup worktree if workspace is main repo', async () => {
			const task = await createTask();

			// Create group directly with main repo path
			const rawGroup = groupRepo.createGroup(
				task.id,
				'worker:room-1:task:test',
				'leader:room-1:task:test',
				'coder',
				'/workspace' // Same as main workspace - simulates no worktree
			);

			// archiveGroup should skip cleanup when workspace is main repo
			await manager.archiveGroup(rawGroup.id);

			// Should NOT have called removeWorktree since workspace is main repo
			expect(sessionFactory.removedWorktrees).not.toContain('/workspace');
		});

		it('should not fail operation when worktree cleanup fails in archiveGroup', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			// Create a factory that fails on removeWorktree
			const failingFactory = {
				...createMockSessionFactory(),
				async removeWorktree(_workspacePath: string) {
					throw new Error('Worktree cleanup failed');
				},
			} satisfies SessionFactory & { removedWorktrees: string[] };

			const failingManager = new TaskGroupManager({
				groupRepo,
				sessionObserver: observer,
				taskManager,
				goalManager,
				sessionFactory: failingFactory,
				workspacePath: '/workspace',
				getRoom: (roomId) => (roomId === 'room-1' ? room : null),
				getTask: (taskId) => taskManager.getTask(taskId),
				getGoal: (goalId) => goalManager.getGoal(goalId),
			});

			const group = await failingManager.spawn(
				room,
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks,
				makeDefaultWorkerConfig()
			);

			// Complete first (no cleanup)
			await failingManager.complete(group.id, 'Done');

			// archiveGroup should not throw even though cleanup fails
			const result = await failingManager.archiveGroup(group.id);
			expect(result).not.toBeNull();
		});
	});
});
