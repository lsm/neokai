/**
 * SpaceTaskRepository Tests
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('SpaceTaskRepository', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let repo: SpaceTaskRepository;
	let spaceId: string;
	let workflowId: string;
	let workflowRunId: string;
	let workflowNodeId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as any);
		repo = new SpaceTaskRepository(db as any);

		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/test',
			slug: 'test',
			name: 'Test',
		});
		spaceId = space.id;

		// Set up workflow records for FK-constrained fields
		const now = Date.now();
		workflowId = 'wf-1';
		workflowRunId = 'run-1';
		workflowNodeId = 'step-1';

		(db as any)
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
			)
			.run(workflowId, spaceId, 'Workflow', now, now);

		(db as any)
			.prepare(
				`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(workflowRunId, spaceId, workflowId, 'Run 1', now, now);

		(db as any)
			.prepare(
				`INSERT INTO space_workflow_nodes (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(workflowNodeId, workflowId, 'Step 1', 0, now, now);
	});

	afterEach(() => {
		db.close();
	});

	describe('createTask', () => {
		it('creates a task with required fields', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Fix bug',
				description: 'Fix the login bug',
			});

			expect(task.id).toBeDefined();
			expect(task.spaceId).toBe(spaceId);
			expect(task.title).toBe('Fix bug');
			expect(task.description).toBe('Fix the login bug');
			expect(task.status).toBe('pending');
			expect(task.priority).toBe('normal');
			expect(task.dependsOn).toEqual([]);
			expect(task.customAgentId).toBeUndefined();
			expect(task.workflowRunId).toBeUndefined();
			expect(task.workflowNodeId).toBeUndefined();
			expect(task.taskAgentSessionId).toBeUndefined();
		});

		it('creates a task with workflow routing fields', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Step task',
				description: '',
				customAgentId: 'agent-1',
				workflowRunId,
				workflowNodeId,
			});

			expect(task.customAgentId).toBe('agent-1');
			expect(task.workflowRunId).toBe(workflowRunId);
			expect(task.workflowNodeId).toBe(workflowNodeId);
		});

		it('creates a task with draft status', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Draft task',
				description: '',
				status: 'draft',
			});
			expect(task.status).toBe('draft');
		});

		it('persists taskAgentSessionId when provided', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Agent task',
				description: '',
				taskAgentSessionId: 'session-abc',
			});
			expect(task.taskAgentSessionId).toBe('session-abc');
		});

		it('leaves taskAgentSessionId undefined when not provided', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(task.taskAgentSessionId).toBeUndefined();
		});
	});

	describe('getTask', () => {
		it('returns task by ID', () => {
			const created = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(repo.getTask(created.id)).not.toBeNull();
		});

		it('returns null for unknown ID', () => {
			expect(repo.getTask('nonexistent')).toBeNull();
		});
	});

	describe('listBySpace', () => {
		it('lists non-archived tasks for a space', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			const b = repo.createTask({ spaceId, title: 'B', description: '' });
			repo.archiveTask(b.id);

			const tasks = repo.listBySpace(spaceId);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('A');
		});

		it('includes archived tasks when requested', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			const b = repo.createTask({ spaceId, title: 'B', description: '' });
			repo.archiveTask(b.id);

			expect(repo.listBySpace(spaceId, true)).toHaveLength(2);
		});
	});

	describe('listByWorkflowRun', () => {
		it('lists tasks by workflow run ID', () => {
			repo.createTask({ spaceId, title: 'A', description: '', workflowRunId });
			repo.createTask({ spaceId, title: 'C', description: '' });

			const tasks = repo.listByWorkflowRun(workflowRunId);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('A');
		});
	});

	describe('listByStatus', () => {
		it('lists tasks by status', () => {
			repo.createTask({ spaceId, title: 'Pending', description: '', status: 'pending' });
			repo.createTask({ spaceId, title: 'Draft', description: '', status: 'draft' });

			const pending = repo.listByStatus(spaceId, 'pending');
			expect(pending).toHaveLength(1);
			expect(pending[0].title).toBe('Pending');
		});
	});

	describe('updateTask', () => {
		it('updates status and sets started_at for in_progress', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { status: 'in_progress' });
			expect(updated!.status).toBe('in_progress');
			expect(updated!.startedAt).toBeDefined();
		});

		it('sets completed_at for completed status', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { status: 'in_progress' });
			const updated = repo.updateTask(task.id, { status: 'completed' });
			expect(updated!.completedAt).toBeDefined();
		});

		it('auto-clears active_session on terminal status', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { status: 'in_progress', activeSession: 'worker' });
			const updated = repo.updateTask(task.id, { status: 'completed' });
			expect(updated!.activeSession).toBeNull();
		});

		it('updates customAgentId, workflowRunId, workflowNodeId', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, {
				customAgentId: 'custom-agent',
				workflowRunId,
				workflowNodeId,
			});
			expect(updated!.customAgentId).toBe('custom-agent');
			expect(updated!.workflowRunId).toBe(workflowRunId);
			expect(updated!.workflowNodeId).toBe(workflowNodeId);
		});

		it('clears nullable fields', () => {
			const task = repo.createTask({
				spaceId,
				title: 'T',
				description: '',
				customAgentId: 'ca',
			});
			const updated = repo.updateTask(task.id, { customAgentId: null });
			expect(updated!.customAgentId).toBeUndefined();
		});

		it('sets taskAgentSessionId', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { taskAgentSessionId: 'session-xyz' });
			expect(updated!.taskAgentSessionId).toBe('session-xyz');
		});

		it('clears taskAgentSessionId', () => {
			const task = repo.createTask({
				spaceId,
				title: 'T',
				description: '',
				taskAgentSessionId: 'session-xyz',
			});
			const updated = repo.updateTask(task.id, { taskAgentSessionId: null });
			expect(updated!.taskAgentSessionId).toBeUndefined();
		});
	});

	describe('getTaskBySessionId', () => {
		it('returns the task matching the session ID', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Agent task',
				description: '',
				taskAgentSessionId: 'session-lookup',
			});
			const found = repo.getTaskBySessionId('session-lookup');
			expect(found).not.toBeNull();
			expect(found!.id).toBe(task.id);
			expect(found!.taskAgentSessionId).toBe('session-lookup');
		});

		it('returns null when no task matches the session ID', () => {
			expect(repo.getTaskBySessionId('nonexistent-session')).toBeNull();
		});

		it('returns the correct task when multiple tasks exist', () => {
			repo.createTask({ spaceId, title: 'Other', description: '' });
			const task = repo.createTask({
				spaceId,
				title: 'Agent task',
				description: '',
				taskAgentSessionId: 'session-specific',
			});
			const found = repo.getTaskBySessionId('session-specific');
			expect(found!.id).toBe(task.id);
		});
	});

	describe('archiveTask', () => {
		it('sets status to archived and stamps archivedAt', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const archived = repo.archiveTask(task.id);
			expect(archived!.status).toBe('archived');
			expect(archived!.archivedAt).toBeDefined();
			expect(archived!.archivedAt).toBeGreaterThan(0);
		});

		it('archived tasks are excluded from listBySpace by default', () => {
			repo.createTask({ spaceId, title: 'Active', description: '' });
			const toArchive = repo.createTask({ spaceId, title: 'Archived', description: '' });
			repo.archiveTask(toArchive.id);

			const tasks = repo.listBySpace(spaceId);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('Active');
		});

		it('archived tasks are excluded from listByStatus', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '', status: 'pending' });
			repo.archiveTask(task.id);

			const pending = repo.listByStatus(spaceId, 'pending');
			expect(pending).toHaveLength(0);
		});

		it('archived tasks are excluded from listByWorkflowRun', () => {
			const task = repo.createTask({
				spaceId,
				title: 'WF Task',
				description: '',
				workflowRunId,
			});
			repo.archiveTask(task.id);

			const tasks = repo.listByWorkflowRun(workflowRunId);
			expect(tasks).toHaveLength(0);
		});
	});

	describe('updateTask archived_at stamping', () => {
		it('stamps archived_at when status is set to archived via updateTask', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { status: 'archived' });
			expect(updated!.status).toBe('archived');
			expect(updated!.archivedAt).toBeDefined();
			expect(updated!.archivedAt).toBeGreaterThan(0);
		});

		it('auto-clears active_session when status is set to archived', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { status: 'in_progress', activeSession: 'worker' });
			const updated = repo.updateTask(task.id, { status: 'archived' });
			expect(updated!.activeSession).toBeNull();
		});
	});

	describe('deleteTask', () => {
		it('deletes a task', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(repo.deleteTask(task.id)).toBe(true);
			expect(repo.getTask(task.id)).toBeNull();
		});

		it('returns false for unknown ID', () => {
			expect(repo.deleteTask('nonexistent')).toBe(false);
		});
	});

	describe('promoteDraftTasksByCreator', () => {
		it('promotes draft tasks to pending', () => {
			repo.createTask({
				spaceId,
				title: 'D',
				description: '',
				status: 'draft',
				createdByTaskId: 'planner-1',
			});
			repo.createTask({
				spaceId,
				title: 'P',
				description: '',
				status: 'pending',
				createdByTaskId: 'planner-1',
			});

			const count = repo.promoteDraftTasksByCreator('planner-1');
			expect(count).toBe(1);

			const tasks = repo.listBySpace(spaceId);
			expect(tasks.every((t) => t.status !== 'draft')).toBe(true);
		});
	});

	describe('goalId', () => {
		it('creates a task with goalId', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Goal task',
				description: '',
				goalId: 'goal-123',
			});
			expect(task.goalId).toBe('goal-123');
		});

		it('leaves goalId undefined when not provided', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(task.goalId).toBeUndefined();
		});

		it('updates goalId on existing task', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { goalId: 'goal-456' });
			expect(updated!.goalId).toBe('goal-456');
		});

		it('clears goalId with null', () => {
			const task = repo.createTask({
				spaceId,
				title: 'T',
				description: '',
				goalId: 'goal-789',
			});
			const updated = repo.updateTask(task.id, { goalId: null });
			expect(updated!.goalId).toBeUndefined();
		});
	});

	describe('completionSummary', () => {
		it('is undefined when not set', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(task.completionSummary).toBeUndefined();
		});

		it('sets completionSummary via updateTask', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, {
				status: 'completed',
				completionSummary: 'Implemented the feature and added tests.',
			});
			expect(updated!.completionSummary).toBe('Implemented the feature and added tests.');
			expect(updated!.status).toBe('completed');
			expect(updated!.completedAt).toBeDefined();
		});

		it('clears completionSummary with null', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { completionSummary: 'Done.' });
			const cleared = repo.updateTask(task.id, { completionSummary: null });
			expect(cleared!.completionSummary).toBeUndefined();
		});

		it('persists completionSummary across reads', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { completionSummary: 'All done!' });
			const fetched = repo.getTask(task.id);
			expect(fetched!.completionSummary).toBe('All done!');
		});
	});

	describe('findByGoalId', () => {
		it('returns tasks for a given goal', () => {
			repo.createTask({ spaceId, title: 'A', description: '', goalId: 'goal-1' });
			repo.createTask({ spaceId, title: 'B', description: '', goalId: 'goal-1' });
			repo.createTask({ spaceId, title: 'C', description: '', goalId: 'goal-2' });
			repo.createTask({ spaceId, title: 'D', description: '' });

			const tasks = repo.findByGoalId('goal-1');
			expect(tasks).toHaveLength(2);
			expect(tasks.map((t) => t.title)).toEqual(['A', 'B']);
		});

		it('excludes archived tasks', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Archived',
				description: '',
				goalId: 'goal-1',
			});
			repo.createTask({ spaceId, title: 'Active', description: '', goalId: 'goal-1' });
			repo.archiveTask(task.id);

			const tasks = repo.findByGoalId('goal-1');
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('Active');
		});

		it('returns empty array when no tasks match', () => {
			expect(repo.findByGoalId('nonexistent')).toEqual([]);
		});

		it('orders results by created_at ascending', () => {
			repo.createTask({ spaceId, title: 'First', description: '', goalId: 'goal-1' });
			repo.createTask({ spaceId, title: 'Second', description: '', goalId: 'goal-1' });
			repo.createTask({ spaceId, title: 'Third', description: '', goalId: 'goal-1' });

			const tasks = repo.findByGoalId('goal-1');
			expect(tasks.map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
		});
	});

	describe('taskNumber (numeric task IDs)', () => {
		it('auto-assigns taskNumber starting at 1', () => {
			const task = repo.createTask({ spaceId, title: 'First', description: '' });
			expect(task.taskNumber).toBe(1);
		});

		it('auto-increments taskNumber within a space', () => {
			const t1 = repo.createTask({ spaceId, title: 'A', description: '' });
			const t2 = repo.createTask({ spaceId, title: 'B', description: '' });
			const t3 = repo.createTask({ spaceId, title: 'C', description: '' });
			expect(t1.taskNumber).toBe(1);
			expect(t2.taskNumber).toBe(2);
			expect(t3.taskNumber).toBe(3);
		});

		it('scopes taskNumber per space (two spaces get independent sequences)', () => {
			const space2 = spaceRepo.createSpace({
				workspacePath: '/workspace/test2',
				slug: 'space-2',
				name: 'Space 2',
			});

			const s1t1 = repo.createTask({ spaceId, title: 'S1-A', description: '' });
			const s1t2 = repo.createTask({ spaceId, title: 'S1-B', description: '' });
			const s2t1 = repo.createTask({ spaceId: space2.id, title: 'S2-A', description: '' });
			const s2t2 = repo.createTask({ spaceId: space2.id, title: 'S2-B', description: '' });

			expect(s1t1.taskNumber).toBe(1);
			expect(s1t2.taskNumber).toBe(2);
			expect(s2t1.taskNumber).toBe(1);
			expect(s2t2.taskNumber).toBe(2);
		});

		it('leaves gaps when non-highest task is deleted', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			const t2 = repo.createTask({ spaceId, title: 'B', description: '' });
			repo.createTask({ spaceId, title: 'C', description: '' });
			repo.deleteTask(t2.id);

			// After deleting #2, next task gets MAX(1,3)+1 = 4, leaving a gap at #2
			const t4 = repo.createTask({ spaceId, title: 'D', description: '' });
			expect(t4.taskNumber).toBe(4);
		});

		it('is monotonically increasing (MAX+1 strategy)', () => {
			const t1 = repo.createTask({ spaceId, title: 'A', description: '' });
			const t2 = repo.createTask({ spaceId, title: 'B', description: '' });
			expect(t1.taskNumber).toBeLessThan(t2.taskNumber);
		});

		it('enforces UNIQUE(space_id, task_number) constraint', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			// Manually inserting a duplicate task_number should throw
			expect(() => {
				(db as any)
					.prepare(
						`INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, depends_on, created_at, updated_at)
						VALUES ('dup-id', ?, 1, 'Dup', '', 'pending', 'normal', '[]', ?, ?)`
					)
					.run(spaceId, Date.now(), Date.now());
			}).toThrow();
		});

		it('taskNumber is returned by getTask', () => {
			const created = repo.createTask({ spaceId, title: 'T', description: '' });
			const fetched = repo.getTask(created.id);
			expect(fetched!.taskNumber).toBe(1);
		});

		it('taskNumber is returned in list queries', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			repo.createTask({ spaceId, title: 'B', description: '' });

			const tasks = repo.listBySpace(spaceId);
			const numbers = tasks.map((t) => t.taskNumber).sort();
			expect(numbers).toEqual([1, 2]);
		});
	});

	describe('getTaskByNumber', () => {
		it('returns the correct task by (spaceId, taskNumber)', () => {
			const t1 = repo.createTask({ spaceId, title: 'A', description: '' });
			repo.createTask({ spaceId, title: 'B', description: '' });

			const found = repo.getTaskByNumber(spaceId, 1);
			expect(found).not.toBeNull();
			expect(found!.id).toBe(t1.id);
			expect(found!.taskNumber).toBe(1);
		});

		it('returns null for a non-existent taskNumber', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			expect(repo.getTaskByNumber(spaceId, 999)).toBeNull();
		});

		it('returns null when taskNumber exists in a different space', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });

			const space2 = spaceRepo.createSpace({
				workspacePath: '/workspace/test3',
				slug: 'space-3',
				name: 'Space 3',
			});
			expect(repo.getTaskByNumber(space2.id, 1)).toBeNull();
		});
	});

	describe('bulk task creation', () => {
		it('assigns unique monotonically increasing taskNumbers for many tasks', () => {
			// Repo-level createTask is synchronous (bun:sqlite), so this tests
			// sequential bulk creation. Concurrent (Promise.all) tests live in
			// space-task-manager.test.ts where createTask is async.
			const tasks = Array.from({ length: 20 }, (_, i) =>
				repo.createTask({ spaceId, title: `Task ${i}`, description: '' })
			);

			const numbers = tasks.map((t) => t.taskNumber);
			const uniqueNumbers = new Set(numbers);
			expect(uniqueNumbers.size).toBe(20);
			expect(Math.min(...numbers)).toBe(1);
			expect(Math.max(...numbers)).toBe(20);
		});
	});
});
