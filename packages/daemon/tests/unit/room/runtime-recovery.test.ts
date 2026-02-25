import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { recoverRuntime, type SessionStateChecker } from '../../../src/lib/room/runtime-recovery';
import { RoomRuntime } from '../../../src/lib/room/room-runtime';
import { TaskPairRepository } from '../../../src/lib/room/task-pair-repository';
import { SessionObserver } from '../../../src/lib/room/session-observer';
import { GoalManager } from '../../../src/lib/room/goal-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import type { Room } from '@neokai/shared';
import type { SessionFactory } from '../../../src/lib/room/task-pair-manager';
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
	let taskPairRepo: TaskPairRepository;
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
				created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
			);
			CREATE TABLE task_pairs (
				id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
				craft_session_id TEXT NOT NULL, lead_session_id TEXT NOT NULL,
				pair_state TEXT NOT NULL DEFAULT 'awaiting_craft',
				feedback_iteration INTEGER NOT NULL DEFAULT 0,
				lead_contract_violations INTEGER NOT NULL DEFAULT 0,
				last_processed_lead_turn_id TEXT,
				last_forwarded_message_id TEXT,
				active_work_started_at INTEGER,
				active_work_elapsed INTEGER NOT NULL DEFAULT 0,
				hibernated_at INTEGER,
				version INTEGER NOT NULL DEFAULT 0,
				tokens_used INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL, completed_at INTEGER
			);
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${Date.now()}, ${Date.now()});
		`);

		const mockHub = createMockDaemonHub();
		taskPairRepo = new TaskPairRepository(db as never);
		observer = new SessionObserver(mockHub as unknown as DaemonHub);
		taskManager = new TaskManager(db as never, 'room-1');
		goalManager = new GoalManager(db as never, 'room-1');
		sessionFactory = createMockSessionFactory();

		runtime = new RoomRuntime({
			room: makeRoom(),
			taskPairRepo,
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

	/** Helper: create a task and pair directly in DB */
	function createTaskAndPair(
		pairState: string,
		taskStatus = 'in_progress'
	): { taskId: string; pair: ReturnType<typeof taskPairRepo.getPair> } {
		const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(taskId, 'room-1', 'Test task', 'Description', taskStatus, now);

		const pair = taskPairRepo.createPair(taskId, `craft:${taskId}`, `lead:${taskId}`);
		if (pairState !== 'awaiting_craft') {
			taskPairRepo.updatePairState(pair.id, pairState as never, pair.version);
		}

		return { taskId, pair: taskPairRepo.getPair(pair.id) };
	}

	it('should return empty result when no active pairs', async () => {
		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredPairs).toBe(0);
		expect(result.failedPairs).toBe(0);
	});

	it('should fail pairs with lost craft sessions', async () => {
		const { taskId, pair } = createTaskAndPair('awaiting_craft');

		const checker: SessionStateChecker = {
			sessionExists: (id) => !id.startsWith('craft:'),
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.failedPairs).toBe(1);
		const updatedPair = taskPairRepo.getPair(pair!.id);
		expect(updatedPair!.pairState).toBe('failed');

		const task = await taskManager.getTask(taskId);
		expect(task!.status).toBe('failed');
	});

	it('should fail pairs with lost lead sessions', async () => {
		const { taskId, pair } = createTaskAndPair('awaiting_lead');

		const checker: SessionStateChecker = {
			sessionExists: (id) => !id.startsWith('lead:'),
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.failedPairs).toBe(1);
		const updatedPair = taskPairRepo.getPair(pair!.id);
		expect(updatedPair!.pairState).toBe('failed');
	});

	it('should reattach observers for active craft sessions', async () => {
		const { pair } = createTaskAndPair('awaiting_craft');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.reattachedObservers).toBe(1);
		expect(observer.isObserving(pair!.craftSessionId)).toBe(true);
	});

	it('should reattach observers for active lead sessions', async () => {
		const { pair } = createTaskAndPair('awaiting_lead');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.reattachedObservers).toBe(1);
		expect(observer.isObserving(pair!.leadSessionId)).toBe(true);
	});

	it('should process immediately terminal craft sessions', async () => {
		const { pair } = createTaskAndPair('awaiting_craft');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: (id) => id.startsWith('craft:'),
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.immediateTerminals).toBe(1);
		// Pair should transition to awaiting_lead (craft output routed to lead)
		const updated = taskPairRepo.getPair(pair!.id);
		expect(updated!.pairState).toBe('awaiting_lead');
	});

	it('should skip awaiting_human pairs', async () => {
		createTaskAndPair('awaiting_human');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredPairs).toBe(1);
		expect(result.failedPairs).toBe(0);
		expect(result.reattachedObservers).toBe(0);
	});

	it('should skip hibernated pairs', async () => {
		createTaskAndPair('hibernated');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredPairs).toBe(1);
		expect(result.failedPairs).toBe(0);
		expect(result.reattachedObservers).toBe(0);
	});

	it('should handle multiple pairs', async () => {
		createTaskAndPair('awaiting_craft');
		createTaskAndPair('awaiting_lead');
		createTaskAndPair('awaiting_human');

		const checker: SessionStateChecker = {
			sessionExists: () => true,
			isTerminalState: () => false,
		};

		const result = await recoverRuntime(
			'room-1',
			taskPairRepo,
			taskManager,
			observer,
			checker,
			runtime
		);

		expect(result.recoveredPairs).toBe(3);
		// 2 pairs need observers (awaiting_craft + awaiting_lead)
		expect(result.reattachedObservers).toBe(2);
	});
});
