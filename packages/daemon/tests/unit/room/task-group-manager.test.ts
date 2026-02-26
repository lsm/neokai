import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskGroupManager, type SessionFactory } from '../../../src/lib/room/task-group-manager';
import { SessionGroupRepository } from '../../../src/lib/room/session-group-repository';
import { SessionObserver } from '../../../src/lib/room/session-observer';
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

function createMockLeadCallbacks(): LeadToolCallbacks {
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
				created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY, group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_craft',
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL, completed_at INTEGER
			);
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, role)
			);
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT, role TEXT NOT NULL, message_type TEXT NOT NULL,
				content TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${Date.now()}, ${Date.now()});
		`);

		const mockHub = createMockDaemonHub();
		groupRepo = new SessionGroupRepository(db as never);
		observer = new SessionObserver(mockHub as unknown as DaemonHub);
		taskManager = new TaskManager(db as never, 'room-1');
		goalManager = new GoalManager(db as never, 'room-1');
		sessionFactory = createMockSessionFactory();

		manager = new TaskGroupManager({
			room,
			groupRepo,
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

	describe('spawn', () => {
		it('should create a session group record', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();

			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			expect(group).toBeDefined();
			expect(group.taskId).toBe(task.id);
			expect(group.state).toBe('awaiting_craft');
			expect(group.feedbackIteration).toBe(0);
		});

		it('should create both Craft and Lead sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();

			await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
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

			await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			const updated = await taskManager.getTask(task.id);
			expect(updated!.status).toBe('in_progress');
		});

		it('should observe both sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();

			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			expect(observer.isObserving(group.craftSessionId)).toBe(true);
			expect(observer.isObserving(group.leadSessionId)).toBe(true);
		});
	});

	describe('routeCraftToLead', () => {
		it('should inject message into Lead session', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			await manager.routeCraftToLead(group.id, 'Craft output here');

			const injectCalls = sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && c.args[0] === group.leadSessionId
			);
			expect(injectCalls).toHaveLength(1);
			expect(injectCalls[0].args[1]).toBe('Craft output here');
		});

		it('should update group state to awaiting_lead', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			const updated = await manager.routeCraftToLead(group.id, 'Craft output');

			expect(updated!.state).toBe('awaiting_lead');
		});

		it('should reset lead contract violations', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			// Manually set violations
			groupRepo.updateLeadContractViolations(group.id, 1, 'turn-1', group.version);

			const afterRoute = await manager.routeCraftToLead(group.id, 'Output');

			expect(afterRoute!.leadContractViolations).toBe(0);
		});

		it('should return null for non-existent group', async () => {
			const result = await manager.routeCraftToLead('nonexistent', 'output');
			expect(result).toBeNull();
		});
	});

	describe('routeLeadToCraft', () => {
		it('should inject message into Craft session', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			// First route to Lead so group is in awaiting_lead state
			await manager.routeCraftToLead(group.id, 'Craft output');

			await manager.routeLeadToCraft(group.id, 'Fix the tests');

			const feedbackCalls = sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === group.craftSessionId &&
					c.args[1] === 'Fix the tests'
			);
			expect(feedbackCalls).toHaveLength(1);
		});

		it('should update group state to awaiting_craft and increment iteration', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			await manager.routeCraftToLead(group.id, 'Output');
			const updated = await manager.routeLeadToCraft(group.id, 'Feedback');

			expect(updated!.state).toBe('awaiting_craft');
			expect(updated!.feedbackIteration).toBe(1);
		});
	});

	describe('complete', () => {
		it('should complete the group and task', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			const updated = await manager.complete(group.id, 'All done');

			expect(updated!.state).toBe('completed');
			expect(updated!.completedAt).toBeDefined();

			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('completed');
			expect(taskResult!.result).toBe('All done');
		});

		it('should stop observing sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			await manager.complete(group.id, 'Done');

			expect(observer.isObserving(group.craftSessionId)).toBe(false);
			expect(observer.isObserving(group.leadSessionId)).toBe(false);
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
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			const updated = await manager.fail(group.id, 'Cannot complete');

			expect(updated!.state).toBe('failed');
			expect(updated!.completedAt).toBeDefined();

			const taskResult = await taskManager.getTask(task.id);
			expect(taskResult!.status).toBe('failed');
		});

		it('should stop observing sessions', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			await manager.fail(group.id, 'Failed');

			expect(observer.isObserving(group.craftSessionId)).toBe(false);
			expect(observer.isObserving(group.leadSessionId)).toBe(false);
		});
	});

	describe('cancel', () => {
		it('should fail the group with cancel reason', async () => {
			const task = await createTask();
			const goal = makeGoal(db);
			const callbacks = createMockLeadCallbacks();
			const group = await manager.spawn(
				task,
				goal,
				() => {},
				() => {},
				(_groupId) => callbacks
			);

			const updated = await manager.cancel(group.id);

			expect(updated!.state).toBe('failed');
		});
	});
});
