/**
 * SpaceWorkflow Unit Tests
 *
 * Covers:
 * - Repository: full CRUD with step and transition management
 * - Repository: getWorkflowsReferencingAgent
 * - Repository: JSON round-trips (rules, tags, transitions, conditions)
 * - Manager: name uniqueness within space
 * - Manager: at-least-one-step validation
 * - Manager: agentId validation (non-empty, optional SpaceAgentLookup)
 * - Manager: transition validation (from/to step ID refs)
 * - Manager: condition validation (expression non-empty for 'condition' type)
 * - Manager: startStepId validation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import {
	SpaceWorkflowManager,
	WorkflowValidationError,
} from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceAgentLookup } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { WorkflowStepInput, WorkflowTransitionInput } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(process.cwd(), 'tmp', 'test-space-workflow', `t-${Date.now()}-${Math.random()}`);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId = 'space-1'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `/tmp/ws-${spaceId}`, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     config, created_at, updated_at, role)
     VALUES (?, ?, ?, '', null, '[]', '', null, ?, ?, 'coder')`
	).run(agentId, spaceId, name, Date.now(), Date.now());
}

// Step fixtures — no entryGate/exitGate/order in new model
const coderStep: WorkflowStepInput = { id: 'step-coder', name: 'Code', agentId: 'agent-coder' };
const plannerStep: WorkflowStepInput = {
	id: 'step-planner',
	name: 'Plan',
	agentId: 'agent-planner',
};
const generalStep: WorkflowStepInput = {
	id: 'step-general',
	name: 'Review',
	agentId: 'agent-general',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRepository', () => {
	let db: BunDatabase;
	let dir: string;
	let repo: SpaceWorkflowRepository;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db);
		repo = new SpaceWorkflowRepository(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// CRUD
	// -------------------------------------------------------------------------

	test('createWorkflow returns workflow with generated id and steps', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'My Workflow',
			steps: [coderStep, plannerStep],
		});

		expect(wf.id).toBeTruthy();
		expect(wf.spaceId).toBe('space-1');
		expect(wf.name).toBe('My Workflow');
		expect(wf.steps).toHaveLength(2);
		expect(wf.steps[0].name).toBe('Code');
		expect(wf.steps[0].agentId).toBe('agent-coder');
		expect(wf.steps[1].name).toBe('Plan');
		expect(wf.tags).toEqual([]);
		expect(wf.rules).toEqual([]);
		expect(wf.transitions).toEqual([]);
	});

	test('createWorkflow stores tags and config', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Tagged',
			steps: [coderStep],
			tags: ['ci', 'deploy'],
			config: { priority: 'high' },
		});
		expect(wf.tags).toEqual(['ci', 'deploy']);
		expect(wf.config).toEqual({ priority: 'high' });
	});

	test('createWorkflow uses first step as startStepId by default', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Auto Start',
			steps: [coderStep, plannerStep],
		});
		expect(wf.startStepId).toBe(coderStep.id);
	});

	test('createWorkflow respects explicit startStepId', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Explicit Start',
			steps: [coderStep, plannerStep],
			startStepId: plannerStep.id,
		});
		expect(wf.startStepId).toBe(plannerStep.id);
	});

	test('createWorkflow stores transitions', () => {
		const transition: WorkflowTransitionInput = {
			from: coderStep.id!,
			to: plannerStep.id!,
			condition: { type: 'always' },
			order: 0,
		};
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'With Transitions',
			steps: [coderStep, plannerStep],
			transitions: [transition],
		});
		expect(wf.transitions).toHaveLength(1);
		expect(wf.transitions[0].from).toBe(coderStep.id);
		expect(wf.transitions[0].to).toBe(plannerStep.id);
		expect(wf.transitions[0].condition?.type).toBe('always');
	});

	test('getWorkflow returns null for missing id', () => {
		expect(repo.getWorkflow('no-such-id')).toBeNull();
	});

	test('getWorkflow round-trips all fields', () => {
		const created = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Full',
			description: 'A full workflow',
			steps: [coderStep, plannerStep],
			transitions: [{ from: coderStep.id!, to: plannerStep.id!, condition: { type: 'human' } }],
			startStepId: coderStep.id,
			rules: [{ name: 'Rule1', content: 'Follow TDD', appliesTo: [] }],
			tags: ['a', 'b'],
			config: { key: 'value' },
		});

		const fetched = repo.getWorkflow(created.id)!;
		expect(fetched.name).toBe('Full');
		expect(fetched.description).toBe('A full workflow');
		expect(fetched.tags).toEqual(['a', 'b']);
		expect(fetched.rules).toHaveLength(1);
		expect(fetched.rules[0].name).toBe('Rule1');
		expect(fetched.rules[0].id).toBeTruthy();
		expect(fetched.config).toEqual({ key: 'value' });
		expect(fetched.startStepId).toBe(coderStep.id);
		expect(fetched.transitions).toHaveLength(1);
		expect(fetched.transitions[0].condition?.type).toBe('human');
	});

	test('listWorkflows returns all workflows for a space', () => {
		repo.createWorkflow({ spaceId: 'space-1', name: 'WF1', steps: [coderStep] });
		repo.createWorkflow({ spaceId: 'space-1', name: 'WF2', steps: [plannerStep] });
		// Another space — should not appear; use anonymous step (no fixed id) to avoid PK collision
		seedSpace(db, 'space-2');
		repo.createWorkflow({
			spaceId: 'space-2',
			name: 'WF3',
			steps: [{ name: 'Code', agentId: 'agent-coder' }],
		});

		const wfs = repo.listWorkflows('space-1');
		expect(wfs).toHaveLength(2);
		expect(wfs.map((w) => w.name).sort()).toEqual(['WF1', 'WF2']);
	});

	test('updateWorkflow updates name and description', () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'Old Name', steps: [coderStep] });
		const updated = repo.updateWorkflow(wf.id, { name: 'New Name', description: 'Updated desc' });
		expect(updated?.name).toBe('New Name');
		expect(updated?.description).toBe('Updated desc');
	});

	test('updateWorkflow bumps updatedAt on step-only update', async () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		const before = wf.updatedAt;
		// Small delay to ensure timestamp difference
		await new Promise((r) => setTimeout(r, 2));
		const updated = repo.updateWorkflow(wf.id, {
			steps: [{ id: 'new-step', name: 'Plan', agentId: 'agent-planner' }],
		});
		expect(updated?.updatedAt).toBeGreaterThan(before);
	});

	test('updateWorkflow replaces all steps on steps param', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep, plannerStep],
		});
		expect(wf.steps).toHaveLength(2);

		const updated = repo.updateWorkflow(wf.id, {
			steps: [{ id: 'step-review', name: 'Review', agentId: 'agent-general' }],
		});
		expect(updated?.steps).toHaveLength(1);
		expect(updated?.steps[0].agentId).toBe('agent-general');
	});

	test('updateWorkflow replaces transitions when provided', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep, plannerStep],
			transitions: [{ from: coderStep.id!, to: plannerStep.id!, condition: { type: 'always' } }],
		});
		expect(wf.transitions).toHaveLength(1);

		const updated = repo.updateWorkflow(wf.id, {
			transitions: [],
		});
		expect(updated?.transitions).toHaveLength(0);
	});

	test('updateWorkflow returns null for missing id', () => {
		expect(repo.updateWorkflow('missing', { name: 'X' })).toBeNull();
	});

	test('deleteWorkflow removes the workflow and its steps', () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(repo.deleteWorkflow(wf.id)).toBe(true);
		expect(repo.getWorkflow(wf.id)).toBeNull();

		// Steps should be gone (CASCADE)
		const rows = db.prepare(`SELECT * FROM space_workflow_steps WHERE workflow_id = ?`).all(wf.id);
		expect(rows).toHaveLength(0);
	});

	test('deleteWorkflow removes transitions (CASCADE)', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep, plannerStep],
			transitions: [{ from: coderStep.id!, to: plannerStep.id! }],
		});
		expect(repo.deleteWorkflow(wf.id)).toBe(true);

		const rows = db
			.prepare(`SELECT * FROM space_workflow_transitions WHERE workflow_id = ?`)
			.all(wf.id);
		expect(rows).toHaveLength(0);
	});

	test('deleteWorkflow returns false for missing id', () => {
		expect(repo.deleteWorkflow('no-such-id')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// getWorkflowsReferencingAgent
	// -------------------------------------------------------------------------

	test('getWorkflowsReferencingAgent returns workflows with matching agent', () => {
		seedAgent(db, 'agent-1', 'space-1', 'Alpha');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF With Agent',
			steps: [{ id: 'step-1', name: 'Step', agentId: 'agent-1' }],
		});
		const results = repo.getWorkflowsReferencingAgent('agent-1');
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe(wf.id);
	});

	test('getWorkflowsReferencingAgent returns empty for unmatched agent', () => {
		repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep],
		});
		expect(repo.getWorkflowsReferencingAgent('no-such-agent')).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// JSON round-trips
	// -------------------------------------------------------------------------

	test('JSON round-trip: condition with expression', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Condition WF',
			steps: [coderStep, plannerStep],
			transitions: [
				{
					from: coderStep.id!,
					to: plannerStep.id!,
					condition: {
						type: 'condition',
						expression: 'bun test',
						timeoutMs: 30000,
						maxRetries: 2,
					},
				},
			],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		const t = fetched.transitions[0];
		expect(t.condition?.type).toBe('condition');
		expect(t.condition?.expression).toBe('bun test');
		expect(t.condition?.timeoutMs).toBe(30000);
		expect(t.condition?.maxRetries).toBe(2);
	});

	test('JSON round-trip: human condition', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Human WF',
			steps: [coderStep, plannerStep],
			transitions: [
				{
					from: coderStep.id!,
					to: plannerStep.id!,
					condition: { type: 'human', description: 'Please review' },
				},
			],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.transitions[0].condition?.type).toBe('human');
		expect(fetched.transitions[0].condition?.description).toBe('Please review');
	});

	test('JSON round-trip: transition with no condition (unconditional)', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'No Cond WF',
			steps: [coderStep, plannerStep],
			transitions: [{ from: coderStep.id!, to: plannerStep.id! }],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.transitions[0].condition).toBeUndefined();
	});

	test('JSON round-trip: rules with appliesTo', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep],
			rules: [
				{ name: 'R1', content: 'Always test', appliesTo: ['step-id-1'] },
				{ name: 'R2', content: 'No shortcuts' },
			],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.rules).toHaveLength(2);
		expect(fetched.rules[0].appliesTo).toEqual(['step-id-1']);
		expect(fetched.rules[1].appliesTo).toBeUndefined();
	});

	test('JSON round-trip: agentId is stored in agent_id column and round-trips', () => {
		seedAgent(db, 'agent-99', 'space-1', 'MyAgent');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Custom WF',
			steps: [{ id: 'step-99', name: 'Step', agentId: 'agent-99' }],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.steps[0].agentId).toBe('agent-99');

		// Verify agent_id column is set
		const row = db
			.prepare('SELECT agent_id FROM space_workflow_steps WHERE workflow_id = ?')
			.get(wf.id) as { agent_id: string };
		expect(row.agent_id).toBe('agent-99');
	});

	// -------------------------------------------------------------------------
	// Layout field
	// -------------------------------------------------------------------------

	test('createWorkflow stores layout and round-trips it', () => {
		const layout = {
			[coderStep.id!]: { x: 100, y: 200 },
			[plannerStep.id!]: { x: 300, y: 400 },
		};
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Layout WF',
			steps: [coderStep, plannerStep],
			layout,
		});
		expect(wf.layout).toEqual(layout);

		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.layout).toEqual(layout);
	});

	test('createWorkflow without layout returns undefined layout', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'No Layout WF',
			steps: [coderStep],
		});
		expect(wf.layout).toBeUndefined();

		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.layout).toBeUndefined();
	});

	test('updateWorkflow sets layout on an existing workflow', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep],
		});
		expect(wf.layout).toBeUndefined();

		const layout = { [coderStep.id!]: { x: 50, y: 75 } };
		const updated = repo.updateWorkflow(wf.id, { layout });
		expect(updated?.layout).toEqual(layout);

		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.layout).toEqual(layout);
	});

	test('updateWorkflow clears layout when null is passed', () => {
		const layout = { [coderStep.id!]: { x: 10, y: 20 } };
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep],
			layout,
		});
		expect(wf.layout).toEqual(layout);

		const updated = repo.updateWorkflow(wf.id, { layout: null });
		expect(updated?.layout).toBeUndefined();
	});

	test('createWorkflow stores maxIterations', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Cyclic WF',
			steps: [coderStep],
			maxIterations: 3,
		});
		expect(wf.maxIterations).toBe(3);

		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.maxIterations).toBe(3);
	});

	test('createWorkflow without maxIterations returns undefined', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'No Iterations WF',
			steps: [coderStep],
		});
		expect(wf.maxIterations).toBeUndefined();
	});

	test('updateWorkflow sets maxIterations on an existing workflow', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF Iter',
			steps: [coderStep],
		});
		expect(wf.maxIterations).toBeUndefined();

		const updated = repo.updateWorkflow(wf.id, { maxIterations: 10 });
		expect(updated?.maxIterations).toBe(10);

		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.maxIterations).toBe(10);
	});

	test('updateWorkflow clears maxIterations when null is passed', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF Clear Iter',
			steps: [coderStep],
			maxIterations: 5,
		});
		expect(wf.maxIterations).toBe(5);

		const updated = repo.updateWorkflow(wf.id, { maxIterations: null });
		expect(updated?.maxIterations).toBeUndefined();
	});

	test('layout column contains raw JSON in the DB', () => {
		const layout = { [coderStep.id!]: { x: 1, y: 2 } };
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF Raw',
			steps: [coderStep],
			layout,
		});
		const row = db.prepare('SELECT layout FROM space_workflows WHERE id = ?').get(wf.id) as {
			layout: string;
		};
		expect(JSON.parse(row.layout)).toEqual(layout);
	});
});

// ---------------------------------------------------------------------------
// Manager tests
// ---------------------------------------------------------------------------

describe('SpaceWorkflowManager', () => {
	let db: BunDatabase;
	let dir: string;
	let repo: SpaceWorkflowRepository;
	let manager: SpaceWorkflowManager;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db);
		repo = new SpaceWorkflowRepository(db);
		manager = new SpaceWorkflowManager(repo, null);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// Name uniqueness
	// -------------------------------------------------------------------------

	test('createWorkflow throws if name already exists in space', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Dup', steps: [coderStep] });
		expect(() =>
			manager.createWorkflow({ spaceId: 'space-1', name: 'Dup', steps: [plannerStep] })
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow allows same name in different spaces', () => {
		seedSpace(db, 'space-2');
		manager.createWorkflow({ spaceId: 'space-1', name: 'Same', steps: [coderStep] });
		// Use anonymous step (no fixed id) to avoid PK collision across spaces in the same DB
		const wf2 = manager.createWorkflow({
			spaceId: 'space-2',
			name: 'Same',
			steps: [{ name: 'Code', agentId: 'agent-coder' }],
		});
		expect(wf2.name).toBe('Same');
	});

	test('updateWorkflow throws if new name conflicts with another workflow', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Existing', steps: [coderStep] });
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF2', steps: [plannerStep] });
		expect(() => manager.updateWorkflow(wf.id, { name: 'Existing' })).toThrow(
			WorkflowValidationError
		);
	});

	test('updateWorkflow allows keeping the same name', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		const updated = manager.updateWorkflow(wf.id, { name: 'WF' });
		expect(updated?.name).toBe('WF');
	});

	test('name is trimmed before storage — whitespace variants collide', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Foo', steps: [coderStep] });
		expect(() =>
			manager.createWorkflow({ spaceId: 'space-1', name: '  Foo  ', steps: [plannerStep] })
		).toThrow(WorkflowValidationError);
	});

	test('name is stored trimmed', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: '  Trimmed  ',
			steps: [coderStep],
		});
		expect(wf.name).toBe('Trimmed');
	});

	// -------------------------------------------------------------------------
	// At-least-one-step
	// -------------------------------------------------------------------------

	test('createWorkflow throws when steps is empty', () => {
		expect(() => manager.createWorkflow({ spaceId: 'space-1', name: 'Empty', steps: [] })).toThrow(
			WorkflowValidationError
		);
	});

	test('createWorkflow throws when steps is not provided (defaults to empty)', () => {
		expect(() => manager.createWorkflow({ spaceId: 'space-1', name: 'NoSteps' })).toThrow(
			WorkflowValidationError
		);
	});

	test('updateWorkflow throws when replacing with empty steps', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(() => manager.updateWorkflow(wf.id, { steps: [] })).toThrow(WorkflowValidationError);
	});

	test('updateWorkflow throws when steps is null (treated as empty replacement)', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(() => manager.updateWorkflow(wf.id, { steps: null as unknown as [] })).toThrow(
			WorkflowValidationError
		);
	});

	// -------------------------------------------------------------------------
	// Agent ID validation
	// -------------------------------------------------------------------------

	test('createWorkflow accepts any non-empty agentId (no lookup)', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [{ name: 'Step', agentId: 'some-uuid' }],
		});
		expect(wf.steps[0].agentId).toBe('some-uuid');
	});

	test('createWorkflow rejects empty agentId', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad AgentId',
				steps: [{ name: 'Step', agentId: '' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects whitespace-only agentId', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Whitespace AgentId',
				steps: [{ name: 'Step', agentId: '   ' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow accepts agentId when agent exists in lookup', () => {
		seedAgent(db, 'agent-1', 'space-1', 'MyAgent');
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) =>
				id === 'agent-1' ? { id: 'agent-1', name: 'MyAgent' } : null,
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		const wf = mgr.createWorkflow({
			spaceId: 'space-1',
			name: 'Custom WF',
			steps: [{ name: 'Step', agentId: 'agent-1' }],
		});
		expect(wf.steps[0].agentId).toBe('agent-1');
	});

	test('createWorkflow rejects agentId when agent does not exist in lookup', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: () => null,
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		expect(() =>
			mgr.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Agent',
				steps: [{ name: 'Step', agentId: 'non-existent-uuid' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow skips lookup when agentLookup is null', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'No-Lookup WF',
			steps: [{ name: 'Step', agentId: 'anything' }],
		});
		expect(wf.steps[0].agentId).toBe('anything');
	});

	test('updateWorkflow rejects invalid agentId via lookup', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		const lookup: SpaceAgentLookup = { getAgentById: () => null };
		const mgr = new SpaceWorkflowManager(repo, lookup);
		expect(() =>
			mgr.updateWorkflow(wf.id, {
				steps: [{ id: 'step-x', name: 'Step', agentId: 'non-existent' }],
			})
		).toThrow(WorkflowValidationError);
	});

	// -------------------------------------------------------------------------
	// Transition validation
	// -------------------------------------------------------------------------

	test('createWorkflow accepts valid transitions referencing step IDs', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Trans WF',
			steps: [coderStep, plannerStep],
			transitions: [{ from: coderStep.id!, to: plannerStep.id!, condition: { type: 'always' } }],
		});
		expect(wf.transitions).toHaveLength(1);
	});

	test('createWorkflow rejects transition with empty from', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans',
				steps: [coderStep, plannerStep],
				transitions: [{ from: '', to: plannerStep.id! }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transition with empty to', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans2',
				steps: [coderStep, plannerStep],
				transitions: [{ from: coderStep.id!, to: '' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transition referencing non-existent from step', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans From',
				steps: [coderStep, plannerStep],
				transitions: [{ from: 'no-such-step', to: plannerStep.id! }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transition referencing non-existent to step', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans To',
				steps: [coderStep, plannerStep],
				transitions: [{ from: coderStep.id!, to: 'no-such-step' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transitions when any step lacks an explicit id', () => {
		// Steps without explicit IDs cannot be referenced in transitions at validation time.
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Anon Steps Trans',
				// Neither step has an explicit id — backend would assign UUIDs at persist time
				steps: [
					{ name: 'Plan', agentId: 'agent-planner' },
					{ name: 'Code', agentId: 'agent-coder' },
				],
				transitions: [{ from: 'anything', to: 'anything-else' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow allows transitions when all steps have explicit ids', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Explicit IDs',
				steps: [coderStep, plannerStep],
				transitions: [{ from: coderStep.id!, to: plannerStep.id! }],
			})
		).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Condition validation
	// -------------------------------------------------------------------------

	test('createWorkflow rejects condition type with empty expression', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Empty Expr',
				steps: [coderStep, plannerStep],
				transitions: [
					{
						from: coderStep.id!,
						to: plannerStep.id!,
						condition: { type: 'condition', expression: '' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow accepts condition type with non-empty expression', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Good Expr',
			steps: [coderStep, plannerStep],
			transitions: [
				{
					from: coderStep.id!,
					to: plannerStep.id!,
					condition: { type: 'condition', expression: 'bun test' },
				},
			],
		});
		expect(wf.transitions[0].condition?.expression).toBe('bun test');
	});

	test('createWorkflow accepts any expression (no allowlist)', () => {
		// No allowlist — any expression is accepted at storage time
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Any Expr',
			steps: [coderStep, plannerStep],
			transitions: [
				{
					from: coderStep.id!,
					to: plannerStep.id!,
					condition: { type: 'condition', expression: 'rm -rf /tmp' },
				},
			],
		});
		expect(wf.transitions[0].condition?.expression).toBe('rm -rf /tmp');
	});

	test('createWorkflow accepts human condition without expression', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Human WF',
			steps: [coderStep, plannerStep],
			transitions: [
				{
					from: coderStep.id!,
					to: plannerStep.id!,
					condition: { type: 'human', description: 'Please review' },
				},
			],
		});
		expect(wf.transitions[0].condition?.type).toBe('human');
	});

	// -------------------------------------------------------------------------
	// Delete
	// -------------------------------------------------------------------------

	test('deleteWorkflow removes an existing workflow', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(manager.deleteWorkflow(wf.id)).toBe(true);
		expect(manager.getWorkflow(wf.id)).toBeNull();
	});

	test('deleteWorkflow returns false for non-existent workflow', () => {
		expect(manager.deleteWorkflow('no-such-id')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Steps stored in insertion order
	// -------------------------------------------------------------------------

	test('steps are stored and retrieved in insertion order', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Ordered',
			steps: [plannerStep, coderStep, generalStep],
		});
		expect(wf.steps[0].name).toBe('Plan');
		expect(wf.steps[1].name).toBe('Code');
		expect(wf.steps[2].name).toBe('Review');
	});

	// -------------------------------------------------------------------------
	// getWorkflowsReferencingAgent
	// -------------------------------------------------------------------------

	test('getWorkflowsReferencingAgent returns workflows using given agent', () => {
		seedAgent(db, 'agent-1', 'space-1', 'Alpha');
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Uses Alpha',
			steps: [{ id: 'step-1', name: 'Step', agentId: 'agent-1' }],
		});
		manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Uses Other',
			steps: [coderStep],
		});
		const refs = manager.getWorkflowsReferencingAgent('agent-1');
		expect(refs).toHaveLength(1);
		expect(refs[0].id).toBe(wf.id);
	});
});
