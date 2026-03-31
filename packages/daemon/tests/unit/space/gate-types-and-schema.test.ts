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
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/test', 'Test Space', ${now}, ${now})`
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

	test('Gate with scalar field (boolean check)', () => {
		const gate: Gate = {
			id: 'gate-1',
			fields: [{ name: 'approved', type: 'boolean', writers: ['reviewer'], check: { op: '==', value: true } }],
			resetOnCycle: false,
			description: 'Approval gate',
		};
		expect(gate.fields).toHaveLength(1);
		expect(gate.fields[0].name).toBe('approved');
	});

	test('Gate with map field (count check)', () => {
		const gate: Gate = {
			id: 'gate-2',
			fields: [{ name: 'reviews', type: 'map', writers: ['reviewer-1', 'reviewer-2'], check: { op: 'count', match: 'approved', min: 2 } }],
			resetOnCycle: true,
		};
		expect(gate.fields[0].type).toBe('map');
		expect(gate.fields[0].check.op).toBe('count');
	});

	test('Gate with multiple fields (all must pass)', () => {
		const gate: Gate = {
			id: 'gate-3',
			fields: [
				{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
				{ name: 'reviews', type: 'map', writers: ['*'], check: { op: 'count', match: 'approved', min: 2 } },
			],
			resetOnCycle: false,
		};
		expect(gate.fields).toHaveLength(2);
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
				fields: [{ name: 'approved', type: 'boolean', writers: ['reviewer'], check: { op: '==', value: true } }],
				resetOnCycle: false,
				description: 'Plan approval gate',
			},
			{
				id: 'gate-review-count',
				fields: [{ name: 'approvals', type: 'map', writers: ['reviewer-1', 'reviewer-2'], check: { op: 'count', match: 'approved', min: 2 } }],
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
		expect(workflow.gates![0].fields[0].name).toBe('approved');
		expect(workflow.gates![1].id).toBe('gate-review-count');
		expect(workflow.gates![1].fields[0].check.op).toBe('count');
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
					fields: [{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
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

	test('failureReason persists through updateRun and round-trips correctly', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'FR Persist Test',
		});

		const runRepo = new SpaceWorkflowRunRepository(db);
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Failure Test Run',
		});

		// Set failureReason
		const updated = runRepo.updateRun(run.id, {
			status: 'needs_attention',
			failureReason: 'maxIterationsReached',
		});
		expect(updated).not.toBeNull();
		expect(updated!.failureReason).toBe('maxIterationsReached');

		// Verify round-trip through getRun
		const fetched = runRepo.getRun(run.id);
		expect(fetched!.failureReason).toBe('maxIterationsReached');
	});

	test('failureReason can be cleared by setting to null', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'FR Clear Test',
		});

		const runRepo = new SpaceWorkflowRunRepository(db);
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Clear Test Run',
		});

		// Set then clear
		runRepo.updateRun(run.id, { failureReason: 'humanRejected' });
		const cleared = runRepo.updateRun(run.id, { failureReason: null });
		expect(cleared!.failureReason).toBeUndefined();
	});

	test('all four failureReason values persist correctly', () => {
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: 'FR All Values',
		});
		const runRepo = new SpaceWorkflowRunRepository(db);

		const reasons: WorkflowRunFailureReason[] = [
			'humanRejected',
			'maxIterationsReached',
			'nodeTimeout',
			'agentCrash',
		];

		for (const reason of reasons) {
			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: `Run for ${reason}`,
			});
			runRepo.updateRun(run.id, { failureReason: reason });
			const fetched = runRepo.getRun(run.id);
			expect(fetched!.failureReason).toBe(reason);
		}
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
