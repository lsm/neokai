/**
 * SpaceWorkflowRepository — isCyclic round-trip test
 *
 * Verifies that `isCyclic` on WorkflowTransition persists correctly
 * through insertTransition() and reads back via getWorkflow().
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('SpaceWorkflowRepository — isCyclic', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as any);
		workflowRepo = new SpaceWorkflowRepository(db as any);

		const space = spaceRepo.createSpace({ workspacePath: '/workspace/test', name: 'Test' });
		spaceId = space.id;
	});

	afterEach(() => {
		db.close();
	});

	it('round-trips isCyclic: true through insert and read', () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId,
			name: 'Cyclic Workflow',
			steps: [
				{ id: 'step-plan', agentId: 'agent-1', name: 'Plan' },
				{ id: 'step-verify', agentId: 'agent-2', name: 'Verify' },
			],
			transitions: [
				{ from: 'step-plan', to: 'step-verify', order: 0 },
				{
					from: 'step-verify',
					to: 'step-plan',
					order: 1,
					isCyclic: true,
					condition: { type: 'task_result', expression: 'failed' },
				},
			],
			rules: [],
		});

		const fetched = workflowRepo.getWorkflow(workflow.id);
		expect(fetched).not.toBeNull();

		const cyclicTransition = fetched!.transitions.find((t) => t.isCyclic === true);
		expect(cyclicTransition).toBeDefined();
		expect(cyclicTransition!.isCyclic).toBe(true);
		expect(cyclicTransition!.condition).toEqual({
			type: 'task_result',
			expression: 'failed',
		});
	});

	it('round-trips isCyclic: undefined (absent) through insert and read', () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId,
			name: 'Linear Workflow',
			steps: [
				{ id: 'step-code', agentId: 'agent-1', name: 'Code' },
				{ id: 'step-review', agentId: 'agent-2', name: 'Review' },
			],
			transitions: [{ from: 'step-code', to: 'step-review', order: 0 }],
			rules: [],
		});

		const fetched = workflowRepo.getWorkflow(workflow.id);
		expect(fetched).not.toBeNull();
		expect(fetched!.transitions).toHaveLength(1);
		expect(fetched!.transitions[0].isCyclic).toBeUndefined();
	});

	it('persists task_result condition type correctly', () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId,
			name: 'Task Result Workflow',
			steps: [
				{ id: 'step-verify', agentId: 'agent-1', name: 'Verify' },
				{ id: 'step-done', agentId: 'agent-2', name: 'Done' },
			],
			transitions: [
				{
					from: 'step-verify',
					to: 'step-done',
					order: 0,
					condition: { type: 'task_result', expression: 'passed' },
				},
			],
			rules: [],
		});

		const fetched = workflowRepo.getWorkflow(workflow.id);
		expect(fetched).not.toBeNull();
		const trans = fetched!.transitions[0];
		expect(trans.condition).toEqual({
			type: 'task_result',
			expression: 'passed',
		});
	});
});
