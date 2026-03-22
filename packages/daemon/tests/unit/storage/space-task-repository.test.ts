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
	let workflowStepId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as any);
		repo = new SpaceTaskRepository(db as any);

		const space = spaceRepo.createSpace({ workspacePath: '/workspace/test', name: 'Test' });
		spaceId = space.id;

		// Set up workflow records for FK-constrained fields
		const now = Date.now();
		workflowId = 'wf-1';
		workflowRunId = 'run-1';
		workflowStepId = 'step-1';

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
				`INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(workflowStepId, workflowId, 'Step 1', 0, now, now);
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
			expect(task.workflowStepId).toBeUndefined();
			expect(task.taskAgentSessionId).toBeUndefined();
		});

		it('creates a task with workflow routing fields', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Step task',
				description: '',
				customAgentId: 'agent-1',
				workflowRunId,
				workflowStepId,
			});

			expect(task.customAgentId).toBe('agent-1');
			expect(task.workflowRunId).toBe(workflowRunId);
			expect(task.workflowStepId).toBe(workflowStepId);
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

		it('updates customAgentId, workflowRunId, workflowStepId', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, {
				customAgentId: 'custom-agent',
				workflowRunId,
				workflowStepId,
			});
			expect(updated!.customAgentId).toBe('custom-agent');
			expect(updated!.workflowRunId).toBe(workflowRunId);
			expect(updated!.workflowStepId).toBe(workflowStepId);
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
});
