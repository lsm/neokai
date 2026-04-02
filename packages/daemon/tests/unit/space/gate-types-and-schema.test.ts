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
	GateScript,
	GateField,
} from '@neokai/shared';
import { computeGateDefaults } from '@neokai/shared';
import { evaluateGate } from '../../../src/lib/space/runtime/gate-evaluator.ts';

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
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					writers: ['reviewer'],
					check: { op: '==', value: true },
				},
			],
			resetOnCycle: false,
			description: 'Approval gate',
		};
		expect(gate.fields).toHaveLength(1);
		expect(gate.fields[0].name).toBe('approved');
	});

	test('Gate with map field (count check)', () => {
		const gate: Gate = {
			id: 'gate-2',
			fields: [
				{
					name: 'reviews',
					type: 'map',
					writers: ['reviewer-1', 'reviewer-2'],
					check: { op: 'count', match: 'approved', min: 2 },
				},
			],
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
				{
					name: 'reviews',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 2 },
				},
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
				fields: [
					{
						name: 'approved',
						type: 'boolean',
						writers: ['reviewer'],
						check: { op: '==', value: true },
					},
				],
				resetOnCycle: false,
				description: 'Plan approval gate',
			},
			{
				id: 'gate-review-count',
				fields: [
					{
						name: 'approvals',
						type: 'map',
						writers: ['reviewer-1', 'reviewer-2'],
						check: { op: 'count', match: 'approved', min: 2 },
					},
				],
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
					fields: [
						{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
					],
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

// ---------------------------------------------------------------------------
// Extended Gate interface: label, color, script, optional fields
// ---------------------------------------------------------------------------

describe('Gate extended interface (label, color, script, optional fields)', () => {
	test('Gate accepts label and color', () => {
		const gate: Gate = {
			id: 'gate-label-color',
			label: 'Code Review',
			color: '#22c55e',
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					writers: ['reviewer'],
					check: { op: '==', value: true },
				},
			],
			resetOnCycle: false,
		};
		expect(gate.label).toBe('Code Review');
		expect(gate.color).toBe('#22c55e');
	});

	test('Gate accepts GateScript', () => {
		const script: GateScript = {
			interpreter: 'bash',
			source: 'echo "check passed"',
			timeoutMs: 5000,
		};
		const gate: Gate = {
			id: 'gate-script',
			script,
			resetOnCycle: false,
		};
		expect(gate.script).toBeDefined();
		expect(gate.script!.interpreter).toBe('bash');
		expect(gate.script!.source).toBe('echo "check passed"');
		expect(gate.script!.timeoutMs).toBe(5000);
	});

	test('GateScript accepts all interpreter types', () => {
		const interpreters: GateScript['interpreter'][] = ['bash', 'node', 'python3'];
		for (const interpreter of interpreters) {
			const script: GateScript = { interpreter, source: 'test' };
			expect(script.interpreter).toBe(interpreter);
		}
	});

	test('GateScript timeoutMs is optional', () => {
		const script: GateScript = {
			interpreter: 'node',
			source: 'console.log("ok")',
		};
		expect(script.timeoutMs).toBeUndefined();
	});

	test('Gate without fields compiles and fields is undefined', () => {
		const gate: Gate = {
			id: 'gate-no-fields',
			script: {
				interpreter: 'bash',
				source: 'exit 0',
			},
			resetOnCycle: false,
		};
		expect(gate.fields).toBeUndefined();
	});

	test('Gate with all new fields together', () => {
		const gate: Gate = {
			id: 'gate-full',
			description: 'Full gate',
			label: 'Build Check',
			color: '#ef4444',
			fields: [
				{
					name: 'build_passed',
					type: 'boolean',
					writers: ['builder'],
					check: { op: '==', value: true },
				},
			],
			script: {
				interpreter: 'bash',
				source: 'make test',
				timeoutMs: 60000,
			},
			resetOnCycle: false,
		};
		expect(gate.label).toBe('Build Check');
		expect(gate.color).toBe('#ef4444');
		expect(gate.fields).toHaveLength(1);
		expect(gate.script!.interpreter).toBe('bash');
	});

	test('Gate with only label and no fields or script', () => {
		const gate: Gate = {
			id: 'gate-label-only',
			label: 'Manual Gate',
			resetOnCycle: false,
		};
		expect(gate.label).toBe('Manual Gate');
		expect(gate.fields).toBeUndefined();
		expect(gate.script).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// computeGateDefaults with optional fields
// ---------------------------------------------------------------------------

describe('computeGateDefaults with optional fields', () => {
	test('computeGateDefaults(undefined) returns empty object', () => {
		const result = computeGateDefaults(undefined);
		expect(result).toEqual({});
	});

	test('computeGateDefaults([]) returns empty object', () => {
		const result = computeGateDefaults([]);
		expect(result).toEqual({});
	});

	test('computeGateDefaults with map fields returns map defaults', () => {
		const fields: GateField[] = [
			{
				name: 'reviews',
				type: 'map',
				writers: ['reviewer-1', 'reviewer-2'],
				check: { op: 'count', match: 'approved', min: 2 },
			},
		];
		const result = computeGateDefaults(fields);
		expect(result).toEqual({ reviews: {} });
	});

	test('computeGateDefaults with boolean fields returns empty (no key)', () => {
		const fields: GateField[] = [
			{
				name: 'approved',
				type: 'boolean',
				writers: ['reviewer'],
				check: { op: '==', value: true },
			},
		];
		const result = computeGateDefaults(fields);
		expect(result).toEqual({});
	});

	test('computeGateDefaults with mixed fields returns only map defaults', () => {
		const fields: GateField[] = [
			{
				name: 'approved',
				type: 'boolean',
				writers: ['reviewer'],
				check: { op: '==', value: true },
			},
			{
				name: 'votes',
				type: 'map',
				writers: ['*'],
				check: { op: 'count', match: 'yes', min: 2 },
			},
			{
				name: 'comment',
				type: 'string',
				writers: ['human'],
				check: { op: 'exists' },
			},
		];
		const result = computeGateDefaults(fields);
		expect(result).toEqual({ votes: {} });
	});

	test('computeGateDefaults with multiple map fields returns all map defaults', () => {
		const fields: GateField[] = [
			{
				name: 'reviewer_votes',
				type: 'map',
				writers: ['reviewer'],
				check: { op: 'count', match: 'approved', min: 1 },
			},
			{
				name: 'tester_votes',
				type: 'map',
				writers: ['tester'],
				check: { op: 'count', match: 'passed', min: 1 },
			},
		];
		const result = computeGateDefaults(fields);
		expect(result).toEqual({ reviewer_votes: {}, tester_votes: {} });
	});
});

// ---------------------------------------------------------------------------
// evaluateGate with optional fields
// ---------------------------------------------------------------------------

describe('evaluateGate with optional fields', () => {
	test('Gate with no fields evaluates as open', () => {
		const gate: Gate = {
			id: 'gate-empty',
			resetOnCycle: false,
		};
		const result = evaluateGate(gate, {});
		expect(result.open).toBe(true);
	});

	test('Gate with script-only (no fields) evaluates as open', () => {
		// Note: evaluateGate does not execute gate.script — it only checks field-based
		// conditions. A script-only gate opens trivially because there are no fields to
		// fail. Script execution will be implemented in a follow-up task.
		const gate: Gate = {
			id: 'gate-script-only',
			script: {
				interpreter: 'bash',
				source: 'echo "ok"',
			},
			resetOnCycle: false,
		};
		const result = evaluateGate(gate, {});
		expect(result.open).toBe(true);
	});

	test('Gate with fields still evaluates normally', () => {
		const gate: Gate = {
			id: 'gate-with-fields',
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					writers: ['reviewer'],
					check: { op: '==', value: true },
				},
			],
			resetOnCycle: false,
		};
		const result = evaluateGate(gate, { approved: false });
		expect(result.open).toBe(false);
		const result2 = evaluateGate(gate, { approved: true });
		expect(result2.open).toBe(true);
	});
});
