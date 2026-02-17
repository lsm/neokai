/**
 * Task Repository Tests
 *
 * Tests for Neo task CRUD operations and status management.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskRepository } from '../../../src/storage/repositories/task-repository';
import type {
	NeoTask,
	CreateTaskParams,
	UpdateTaskParams,
	TaskStatus,
	TaskPriority,
	TaskFilter,
} from '@neokai/shared';

describe('TaskRepository', () => {
	let db: Database;
	let repository: TaskRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				session_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER
			);

			CREATE INDEX idx_tasks_room ON tasks(room_id);
			CREATE INDEX idx_tasks_status ON tasks(status);
		`);
		repository = new TaskRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createTask', () => {
		it('should create a task with required fields', () => {
			const params: CreateTaskParams = {
				roomId: 'room-1',
				title: 'Test Task',
				description: 'This is a test task',
			};

			const task = repository.createTask(params);

			expect(task.id).toBeDefined();
			expect(task.roomId).toBe('room-1');
			expect(task.title).toBe('Test Task');
			expect(task.description).toBe('This is a test task');
			expect(task.status).toBe('pending');
			expect(task.priority).toBe('normal');
		});

		it('should create a task with optional fields', () => {
			const params: CreateTaskParams = {
				roomId: 'room-1',
				title: 'Complex Task',
				description: 'A task with dependencies',
				priority: 'high',
				dependsOn: ['task-1', 'task-2'],
			};

			const task = repository.createTask(params);

			expect(task.priority).toBe('high');
			expect(task.dependsOn).toEqual(['task-1', 'task-2']);
		});

		it('should set createdAt timestamp', () => {
			const beforeTime = Date.now();
			const params: CreateTaskParams = {
				roomId: 'room-1',
				title: 'Task',
				description: 'Description',
			};

			const task = repository.createTask(params);

			expect(task.createdAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should initialize sessionId as undefined', () => {
			const params: CreateTaskParams = {
				roomId: 'room-1',
				title: 'Task',
				description: 'Description',
			};

			const task = repository.createTask(params);

			expect(task.sessionId).toBeUndefined();
		});

		it('should support all priority levels', () => {
			const priorities: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

			priorities.forEach((priority, index) => {
				const task = repository.createTask({
					roomId: 'room-1',
					title: `Task ${index}`,
					description: 'Description',
					priority,
				});
				expect(task.priority).toBe(priority);
			});
		});
	});

	describe('getTask', () => {
		it('should return task by ID', () => {
			const created = repository.createTask({
				roomId: 'room-1',
				title: 'Test Task',
				description: 'Description',
			});

			const task = repository.getTask(created.id);

			expect(task).not.toBeNull();
			expect(task?.id).toBe(created.id);
			expect(task?.title).toBe('Test Task');
		});

		it('should return null for non-existent ID', () => {
			const task = repository.getTask('non-existent-id');

			expect(task).toBeNull();
		});
	});

	describe('listTasks', () => {
		it('should return all tasks for a room', () => {
			repository.createTask({ roomId: 'room-1', title: 'Task 1', description: 'Desc 1' });
			repository.createTask({ roomId: 'room-1', title: 'Task 2', description: 'Desc 2' });
			repository.createTask({ roomId: 'room-2', title: 'Task 3', description: 'Desc 3' });

			const tasks = repository.listTasks('room-1');

			expect(tasks.length).toBe(2);
			expect(tasks.map((t) => t.title)).toContain('Task 1');
			expect(tasks.map((t) => t.title)).toContain('Task 2');
		});

		it('should return tasks ordered by created_at DESC', async () => {
			repository.createTask({ roomId: 'room-1', title: 'Oldest', description: 'Desc' });
			await new Promise((r) => setTimeout(r, 5));
			repository.createTask({ roomId: 'room-1', title: 'Middle', description: 'Desc' });
			await new Promise((r) => setTimeout(r, 5));
			repository.createTask({ roomId: 'room-1', title: 'Newest', description: 'Desc' });

			const tasks = repository.listTasks('room-1');

			expect(tasks[0].title).toBe('Newest');
			expect(tasks[1].title).toBe('Middle');
			expect(tasks[2].title).toBe('Oldest');
		});

		it('should filter by status', () => {
			repository.createTask({ roomId: 'room-1', title: 'Pending 1', description: 'Desc' });
			repository.createTask({ roomId: 'room-1', title: 'In Progress', description: 'Desc' });
			const task = repository.createTask({
				roomId: 'room-1',
				title: 'Pending 2',
				description: 'Desc',
			});
			repository.updateTask(task.id, { status: 'in_progress' });

			const filter: TaskFilter = { status: 'pending' };
			const pendingTasks = repository.listTasks('room-1', filter);

			expect(pendingTasks.length).toBe(2);
		});

		it('should filter by priority', () => {
			repository.createTask({
				roomId: 'room-1',
				title: 'High Priority',
				description: 'Desc',
				priority: 'high',
			});
			repository.createTask({
				roomId: 'room-1',
				title: 'Normal Priority',
				description: 'Desc',
				priority: 'normal',
			});

			const filter: TaskFilter = { priority: 'high' };
			const highPriorityTasks = repository.listTasks('room-1', filter);

			expect(highPriorityTasks.length).toBe(1);
			expect(highPriorityTasks[0].priority).toBe('high');
		});

		it('should filter by sessionId', () => {
			const task1 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 1',
				description: 'Desc',
			});
			const task2 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 2',
				description: 'Desc',
			});
			repository.updateTask(task1.id, { sessionId: 'session-1' });
			repository.updateTask(task2.id, { sessionId: 'session-2' });

			const filter: TaskFilter = { sessionId: 'session-1' };
			const tasks = repository.listTasks('room-1', filter);

			expect(tasks.length).toBe(1);
			expect(tasks[0].sessionId).toBe('session-1');
		});

		it('should combine multiple filters', () => {
			const task1 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 1',
				description: 'Desc',
				priority: 'high',
			});
			repository.updateTask(task1.id, { status: 'in_progress' });
			repository.createTask({
				roomId: 'room-1',
				title: 'Task 2',
				description: 'Desc',
				priority: 'high',
			});

			const filter: TaskFilter = { status: 'in_progress', priority: 'high' };
			const tasks = repository.listTasks('room-1', filter);

			expect(tasks.length).toBe(1);
		});

		it('should return empty array for non-existent room', () => {
			const tasks = repository.listTasks('non-existent-room');

			expect(tasks).toEqual([]);
		});
	});

	describe('updateTask', () => {
		it('should update title', () => {
			const task = repository.createTask({
				roomId: 'room-1',
				title: 'Original Title',
				description: 'Desc',
			});

			const updated = repository.updateTask(task.id, { title: 'New Title' });

			expect(updated?.title).toBe('New Title');
		});

		it('should update description', () => {
			const task = repository.createTask({
				roomId: 'room-1',
				title: 'Task',
				description: 'Original desc',
			});

			const updated = repository.updateTask(task.id, { description: 'New description' });

			expect(updated?.description).toBe('New description');
		});

		it('should update sessionId', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, { sessionId: 'session-1' });

			expect(updated?.sessionId).toBe('session-1');
		});

		it('should clear sessionId when set to null', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });
			repository.updateTask(task.id, { sessionId: 'session-1' });

			const updated = repository.updateTask(task.id, { sessionId: null });

			expect(updated?.sessionId).toBeUndefined();
		});

		it('should update status and set started_at when status is in_progress', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });
			const beforeTime = Date.now();

			const updated = repository.updateTask(task.id, { status: 'in_progress' });

			expect(updated?.status).toBe('in_progress');
			expect(updated?.startedAt).toBeDefined();
			expect(updated?.startedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should update status and set completed_at when status is completed', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });
			const beforeTime = Date.now();

			const updated = repository.updateTask(task.id, { status: 'completed' });

			expect(updated?.status).toBe('completed');
			expect(updated?.completedAt).toBeDefined();
			expect(updated?.completedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should update status and set completed_at when status is failed', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });
			const beforeTime = Date.now();

			const updated = repository.updateTask(task.id, { status: 'failed' });

			expect(updated?.status).toBe('failed');
			expect(updated?.completedAt).toBeDefined();
			expect(updated?.completedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should update priority', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, { priority: 'urgent' });

			expect(updated?.priority).toBe('urgent');
		});

		it('should update progress', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, { progress: 50 });

			expect(updated?.progress).toBe(50);
		});

		it('should update currentStep', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, { currentStep: 'Running tests' });

			expect(updated?.currentStep).toBe('Running tests');
		});

		it('should update result', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, { result: 'Task completed successfully' });

			expect(updated?.result).toBe('Task completed successfully');
		});

		it('should update error', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, { error: 'Something went wrong' });

			expect(updated?.error).toBe('Something went wrong');
		});

		it('should update dependsOn', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, { dependsOn: ['task-a', 'task-b'] });

			expect(updated?.dependsOn).toEqual(['task-a', 'task-b']);
		});

		it('should return null for non-existent task', () => {
			const updated = repository.updateTask('non-existent', { title: 'New Title' });

			expect(updated).toBeNull();
		});

		it('should update multiple fields at once', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const updated = repository.updateTask(task.id, {
				title: 'Updated Title',
				status: 'in_progress',
				priority: 'high',
				progress: 25,
				currentStep: 'Step 1',
			});

			expect(updated?.title).toBe('Updated Title');
			expect(updated?.status).toBe('in_progress');
			expect(updated?.priority).toBe('high');
			expect(updated?.progress).toBe(25);
			expect(updated?.currentStep).toBe('Step 1');
		});
	});

	describe('deleteTask', () => {
		it('should delete a task by ID', () => {
			const task = repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			repository.deleteTask(task.id);

			expect(repository.getTask(task.id)).toBeNull();
		});

		it('should only delete the specified task', () => {
			const task1 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 1',
				description: 'Desc',
			});
			const task2 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 2',
				description: 'Desc',
			});

			repository.deleteTask(task1.id);

			expect(repository.getTask(task1.id)).toBeNull();
			expect(repository.getTask(task2.id)).not.toBeNull();
		});

		it('should not throw when deleting non-existent task', () => {
			expect(() => repository.deleteTask('non-existent')).not.toThrow();
		});
	});

	describe('deleteTasksForRoom', () => {
		it('should delete all tasks for a room', () => {
			repository.createTask({ roomId: 'room-1', title: 'Task 1', description: 'Desc' });
			repository.createTask({ roomId: 'room-1', title: 'Task 2', description: 'Desc' });
			repository.createTask({ roomId: 'room-2', title: 'Task 3', description: 'Desc' });

			repository.deleteTasksForRoom('room-1');

			expect(repository.listTasks('room-1')).toEqual([]);
			expect(repository.listTasks('room-2').length).toBe(1);
		});

		it('should not throw when deleting for non-existent room', () => {
			expect(() => repository.deleteTasksForRoom('non-existent')).not.toThrow();
		});
	});

	describe('countTasksByStatus', () => {
		it('should count tasks by status', () => {
			repository.createTask({ roomId: 'room-1', title: 'Task 1', description: 'Desc' });
			repository.createTask({ roomId: 'room-1', title: 'Task 2', description: 'Desc' });
			const task3 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 3',
				description: 'Desc',
			});
			repository.updateTask(task3.id, { status: 'in_progress' });

			const pendingCount = repository.countTasksByStatus('room-1', 'pending');
			const inProgressCount = repository.countTasksByStatus('room-1', 'in_progress');

			expect(pendingCount).toBe(2);
			expect(inProgressCount).toBe(1);
		});

		it('should return 0 when no tasks match status', () => {
			repository.createTask({ roomId: 'room-1', title: 'Task', description: 'Desc' });

			const completedCount = repository.countTasksByStatus('room-1', 'completed');

			expect(completedCount).toBe(0);
		});

		it('should return 0 for non-existent room', () => {
			const count = repository.countTasksByStatus('non-existent', 'pending');

			expect(count).toBe(0);
		});
	});

	describe('countActiveTasks', () => {
		it('should count active (non-completed, non-failed) tasks', () => {
			const task1 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 1',
				description: 'Desc',
			});
			const task2 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 2',
				description: 'Desc',
			});
			const task3 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 3',
				description: 'Desc',
			});
			const task4 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 4',
				description: 'Desc',
			});

			repository.updateTask(task1.id, { status: 'in_progress' });
			repository.updateTask(task2.id, { status: 'completed' });
			repository.updateTask(task3.id, { status: 'failed' });
			// task4 stays pending

			const activeCount = repository.countActiveTasks('room-1');

			expect(activeCount).toBe(2); // pending + in_progress
		});

		it('should return 0 when all tasks are completed or failed', () => {
			const task1 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 1',
				description: 'Desc',
			});
			const task2 = repository.createTask({
				roomId: 'room-1',
				title: 'Task 2',
				description: 'Desc',
			});

			repository.updateTask(task1.id, { status: 'completed' });
			repository.updateTask(task2.id, { status: 'failed' });

			const activeCount = repository.countActiveTasks('room-1');

			expect(activeCount).toBe(0);
		});

		it('should return 0 for non-existent room', () => {
			const count = repository.countActiveTasks('non-existent');

			expect(count).toBe(0);
		});
	});

	describe('task lifecycle', () => {
		it('should support full task lifecycle', async () => {
			// Create task
			const task = repository.createTask({
				roomId: 'room-1',
				title: 'Feature Implementation',
				description: 'Implement new feature',
				priority: 'high',
				dependsOn: ['task-prereq'],
			});
			expect(task.status).toBe('pending');

			// Start task
			await new Promise((r) => setTimeout(r, 5));
			repository.updateTask(task.id, {
				status: 'in_progress',
				sessionId: 'session-1',
				progress: 0,
			});
			let current = repository.getTask(task.id);
			expect(current?.status).toBe('in_progress');
			expect(current?.startedAt).toBeDefined();

			// Update progress
			repository.updateTask(task.id, {
				progress: 50,
				currentStep: 'Writing tests',
			});
			current = repository.getTask(task.id);
			expect(current?.progress).toBe(50);
			expect(current?.currentStep).toBe('Writing tests');

			// Complete task
			repository.updateTask(task.id, {
				status: 'completed',
				progress: 100,
				result: 'Feature implemented successfully',
			});
			current = repository.getTask(task.id);
			expect(current?.status).toBe('completed');
			expect(current?.completedAt).toBeDefined();
			expect(current?.result).toBe('Feature implemented successfully');
		});

		it('should support task failure with error', async () => {
			const task = repository.createTask({
				roomId: 'room-1',
				title: 'Risky Task',
				description: 'Task that might fail',
			});

			repository.updateTask(task.id, { status: 'in_progress' });

			// Fail task
			repository.updateTask(task.id, {
				status: 'failed',
				error: 'Connection timeout',
			});

			const failed = repository.getTask(task.id);
			expect(failed?.status).toBe('failed');
			expect(failed?.completedAt).toBeDefined();
			expect(failed?.error).toBe('Connection timeout');
		});

		it('should support blocked task status', () => {
			const task = repository.createTask({
				roomId: 'room-1',
				title: 'Blocked Task',
				description: 'Waiting on dependency',
			});

			repository.updateTask(task.id, { status: 'blocked' });

			const blocked = repository.getTask(task.id);
			expect(blocked?.status).toBe('blocked');
		});
	});
});
