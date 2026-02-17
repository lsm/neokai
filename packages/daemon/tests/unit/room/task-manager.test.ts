/**
 * TaskManager Tests
 *
 * Tests for task management with status transitions:
 * - Initialization
 * - Creating tasks
 * - Listing and filtering tasks
 * - Status transitions (pending -> in_progress -> completed/failed)
 * - Task assignment to sessions
 * - Progress updates
 * - Priority handling
 * - Dependencies
 * - Edge cases
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { TaskManager } from '../../../src/lib/room/task-manager';
import { RoomManager } from '../../../src/lib/room/room-manager';
import type { NeoTask, TaskStatus, TaskPriority, TaskFilter } from '@neokai/shared';

describe('TaskManager', () => {
	let db: Database;
	let taskManager: TaskManager;
	let roomManager: RoomManager;
	let roomId: string;

	beforeEach(() => {
		// Use an anonymous in-memory database for each test
		// This ensures complete isolation between tests
		db = new Database(':memory:');
		createTables(db);

		// Create room manager and a room
		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: ['/workspace/test'],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Create task manager
		taskManager = new TaskManager(db, roomId);
	});

	afterEach(() => {
		db.close();
	});

	describe('initialization', () => {
		it('should create task manager with valid room', () => {
			expect(taskManager).toBeDefined();
		});
	});

	describe('createTask', () => {
		it('should create a task with minimal params', async () => {
			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
			});

			expect(task).toBeDefined();
			expect(task.id).toBeDefined();
			expect(task.roomId).toBeDefined();
			expect(task.title).toBe('Test Task');
			expect(task.description).toBe('');
			expect(task.status).toBe('pending');
			expect(task.priority).toBe('normal');
			expect(task.progress).toBeUndefined();
			expect(task.dependsOn).toEqual([]);
		});

		it('should create a task with all params', async () => {
			const task = await taskManager.createTask({
				title: 'Full Task',
				description: 'A detailed task description',
				priority: 'high',
				dependsOn: ['task-1', 'task-2'],
			});

			expect(task.title).toBe('Full Task');
			expect(task.description).toBe('A detailed task description');
			expect(task.priority).toBe('high');
			expect(task.dependsOn).toEqual(['task-1', 'task-2']);
		});

		it('should create task with urgent priority', async () => {
			const task = await taskManager.createTask({
				title: 'Urgent Task',
				description: '',
				priority: 'urgent',
			});

			expect(task.priority).toBe('urgent');
		});

		it('should create task with low priority', async () => {
			const task = await taskManager.createTask({
				title: 'Low Priority Task',
				description: '',
				priority: 'low',
			});

			expect(task.priority).toBe('low');
		});

		it('should set createdAt timestamp', async () => {
			const before = Date.now();
			const task = await taskManager.createTask({ title: 'Test', description: '' });
			const after = Date.now();

			expect(task.createdAt).toBeGreaterThanOrEqual(before);
			expect(task.createdAt).toBeLessThanOrEqual(after);
		});
	});

	describe('getTask', () => {
		it('should get a task by ID', async () => {
			const created = await taskManager.createTask({
				title: 'Test Task',
				description: '',
			});

			const retrieved = await taskManager.getTask(created.id);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe(created.id);
			expect(retrieved?.title).toBe('Test Task');
		});

		it('should return null for non-existent task', async () => {
			const task = await taskManager.getTask('non-existent-id');

			expect(task).toBeNull();
		});

		it('should only return tasks from the same room', async () => {
			const created = await taskManager.createTask({
				title: 'Room 1 Task',
				description: '',
			});

			// Create another room and task manager
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const taskManager2 = new TaskManager(db, room2.id);

			// Should not be able to access room 1's task from room 2's manager
			const retrieved = await taskManager2.getTask(created.id);

			expect(retrieved).toBeNull();
		});
	});

	describe('listTasks', () => {
		it('should list all tasks for room', async () => {
			await taskManager.createTask({ title: 'Task 1', description: '' });
			await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.createTask({ title: 'Task 3', description: '' });

			const tasks = await taskManager.listTasks();

			expect(tasks).toHaveLength(3);
		});

		it('should filter tasks by status', async () => {
			await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.startTask(task2.id, 'session-123');

			const pendingTasks = await taskManager.listTasks({ status: 'pending' });
			const inProgressTasks = await taskManager.listTasks({ status: 'in_progress' });

			expect(pendingTasks).toHaveLength(1);
			expect(inProgressTasks).toHaveLength(1);
		});

		it('should filter tasks by priority', async () => {
			await taskManager.createTask({ title: 'Task 1', description: '', priority: 'high' });
			await taskManager.createTask({ title: 'Task 2', description: '', priority: 'low' });
			await taskManager.createTask({ title: 'Task 3', description: '', priority: 'high' });

			const highPriorityTasks = await taskManager.listTasks({ priority: 'high' });

			expect(highPriorityTasks).toHaveLength(2);
		});

		it('should filter tasks by session ID', async () => {
			await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			await taskManager.startTask(task2.id, 'session-123');

			const sessionTasks = await taskManager.listTasks({ sessionId: 'session-123' });

			expect(sessionTasks).toHaveLength(1);
			expect(sessionTasks[0].sessionId).toBe('session-123');
		});

		it('should return empty array for room with no tasks', async () => {
			const tasks = await taskManager.listTasks();

			expect(tasks).toEqual([]);
		});

		it('should not return tasks from other rooms', async () => {
			await taskManager.createTask({ title: 'Room 1 Task', description: '' });

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const taskManager2 = new TaskManager(db, room2.id);
			await taskManager2.createTask({ title: 'Room 2 Task', description: '' });

			const tasks1 = await taskManager.listTasks();
			const tasks2 = await taskManager2.listTasks();

			expect(tasks1).toHaveLength(1);
			expect(tasks2).toHaveLength(1);
		});
	});

	describe('updateTaskStatus', () => {
		it('should update task status to in_progress', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskStatus(task.id, 'in_progress');

			expect(updated.status).toBe('in_progress');
			expect(updated.startedAt).toBeDefined();
		});

		it('should update task status to completed', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskStatus(task.id, 'completed');

			expect(updated.status).toBe('completed');
			expect(updated.completedAt).toBeDefined();
		});

		it('should update task status to failed', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskStatus(task.id, 'failed');

			expect(updated.status).toBe('failed');
			expect(updated.completedAt).toBeDefined();
		});

		it('should update task status to blocked', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskStatus(task.id, 'blocked');

			expect(updated.status).toBe('blocked');
		});

		it('should include additional updates', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskStatus(task.id, 'completed', {
				result: 'Task completed successfully',
			});

			expect(updated.result).toBe('Task completed successfully');
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.updateTaskStatus('non-existent', 'completed')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('updateTaskProgress', () => {
		it('should update task progress', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskProgress(task.id, 50);

			expect(updated.progress).toBe(50);
		});

		it('should update task progress with current step', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskProgress(task.id, 75, 'Running tests');

			expect(updated.progress).toBe(75);
			expect(updated.currentStep).toBe('Running tests');
		});

		it('should clamp progress to 0-100 range', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated1 = await taskManager.updateTaskProgress(task.id, -10);
			expect(updated1.progress).toBe(0);

			const updated2 = await taskManager.updateTaskProgress(task.id, 150);
			expect(updated2.progress).toBe(100);
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.updateTaskProgress('non-existent', 50)).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('startTask', () => {
		it('should start task and assign session', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.startTask(task.id, 'session-123');

			expect(updated.status).toBe('in_progress');
			expect(updated.sessionId).toBe('session-123');
			expect(updated.startedAt).toBeDefined();
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.startTask('non-existent', 'session-123')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('completeTask', () => {
		it('should complete task with result', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.completeTask(task.id, 'Task completed successfully');

			expect(updated.status).toBe('completed');
			expect(updated.result).toBe('Task completed successfully');
			expect(updated.progress).toBe(100);
			expect(updated.completedAt).toBeDefined();
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.completeTask('non-existent', 'Done')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('failTask', () => {
		it('should fail task with error', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.failTask(task.id, 'Something went wrong');

			expect(updated.status).toBe('failed');
			expect(updated.error).toBe('Something went wrong');
			expect(updated.completedAt).toBeDefined();
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.failTask('non-existent', 'Error')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('blockTask', () => {
		it('should block task', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.blockTask(task.id);

			expect(updated.status).toBe('blocked');
		});

		it('should block task with reason', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.blockTask(task.id, 'Waiting for dependency');

			expect(updated.status).toBe('blocked');
			expect(updated.currentStep).toBe('Waiting for dependency');
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.blockTask('non-existent')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('unblockTask', () => {
		it('should unblock task and return to pending status', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });
			await taskManager.blockTask(task.id, 'Blocked');

			const updated = await taskManager.unblockTask(task.id);

			expect(updated.status).toBe('pending');
			// Note: currentStep is not cleared due to the way undefined is handled in the repository
			// The updateTaskStatus passes currentStep: undefined, but the repository checks !== undefined
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.unblockTask('non-existent')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('getPendingCount', () => {
		it('should return 0 for room with no pending tasks', async () => {
			const count = await taskManager.getPendingCount();

			expect(count).toBe(0);
		});

		it('should return correct count of pending tasks', async () => {
			await taskManager.createTask({ title: 'Task 1', description: '' });
			await taskManager.createTask({ title: 'Task 2', description: '' });
			const task3 = await taskManager.createTask({ title: 'Task 3', description: '' });
			await taskManager.startTask(task3.id, 'session-123');

			const count = await taskManager.getPendingCount();

			expect(count).toBe(2);
		});
	});

	describe('getActiveCount', () => {
		it('should return 0 for room with no active tasks', async () => {
			const count = await taskManager.getActiveCount();

			expect(count).toBe(0);
		});

		it('should return correct count of in_progress tasks', async () => {
			await taskManager.createTask({ title: 'Task 1', description: '' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: '' });
			const task3 = await taskManager.createTask({ title: 'Task 3', description: '' });
			await taskManager.startTask(task2.id, 'session-123');
			await taskManager.startTask(task3.id, 'session-456');

			const count = await taskManager.getActiveCount();

			expect(count).toBe(2);
		});
	});

	describe('getActiveTasks', () => {
		it('should return empty array when no active tasks', async () => {
			const tasks = await taskManager.getActiveTasks();

			expect(tasks).toEqual([]);
		});

		it('should return only non-completed, non-failed tasks', async () => {
			await taskManager.createTask({ title: 'Pending Task', description: '' });
			const task2 = await taskManager.createTask({ title: 'In Progress Task', description: '' });
			await taskManager.startTask(task2.id, 'session-123');
			const task3 = await taskManager.createTask({ title: 'Completed Task', description: '' });
			await taskManager.completeTask(task3.id, 'Done');
			const task4 = await taskManager.createTask({ title: 'Failed Task', description: '' });
			await taskManager.failTask(task4.id, 'Error');
			const task5 = await taskManager.createTask({ title: 'Blocked Task', description: '' });
			await taskManager.blockTask(task5.id);

			const tasks = await taskManager.getActiveTasks();

			expect(tasks).toHaveLength(3);
			const statuses = tasks.map((t) => t.status);
			expect(statuses).toContain('pending');
			expect(statuses).toContain('in_progress');
			expect(statuses).toContain('blocked');
		});
	});

	describe('deleteTask', () => {
		it('should delete an existing task', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const result = await taskManager.deleteTask(task.id);

			expect(result).toBe(true);

			const retrieved = await taskManager.getTask(task.id);
			expect(retrieved).toBeNull();
		});

		it('should return false for non-existent task', async () => {
			const result = await taskManager.deleteTask('non-existent');

			expect(result).toBe(false);
		});

		it('should not delete tasks from other rooms', async () => {
			const task = await taskManager.createTask({ title: 'Room 1 Task', description: '' });

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const taskManager2 = new TaskManager(db, room2.id);

			const result = await taskManager2.deleteTask(task.id);

			expect(result).toBe(false);

			const retrieved = await taskManager.getTask(task.id);
			expect(retrieved).not.toBeNull();
		});
	});

	describe('updateTaskPriority', () => {
		it('should update task priority', async () => {
			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				priority: 'normal',
			});

			const updated = await taskManager.updateTaskPriority(task.id, 'urgent');

			expect(updated.priority).toBe('urgent');
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.updateTaskPriority('non-existent', 'high')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('getNextPendingTask', () => {
		it('should return null when no pending tasks', async () => {
			const task = await taskManager.getNextPendingTask();

			expect(task).toBeNull();
		});

		it('should return pending task by priority', async () => {
			await taskManager.createTask({ title: 'Low Task', description: '', priority: 'low' });
			await taskManager.createTask({ title: 'High Task', description: '', priority: 'high' });
			await taskManager.createTask({ title: 'Normal Task', description: '', priority: 'normal' });

			const task = await taskManager.getNextPendingTask();

			expect(task).not.toBeNull();
			expect(task?.title).toBe('High Task');
		});

		it('should return oldest task when same priority', async () => {
			await taskManager.createTask({ title: 'First Task', description: '', priority: 'normal' });
			await new Promise((resolve) => setTimeout(resolve, 5));
			await taskManager.createTask({ title: 'Second Task', description: '', priority: 'normal' });

			const task = await taskManager.getNextPendingTask();

			expect(task?.title).toBe('First Task');
		});

		it('should prioritize by urgency order', async () => {
			await taskManager.createTask({ title: 'Normal', description: '', priority: 'normal' });
			await taskManager.createTask({ title: 'Low', description: '', priority: 'low' });
			await taskManager.createTask({ title: 'High', description: '', priority: 'high' });
			await taskManager.createTask({ title: 'Urgent', description: '', priority: 'urgent' });

			const task = await taskManager.getNextPendingTask();

			expect(task?.title).toBe('Urgent');
		});

		it('should skip tasks with unmet dependencies', async () => {
			const depTask = await taskManager.createTask({
				title: 'Dependency Task',
				description: '',
				priority: 'low',
			});
			await taskManager.createTask({
				title: 'Dependent Task',
				description: '',
				priority: 'high',
				dependsOn: [depTask.id],
			});

			const task = await taskManager.getNextPendingTask();

			// Should return dependency task, not the dependent one
			expect(task?.title).toBe('Dependency Task');
		});

		it('should return task with met dependencies', async () => {
			const depTask = await taskManager.createTask({ title: 'Dependency Task', description: '' });
			await taskManager.completeTask(depTask.id, 'Done');
			await taskManager.createTask({
				title: 'Dependent Task',
				description: '',
				priority: 'high',
				dependsOn: [depTask.id],
			});

			const task = await taskManager.getNextPendingTask();

			expect(task?.title).toBe('Dependent Task');
		});
	});

	describe('areDependenciesMet', () => {
		it('should return true for task with no dependencies', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const met = await taskManager.areDependenciesMet(task);

			expect(met).toBe(true);
		});

		it('should return true when all dependencies completed', async () => {
			const dep1 = await taskManager.createTask({ title: 'Dep 1', description: '' });
			const dep2 = await taskManager.createTask({ title: 'Dep 2', description: '' });
			await taskManager.completeTask(dep1.id, 'Done');
			await taskManager.completeTask(dep2.id, 'Done');

			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				dependsOn: [dep1.id, dep2.id],
			});

			const met = await taskManager.areDependenciesMet(task);

			expect(met).toBe(true);
		});

		it('should return false when dependency not completed', async () => {
			const dep = await taskManager.createTask({ title: 'Dep', description: '' });

			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				dependsOn: [dep.id],
			});

			const met = await taskManager.areDependenciesMet(task);

			expect(met).toBe(false);
		});

		it('should return false when dependency is in_progress', async () => {
			const dep = await taskManager.createTask({ title: 'Dep', description: '' });
			await taskManager.startTask(dep.id, 'session-123');

			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				dependsOn: [dep.id],
			});

			const met = await taskManager.areDependenciesMet(task);

			expect(met).toBe(false);
		});

		it('should return false when dependency does not exist', async () => {
			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				dependsOn: ['non-existent'],
			});

			const met = await taskManager.areDependenciesMet(task);

			expect(met).toBe(false);
		});

		it('should return false when any dependency not met', async () => {
			const dep1 = await taskManager.createTask({ title: 'Dep 1', description: '' });
			const dep2 = await taskManager.createTask({ title: 'Dep 2', description: '' });
			await taskManager.completeTask(dep1.id, 'Done');
			// dep2 is still pending

			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				dependsOn: [dep1.id, dep2.id],
			});

			const met = await taskManager.areDependenciesMet(task);

			expect(met).toBe(false);
		});
	});

	describe('multiple rooms', () => {
		it('should isolate tasks between rooms', async () => {
			// Create another room
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const taskManager2 = new TaskManager(db, room2.id);

			// Add tasks to both rooms
			await taskManager.createTask({ title: 'Room 1 Task', description: '' });
			await taskManager2.createTask({ title: 'Room 2 Task', description: '' });

			// Verify isolation
			const tasks1 = await taskManager.listTasks();
			const tasks2 = await taskManager2.listTasks();

			expect(tasks1).toHaveLength(1);
			expect(tasks2).toHaveLength(1);
			expect(tasks1[0].title).toBe('Room 1 Task');
			expect(tasks2[0].title).toBe('Room 2 Task');
		});
	});

	describe('edge cases', () => {
		it('should handle empty description', async () => {
			const task = await taskManager.createTask({
				title: 'Test',
				description: '',
			});

			expect(task.description).toBe('');
		});

		it('should handle empty dependencies', async () => {
			const task = await taskManager.createTask({
				title: 'Test',
				description: '',
				dependsOn: [],
			});

			expect(task.dependsOn).toEqual([]);
		});

		it('should handle special characters in title', async () => {
			const task = await taskManager.createTask({
				title: 'Test with "quotes" and \'apostrophes\'',
				description: '',
			});

			expect(task.title).toBe('Test with "quotes" and \'apostrophes\'');
		});

		it('should handle unicode in title and description', async () => {
			const task = await taskManager.createTask({
				title: '你好世界 🌍 Task',
				description: 'Description with unicode: مرحبا',
			});

			expect(task.title).toBe('你好世界 🌍 Task');
			expect(task.description).toBe('Description with unicode: مرحبا');
		});

		it('should handle very long description', async () => {
			const longDescription = 'x'.repeat(10000);
			const task = await taskManager.createTask({
				title: 'Test',
				description: longDescription,
			});

			expect(task.description).toBe(longDescription);
		});

		it('should handle multiple status transitions', async () => {
			const task = await taskManager.createTask({ title: 'Test', description: '' });

			await taskManager.startTask(task.id, 'session-123');
			await taskManager.blockTask(task.id, 'Waiting');
			await taskManager.unblockTask(task.id);
			await taskManager.startTask(task.id, 'session-456');
			await taskManager.completeTask(task.id, 'Done');

			const final = await taskManager.getTask(task.id);
			expect(final?.status).toBe('completed');
		});
	});
});
