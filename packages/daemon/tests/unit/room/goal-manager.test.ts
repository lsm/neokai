/**
 * GoalManager Tests
 *
 * Tests for goal management with progress tracking:
 * - Initialization
 * - Creating goals
 * - Listing and filtering goals
 * - Status transitions (pending -> in_progress -> completed/blocked)
 * - Linking tasks to goals
 * - Progress aggregation from linked tasks
 * - Priority handling
 * - Edge cases
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { GoalManager } from '../../../src/lib/room/goal-manager';
import { RoomManager } from '../../../src/lib/room/room-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomGoal, GoalStatus, GoalPriority } from '@neokai/shared';

describe('GoalManager', () => {
	let db: Database;
	let goalManager: GoalManager;
	let taskManager: TaskManager;
	let roomManager: RoomManager;
	let roomId: string;
	let mockDaemonHub: DaemonHub;
	let trackedEvents: Array<{ event: string; data: unknown }>;

	beforeEach(() => {
		// Use an anonymous in-memory database for each test
		// This ensures complete isolation between tests
		db = new Database(':memory:');
		createTables(db);

		// Create goals table (migration 17 - not included in createTables)
		db.exec(`
			CREATE TABLE IF NOT EXISTS goals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]',
				metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

		// Create room manager and a room
		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: [{ path: '/workspace/test' }],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Track events emitted by the daemon hub
		trackedEvents = [];
		mockDaemonHub = {
			emit: mock(async (event: string, data: unknown) => {
				trackedEvents.push({ event, data });
			}),
		} as unknown as DaemonHub;

		// Create goal manager with mock daemon hub
		goalManager = new GoalManager(db, roomId, mockDaemonHub);

		// Create task manager for testing task linking
		taskManager = new TaskManager(db, roomId);
	});

	afterEach(() => {
		db.close();
	});

	describe('initialization', () => {
		it('should create goal manager with valid room', () => {
			expect(goalManager).toBeDefined();
		});

		it('should work without daemon hub (no event emission)', async () => {
			const managerWithoutHub = new GoalManager(db, roomId);
			const goal = await managerWithoutHub.createGoal({
				title: 'Test Goal',
				description: 'Description',
			});

			expect(goal).toBeDefined();
			expect(goal.title).toBe('Test Goal');
		});
	});

	describe('createGoal', () => {
		it('should create a goal with minimal params', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Goal',
				description: '',
			});

			expect(goal).toBeDefined();
			expect(goal.id).toBeDefined();
			expect(goal.roomId).toBe(roomId);
			expect(goal.title).toBe('Test Goal');
			expect(goal.description).toBe('');
			expect(goal.status).toBe('pending');
			expect(goal.priority).toBe('normal');
			expect(goal.progress).toBe(0);
			expect(goal.linkedTaskIds).toEqual([]);
			expect(goal.metrics).toEqual({});
		});

		it('should create a goal with all params', async () => {
			const goal = await goalManager.createGoal({
				title: 'Full Goal',
				description: 'A detailed goal description',
				priority: 'high',
			});

			expect(goal.title).toBe('Full Goal');
			expect(goal.description).toBe('A detailed goal description');
			expect(goal.priority).toBe('high');
		});

		it('should create goal with urgent priority', async () => {
			const goal = await goalManager.createGoal({
				title: 'Urgent Goal',
				description: '',
				priority: 'urgent',
			});

			expect(goal.priority).toBe('urgent');
		});

		it('should create goal with low priority', async () => {
			const goal = await goalManager.createGoal({
				title: 'Low Priority Goal',
				description: '',
				priority: 'low',
			});

			expect(goal.priority).toBe('low');
		});

		it('should set createdAt timestamp', async () => {
			const before = Date.now();
			const goal = await goalManager.createGoal({ title: 'Test', description: '' });
			const after = Date.now();

			expect(goal.createdAt).toBeGreaterThanOrEqual(before);
			expect(goal.createdAt).toBeLessThanOrEqual(after);
		});

		it('should emit goal.created event', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Goal',
				description: 'Description',
			});

			expect(trackedEvents).toHaveLength(1);
			expect(trackedEvents[0].event).toBe('goal.created');
			expect(trackedEvents[0].data).toEqual({
				sessionId: `room:${roomId}`,
				roomId,
				goalId: goal.id,
				goal,
			});
		});
	});

	describe('getGoal', () => {
		it('should get a goal by ID', async () => {
			const created = await goalManager.createGoal({
				title: 'Test Goal',
				description: '',
			});

			const retrieved = await goalManager.getGoal(created.id);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(created.id);
			expect(retrieved?.title).toBe('Test Goal');
		});

		it('should return null for non-existent goal', async () => {
			const goal = await goalManager.getGoal('non-existent-id');

			expect(goal).toBeNull();
		});

		it('should only return goals from the same room', async () => {
			const created = await goalManager.createGoal({
				title: 'Room 1 Goal',
				description: '',
			});

			// Create another room and goal manager
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const goalManager2 = new GoalManager(db, room2.id);

			// Should not be able to access room 1's goal from room 2's manager
			const retrieved = await goalManager2.getGoal(created.id);

			expect(retrieved).toBeNull();
		});
	});

	describe('listGoals', () => {
		it('should list all goals for room', async () => {
			await goalManager.createGoal({ title: 'Goal 1', description: '' });
			await goalManager.createGoal({ title: 'Goal 2', description: '' });
			await goalManager.createGoal({ title: 'Goal 3', description: '' });

			const goals = await goalManager.listGoals();

			expect(goals).toHaveLength(3);
		});

		it('should filter goals by status', async () => {
			await goalManager.createGoal({ title: 'Goal 1', description: '' });
			const goal2 = await goalManager.createGoal({ title: 'Goal 2', description: '' });
			await goalManager.startGoal(goal2.id);

			const pendingGoals = await goalManager.listGoals('pending');
			const inProgressGoals = await goalManager.listGoals('in_progress');

			expect(pendingGoals).toHaveLength(1);
			expect(inProgressGoals).toHaveLength(1);
		});

		it('should return empty array for room with no goals', async () => {
			const goals = await goalManager.listGoals();

			expect(goals).toEqual([]);
		});

		it('should not return goals from other rooms', async () => {
			await goalManager.createGoal({ title: 'Room 1 Goal', description: '' });

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const goalManager2 = new GoalManager(db, room2.id);
			await goalManager2.createGoal({ title: 'Room 2 Goal', description: '' });

			const goals1 = await goalManager.listGoals();
			const goals2 = await goalManager2.listGoals();

			expect(goals1).toHaveLength(1);
			expect(goals2).toHaveLength(1);
		});
	});

	describe('updateGoalStatus', () => {
		it('should update goal status to in_progress', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.updateGoalStatus(goal.id, 'in_progress');

			expect(updated.status).toBe('in_progress');
		});

		it('should update goal status to completed', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.updateGoalStatus(goal.id, 'completed');

			expect(updated.status).toBe('completed');
			expect(updated.completedAt).toBeDefined();
		});

		it('should update goal status to blocked', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.updateGoalStatus(goal.id, 'blocked');

			expect(updated.status).toBe('blocked');
		});

		it('should include additional updates', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.updateGoalStatus(goal.id, 'completed', {
				progress: 100,
			});

			expect(updated.progress).toBe(100);
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.updateGoalStatus('non-existent', 'completed')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});

		it('should emit goal.updated event', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			trackedEvents.length = 0; // Clear create event

			const updated = await goalManager.updateGoalStatus(goal.id, 'in_progress');

			expect(trackedEvents).toHaveLength(1);
			expect(trackedEvents[0].event).toBe('goal.updated');
			expect(trackedEvents[0].data).toEqual({
				sessionId: `room:${roomId}`,
				roomId,
				goalId: goal.id,
				goal: updated,
			});
		});
	});

	describe('updateGoalProgress', () => {
		it('should update goal progress', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.updateGoalProgress(goal.id, 50);

			expect(updated.progress).toBe(50);
		});

		it('should update goal progress with metrics', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const metrics = { tasksCompleted: 5, totalTasks: 10 };
			const updated = await goalManager.updateGoalProgress(goal.id, 75, metrics);

			expect(updated.progress).toBe(75);
			expect(updated.metrics).toEqual(metrics);
		});

		it('should clamp progress to 0-100 range', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated1 = await goalManager.updateGoalProgress(goal.id, -10);
			expect(updated1.progress).toBe(0);

			const updated2 = await goalManager.updateGoalProgress(goal.id, 150);
			expect(updated2.progress).toBe(100);
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.updateGoalProgress('non-existent', 50)).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});

		it('should emit goal.progressUpdated event', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			trackedEvents.length = 0; // Clear create event

			await goalManager.updateGoalProgress(goal.id, 75);

			expect(trackedEvents).toHaveLength(1);
			expect(trackedEvents[0].event).toBe('goal.progressUpdated');
			expect(trackedEvents[0].data).toEqual({
				sessionId: `room:${roomId}`,
				roomId,
				goalId: goal.id,
				progress: 75,
			});
		});
	});

	describe('updateGoalPriority', () => {
		it('should update goal priority', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test Goal',
				description: '',
				priority: 'normal',
			});

			const updated = await goalManager.updateGoalPriority(goal.id, 'urgent');

			expect(updated.priority).toBe('urgent');
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.updateGoalPriority('non-existent', 'high')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	describe('startGoal', () => {
		it('should start goal and set status to in_progress', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.startGoal(goal.id);

			expect(updated.status).toBe('in_progress');
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.startGoal('non-existent')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	describe('completeGoal', () => {
		it('should complete goal and set progress to 100', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.completeGoal(goal.id);

			expect(updated.status).toBe('completed');
			expect(updated.progress).toBe(100);
			expect(updated.completedAt).toBeDefined();
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.completeGoal('non-existent')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	describe('blockGoal', () => {
		it('should block goal', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const updated = await goalManager.blockGoal(goal.id);

			expect(updated.status).toBe('blocked');
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.blockGoal('non-existent')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	describe('unblockGoal', () => {
		it('should unblock goal and return to pending status', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			await goalManager.blockGoal(goal.id);

			const updated = await goalManager.unblockGoal(goal.id);

			expect(updated.status).toBe('pending');
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.unblockGoal('non-existent')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	describe('linkTaskToGoal', () => {
		it('should link a task to a goal', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await goalManager.linkTaskToGoal(goal.id, task.id);

			expect(updated.linkedTaskIds).toContain(task.id);
		});

		it('should throw error for non-existent goal', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			await expect(goalManager.linkTaskToGoal('non-existent', task.id)).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});

		it('should throw error for non-existent task', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			await expect(goalManager.linkTaskToGoal(goal.id, 'non-existent')).rejects.toThrow(
				'Task not found in this room: non-existent'
			);
		});

		it('should throw error for task from different room', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const taskManager2 = new TaskManager(db, room2.id);
			const task = await taskManager2.createTask({ title: 'Room 2 Task', description: '' });

			await expect(goalManager.linkTaskToGoal(goal.id, task.id)).rejects.toThrow(
				`Task not found in this room: ${task.id}`
			);
		});

		it('should recalculate progress when task is linked', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });
			await taskManager.updateTaskProgress(task.id, 50);

			const updated = await goalManager.linkTaskToGoal(goal.id, task.id);

			expect(updated.progress).toBe(50);
		});

		it('should not duplicate task IDs', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			await goalManager.linkTaskToGoal(goal.id, task.id);
			const updated = await goalManager.linkTaskToGoal(goal.id, task.id);

			expect(updated.linkedTaskIds.filter((id) => id === task.id)).toHaveLength(1);
		});
	});

	describe('unlinkTaskFromGoal', () => {
		it('should unlink a task from a goal', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });
			await goalManager.linkTaskToGoal(goal.id, task.id);

			const updated = await goalManager.unlinkTaskFromGoal(goal.id, task.id);

			expect(updated.linkedTaskIds).not.toContain(task.id);
		});

		it('should throw error for non-existent goal', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			await expect(goalManager.unlinkTaskFromGoal('non-existent', task.id)).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});

		it('should recalculate progress when task is unlinked', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task1 = await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.updateTaskProgress(task1.id, 50);
			await taskManager.updateTaskProgress(task2.id, 100);

			await goalManager.linkTaskToGoal(goal.id, task1.id);
			await goalManager.linkTaskToGoal(goal.id, task2.id);

			// Progress should be 75 (average of 50 and 100)
			let updated = await goalManager.getGoal(goal.id);
			expect(updated?.progress).toBe(75);

			// Unlink task2, progress should now be 50
			updated = await goalManager.unlinkTaskFromGoal(goal.id, task2.id);
			expect(updated?.progress).toBe(50);
		});
	});

	describe('calculateProgressFromTasks', () => {
		it('should return 0 for goal with no linked tasks', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const progress = await goalManager.calculateProgressFromTasks(goal);

			expect(progress).toBe(0);
		});

		it('should calculate average progress from linked tasks', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task1 = await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.updateTaskProgress(task1.id, 50);
			await taskManager.updateTaskProgress(task2.id, 100);

			await goalManager.linkTaskToGoal(goal.id, task1.id);
			await goalManager.linkTaskToGoal(goal.id, task2.id);

			const updatedGoal = await goalManager.getGoal(goal.id);
			const progress = await goalManager.calculateProgressFromTasks(updatedGoal!);

			expect(progress).toBe(75);
		});

		it('should treat completed tasks as 100%', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task1 = await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.completeTask(task1.id, 'Done');
			await taskManager.updateTaskProgress(task2.id, 50);

			await goalManager.linkTaskToGoal(goal.id, task1.id);
			await goalManager.linkTaskToGoal(goal.id, task2.id);

			const updatedGoal = await goalManager.getGoal(goal.id);
			const progress = await goalManager.calculateProgressFromTasks(updatedGoal!);

			expect(progress).toBe(75); // (100 + 50) / 2
		});

		it('should treat failed tasks as 0%', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task1 = await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.failTask(task1.id, 'Failed');
			await taskManager.updateTaskProgress(task2.id, 50);

			await goalManager.linkTaskToGoal(goal.id, task1.id);
			await goalManager.linkTaskToGoal(goal.id, task2.id);

			const updatedGoal = await goalManager.getGoal(goal.id);
			const progress = await goalManager.calculateProgressFromTasks(updatedGoal!);

			expect(progress).toBe(25); // (0 + 50) / 2
		});

		it('should ignore tasks from other rooms', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task1 = await taskManager.createTask({ title: 'Task 1', description: '' });
			await taskManager.updateTaskProgress(task1.id, 50);

			// Manually add a non-existent task ID to linkedTaskIds
			const goalRepo = new (
				await import('../../../src/storage/repositories/goal-repository')
			).GoalRepository(db);
			goalRepo.updateGoal(goal.id, { linkedTaskIds: [task1.id, 'non-existent-task'] });

			const updatedGoal = await goalManager.getGoal(goal.id);
			const progress = await goalManager.calculateProgressFromTasks(updatedGoal!);

			// Only task1 should be counted
			expect(progress).toBe(50);
		});
	});

	describe('getGoalsForTask', () => {
		it('should return goals that have a specific task linked', async () => {
			const goal1 = await goalManager.createGoal({ title: 'Goal 1', description: '' });
			const goal2 = await goalManager.createGoal({ title: 'Goal 2', description: '' });
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			await goalManager.linkTaskToGoal(goal1.id, task.id);
			await goalManager.linkTaskToGoal(goal2.id, task.id);

			const goals = await goalManager.getGoalsForTask(task.id);

			expect(goals).toHaveLength(2);
			expect(goals.map((g) => g.id)).toContain(goal1.id);
			expect(goals.map((g) => g.id)).toContain(goal2.id);
		});

		it('should return empty array when task is not linked to any goal', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const goals = await goalManager.getGoalsForTask(task.id);

			expect(goals).toEqual([]);
		});
	});

	describe('updateGoalsForTask', () => {
		it('should recalculate progress for all goals linked to a task', async () => {
			const goal1 = await goalManager.createGoal({ title: 'Goal 1', description: '' });
			const goal2 = await goalManager.createGoal({ title: 'Goal 2', description: '' });
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			await goalManager.linkTaskToGoal(goal1.id, task.id);
			await goalManager.linkTaskToGoal(goal2.id, task.id);

			// Update task progress
			await taskManager.updateTaskProgress(task.id, 75);

			// Trigger recalculation
			await goalManager.updateGoalsForTask(task.id);

			const updatedGoal1 = await goalManager.getGoal(goal1.id);
			const updatedGoal2 = await goalManager.getGoal(goal2.id);

			expect(updatedGoal1?.progress).toBe(75);
			expect(updatedGoal2?.progress).toBe(75);
		});
	});

	describe('getActiveCount', () => {
		it('should return 0 for room with no active goals', async () => {
			const count = await goalManager.getActiveCount();

			expect(count).toBe(0);
		});

		it('should return correct count of pending and in_progress goals', async () => {
			await goalManager.createGoal({ title: 'Goal 1', description: '' });
			const goal2 = await goalManager.createGoal({ title: 'Goal 2', description: '' });
			const goal3 = await goalManager.createGoal({ title: 'Goal 3', description: '' });
			await goalManager.startGoal(goal2.id);
			await goalManager.completeGoal(goal3.id);

			const count = await goalManager.getActiveCount();

			expect(count).toBe(2); // 1 pending + 1 in_progress
		});
	});

	describe('getActiveGoals', () => {
		it('should return empty array when no active goals', async () => {
			const goals = await goalManager.getActiveGoals();

			expect(goals).toEqual([]);
		});

		it('should return only pending and in_progress goals', async () => {
			await goalManager.createGoal({ title: 'Pending Goal', description: '' });
			const goal2 = await goalManager.createGoal({ title: 'In Progress Goal', description: '' });
			await goalManager.startGoal(goal2.id);
			const goal3 = await goalManager.createGoal({ title: 'Completed Goal', description: '' });
			await goalManager.completeGoal(goal3.id);
			const goal4 = await goalManager.createGoal({ title: 'Blocked Goal', description: '' });
			await goalManager.blockGoal(goal4.id);

			const goals = await goalManager.getActiveGoals();

			expect(goals).toHaveLength(2);
			const statuses = goals.map((g) => g.status);
			expect(statuses).toContain('pending');
			expect(statuses).toContain('in_progress');
			expect(statuses).not.toContain('completed');
			expect(statuses).not.toContain('blocked');
		});
	});

	describe('getNextGoal', () => {
		it('should return null when no active goals', async () => {
			const goal = await goalManager.getNextGoal();

			expect(goal).toBeNull();
		});

		it('should return active goal by priority', async () => {
			await goalManager.createGoal({ title: 'Low Goal', description: '', priority: 'low' });
			await goalManager.createGoal({ title: 'High Goal', description: '', priority: 'high' });
			await goalManager.createGoal({ title: 'Normal Goal', description: '', priority: 'normal' });

			const goal = await goalManager.getNextGoal();

			expect(goal).not.toBeNull();
			expect(goal?.title).toBe('High Goal');
		});

		it('should return oldest goal when same priority', async () => {
			await goalManager.createGoal({ title: 'First Goal', description: '', priority: 'normal' });
			await new Promise((resolve) => setTimeout(resolve, 5));
			await goalManager.createGoal({ title: 'Second Goal', description: '', priority: 'normal' });

			const goal = await goalManager.getNextGoal();

			expect(goal?.title).toBe('First Goal');
		});

		it('should prioritize by urgency order', async () => {
			await goalManager.createGoal({ title: 'Normal', description: '', priority: 'normal' });
			await goalManager.createGoal({ title: 'Low', description: '', priority: 'low' });
			await goalManager.createGoal({ title: 'High', description: '', priority: 'high' });
			await goalManager.createGoal({ title: 'Urgent', description: '', priority: 'urgent' });

			const goal = await goalManager.getNextGoal();

			expect(goal?.title).toBe('Urgent');
		});

		it('should prefer in_progress goals over pending', async () => {
			const goal1 = await goalManager.createGoal({
				title: 'Pending Urgent',
				description: '',
				priority: 'urgent',
			});
			const goal2 = await goalManager.createGoal({
				title: 'In Progress Normal',
				description: '',
				priority: 'normal',
			});
			await goalManager.startGoal(goal2.id);

			const nextGoal = await goalManager.getNextGoal();

			// Should prefer in_progress even though pending has higher priority
			expect(nextGoal?.title).toBe('In Progress Normal');
		});

		it('should not return completed goals', async () => {
			const goal = await goalManager.createGoal({ title: 'Completed Goal', description: '' });
			await goalManager.completeGoal(goal.id);

			const nextGoal = await goalManager.getNextGoal();

			expect(nextGoal).toBeNull();
		});

		it('should not return blocked goals', async () => {
			const goal = await goalManager.createGoal({ title: 'Blocked Goal', description: '' });
			await goalManager.blockGoal(goal.id);

			const nextGoal = await goalManager.getNextGoal();

			expect(nextGoal).toBeNull();
		});
	});

	describe('deleteGoal', () => {
		it('should delete an existing goal', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const result = await goalManager.deleteGoal(goal.id);

			expect(result).toBe(true);

			const retrieved = await goalManager.getGoal(goal.id);
			expect(retrieved).toBeNull();
		});

		it('should return false for non-existent goal', async () => {
			const result = await goalManager.deleteGoal('non-existent');

			expect(result).toBe(false);
		});

		it('should not delete goals from other rooms', async () => {
			const goal = await goalManager.createGoal({ title: 'Room 1 Goal', description: '' });

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const goalManager2 = new GoalManager(db, room2.id);

			const result = await goalManager2.deleteGoal(goal.id);

			expect(result).toBe(false);

			const retrieved = await goalManager.getGoal(goal.id);
			expect(retrieved).not.toBeNull();
		});
	});

	describe('recalculateProgress', () => {
		it('should recalculate and update goal progress', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const task1 = await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.updateTaskProgress(task1.id, 40);
			await taskManager.updateTaskProgress(task2.id, 60);

			// Link tasks manually via repo to avoid auto-recalculation
			const goalRepo = new (
				await import('../../../src/storage/repositories/goal-repository')
			).GoalRepository(db);
			goalRepo.updateGoal(goal.id, { linkedTaskIds: [task1.id, task2.id] });

			const progress = await goalManager.recalculateProgress(goal.id);

			expect(progress).toBe(50);

			const updatedGoal = await goalManager.getGoal(goal.id);
			expect(updatedGoal?.progress).toBe(50);
		});

		it('should throw error for non-existent goal', async () => {
			await expect(goalManager.recalculateProgress('non-existent')).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	describe('multiple rooms', () => {
		it('should isolate goals between rooms', async () => {
			// Create another room
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const goalManager2 = new GoalManager(db, room2.id);

			// Add goals to both rooms
			await goalManager.createGoal({ title: 'Room 1 Goal', description: '' });
			await goalManager2.createGoal({ title: 'Room 2 Goal', description: '' });

			// Verify isolation
			const goals1 = await goalManager.listGoals();
			const goals2 = await goalManager2.listGoals();

			expect(goals1).toHaveLength(1);
			expect(goals2).toHaveLength(1);
			expect(goals1[0].title).toBe('Room 1 Goal');
			expect(goals2[0].title).toBe('Room 2 Goal');
		});
	});

	describe('edge cases', () => {
		it('should handle empty description', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test',
				description: '',
			});

			expect(goal.description).toBe('');
		});

		it('should handle special characters in title', async () => {
			const goal = await goalManager.createGoal({
				title: 'Test with "quotes" and \'apostrophes\'',
				description: '',
			});

			expect(goal.title).toBe('Test with "quotes" and \'apostrophes\'');
		});

		it('should handle unicode in title and description', async () => {
			const goal = await goalManager.createGoal({
				title: 'Goal with unicode: \u4f60\u597d\u4e16\u754c',
				description: 'Description with emoji: \ud83c\udf0d',
			});

			expect(goal.title).toBe('Goal with unicode: \u4f60\u597d\u4e16\u754c');
			expect(goal.description).toBe('Description with emoji: \ud83c\udf0d');
		});

		it('should handle very long description', async () => {
			const longDescription = 'x'.repeat(10000);
			const goal = await goalManager.createGoal({
				title: 'Test',
				description: longDescription,
			});

			expect(goal.description).toBe(longDescription);
		});

		it('should handle multiple status transitions', async () => {
			const goal = await goalManager.createGoal({ title: 'Test', description: '' });

			await goalManager.startGoal(goal.id);
			await goalManager.blockGoal(goal.id);
			await goalManager.unblockGoal(goal.id);
			await goalManager.startGoal(goal.id);
			await goalManager.completeGoal(goal.id);

			const final = await goalManager.getGoal(goal.id);
			expect(final?.status).toBe('completed');
		});

		it('should handle linking multiple tasks to a goal', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });
			const tasks = [];
			for (let i = 0; i < 10; i++) {
				const task = await taskManager.createTask({ title: `Task ${i}`, description: '' });
				await taskManager.updateTaskProgress(task.id, i * 10);
				tasks.push(task);
			}

			for (const task of tasks) {
				await goalManager.linkTaskToGoal(goal.id, task.id);
			}

			const updatedGoal = await goalManager.getGoal(goal.id);
			expect(updatedGoal?.linkedTaskIds).toHaveLength(10);
		});

		it('should handle metrics with various numeric values', async () => {
			const goal = await goalManager.createGoal({ title: 'Test Goal', description: '' });

			const metrics = {
				tasksCompleted: 10,
				percentage: 85.5,
				largeNumber: 1000000,
				zero: 0,
			};
			const updated = await goalManager.updateGoalProgress(goal.id, 50, metrics);

			expect(updated.metrics).toEqual(metrics);
		});
	});
});
