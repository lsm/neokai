import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { recoverRuntime, type SessionStateChecker } from '../../../src/lib/room/runtime-recovery';
import { RoomRuntime } from '../../../src/lib/room/room-runtime';
import { SessionGroupRepository } from '../../../src/lib/room/session-group-repository';
import { SessionObserver } from '../../../src/lib/room/session-observer';
import { GoalManager } from '../../../src/lib/room/goal-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import type { Room } from '@neokai/shared';
import type { SessionFactory } from '../../../src/lib/room/task-group-manager';
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
		async injectMessage(sessionId: string, message: string) {
			calls.push({ method: 'injectMessage', args: [sessionId, message] });
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
				created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task_pair',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_craft',
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
				PRIMARY KEY (group_id, role)
			);
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT,
				role TEXT NOT NULL,
				message_type TEXT NOT NULL,
				content TEXT NOT NULL,
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

		const group = groupRepo.createGroup(taskId, `craft:${taskId}`, `lead:${taskId}`);
		if (groupState !== 'awaiting_craft') {
			groupRepo.updateGroupState(group.id, groupState as never, group.version);
		}

		return { taskId, group: groupRepo.getGroup(group.id) };
	}

	it('should return empty result when no active groups', async () => {
		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

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

	it('should fail groups with lost craft sessions', async () => {
		const { taskId, group } = createTaskAndGroup('awaiting_craft');

		const checker: SessionStateChecker = {
			sessionExists: (id) => !id.startsWith('craft:'),
			isTerminalState: () => false,
		};

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

	it('should fail groups with lost lead sessions', async () => {
		const { taskId, group } = createTaskAndGroup('awaiting_lead');

		const checker: SessionStateChecker = {
			sessionExists: (id) => !id.startsWith('lead:'),
			isTerminalState: () => false,
		};

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

	it('should reattach observers for active craft sessions', async () => {
		const { group } = createTaskAndGroup('awaiting_craft');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.reattachedObservers).toBe(1);
		expect(observer.isObserving(group!.craftSessionId)).toBe(true);
	});

	it('should reattach observers for active lead sessions', async () => {
		const { group } = createTaskAndGroup('awaiting_lead');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.reattachedObservers).toBe(1);
		expect(observer.isObserving(group!.leadSessionId)).toBe(true);
	});

	it('should process immediately terminal craft sessions', async () => {
		const { group } = createTaskAndGroup('awaiting_craft');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: (id) => id.startsWith('craft:'),
		};

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.immediateTerminals).toBe(1);
		// Group should transition to awaiting_lead (craft output routed to lead)
		const updated = groupRepo.getGroup(group!.id);
		expect(updated!.state).toBe('awaiting_lead');
	});

	it('should skip awaiting_human groups', async () => {
		createTaskAndGroup('awaiting_human');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

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
		expect(result.reattachedObservers).toBe(0);
	});

	it('should skip hibernated groups', async () => {
		createTaskAndGroup('hibernated');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

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
		expect(result.reattachedObservers).toBe(0);
	});

	it('should handle multiple groups', async () => {
		createTaskAndGroup('awaiting_craft');
		createTaskAndGroup('awaiting_lead');
		createTaskAndGroup('awaiting_human');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			groupRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredGroups).toBe(3);
		// 2 groups need observers (awaiting_craft + awaiting_lead)
		expect(result.reattachedObservers).toBe(2);
	});
});
