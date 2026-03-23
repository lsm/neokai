/**
 * SpaceWorkflowRunRepository Tests
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('SpaceWorkflowRunRepository', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let repo: SpaceWorkflowRunRepository;
	let spaceId: string;
	const WORKFLOW_ID = 'workflow-1';

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as any);
		repo = new SpaceWorkflowRunRepository(db as any);

		const space = spaceRepo.createSpace({ workspacePath: '/workspace/test', name: 'Test' });
		spaceId = space.id;

		// Insert a dummy workflow row to satisfy the FK
		const now = Date.now();
		(db as any)
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
			)
			.run(WORKFLOW_ID, spaceId, 'My Workflow', now, now);
	});

	afterEach(() => {
		db.close();
	});

	describe('createRun', () => {
		it('creates a run with required fields', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Run #1' });

			expect(run.id).toBeDefined();
			expect(run.spaceId).toBe(spaceId);
			expect(run.workflowId).toBe(WORKFLOW_ID);
			expect(run.title).toBe('Run #1');
			expect(run.status).toBe('pending');
			expect(run.currentStepId).toBeUndefined();
			expect(run.config).toBeUndefined();
			expect(run.completedAt).toBeUndefined();
		});

		it('maps NULL currentStepId to undefined (round-trip contract)', () => {
			// Explicit omission: NULL stored in DB must come back as undefined, not ''
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'No step' });
			expect(run.currentStepId).toBeUndefined();
			// Re-fetch from DB to confirm persistence
			expect(repo.getRun(run.id)!.currentStepId).toBeUndefined();
		});

		it('creates a run with description', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'Run #2',
				description: 'Deploy v2.0',
			});
			expect(run.description).toBe('Deploy v2.0');
		});
	});

	describe('getRun', () => {
		it('returns run by ID', () => {
			const created = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			expect(repo.getRun(created.id)).not.toBeNull();
		});

		it('returns null for unknown ID', () => {
			expect(repo.getRun('nonexistent')).toBeNull();
		});
	});

	describe('listBySpace', () => {
		it('returns runs for a space in descending order', () => {
			repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R1' });
			repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R2' });

			const runs = repo.listBySpace(spaceId);
			expect(runs).toHaveLength(2);
		});

		it('returns empty for unknown space', () => {
			expect(repo.listBySpace('unknown')).toHaveLength(0);
		});
	});

	describe('getActiveRuns', () => {
		it('returns only in_progress runs (excludes pending and completed)', () => {
			// 'pending' is a transient state that should NOT appear in active runs
			repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Pending' });

			// 'in_progress' — should appear
			const r2 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Active' });
			repo.updateStatus(r2.id, 'in_progress');

			// 'completed' — should not appear
			const r3 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Completed' });
			repo.updateStatus(r3.id, 'completed');

			const active = repo.getActiveRuns(spaceId);
			expect(active).toHaveLength(1);
			expect(active[0].title).toBe('Active');
		});
	});

	describe('getRehydratableRuns', () => {
		it('returns in_progress and needs_attention runs; excludes pending, completed, cancelled', () => {
			// 'pending' — excluded (transient creation state)
			repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Pending' });

			// 'in_progress' — included
			const r2 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'InProgress' });
			repo.updateStatus(r2.id, 'in_progress');

			// 'needs_attention' (human gate blocked) — included so gate can be resolved after restart
			const r3 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'NeedsAttention' });
			repo.updateStatus(r3.id, 'needs_attention');

			// 'completed' — excluded
			const r4 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Completed' });
			repo.updateStatus(r4.id, 'completed');

			// 'cancelled' — excluded
			const r5 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Cancelled' });
			repo.updateStatus(r5.id, 'cancelled');

			const rehydratable = repo.getRehydratableRuns(spaceId);
			expect(rehydratable).toHaveLength(2);
			const titles = rehydratable.map((r) => r.title).sort();
			expect(titles).toEqual(['InProgress', 'NeedsAttention']);
		});
	});

	describe('updateRun', () => {
		it('updates title and description', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			const updated = repo.updateRun(run.id, { title: 'Updated', description: 'New desc' });
			expect(updated!.title).toBe('Updated');
			expect(updated!.description).toBe('New desc');
		});

		it('sets completedAt when status is completed', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			const updated = repo.updateRun(run.id, { status: 'completed' });
			expect(updated!.completedAt).toBeDefined();
		});

		it('sets completedAt when status is cancelled', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			const updated = repo.updateRun(run.id, { status: 'cancelled' });
			expect(updated!.completedAt).toBeDefined();
		});
	});

	describe('updateCurrentStep', () => {
		it('updates the current step ID', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			const updated = repo.updateCurrentStep(run.id, 'step-abc');
			expect(updated!.currentStepId).toBe('step-abc');
		});
	});

	describe('updateStatus', () => {
		it('updates only the status', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			const updated = repo.updateStatus(run.id, 'in_progress');
			expect(updated!.status).toBe('in_progress');
		});
	});

	describe('iteration tracking', () => {
		it('defaults iterationCount to 0 and maxIterations to 5', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			expect(run.iterationCount).toBe(0);
			expect(run.maxIterations).toBe(5);
		});

		it('creates a run with custom maxIterations', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'Custom cap',
				maxIterations: 3,
			});
			expect(run.maxIterations).toBe(3);
			expect(run.iterationCount).toBe(0);
		});

		it('updates iterationCount via updateRun', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			const updated = repo.updateRun(run.id, { iterationCount: 2 });
			expect(updated!.iterationCount).toBe(2);
			// Re-fetch to confirm persistence
			expect(repo.getRun(run.id)!.iterationCount).toBe(2);
		});

		it('updates maxIterations via updateRun', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			const updated = repo.updateRun(run.id, { maxIterations: 10 });
			expect(updated!.maxIterations).toBe(10);
		});

		it('round-trips iteration fields through create → get', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'Round-trip',
				maxIterations: 7,
			});
			const fetched = repo.getRun(run.id)!;
			expect(fetched.iterationCount).toBe(0);
			expect(fetched.maxIterations).toBe(7);
		});
	});

	describe('deleteRun', () => {
		it('deletes a run', () => {
			const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
			expect(repo.deleteRun(run.id)).toBe(true);
			expect(repo.getRun(run.id)).toBeNull();
		});

		it('returns false for unknown ID', () => {
			expect(repo.deleteRun('nonexistent')).toBe(false);
		});
	});

	describe('goalId', () => {
		it('creates a run with goalId and persists it', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'Goal Run',
				goalId: 'goal-123',
			});

			expect(run.goalId).toBe('goal-123');

			// Verify persistence via re-fetch
			const fetched = repo.getRun(run.id)!;
			expect(fetched.goalId).toBe('goal-123');
		});

		it('creates a run without goalId — maps to undefined', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'No Goal',
			});

			expect(run.goalId).toBeUndefined();

			// Re-fetch from DB to confirm persistence
			expect(repo.getRun(run.id)!.goalId).toBeUndefined();
		});

		it('goalId survives status and step updates', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'Goal Persist',
				goalId: 'goal-456',
			});

			repo.updateStatus(run.id, 'in_progress');
			repo.updateCurrentStep(run.id, 'step-xyz');

			const updated = repo.getRun(run.id)!;
			expect(updated.goalId).toBe('goal-456');
			expect(updated.status).toBe('in_progress');
			expect(updated.currentStepId).toBe('step-xyz');
		});

		it('goalId is included when listing runs by space', () => {
			repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'G1',
				goalId: 'goal-a',
			});
			repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'G2',
			});

			const runs = repo.listBySpace(spaceId);
			expect(runs).toHaveLength(2);
			const withGoal = runs.find((r) => r.title === 'G1')!;
			const withoutGoal = runs.find((r) => r.title === 'G2')!;
			expect(withGoal.goalId).toBe('goal-a');
			expect(withoutGoal.goalId).toBeUndefined();
		});

		it('goalId is included in getActiveRuns results', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'Active Goal',
				goalId: 'goal-active',
			});
			repo.updateStatus(run.id, 'in_progress');

			const active = repo.getActiveRuns(spaceId);
			expect(active).toHaveLength(1);
			expect(active[0].goalId).toBe('goal-active');
		});

		it('goalId is included in getRehydratableRuns results', () => {
			const run = repo.createRun({
				spaceId,
				workflowId: WORKFLOW_ID,
				title: 'Needs Attn',
				goalId: 'goal-rehydrate',
			});
			repo.updateStatus(run.id, 'needs_attention');

			const rehydratable = repo.getRehydratableRuns(spaceId);
			expect(rehydratable).toHaveLength(1);
			expect(rehydratable[0].goalId).toBe('goal-rehydrate');
		});
	});
});
