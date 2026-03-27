/**
 * Gate Types and Schema Integration Tests
 *
 * Validates that:
 *   - Channel and Gate types are structurally correct
 *   - Gate definitions persist to and load from SQLite (workflow repository)
 *   - gate_data table supports CRUD via the repository
 *   - send_message schema accepts the optional `data` field
 *   - SpaceWorkflowRun supports failureReason
 *   - Gateless channels route without obstruction
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSpaceTables } from '../helpers/space-test-db.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { GateDataRepository } from '../../../src/storage/repositories/gate-data-repository.ts';
import { SendMessageSchema } from '../../../src/lib/space/tools/node-agent-tool-schemas.ts';
import type {
	Gate,
	Channel,
	GateCondition,
	WorkflowRunFailureReason,
	SpaceWorkflowRun,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

let db: Database;
const SPACE_ID = 'space-test-1';

function freshDb(): Database {
	const d = new Database(':memory:');
	createSpaceTables(d);
	const now = Date.now();
	d.exec(
		`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '/tmp/test', 'Test Space', ${now}, ${now})`
	);
	return d;
}

beforeEach(() => {
	db = freshDb();
});

// ---------------------------------------------------------------------------
// Type validation — compile-time checks expressed as runtime assertions
// ---------------------------------------------------------------------------

describe('Gate and Channel type validation', () => {
	test('Channel without gateId is always open (type-level)', () => {
		const channel: Channel = {
			id: 'ch-1',
			from: 'planner',
			to: 'coder',
		};
		expect(channel.gateId).toBeUndefined();
	});

	test('Channel with gateId references a gate', () => {
		const channel: Channel = {
			id: 'ch-2',
			from: 'coder',
			to: 'reviewer',
			gateId: 'gate-approval',
			isCyclic: false,
			label: 'Code Review Gate',
		};
		expect(channel.gateId).toBe('gate-approval');
	});

	test('Gate with check condition', () => {
		const gate: Gate = {
			id: 'gate-1',
			condition: { type: 'check', field: 'approved', value: true },
			data: { approved: false },
			allowedWriterRoles: ['reviewer'],
			resetOnCycle: false,
			description: 'Approval gate',
		};
		expect(gate.condition.type).toBe('check');
	});

	test('Gate with count condition', () => {
		const gate: Gate = {
			id: 'gate-2',
			condition: { type: 'count', field: 'approvals', threshold: 2 },
			data: { approvals: 0 },
			allowedWriterRoles: ['reviewer-1', 'reviewer-2'],
			resetOnCycle: true,
		};
		expect(gate.condition.type).toBe('count');
	});

	test('Gate with composite all condition', () => {
		const condition: GateCondition = {
			type: 'all',
			conditions: [
				{ type: 'check', field: 'approved', value: true },
				{ type: 'count', field: 'reviews', threshold: 2 },
			],
		};
		const gate: Gate = {
			id: 'gate-3',
			condition,
			data: { approved: false, reviews: 0 },
			allowedWriterRoles: ['*'],
			resetOnCycle: false,
		};
		expect(gate.condition.type).toBe('all');
		if (gate.condition.type === 'all') {
			expect(gate.condition.conditions).toHaveLength(2);
		}
	});

	test('Gate with composite any condition', () => {
		const condition: GateCondition = {
			type: 'any',
			conditions: [
				{ type: 'check', field: 'fast_track', value: true },
				{ type: 'count', field: 'approvals', threshold: 3 },
			],
		};
		const gate: Gate = {
			id: 'gate-4',
			condition,
			data: {},
			allowedWriterRoles: ['*'],
			resetOnCycle: false,
		};
		expect(gate.condition.type).toBe('any');
	});

	test('WorkflowRunFailureReason type accepts all valid values', () => {
		const reasons: WorkflowRunFailureReason[] = [
			'humanRejected',
			'maxIterationsReached',
			'nodeTimeout',
			'agentCrash',
		];
		expect(reasons).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// Workflow repository — gates persistence
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRepository — gates round-trip', () => {
	test('creates workflow with gates and retrieves them', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);

		const gates: Gate[] = [
			{
				id: 'gate-approval',
				condition: { type: 'check', field: 'approved', value: true },
				data: { approved: false },
				allowedWriterRoles: ['reviewer'],
				resetOnCycle: false,
				description: 'Plan approval gate',
			},
			{
				id: 'gate-review-count',
				condition: { type: 'count', field: 'approvals', threshold: 2 },
				data: { approvals: 0 },
				allowedWriterRoles: ['reviewer-1', 'reviewer-2'],
				resetOnCycle: true,
			},
		];

		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'Test Workflow',
			gates,
		});

		expect(workflow.gates).toBeDefined();
		expect(workflow.gates).toHaveLength(2);
		expect(workflow.gates![0].id).toBe('gate-approval');
		expect(workflow.gates![0].condition.type).toBe('check');
		expect(workflow.gates![1].id).toBe('gate-review-count');
		expect(workflow.gates![1].condition.type).toBe('count');
		expect(workflow.gates![1].resetOnCycle).toBe(true);
	});

	test('workflow without gates returns undefined gates', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'No Gates Workflow',
		});
		expect(workflow.gates).toBeUndefined();
	});

	test('updateWorkflow can set and clear gates', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'Update Gates Test',
		});

		// Set gates
		const updated = workflowRepo.updateWorkflow(workflow.id, {
			gates: [
				{
					id: 'gate-1',
					condition: { type: 'check', field: 'ready', value: true },
					data: { ready: false },
					allowedWriterRoles: ['*'],
					resetOnCycle: false,
				},
			],
		});
		expect(updated!.gates).toHaveLength(1);

		// Clear gates
		const cleared = workflowRepo.updateWorkflow(workflow.id, { gates: null });
		expect(cleared!.gates).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Workflow run — failureReason persistence
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRunRepository — failureReason', () => {
	test('failureReason is undefined for normal runs', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'FR Test Workflow',
		});

		const runRepo = new SpaceWorkflowRunRepository(db);
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Test Run',
		});
		expect(run.failureReason).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Gate data — schema creation and CRUD
// ---------------------------------------------------------------------------

describe('gate_data table — schema and CRUD', () => {
	test('gate_data table exists and supports insert/select', () => {
		const repo = new GateDataRepository(db);

		// First create a workflow and run for FK
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'GD Test Workflow',
		});
		const runRepo = new SpaceWorkflowRunRepository(db);
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'GD Test Run',
		});

		// CRUD
		repo.set(run.id, 'gate-1', { approved: false });
		const record = repo.get(run.id, 'gate-1');
		expect(record).not.toBeNull();
		expect(record!.data).toEqual({ approved: false });

		// Merge
		repo.merge(run.id, 'gate-1', { approved: true });
		expect(repo.get(run.id, 'gate-1')!.data).toEqual({ approved: true });

		// Delete
		repo.delete(run.id, 'gate-1');
		expect(repo.get(run.id, 'gate-1')).toBeNull();
	});

	test('gate_data cascade deletes with workflow run', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'Cascade Test',
		});
		const runRepo = new SpaceWorkflowRunRepository(db);
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Cascade Run',
		});

		const gateRepo = new GateDataRepository(db);
		gateRepo.set(run.id, 'gate-a', { value: 1 });
		gateRepo.set(run.id, 'gate-b', { value: 2 });

		// Delete the run
		runRepo.deleteRun(run.id);

		// Gate data should be gone (CASCADE)
		expect(gateRepo.listByRun(run.id)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// send_message schema — data field
// ---------------------------------------------------------------------------

describe('SendMessageSchema — data field', () => {
	test('accepts message without data', () => {
		const result = SendMessageSchema.safeParse({
			target: 'reviewer',
			message: 'Hello',
		});
		expect(result.success).toBe(true);
	});

	test('accepts message with data', () => {
		const result = SendMessageSchema.safeParse({
			target: 'reviewer',
			message: 'Approve please',
			data: { approved: true, score: 95 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.data).toEqual({ approved: true, score: 95 });
		}
	});

	test('accepts message with empty data object', () => {
		const result = SendMessageSchema.safeParse({
			target: 'reviewer',
			message: 'No data',
			data: {},
		});
		expect(result.success).toBe(true);
	});

	test('rejects message with non-object data', () => {
		const result = SendMessageSchema.safeParse({
			target: 'reviewer',
			message: 'Bad data',
			data: 'not an object',
		});
		expect(result.success).toBe(false);
	});
});
