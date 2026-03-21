/**
 * SpaceTaskManager Tests
 *
 * Tests task lifecycle, status transitions, and dependency validation.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import {
	SpaceTaskManager,
	VALID_SPACE_TASK_TRANSITIONS,
	isValidSpaceTaskTransition,
} from '../../../src/lib/space/managers/space-task-manager';
import { createSpaceTables } from '../helpers/space-test-db';

describe('SpaceTaskManager', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let manager: SpaceTaskManager;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as any);

		const space = spaceRepo.createSpace({ workspacePath: '/workspace/test', name: 'Test' });
		spaceId = space.id;
		manager = new SpaceTaskManager(db as any, spaceId);
	});

	afterEach(() => {
		db.close();
	});

	describe('isValidSpaceTaskTransition', () => {
		it('allows valid transitions', () => {
			expect(isValidSpaceTaskTransition('pending', 'in_progress')).toBe(true);
			expect(isValidSpaceTaskTransition('in_progress', 'completed')).toBe(true);
			expect(isValidSpaceTaskTransition('in_progress', 'review')).toBe(true);
			expect(isValidSpaceTaskTransition('review', 'completed')).toBe(true);
		});

		it('rejects invalid transitions', () => {
			expect(isValidSpaceTaskTransition('completed', 'pending')).toBe(false);
			expect(isValidSpaceTaskTransition('pending', 'completed')).toBe(false);
		});
	});

	describe('createTask', () => {
		it('creates a task with minimal params', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			expect(task.spaceId).toBe(spaceId);
			expect(task.title).toBe('T');
			expect(task.status).toBe('pending');
		});

		it('creates a task with dependencies', async () => {
			const dep = await manager.createTask({ title: 'Dep', description: '' });
			const task = await manager.createTask({
				title: 'Child',
				description: '',
				dependsOn: [dep.id],
			});
			expect(task.dependsOn).toContain(dep.id);
		});

		it('throws when a dependency does not exist', async () => {
			await expect(
				manager.createTask({ title: 'T', description: '', dependsOn: ['nonexistent'] })
			).rejects.toThrow('Dependency task not found');
		});
	});

	describe('getTask', () => {
		it('returns task belonging to this space', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			expect(await manager.getTask(task.id)).not.toBeNull();
		});

		it('returns null for task in another space', async () => {
			// Create another space and its manager
			const otherSpace = spaceRepo.createSpace({
				workspacePath: '/workspace/other',
				name: 'Other',
			});
			const otherManager = new SpaceTaskManager(db as any, otherSpace.id);
			const otherTask = await otherManager.createTask({ title: 'T', description: '' });

			// Task from other space is not visible
			expect(await manager.getTask(otherTask.id)).toBeNull();
		});
	});

	describe('setTaskStatus', () => {
		it('transitions pending -> in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			const updated = await manager.setTaskStatus(task.id, 'in_progress');
			expect(updated.status).toBe('in_progress');
		});

		it('transitions in_progress -> completed with result', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			const done = await manager.setTaskStatus(task.id, 'completed', { result: 'Done!' });
			expect(done.status).toBe('completed');
			expect(done.progress).toBe(100);
			expect(done.result).toBe('Done!');
		});

		it('throws for invalid transition', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await expect(manager.setTaskStatus(task.id, 'completed')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('clears error and result when restarting from needs_attention', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'needs_attention', { error: 'Oops' });

			const restarted = await manager.setTaskStatus(task.id, 'pending');
			expect(restarted.error).toBeUndefined();
			expect(restarted.result).toBeUndefined();
			expect(restarted.progress).toBeUndefined();
		});

		it('clears error and result when restarting from cancelled -> pending', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'needs_attention', { error: 'Failed' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);

			const restarted = await manager.setTaskStatus(task.id, 'pending');
			expect(restarted.status).toBe('pending');
			expect(restarted.error).toBeUndefined();
			expect(restarted.result).toBeUndefined();
			expect(restarted.progress).toBeUndefined();
		});

		it('clears fields when restarting from cancelled -> in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);

			const restarted = await manager.setTaskStatus(task.id, 'in_progress');
			expect(restarted.status).toBe('in_progress');
			expect(restarted.error).toBeUndefined();
			expect(restarted.progress).toBeUndefined();
		});

		it('throws for unknown task', async () => {
			await expect(manager.setTaskStatus('nonexistent', 'in_progress')).rejects.toThrow(
				'not found'
			);
		});
	});

	describe('startTask / completeTask / failTask', () => {
		it('starts a task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			const started = await manager.startTask(task.id);
			expect(started.status).toBe('in_progress');
		});

		it('completes a task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const done = await manager.completeTask(task.id, 'All done');
			expect(done.status).toBe('completed');
		});

		it('fails a task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const failed = await manager.failTask(task.id, 'Something went wrong');
			expect(failed.status).toBe('needs_attention');
			expect(failed.error).toBe('Something went wrong');
		});
	});

	describe('cancelTask', () => {
		it('cancels a task and cascades to pending dependents', async () => {
			const t1 = await manager.createTask({ title: 'T1', description: '' });
			const t2 = await manager.createTask({
				title: 'T2',
				description: '',
				dependsOn: [t1.id],
			});

			await manager.cancelTask(t1.id);

			expect((await manager.getTask(t1.id))!.status).toBe('cancelled');
			expect((await manager.getTask(t2.id))!.status).toBe('cancelled');
		});
	});

	describe('reviewTask', () => {
		it('moves task to review with PR info', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const reviewed = await manager.reviewTask(task.id, 'https://github.com/org/repo/pull/42');
			expect(reviewed.status).toBe('review');
			expect(reviewed.prUrl).toBe('https://github.com/org/repo/pull/42');
			expect(reviewed.prNumber).toBe(42);
		});
	});

	describe('updateTaskProgress', () => {
		it('updates progress and current step', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			const updated = await manager.updateTaskProgress(task.id, 50, 'halfway');
			expect(updated.progress).toBe(50);
			expect(updated.currentStep).toBe('halfway');
		});

		it('clamps progress to 0-100', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			expect((await manager.updateTaskProgress(task.id, 150)).progress).toBe(100);
			expect((await manager.updateTaskProgress(task.id, -10)).progress).toBe(0);
		});
	});

	describe('archiveTask', () => {
		it('archives a task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			const archived = await manager.archiveTask(task.id);
			expect(archived.archivedAt).toBeDefined();
		});
	});

	describe('deleteTask', () => {
		it('deletes a task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			expect(await manager.deleteTask(task.id)).toBe(true);
			expect(await manager.getTask(task.id)).toBeNull();
		});

		it('returns false for unknown task', async () => {
			expect(await manager.deleteTask('nonexistent')).toBe(false);
		});
	});

	describe('areDependenciesMet', () => {
		it('returns true when no dependencies', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			expect(await manager.areDependenciesMet(task)).toBe(true);
		});

		it('returns false when dependency is not completed', async () => {
			const dep = await manager.createTask({ title: 'Dep', description: '' });
			const task = await manager.createTask({
				title: 'Child',
				description: '',
				dependsOn: [dep.id],
			});
			expect(await manager.areDependenciesMet(task)).toBe(false);
		});

		it('returns true when all dependencies are completed', async () => {
			const dep = await manager.createTask({ title: 'Dep', description: '' });
			await manager.startTask(dep.id);
			await manager.completeTask(dep.id, 'done');

			const task = await manager.createTask({
				title: 'Child',
				description: '',
				dependsOn: [dep.id],
			});
			expect(await manager.areDependenciesMet(task)).toBe(true);
		});
	});

	describe('retryTask', () => {
		it('retries a needs_attention task -> pending', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.failTask(task.id, 'Something went wrong');

			const retried = await manager.retryTask(task.id);
			expect(retried.status).toBe('pending');
			expect(retried.error).toBeUndefined();
			expect(retried.result).toBeUndefined();
			expect(retried.progress).toBeUndefined();
		});

		it('retries a cancelled task -> pending', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.cancelTask(task.id);

			const retried = await manager.retryTask(task.id);
			expect(retried.status).toBe('pending');
			expect(retried.error).toBeUndefined();
		});

		it('updates description when provided', async () => {
			const task = await manager.createTask({ title: 'T', description: 'original' });
			await manager.startTask(task.id);
			await manager.failTask(task.id, 'error');

			const retried = await manager.retryTask(task.id, { description: 'updated description' });
			expect(retried.status).toBe('pending');
			expect(retried.description).toBe('updated description');
		});

		it('throws when task is in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);

			await expect(manager.retryTask(task.id)).rejects.toThrow(
				"Cannot retry task in 'in_progress'"
			);
		});

		it('throws when task is pending', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });

			await expect(manager.retryTask(task.id)).rejects.toThrow("Cannot retry task in 'pending'");
		});

		it('throws when task is completed', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'done');

			await expect(manager.retryTask(task.id)).rejects.toThrow("Cannot retry task in 'completed'");
		});

		it('throws for unknown task', async () => {
			await expect(manager.retryTask('nonexistent')).rejects.toThrow('Task not found');
		});
	});

	describe('reassignTask', () => {
		it('reassigns a pending task to a custom agent', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });

			const reassigned = await manager.reassignTask(task.id, 'custom-agent-123');
			expect(reassigned.customAgentId).toBe('custom-agent-123');
		});

		it('reassigns with assignedAgent type', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });

			const reassigned = await manager.reassignTask(task.id, 'custom-agent-456', 'general');
			expect(reassigned.customAgentId).toBe('custom-agent-456');
			expect(reassigned.assignedAgent).toBe('general');
		});

		it('clears customAgentId when null is provided', async () => {
			const task = await manager.createTask({
				title: 'T',
				description: '',
				customAgentId: 'old-agent',
			});

			const reassigned = await manager.reassignTask(task.id, null);
			expect(reassigned.customAgentId).toBeUndefined();
		});

		it('reassigns a needs_attention task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.failTask(task.id, 'error');

			const reassigned = await manager.reassignTask(task.id, 'new-agent', 'coder');
			expect(reassigned.customAgentId).toBe('new-agent');
			expect(reassigned.status).toBe('needs_attention');
		});

		it('reassigns a cancelled task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.cancelTask(task.id);

			const reassigned = await manager.reassignTask(task.id, 'another-agent');
			expect(reassigned.customAgentId).toBe('another-agent');
			expect(reassigned.status).toBe('cancelled');
		});

		it('throws when task is in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);

			await expect(manager.reassignTask(task.id, 'new-agent')).rejects.toThrow(
				"Cannot reassign task in 'in_progress'"
			);
		});

		it('throws when task is completed', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'done');

			await expect(manager.reassignTask(task.id, 'new-agent')).rejects.toThrow(
				"Cannot reassign task in 'completed'"
			);
		});

		it('throws for unknown task', async () => {
			await expect(manager.reassignTask('nonexistent', 'agent-id')).rejects.toThrow(
				'Task not found'
			);
		});
	});

	describe('VALID_SPACE_TASK_TRANSITIONS', () => {
		it('completed is a terminal state with no transitions', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.completed).toEqual([]);
		});

		it('draft can only go to pending', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.draft).toEqual(['pending']);
		});
	});
});
