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

		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/test',
			slug: 'test',
			name: 'Test',
		});
		spaceId = space.id;
		manager = new SpaceTaskManager(db as any, spaceId);
	});

	afterEach(() => {
		db.close();
	});

	describe('isValidSpaceTaskTransition', () => {
		it('allows valid transitions', () => {
			expect(isValidSpaceTaskTransition('open', 'in_progress')).toBe(true);
			expect(isValidSpaceTaskTransition('in_progress', 'done')).toBe(true);
			expect(isValidSpaceTaskTransition('in_progress', 'blocked')).toBe(true);
			expect(isValidSpaceTaskTransition('done', 'in_progress')).toBe(true);
		});

		it('allows new manual transitions', () => {
			expect(isValidSpaceTaskTransition('open', 'blocked')).toBe(true);
			expect(isValidSpaceTaskTransition('open', 'done')).toBe(true);
			expect(isValidSpaceTaskTransition('in_progress', 'open')).toBe(true);
		});

		it('rejects invalid transitions', () => {
			expect(isValidSpaceTaskTransition('done', 'open')).toBe(false);
		});
	});

	describe('createTask', () => {
		it('creates a task with minimal params', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			expect(task.spaceId).toBe(spaceId);
			expect(task.title).toBe('T');
			expect(task.status).toBe('open');
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
				slug: 'other-space',
				name: 'Other',
			});
			const otherManager = new SpaceTaskManager(db as any, otherSpace.id);
			const otherTask = await otherManager.createTask({ title: 'T', description: '' });

			// Task from other space is not visible
			expect(await manager.getTask(otherTask.id)).toBeNull();
		});
	});

	describe('setTaskStatus', () => {
		it('transitions open -> in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			const updated = await manager.setTaskStatus(task.id, 'in_progress');
			expect(updated.status).toBe('in_progress');
		});

		it('transitions in_progress -> done with result', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			const done = await manager.setTaskStatus(task.id, 'done', { result: 'Done!' });
			expect(done.status).toBe('done');
			expect(done.result).toBe('Done!');
		});

		it('transitions open -> done (already completed)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			const done = await manager.setTaskStatus(task.id, 'done', { result: 'Already done' });
			expect(done.status).toBe('done');
			expect(done.result).toBe('Already done');
		});

		it('transitions open -> blocked (blocker found before start)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			const blocked = await manager.setTaskStatus(task.id, 'blocked', {
				result: 'Missing dependency',
			});
			expect(blocked.status).toBe('blocked');
			expect(blocked.result).toBe('Missing dependency');
		});

		it('transitions in_progress -> open (pause/deprioritize)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			const paused = await manager.setTaskStatus(task.id, 'open');
			expect(paused.status).toBe('open');
			expect(paused.result).toBeNull();
		});

		it('throws for invalid transition', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await expect(manager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('clears result when restarting from blocked', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'blocked');

			const restarted = await manager.setTaskStatus(task.id, 'open');
			expect(restarted.result).toBeNull();
		});

		it('clears result when restarting from cancelled -> open', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'blocked');
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);

			const restarted = await manager.setTaskStatus(task.id, 'open');
			expect(restarted.status).toBe('open');
			expect(restarted.result).toBeNull();
		});

		it('clears fields when restarting from cancelled -> in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);

			const restarted = await manager.setTaskStatus(task.id, 'in_progress');
			expect(restarted.status).toBe('in_progress');
			expect(restarted.error).toBeUndefined();
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
			expect(done.status).toBe('done');
		});

		it('fails a task (marks as blocked)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const failed = await manager.failTask(task.id, 'Something went wrong');
			expect(failed.status).toBe('blocked');
		});

		it('persists result when failing a task with an error message', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const failed = await manager.failTask(task.id, 'Dependency unavailable');
			expect(failed.status).toBe('blocked');
			expect(failed.result).toBe('Dependency unavailable');
		});

		it('persists result when transitioning to blocked via setTaskStatus', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const blocked = await manager.setTaskStatus(task.id, 'blocked', {
				result: 'Waiting for approval',
			});
			expect(blocked.status).toBe('blocked');
			expect(blocked.result).toBe('Waiting for approval');
		});

		it('clears result when unblocking a task back to in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.setTaskStatus(task.id, 'blocked', { result: 'Some reason' });
			const restarted = await manager.setTaskStatus(task.id, 'in_progress');
			expect(restarted.status).toBe('in_progress');
			expect(restarted.result).toBeNull();
		});

		it('failTask without error message does not set result', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const failed = await manager.failTask(task.id);
			expect(failed.status).toBe('blocked');
			expect(failed.result).toBeNull();
		});
	});

	describe('cancelTask', () => {
		it('cancels a task and cascades to open dependents', async () => {
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
		it('records PR metadata without changing status', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			const updated = await manager.reviewTask(task.id, 'https://github.com/org/repo/pull/42');
			// reviewTask no longer changes status — task remains in_progress
			expect(updated.status).toBe('in_progress');
			expect(updated.prUrl).toBe('https://github.com/org/repo/pull/42');
			expect(updated.prNumber).toBe(42);
		});
	});

	describe('archiveTask', () => {
		it('archives a done task and sets both status and archivedAt', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'done');
			const archived = await manager.archiveTask(task.id);
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeDefined();
			expect(typeof archived.archivedAt).toBe('number');
		});

		it('archives a cancelled task and sets both status and archivedAt', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);
			const archived = await manager.archiveTask(task.id);
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeDefined();
			expect(typeof archived.archivedAt).toBe('number');
		});

		it('archives a blocked task and sets both status and archivedAt', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'blocked');
			const archived = await manager.archiveTask(task.id);
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeDefined();
			expect(typeof archived.archivedAt).toBe('number');
		});

		it('throws when archiving a task in open status', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await expect(manager.archiveTask(task.id)).rejects.toThrow("Cannot archive task in 'open'");
		});

		it('throws when archiving a task in in_progress status', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await expect(manager.archiveTask(task.id)).rejects.toThrow(
				"Cannot archive task in 'in_progress'"
			);
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

		it('returns false when dependency is not done', async () => {
			const dep = await manager.createTask({ title: 'Dep', description: '' });
			const task = await manager.createTask({
				title: 'Child',
				description: '',
				dependsOn: [dep.id],
			});
			expect(await manager.areDependenciesMet(task)).toBe(false);
		});

		it('returns true when all dependencies are done', async () => {
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
		it('retries a blocked task -> open', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.failTask(task.id, 'Something went wrong');

			const retried = await manager.retryTask(task.id);
			expect(retried.status).toBe('open');
			expect(retried.result).toBeNull();
		});

		it('retries a cancelled task -> in_progress (reactivation)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.cancelTask(task.id);

			const retried = await manager.retryTask(task.id);
			expect(retried.status).toBe('in_progress');
			expect(retried.error).toBeUndefined();
		});

		it('retries a done task -> in_progress (reactivation)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'done');

			const retried = await manager.retryTask(task.id);
			expect(retried.status).toBe('in_progress');
		});

		it('clears stale result when retrying a done task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'previous result');

			// Verify fields are set before retry
			const completed = await manager.getTask(task.id);
			expect(completed!.result).toBe('previous result');

			const retried = await manager.retryTask(task.id);
			expect(retried.status).toBe('in_progress');
			expect(retried.result).toBeNull();
		});

		it('updates description when provided', async () => {
			const task = await manager.createTask({ title: 'T', description: 'original' });
			await manager.startTask(task.id);
			await manager.failTask(task.id, 'error');

			const retried = await manager.retryTask(task.id, { description: 'updated description' });
			expect(retried.status).toBe('open');
			expect(retried.description).toBe('updated description');
		});

		it('throws when task is in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);

			await expect(manager.retryTask(task.id)).rejects.toThrow(
				"Cannot retry task in 'in_progress'"
			);
		});

		it('throws when task is open', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });

			await expect(manager.retryTask(task.id)).rejects.toThrow("Cannot retry task in 'open'");
		});

		it('throws for unknown task', async () => {
			await expect(manager.retryTask('nonexistent')).rejects.toThrow('Task not found');
		});
	});

	describe('reassignTask', () => {
		it('reassigns a task from open status', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });

			const reassigned = await manager.reassignTask(task.id, 'custom-agent-123');
			// reassignTask is currently a no-op (agent fields removed), returns task unchanged
			expect(reassigned.id).toBe(task.id);
		});

		it('reassigns a blocked task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.failTask(task.id, 'error');

			const reassigned = await manager.reassignTask(task.id, 'new-agent', 'coder');
			expect(reassigned.status).toBe('blocked');
		});

		it('reassigns a cancelled task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.cancelTask(task.id);

			const reassigned = await manager.reassignTask(task.id, 'another-agent');
			expect(reassigned.status).toBe('cancelled');
		});

		it('throws when task is in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);

			await expect(manager.reassignTask(task.id, 'new-agent')).rejects.toThrow(
				"Cannot reassign task in 'in_progress'"
			);
		});

		it('reassigns a done task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'done');

			const reassigned = await manager.reassignTask(task.id, 'new-agent');
			expect(reassigned.status).toBe('done');
		});

		it('throws when task is archived', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'done');
			await manager.archiveTask(task.id);

			await expect(manager.reassignTask(task.id, 'new-agent')).rejects.toThrow(
				"Cannot reassign task in 'archived'"
			);
		});

		it('throws for unknown task', async () => {
			await expect(manager.reassignTask('nonexistent', 'agent-id')).rejects.toThrow(
				'Task not found'
			);
		});
	});

	describe('completion does not prevent reactivation', () => {
		it('done task can be reactivated to in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'done');

			// Verify done state
			const completed = await manager.getTask(task.id);
			expect(completed!.status).toBe('done');
			expect(completed!.result).toBe('done');

			// Reactivate — should succeed without any cleanup blocking it
			const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
			expect(reactivated.result).toBeNull();
		});

		it('cancelled task can be reactivated to in_progress', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.cancelTask(task.id);

			const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
			expect(reactivated.error).toBeUndefined();
		});

		it('done task can be retried via retryTask()', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'previous result');

			const retried = await manager.retryTask(task.id);
			expect(retried.status).toBe('in_progress');
			expect(retried.result).toBeNull();
		});
	});

	describe('VALID_SPACE_TASK_TRANSITIONS', () => {
		it('done allows reactivation and archival', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.done).toEqual(['in_progress', 'archived']);
		});

		it('cancelled allows restart, reactivation, done, and archival', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.cancelled).toEqual([
				'open',
				'in_progress',
				'done',
				'archived',
			]);
		});

		it('blocked allows restart and archival', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.blocked).toEqual(['open', 'in_progress', 'archived']);
		});

		it('archived is a true terminal state with no transitions', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.archived).toEqual([]);
		});

		it('open allows in_progress, blocked, done, and cancelled', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.open).toEqual([
				'in_progress',
				'blocked',
				'done',
				'cancelled',
			]);
		});

		it('in_progress allows open, review, done, blocked, and cancelled', () => {
			expect(VALID_SPACE_TASK_TRANSITIONS.in_progress).toEqual([
				'open',
				'review',
				'done',
				'blocked',
				'cancelled',
			]);
		});
	});

	describe('archived status transitions', () => {
		it('transitions done -> archived', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'done', { result: 'done' });
			const archived = await manager.setTaskStatus(task.id, 'archived');
			expect(archived.status).toBe('archived');
		});

		it('transitions cancelled -> archived', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);
			const archived = await manager.setTaskStatus(task.id, 'archived');
			expect(archived.status).toBe('archived');
		});

		it('transitions cancelled -> done (e.g. PR merged after cancellation)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);
			const done = await manager.setTaskStatus(task.id, 'done');
			expect(done.status).toBe('done');
		});

		it('transitions blocked -> archived', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'blocked');
			const archived = await manager.setTaskStatus(task.id, 'archived');
			expect(archived.status).toBe('archived');
		});

		it('rejects transition from archived to any status', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'done');
			await manager.setTaskStatus(task.id, 'archived');

			await expect(manager.setTaskStatus(task.id, 'in_progress')).rejects.toThrow(
				'Invalid status transition'
			);
			await expect(manager.setTaskStatus(task.id, 'open')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('rejects transition from open -> archived', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await expect(manager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('rejects transition from in_progress -> archived', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await expect(manager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
				'Invalid status transition'
			);
		});

		it('rejects archived -> every status (exhaustive)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'done');
			await manager.setTaskStatus(task.id, 'archived');

			const allStatuses = [
				'open',
				'in_progress',
				'review',
				'done',
				'blocked',
				'cancelled',
				'archived',
			] as const;
			for (const status of allStatuses) {
				await expect(manager.setTaskStatus(task.id, status)).rejects.toThrow(
					'Invalid status transition'
				);
			}
		});

		it('allows cancelled -> open transition (restart)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);
			const restarted = await manager.setTaskStatus(task.id, 'open');
			expect(restarted.status).toBe('open');
		});

		it('allows cancelled -> in_progress transition (reactivation)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.cancelTask(task.id);
			const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
		});

		it('allows done -> in_progress transition (reactivation)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'done', { result: 'done' });
			const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
		});

		it('allows blocked -> open transition (restart)', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.setTaskStatus(task.id, 'in_progress');
			await manager.setTaskStatus(task.id, 'blocked');
			const restarted = await manager.setTaskStatus(task.id, 'open');
			expect(restarted.status).toBe('open');
		});
	});

	describe('retryTask — archived rejection', () => {
		it('throws when retrying an archived task', async () => {
			const task = await manager.createTask({ title: 'T', description: '' });
			await manager.startTask(task.id);
			await manager.completeTask(task.id, 'done');
			await manager.archiveTask(task.id);

			await expect(manager.retryTask(task.id)).rejects.toThrow("Cannot retry task in 'archived'");
		});
	});

	describe('taskNumber (numeric task IDs)', () => {
		it('createTask assigns auto-incrementing taskNumber', async () => {
			const t1 = await manager.createTask({ title: 'A', description: '' });
			const t2 = await manager.createTask({ title: 'B', description: '' });
			expect(t1.taskNumber).toBe(1);
			expect(t2.taskNumber).toBe(2);
		});

		it('getTaskByNumber retrieves the correct task', async () => {
			const t1 = await manager.createTask({ title: 'A', description: '' });
			await manager.createTask({ title: 'B', description: '' });

			const found = await manager.getTaskByNumber(1);
			expect(found).not.toBeNull();
			expect(found!.id).toBe(t1.id);
			expect(found!.taskNumber).toBe(1);
		});

		it('getTaskByNumber returns null for non-existent number', async () => {
			await manager.createTask({ title: 'A', description: '' });
			expect(await manager.getTaskByNumber(999)).toBeNull();
		});

		it('getTaskByNumber is scoped to this space', async () => {
			await manager.createTask({ title: 'A', description: '' });

			const otherSpace = spaceRepo.createSpace({
				workspacePath: '/workspace/other',
				slug: 'other-scoped',
				name: 'Other',
			});
			const otherManager = new SpaceTaskManager(db as any, otherSpace.id);
			expect(await otherManager.getTaskByNumber(1)).toBeNull();
		});

		it('concurrent createTask assigns unique taskNumbers', async () => {
			// Fire 20 async createTask calls concurrently via Promise.all.
			// The db.transaction() in the repository serialises the SELECT MAX + INSERT,
			// so each task should get a unique, monotonically increasing taskNumber.
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, i) =>
					manager.createTask({ title: `Concurrent ${i}`, description: '' })
				)
			);

			const numbers = results.map((t) => t.taskNumber);
			const uniqueNumbers = new Set(numbers);
			expect(uniqueNumbers.size).toBe(20);
			expect(Math.min(...numbers)).toBe(1);
			expect(Math.max(...numbers)).toBe(20);
		});
	});
});
