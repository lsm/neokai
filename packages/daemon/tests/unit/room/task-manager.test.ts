/**
 * TaskManager Tests
 *
 * Tests for task management with status transitions:
 * - Initialization
 * - Creating tasks
 * - Listing and filtering tasks
 * - Status transitions (pending -> in_progress -> completed/failed/cancelled)
 * - Task assignment to sessions
 * - Progress updates
 * - Priority handling
 * - Dependencies
 * - Edge cases
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import {
	TaskManager,
	extractPrNumber,
	VALID_STATUS_TRANSITIONS,
} from '../../../src/lib/room/managers/task-manager';
import { RoomManager } from '../../../src/lib/room/managers/room-manager';

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
			allowedPaths: [{ path: '/workspace/test' }],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Create task manager
		taskManager = new TaskManager(db, roomId, { notifyChange: () => {} } as never);
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
			const dep1 = await taskManager.createTask({ title: 'Dep 1', description: '' });
			const dep2 = await taskManager.createTask({ title: 'Dep 2', description: '' });
			const task = await taskManager.createTask({
				title: 'Full Task',
				description: 'A detailed task description',
				priority: 'high',
				dependsOn: [dep1.id, dep2.id],
			});

			expect(task.title).toBe('Full Task');
			expect(task.description).toBe('A detailed task description');
			expect(task.priority).toBe('high');
			expect(task.dependsOn).toEqual([dep1.id, dep2.id]);
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
			const taskManager2 = new TaskManager(db, room2.id, { notifyChange: () => {} } as never);

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
			await taskManager.startTask(task2.id);

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

		it('should return empty array for room with no tasks', async () => {
			const tasks = await taskManager.listTasks();

			expect(tasks).toEqual([]);
		});

		it('should not return tasks from other rooms', async () => {
			await taskManager.createTask({ title: 'Room 1 Task', description: '' });

			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const taskManager2 = new TaskManager(db, room2.id, { notifyChange: () => {} } as never);
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

		it('should update task status to needs_attention', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskStatus(task.id, 'needs_attention');

			expect(updated.status).toBe('needs_attention');
			expect(updated.completedAt).toBeDefined();
		});

		it('should update task status to review', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.updateTaskStatus(task.id, 'review');

			expect(updated.status).toBe('review');
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
		it('should start task and mark as in_progress', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.startTask(task.id);

			expect(updated.status).toBe('in_progress');
			expect(updated.startedAt).toBeDefined();
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.startTask('non-existent')).rejects.toThrow(
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

			expect(updated.status).toBe('needs_attention');
			expect(updated.error).toBe('Something went wrong');
			expect(updated.completedAt).toBeDefined();
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.failTask('non-existent', 'Error')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('cancelTask', () => {
		it('should cancel task with cancelled status (not needs_attention)', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.cancelTask(task.id);

			expect(updated.status).toBe('cancelled');
			expect(updated.error).toBeUndefined();
			expect(updated.completedAt).toBeDefined();
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.cancelTask('non-existent')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});

		it('should cascade cancellation to pending dependent tasks', async () => {
			const dep = await taskManager.createTask({ title: 'Dep', description: '' });
			const dependent = await taskManager.createTask({
				title: 'Dependent',
				description: '',
				dependsOn: [dep.id],
			});

			await taskManager.cancelTask(dep.id);

			const cancelledDep = await taskManager.getTask(dep.id);
			const cancelledDependent = await taskManager.getTask(dependent.id);
			expect(cancelledDep?.status).toBe('cancelled');
			expect(cancelledDependent?.status).toBe('cancelled');
		});

		it('should cascade transitively through dependency chains', async () => {
			const a = await taskManager.createTask({ title: 'A', description: '' });
			const b = await taskManager.createTask({
				title: 'B',
				description: '',
				dependsOn: [a.id],
			});
			const c = await taskManager.createTask({
				title: 'C',
				description: '',
				dependsOn: [b.id],
			});

			await taskManager.cancelTask(a.id);

			const [ra, rb, rc] = await Promise.all([
				taskManager.getTask(a.id),
				taskManager.getTask(b.id),
				taskManager.getTask(c.id),
			]);
			expect(ra?.status).toBe('cancelled');
			expect(rb?.status).toBe('cancelled');
			expect(rc?.status).toBe('cancelled');
		});

		it('should not cascade to in_progress dependent tasks', async () => {
			const dep = await taskManager.createTask({ title: 'Dep', description: '' });
			const running = await taskManager.createTask({
				title: 'Running',
				description: '',
				dependsOn: [dep.id],
			});
			await taskManager.startTask(running.id);

			await taskManager.cancelTask(dep.id);

			const afterCancel = await taskManager.getTask(running.id);
			// in_progress task is NOT cascaded — it's already running
			expect(afterCancel?.status).toBe('in_progress');
		});
	});

	describe('reviewTask', () => {
		it('should mark task for review', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.reviewTask(task.id);

			expect(updated.status).toBe('review');
		});

		it('should mark task for review with PR URL', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/1');

			expect(updated.status).toBe('review');
			expect(updated.prUrl).toBe('https://github.com/org/repo/pull/1');
			expect(updated.prNumber).toBe(1);
			expect(updated.prCreatedAt).toBeDefined();
		});

		it('should extract PR number from GitHub URL', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.reviewTask(
				task.id,
				'https://github.com/myorg/myrepo/pull/123'
			);

			expect(updated.prNumber).toBe(123);
		});

		it('should leave PR fields undefined when no prUrl provided on a fresh task', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });

			const updated = await taskManager.reviewTask(task.id);

			expect(updated.status).toBe('review');
			expect(updated.prUrl).toBeUndefined();
			expect(updated.prNumber).toBeUndefined();
			expect(updated.prCreatedAt).toBeUndefined();
		});

		it('should preserve existing PR data when reviewed again without prUrl (runtime escalation)', async () => {
			// Task first goes to review with a PR URL
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/42');

			// Simulate rejection — move back to in_progress
			await taskManager.updateTaskStatus(task.id, 'in_progress');

			// Runtime escalates to review without a prUrl (max feedback iterations reached)
			const escalated = await taskManager.reviewTask(task.id);

			// PR data must be preserved — not wiped
			expect(escalated.status).toBe('review');
			expect(escalated.prUrl).toBe('https://github.com/org/repo/pull/42');
			expect(escalated.prNumber).toBe(42);
			expect(escalated.prCreatedAt).toBeDefined();
		});

		it('should overwrite PR data when reviewed again with a new prUrl', async () => {
			const task = await taskManager.createTask({ title: 'Test Task', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/1');

			// Move back to in_progress, then submit new PR
			await taskManager.updateTaskStatus(task.id, 'in_progress');
			const updated = await taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/2');

			expect(updated.prUrl).toBe('https://github.com/org/repo/pull/2');
			expect(updated.prNumber).toBe(2);
		});

		it('should throw error for non-existent task', async () => {
			await expect(taskManager.reviewTask('non-existent')).rejects.toThrow(
				'Task not found: non-existent'
			);
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
			const taskManager2 = new TaskManager(db, room2.id, { notifyChange: () => {} } as never);

			const result = await taskManager2.deleteTask(task.id);

			expect(result).toBe(false);

			const retrieved = await taskManager.getTask(task.id);
			expect(retrieved).not.toBeNull();
		});
	});

	describe('updateTaskFields', () => {
		it('should update task priority', async () => {
			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				priority: 'normal',
			});

			const updated = await taskManager.updateTaskFields(task.id, { priority: 'urgent' });

			expect(updated.priority).toBe('urgent');
		});

		it('should update task title', async () => {
			const task = await taskManager.createTask({ title: 'Old title', description: 'desc' });

			const updated = await taskManager.updateTaskFields(task.id, { title: 'New title' });

			expect(updated.title).toBe('New title');
			expect(updated.description).toBe('desc'); // unchanged
		});

		it('should update task description', async () => {
			const task = await taskManager.createTask({ title: 'T', description: 'Old desc' });

			const updated = await taskManager.updateTaskFields(task.id, { description: 'New desc' });

			expect(updated.description).toBe('New desc');
			expect(updated.title).toBe('T'); // unchanged
		});

		it('should update all fields together', async () => {
			const task = await taskManager.createTask({
				title: 'Old',
				description: 'Old desc',
				priority: 'low',
			});

			const updated = await taskManager.updateTaskFields(task.id, {
				title: 'New',
				description: 'New desc',
				priority: 'urgent',
			});

			expect(updated.title).toBe('New');
			expect(updated.description).toBe('New desc');
			expect(updated.priority).toBe('urgent');
		});

		it('should work for tasks with any status (status-agnostic)', async () => {
			const task = await taskManager.createTask({ title: 'T', description: 'd' });
			await taskManager.startTask(task.id);

			const updated = await taskManager.updateTaskFields(task.id, { title: 'Updated' });

			expect(updated.title).toBe('Updated');
			expect(updated.status).toBe('in_progress');
		});

		it('should work on completed tasks', async () => {
			const task = await taskManager.createTask({ title: 'T', description: 'd' });
			await taskManager.completeTask(task.id, 'done');

			const updated = await taskManager.updateTaskFields(task.id, { title: 'Fixed title' });

			expect(updated.title).toBe('Fixed title');
			expect(updated.status).toBe('completed');
		});

		it('should throw error for non-existent task', async () => {
			await expect(
				taskManager.updateTaskFields('non-existent', { priority: 'high' })
			).rejects.toThrow('Task not found: non-existent');
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
			await taskManager.startTask(dep.id);

			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				dependsOn: [dep.id],
			});

			const met = await taskManager.areDependenciesMet(task);

			expect(met).toBe(false);
		});

		it('should return false when dependency was deleted after creation', async () => {
			const dep = await taskManager.createTask({ title: 'Dep', description: '' });
			const task = await taskManager.createTask({
				title: 'Test Task',
				description: '',
				dependsOn: [dep.id],
			});

			// Delete the dependency — simulates a dep being removed after task creation
			await taskManager.deleteTask(dep.id);

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

	describe('dependency validation on create', () => {
		it('should reject creation with non-existent dependency', async () => {
			await expect(
				taskManager.createTask({
					title: 'Task with bad dep',
					description: '',
					dependsOn: ['non-existent-id'],
				})
			).rejects.toThrow('Dependency task not found in room');
		});

		it('should accept creation with valid dependency', async () => {
			const dep = await taskManager.createTask({ title: 'Dep', description: '' });
			const task = await taskManager.createTask({
				title: 'Dependent',
				description: '',
				dependsOn: [dep.id],
			});
			expect(task.dependsOn).toEqual([dep.id]);
		});

		it('should accept creation with multiple valid dependencies', async () => {
			const dep1 = await taskManager.createTask({ title: 'Dep 1', description: '' });
			const dep2 = await taskManager.createTask({ title: 'Dep 2', description: '' });
			const task = await taskManager.createTask({
				title: 'Dependent',
				description: '',
				dependsOn: [dep1.id, dep2.id],
			});
			expect(task.dependsOn).toEqual([dep1.id, dep2.id]);
		});

		it('should accept creation with empty dependsOn', async () => {
			const task = await taskManager.createTask({
				title: 'No deps',
				description: '',
				dependsOn: [],
			});
			expect(task.dependsOn).toEqual([]);
		});
	});

	describe('multiple rooms', () => {
		it('should isolate tasks between rooms', async () => {
			// Create another room
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const taskManager2 = new TaskManager(db, room2.id, { notifyChange: () => {} } as never);

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

			await taskManager.startTask(task.id);
			await taskManager.reviewTask(task.id);
			await taskManager.startTask(task.id);
			await taskManager.completeTask(task.id, 'Done');

			const final = await taskManager.getTask(task.id);
			expect(final?.status).toBe('completed');
		});
	});

	describe('setTaskStatus — revive to review', () => {
		it('should allow needs_attention → review transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.failTask(task.id, 'boom');

			const revived = await taskManager.setTaskStatus(task.id, 'review');
			expect(revived.status).toBe('review');
		});

		it('should clear error field on needs_attention → review transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.failTask(task.id, 'something broke');

			const revived = await taskManager.setTaskStatus(task.id, 'review');
			expect(revived.status).toBe('review');
			// error is mapped null→undefined by the task repository
			expect(revived.error).toBeUndefined();
		});

		it('should reject cancelled → review transition (not a valid reactivation path)', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.cancelTask(task.id);

			await expect(taskManager.setTaskStatus(task.id, 'review')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('should reject completed → review transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.completeTask(task.id, 'done');

			await expect(taskManager.setTaskStatus(task.id, 'review')).rejects.toThrow(
				'Invalid status transition'
			);
		});
	});

	describe('archived status transitions', () => {
		it('should allow completed → archived transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.completeTask(task.id, 'done');

			const archived = await taskManager.setTaskStatus(task.id, 'archived');
			expect(archived.status).toBe('archived');
		});

		it('should allow cancelled → archived transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.cancelTask(task.id);

			const archived = await taskManager.setTaskStatus(task.id, 'archived');
			expect(archived.status).toBe('archived');
		});

		it('should allow cancelled → completed transition (e.g. PR merged after cancellation)', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.cancelTask(task.id);

			const completed = await taskManager.setTaskStatus(task.id, 'completed');
			expect(completed.status).toBe('completed');
		});

		it('should allow needs_attention → archived transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.failTask(task.id, 'error');

			const archived = await taskManager.setTaskStatus(task.id, 'archived');
			expect(archived.status).toBe('archived');
		});

		it('should allow completed → in_progress reactivation', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.completeTask(task.id, 'done');

			const reactivated = await taskManager.setTaskStatus(task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
		});

		it('should clear result and progress when reactivating a completed task', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.completeTask(task.id, 'previous result');

			const completed = await taskManager.getTask(task.id);
			expect(completed!.result).toBe('previous result');
			expect(completed!.progress).toBe(100);

			const reactivated = await taskManager.setTaskStatus(task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
			expect(reactivated.result).toBeUndefined();
			expect(reactivated.progress).toBeUndefined();
		});

		it('should reject archived → any transition (true terminal)', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.completeTask(task.id, 'done');
			await taskManager.setTaskStatus(task.id, 'archived');

			const allStatuses = [
				'draft',
				'pending',
				'in_progress',
				'review',
				'completed',
				'needs_attention',
				'cancelled',
				'archived',
			] as const;
			for (const status of allStatuses) {
				await expect(taskManager.setTaskStatus(task.id, status)).rejects.toThrow(
					'Invalid status transition'
				);
			}
		});

		it('should allow cancelled → pending transition (restart)', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.cancelTask(task.id);

			const restarted = await taskManager.setTaskStatus(task.id, 'pending');
			expect(restarted.status).toBe('pending');
		});

		it('should allow cancelled → in_progress transition (reactivation)', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.cancelTask(task.id);

			const reactivated = await taskManager.setTaskStatus(task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
		});

		it('should allow needs_attention → pending transition (restart)', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.failTask(task.id, 'error');

			const restarted = await taskManager.setTaskStatus(task.id, 'pending');
			expect(restarted.status).toBe('pending');
		});

		it('should reject review → archived transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.reviewTask(task.id, 'https://github.com/org/repo/pull/1');

			await expect(taskManager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('should reject draft → archived transition', async () => {
			const task = await taskManager.createTask({
				title: 'T',
				description: '',
				status: 'draft',
			});
			await expect(taskManager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('should reject pending → archived transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await expect(taskManager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('should reject in_progress → archived transition', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await expect(taskManager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
				'Invalid status transition'
			);
		});
	});

	describe('archiveTask method', () => {
		it('should archive a completed task via archiveTask()', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.completeTask(task.id, 'done');

			const archived = await taskManager.archiveTask(task.id);
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeDefined();
		});

		it('should archive a cancelled task via archiveTask()', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.cancelTask(task.id);

			const archived = await taskManager.archiveTask(task.id);
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeDefined();
		});

		it('should archive a needs_attention task via archiveTask()', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.failTask(task.id, 'error');

			const archived = await taskManager.archiveTask(task.id);
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeDefined();
		});

		it('should reject archiving a pending task via archiveTask()', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await expect(taskManager.archiveTask(task.id)).rejects.toThrow(
				"Cannot archive task in 'pending'"
			);
		});

		it('should reject archiving an in_progress task via archiveTask()', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await expect(taskManager.archiveTask(task.id)).rejects.toThrow(
				"Cannot archive task in 'in_progress'"
			);
		});

		it('should clear active_session when archiving', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'worker' });
			await taskManager.completeTask(task.id, 'done');

			const archived = await taskManager.archiveTask(task.id);
			expect(archived.activeSession).toBeNull();
		});

		it('should throw for non-existent task', async () => {
			await expect(taskManager.archiveTask('non-existent')).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('VALID_STATUS_TRANSITIONS map', () => {
		it('archived is a true terminal state with no transitions', () => {
			expect(VALID_STATUS_TRANSITIONS.archived).toEqual([]);
		});

		it('completed allows reactivation and archival', () => {
			expect(VALID_STATUS_TRANSITIONS.completed).toEqual(['in_progress', 'archived']);
		});

		it('cancelled allows restart, completion, and archival', () => {
			expect(VALID_STATUS_TRANSITIONS.cancelled).toEqual([
				'pending',
				'in_progress',
				'completed',
				'archived',
			]);
		});

		it('needs_attention allows restart, review, and archival', () => {
			expect(VALID_STATUS_TRANSITIONS.needs_attention).toEqual([
				'pending',
				'in_progress',
				'review',
				'archived',
			]);
		});
	});

	describe('activeSession field', () => {
		it('should be null by default on a new task', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			expect(task.activeSession).toBeNull();
		});

		it('should be settable to worker via updateTaskStatus', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			const updated = await taskManager.updateTaskStatus(task.id, 'in_progress', {
				activeSession: 'worker',
			});
			expect(updated.activeSession).toBe('worker');
		});

		it('should be settable to leader via updateTaskStatus', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			const updated = await taskManager.updateTaskStatus(task.id, 'in_progress', {
				activeSession: 'leader',
			});
			expect(updated.activeSession).toBe('leader');
		});

		it('should be clearable back to null', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'worker' });
			const cleared = await taskManager.updateTaskStatus(task.id, 'in_progress', {
				activeSession: null,
			});
			expect(cleared.activeSession).toBeNull();
		});

		it('should be auto-cleared when task is completed', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'worker' });

			const completed = await taskManager.completeTask(task.id, 'done');
			expect(completed.activeSession).toBeNull();
		});

		it('should be auto-cleared when task is failed', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'leader' });

			const failed = await taskManager.failTask(task.id, 'error occurred');
			expect(failed.activeSession).toBeNull();
		});

		it('should be auto-cleared when task is cancelled', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'worker' });

			const cancelled = await taskManager.cancelTask(task.id);
			expect(cancelled.activeSession).toBeNull();
		});

		it('should persist across getTask calls', async () => {
			const task = await taskManager.createTask({ title: 'T', description: '' });
			await taskManager.startTask(task.id);
			await taskManager.updateTaskStatus(task.id, 'in_progress', { activeSession: 'worker' });

			const fetched = await taskManager.getTask(task.id);
			expect(fetched!.activeSession).toBe('worker');
		});
	});
});

describe('extractPrNumber', () => {
	it('should extract PR number from GitHub URL', () => {
		expect(extractPrNumber('https://github.com/org/repo/pull/123')).toBe(123);
	});

	it('should extract PR number from URL with trailing path', () => {
		expect(extractPrNumber('https://github.com/org/repo/pull/42/files')).toBe(42);
	});

	it('should return null for URL without pull segment', () => {
		expect(extractPrNumber('https://github.com/org/repo')).toBeNull();
	});

	it('should handle large PR numbers', () => {
		expect(extractPrNumber('https://github.com/org/repo/pull/9999')).toBe(9999);
	});

	it('should return null for empty string', () => {
		expect(extractPrNumber('')).toBeNull();
	});
});
