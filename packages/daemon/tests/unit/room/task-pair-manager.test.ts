import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskPairManager, type SessionFactory } from '../../../src/lib/room/task-pair-manager';
import { TaskPairRepository } from '../../../src/lib/room/task-pair-repository';
import { SessionObserver, type TerminalState } from '../../../src/lib/room/session-observer';
import { GoalManager } from '../../../src/lib/room/goal-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';
import type { LeadToolCallbacks } from '../../../src/lib/room/lead-agent';
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

function createMockLeadCallbacks() {
	return {
		async sendToCraft() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
		async completeTask() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
		async failTask() {
			return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
		},
	} satisfies LeadToolCallbacks;
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

describe('TaskPairManager', () => {
	let db: Database;
	let taskPairRepo: TaskPairRepository;
	let observer: SessionObserver;
	let taskManager: TaskManager;
	let goalManager: GoalManager;
	let sessionFactory: ReturnType<typeof createMockSessionFactory>;
	let manager: TaskPairManager;
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

		manager = new TaskPairManager({
			room,
			taskPairRepo,
			sessionObserver: observer,
			taskManager,
			goalManager,
			sessionFactory,
			workspacePath: '/workspace',
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

	describe('spawnPair', () => {
		it('should create a task pair record', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();

			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			expect(pair).toBeDefined();
			expect(pair.taskId).toBe(task.id);
			expect(pair.pairState).toBe('awaiting_craft');
			expect(pair.feedbackIteration).toBe(0);
		});

		it('should create both Craft and Lead sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();

			await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			const craftCalls = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'craft'
			);
			const leadCalls = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'lead'
			);
			expect(craftCalls).toHaveLength(1);
			expect(leadCalls).toHaveLength(1);
		});

		it('should set task to in_progress', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();

			await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			const updated = await taskManager.getTask(task.id);
			expect(updated!.status).toBe('in_progress');
		});

		it('should observe both sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();

			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			expect(observer.isObserving(pair.craftSessionId)).toBe(true);
			expect(observer.isObserving(pair.leadSessionId)).toBe(true);
		});
	});

	describe('routeCraftToLead', () => {
		it('should inject message into Lead session', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			await manager.routeCraftToLead(pair.id, 'Craft output here');

			const injectCalls = sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && c.args[0] === pair.leadSessionId
			);
			expect(injectCalls).toHaveLength(1);
			expect(injectCalls[0].args[1]).toBe('Craft output here');
		});

		it('should update pair state to awaiting_lead', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			const updated = await manager.routeCraftToLead(pair.id, 'Craft output');

			expect(updated!.pairState).toBe('awaiting_lead');
		});

		it('should reset lead contract violations', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			// Manually set violations
			taskPairRepo.updateLeadContractViolations(pair.id, 1, 'turn-1', pair.version);

			const afterRoute = await manager.routeCraftToLead(pair.id, 'Output');

			expect(afterRoute!.leadContractViolations).toBe(0);
		});

		it('should return null for non-existent pair', async () => {
			const result = await manager.routeCraftToLead('nonexistent', 'output');
			expect(result).toBeNull();
		});
	});

	describe('routeLeadToCraft', () => {
		it('should inject message into Craft session', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			// First route to Lead so pair is in awaiting_lead state
			await manager.routeCraftToLead(pair.id, 'Craft output');

			await manager.routeLeadToCraft(pair.id, 'Fix the tests');

			const injectCalls = sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && c.args[0] === pair.craftSessionId
			);
			expect(injectCalls).toHaveLength(1);
			expect(injectCalls[0].args[1]).toBe('Fix the tests');
		});

		it('should update pair state to awaiting_craft and increment iteration', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			await manager.routeCraftToLead(pair.id, 'Output');
			const updated = await manager.routeLeadToCraft(pair.id, 'Feedback');

			expect(updated!.pairState).toBe('awaiting_craft');
			expect(updated!.feedbackIteration).toBe(1);
		});
	});

	describe('completePair', () => {
		it('should complete the pair and task', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			const updated = await manager.completePair(pair.id, 'All done');

			expect(updated!.pairState).toBe('completed');
			expect(updated!.completedAt).toBeDefined();

			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('completed');
			expect(taskResult!.result).toBe('All done');
		});

		it('should stop observing sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			await manager.completePair(pair.id, 'Done');

			expect(observer.isObserving(pair.craftSessionId)).toBe(false);
			expect(observer.isObserving(pair.leadSessionId)).toBe(false);
		});

		it('should return null for non-existent pair', async () => {
			const result = await manager.completePair('nonexistent', 'Done');
			expect(result).toBeNull();
		});
	});

	describe('failPair', () => {
		it('should fail the pair and task', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			const updated = await manager.failPair(pair.id, 'Cannot complete');

			expect(updated!.pairState).toBe('failed');
			expect(updated!.completedAt).toBeDefined();

			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('failed');
		});

		it('should stop observing sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			await manager.failPair(pair.id, 'Failed');

			expect(observer.isObserving(pair.craftSessionId)).toBe(false);
			expect(observer.isObserving(pair.leadSessionId)).toBe(false);
		});
	});

	describe('cancelPair', () => {
		it('should fail the pair with cancel reason', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const pair = await manager.spawnPair(
				task,
				goal,
				() => {},
				() => {},
				callbacks
			);

			const updated = await manager.cancelPair(pair.id);

			expect(updated!.pairState).toBe('failed');
		});
	});
});
