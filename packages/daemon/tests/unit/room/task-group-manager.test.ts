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
function createMockSessionFactory(initialLiveSessions: string[] = []) {
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
		async handoffToWorker() {
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
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
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
				archived_at INTEGER
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

		it('should create Worker session immediately and defer Leader', async () => {
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
			// Worker starts immediately, Leader is deferred until routeWorkerToLeader
			expect(workerCalls).toHaveLength(1);
			expect(leaderCalls).toHaveLength(0);
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
			// Leader is observed proactively so terminal events are not missed after lazy creation.
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
			});
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
			expect(failedTask!.status).toBe('failed');
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
			expect(taskResult!.status).toBe('failed');
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
		it('should fail the group and mark the task as cancelled (not failed)', async () => {
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
			// (semantically distinct from 'failed').
			expect(updated!.completedAt).not.toBeNull();
			const cancelledTask = await taskManager.getTask(task.id);
			expect(cancelledTask?.status).toBe('cancelled');
		});
	});

	describe('worktree cleanup', () => {
		it('should cleanup worktree on task completion', async () => {
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

			// Should have called removeWorktree with the group's workspace path
			expect(sessionFactory.removedWorktrees).toContain(group.workspacePath);
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

		it('should cleanup worktree on archiveGroup (even for failed tasks)', async () => {
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

		it('should cleanup worktree on task cancellation', async () => {
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

			expect(sessionFactory.removedWorktrees).toContain(group.workspacePath);
		});

		it('should cleanup worktree when terminating a non-terminal group', async () => {
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

			expect(sessionFactory.removedWorktrees).toContain(group.workspacePath);
		});

		it('should not cleanup worktree if workspace is main repo', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeaderCallbacks();

			// Create a manager where workspace path matches the worktree path
			// This simulates a scenario where no worktree was created (non-git repo)
			const mainRepoFactory = {
				...createMockSessionFactory(),
				async createWorktree() {
					// Return null to simulate non-git repo (no worktree created)
					return null;
				},
			} satisfies SessionFactory & { removedWorktrees: string[] };

			const mainRepoManager = new TaskGroupManager({
				groupRepo,
				sessionObserver: observer,
				taskManager,
				goalManager,
				sessionFactory: mainRepoFactory,
				workspacePath: '/workspace',
				getRoom: (roomId) => (roomId === 'room-1' ? room : null),
				getTask: (taskId) => taskManager.getTask(taskId),
				getGoal: (goalId) => goalManager.getGoal(goalId),
			});

			// spawn() will throw because worktree creation failed
			// So we need to test the cleanup logic directly via a manually created group
			// Create group directly with main repo path
			const rawGroup = groupRepo.createGroup(
				task.id,
				'worker:room-1:task:test',
				'leader:room-1:task:test',
				'coder',
				'/workspace' // Same as main workspace - simulates no worktree
			);
			await taskManager.startTask(task.id);

			await mainRepoManager.complete(rawGroup.id, 'Done');

			// Should NOT have called removeWorktree since workspace is main repo
			expect(mainRepoFactory.removedWorktrees).not.toContain('/workspace');
		});

		it('should not fail operation when worktree cleanup fails', async () => {
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

			// Should not throw even though cleanup fails
			const result = await failingManager.complete(group.id, 'Done');

			expect(result!.completedAt).not.toBeNull();
			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('completed');
		});
	});
});
