import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { GoalManager } from '../../../src/lib/room/goal-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import { SessionGroupRepository } from '../../../src/lib/room/session-group-repository';
import { createRoomAgentToolHandlers } from '../../../src/lib/room/room-agent-tools';

describe('Room Agent Tools', () => {
	let db: Database;
	let goalManager: GoalManager;
	let taskManager: TaskManager;
	let groupRepo: SessionGroupRepository;
	let handlers: ReturnType<typeof createRoomAgentToolHandlers>;
	const roomId = 'room-1';

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE goals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active',
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]',
				metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				created_by_task_id TEXT,
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER
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
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT,
				role TEXT NOT NULL,
				message_type TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test', ${Date.now()}, ${Date.now()});
		`);

		goalManager = new GoalManager(db as never, roomId);
		taskManager = new TaskManager(db as never, roomId);
		groupRepo = new SessionGroupRepository(db as never);
		handlers = createRoomAgentToolHandlers({ roomId, goalManager, taskManager, groupRepo });
	});

	afterEach(() => {
		db.close();
	});

	function parseResult(result: { content: Array<{ type: string; text: string }> }) {
		return JSON.parse(result.content[0].text) as Record<string, unknown>;
	}

	describe('create_goal', () => {
		it('should create a goal', async () => {
			const result = parseResult(
				await handlers.create_goal({
					title: 'Add health check',
					description: 'Need an endpoint at /health',
				})
			);
			expect(result.success).toBe(true);
			expect(result.goalId).toBeDefined();
		});
	});

	describe('list_goals', () => {
		it('should list goals', async () => {
			await handlers.create_goal({ title: 'Goal 1' });
			await handlers.create_goal({ title: 'Goal 2' });
			const result = parseResult(await handlers.list_goals());
			expect(result.success).toBe(true);
			expect((result.goals as unknown[]).length).toBe(2);
		});
	});

	describe('update_goal', () => {
		it('should update goal status', async () => {
			const created = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = created.goalId as string;
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, status: 'completed' })
			);
			expect(result.success).toBe(true);
		});

		it('should return error for non-existent goal', async () => {
			const result = parseResult(
				await handlers.update_goal({ goal_id: 'no-such-goal', status: 'completed' })
			);
			expect(result.success).toBe(false);
		});
	});

	describe('create_task', () => {
		it('should create a task', async () => {
			const result = parseResult(
				await handlers.create_task({
					title: 'Implement endpoint',
					description: 'Add GET /health returning 200',
				})
			);
			expect(result.success).toBe(true);
			expect(result.taskId).toBeDefined();
		});

		it('should link task to goal when goal_id provided', async () => {
			const goal = parseResult(await handlers.create_goal({ title: 'Health' }));
			const goalId = goal.goalId as string;

			await handlers.create_task({
				title: 'Impl',
				description: 'Do it',
				goal_id: goalId,
			});

			const goals = parseResult(await handlers.list_goals());
			const updatedGoal = (goals.goals as Array<{ id: string; linkedTaskIds: string[] }>).find(
				(g) => g.id === goalId
			);
			expect(updatedGoal!.linkedTaskIds.length).toBe(1);
		});
	});

	describe('list_tasks', () => {
		it('should list all tasks', async () => {
			await handlers.create_task({ title: 'T1', description: 'd1' });
			await handlers.create_task({ title: 'T2', description: 'd2' });
			const result = parseResult(await handlers.list_tasks({}));
			expect((result.tasks as unknown[]).length).toBe(2);
		});

		it('should filter by goal_id', async () => {
			const goal = parseResult(await handlers.create_goal({ title: 'G1' }));
			const goalId = goal.goalId as string;
			await handlers.create_task({
				title: 'Linked',
				description: 'd',
				goal_id: goalId,
			});
			await handlers.create_task({ title: 'Unlinked', description: 'd' });

			const result = parseResult(await handlers.list_tasks({ goal_id: goalId }));
			expect((result.tasks as unknown[]).length).toBe(1);
		});
	});

	describe('cancel_task', () => {
		it('should cancel a task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(await handlers.cancel_task({ task_id: created.taskId as string }));
			expect(result.success).toBe(true);

			const tasks = parseResult(await handlers.list_tasks({ status: 'failed' }));
			expect((tasks.tasks as unknown[]).length).toBe(1);
		});
	});

	describe('get_room_status', () => {
		it('should return room overview', async () => {
			await handlers.create_goal({ title: 'G1' });
			await handlers.create_task({ title: 'T1', description: 'd' });
			const result = parseResult(await handlers.get_room_status());
			expect(result.success).toBe(true);

			const status = result.status as {
				goals: { total: number };
				tasks: { total: number };
				activeGroups: number;
			};
			expect(status.goals.total).toBe(1);
			expect(status.tasks.total).toBe(1);
			expect(status.activeGroups).toBe(0);
		});
	});
});
