import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	recoverRuntime,
	type SessionStateChecker,
} from '../../../src/lib/room/runtime/runtime-recovery';
import { RoomRuntime } from '../../../src/lib/room/runtime/room-runtime';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { SessionObserver } from '../../../src/lib/room/state/session-observer';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import type { Room } from '@neokai/shared';
import type { SessionFactory } from '../../../src/lib/room/runtime/task-group-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

function createMockDaemonHub() {
	return {
		on(
			_event: string,
			_handler: (data: unknown) => void,
			_options?: { sessionId?: string }
		): () => void {
			return () => {};
		},
	};
}

function createMockSessionFactory() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	return {
		calls,
		async createAndStartSession(init: unknown, role: string) {
			calls.push({ method: 'createAndStartSession', args: [init, role] });
		},
		async injectMessage(
			sessionId: string,
			message: string,
			opts?: { deliveryMode?: 'current_turn' | 'next_turn' }
		) {
			calls.push({ method: 'injectMessage', args: [sessionId, message, opts] });
		},
		hasSession(_sessionId: string) {
			return true;
		},
		async answerQuestion(_sessionId: string, _answer: string) {
			return false;
		},
		async createWorktree(_basePath: string, _sessionId: string) {
			return null;
		},
		async restoreSession(sessionId: string) {
			calls.push({ method: 'restoreSession', args: [sessionId] });
			return true;
		},
	} satisfies SessionFactory & { calls: Array<{ method: string; args: unknown[] }> };
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

/** Create a checker where all sessions exist in DB and are live in cache */
function createDefaultChecker(overrides?: Partial<SessionStateChecker>): SessionStateChecker {
	return {
		sessionExists: () => true,
		isTerminalState: () => false,
		isLive: () => true,
		restoreSession: async () => true,
		...overrides,
	};
}

describe('Runtime Recovery', () => {
	let db: Database;
	let groupRepo: SessionGroupRepository;
	let observer: SessionObserver;
	let taskManager: TaskManager;
	let goalManager: GoalManager;
	let sessionFactory: ReturnType<typeof createMockSessionFactory>;
	let runtime: RoomRuntime;

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
				created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_worker',
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
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

		runtime = new RoomRuntime({
			room: makeRoom(),
			groupRepo,
			sessionObserver: observer,
			taskManager,
			goalManager,
			sessionFactory,
			workspacePath: '/workspace',
			tickInterval: 60_000,
		});
	});

	afterEach(() => {
		runtime.stop();
		db.close();
	});

	/** Helper: create a task and group directly in DB */
	function createTaskAndGroup(
		groupState: string,
		taskStatus = 'in_progress'
	): { taskId: string; group: ReturnType<typeof groupRepo.getGroup> } {
		const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(taskId, 'room-1', 'Test task', 'Description', taskStatus, now);

		const group = groupRepo.createGroup(taskId, `worker:${taskId}`, `leader:${taskId}`);
		if (groupState !== 'awaiting_worker') {
			groupRepo.updateGroupState(group.id, groupState as never, group.version);
		}

		return { taskId, group: groupRepo.getGroup(group.id) };
	}

	it('should return empty result when no active groups', async () => {
		const checker = createDefaultChecker();

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredGroups).toBe(0);
		expect(result.failedGroups).toBe(0);
	});

	it('should fail groups with lost worker sessions', async () => {
		const { taskId, group } = createTaskAndGroup('awaiting_worker');

		const checker = createDefaultChecker({
			sessionExists: (id) => !id.startsWith('worker:'),
			isLive: (id) => !id.startsWith('worker:'),
		});

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.failedGroups).toBe(1);
		const updatedGroup = groupRepo.getGroup(group!.id);
		expect(updatedGroup!.state).toBe('failed');

		const task = await taskManager.getTask(taskId);
		expect(task!.status).toBe('failed');
	});

	it('should fail groups with lost leader sessions', async () => {
		const { taskId, group } = createTaskAndGroup('awaiting_leader');

		const checker = createDefaultChecker({
			sessionExists: (id) => !id.startsWith('leader:'),
			isLive: (id) => !id.startsWith('leader:'),
		});

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.failedGroups).toBe(1);
		const updatedGroup = groupRepo.getGroup(group!.id);
		expect(updatedGroup!.state).toBe('failed');

		const task = await taskManager.getTask(taskId);
		expect(task!.status).toBe('failed');
	});

	it('should reattach observers for active worker sessions', async () => {
		const { group } = createTaskAndGroup('awaiting_worker');

		const checker = createDefaultChecker();

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.reattachedObservers).toBe(1);
		expect(observer.isObserving(group!.workerSessionId)).toBe(true);
	});

	it('should reattach observers for active leader sessions', async () => {
		const { group } = createTaskAndGroup('awaiting_leader');

		const checker = createDefaultChecker();

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.reattachedObservers).toBe(1);
		expect(observer.isObserving(group!.leaderSessionId)).toBe(true);
	});

	it('should process immediately terminal worker sessions', async () => {
		const { group } = createTaskAndGroup('awaiting_worker');

		const checker = createDefaultChecker({
			isTerminalState: (id) => id.startsWith('worker:'),
		});

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.immediateTerminals).toBe(1);
		// Group should transition to awaiting_leader (worker output routed to leader)
		const updated = groupRepo.getGroup(group!.id);
		expect(updated!.state).toBe('awaiting_leader');
	});

	it('should restore and observe awaiting_human groups', async () => {
		const { group } = createTaskAndGroup('awaiting_human');

		// Sessions exist in DB but not live in cache
		const checker = createDefaultChecker({
			isLive: () => false,
		});

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredGroups).toBe(1);
		expect(result.failedGroups).toBe(0);
		expect(result.restoredSessions).toBeGreaterThanOrEqual(1);
		expect(result.reattachedObservers).toBe(1);
		// Worker observer should be attached for future approval
		expect(observer.isObserving(group!.workerSessionId)).toBe(true);
	});

	it('should fail awaiting_human group when worker cannot be restored', async () => {
		const { taskId, group } = createTaskAndGroup('awaiting_human');

		const checker = createDefaultChecker({
			isLive: () => false,
			restoreSession: async () => false,
		});

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.failedGroups).toBe(1);
		const updatedGroup = groupRepo.getGroup(group!.id);
		expect(updatedGroup!.state).toBe('failed');

		const task = await taskManager.getTask(taskId);
		expect(task!.status).toBe('failed');
	});

	it('should restore sessions not live in cache for awaiting_worker', async () => {
		const { group } = createTaskAndGroup('awaiting_worker');
		const restoreCalls: string[] = [];

		const checker = createDefaultChecker({
			isLive: () => false,
			restoreSession: async (id) => {
				restoreCalls.push(id);
				return true;
			},
		});

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.restoredSessions).toBeGreaterThanOrEqual(1);
		expect(restoreCalls).toContain(group!.workerSessionId);
		expect(result.reattachedObservers).toBe(1);
	});

	it('should handle multiple groups with mixed states', async () => {
		createTaskAndGroup('awaiting_worker');
		createTaskAndGroup('awaiting_leader');
		createTaskAndGroup('awaiting_human');

		const checker = createDefaultChecker();

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredGroups).toBe(3);
		// All 3 groups get observers (awaiting_human now restores and observes too)
		expect(result.reattachedObservers).toBe(3);
	});
});
