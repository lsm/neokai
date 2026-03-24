/**
 * SpaceWorkflow Unit Tests
 *
 * Covers:
 * - Repository: full CRUD with node and transition management
 * - Repository: getWorkflowsReferencingAgent
 * - Repository: JSON round-trips (rules, tags, transitions, conditions)
 * - Manager: name uniqueness within space
 * - Manager: at-least-one-node validation
 * - Manager: agentId validation (non-empty, optional SpaceAgentLookup)
 * - Manager: transition validation (from/to node ID refs)
 * - Manager: condition validation (expression non-empty for 'condition' type)
 * - Manager: startNodeId validation
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
import type { WorkflowNodeInput, WorkflowTransitionInput } from '@neokai/shared';

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

// Node fixtures — no entryGate/exitGate/order in new model
const coderNode: WorkflowNodeInput = { id: 'node-coder', name: 'Code', agentId: 'agent-coder' };
const plannerNode: WorkflowNodeInput = {
	id: 'node-planner',
	name: 'Plan',
	agentId: 'agent-planner',
};
const generalNode: WorkflowNodeInput = {
	id: 'node-general',
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
			nodes: [coderNode, plannerNode],
		});

		expect(wf.id).toBeTruthy();
		expect(wf.spaceId).toBe('space-1');
		expect(wf.name).toBe('My Workflow');
		expect(wf.nodes).toHaveLength(2);
		expect(wf.nodes[0].name).toBe('Code');
		expect(wf.nodes[0].agentId).toBe('agent-coder');
		expect(wf.nodes[1].name).toBe('Plan');
		expect(wf.tags).toEqual([]);
		expect(wf.rules).toEqual([]);
		expect(wf.transitions).toEqual([]);
	});

	test('createWorkflow stores tags and config', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Tagged',
			nodes: [coderNode],
			tags: ['ci', 'deploy'],
			config: { priority: 'high' },
		});
		expect(wf.tags).toEqual(['ci', 'deploy']);
		expect(wf.config).toEqual({ priority: 'high' });
	});

	test('createWorkflow uses first node as startNodeId by default', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Auto Start',
			nodes: [coderNode, plannerNode],
		});
		expect(wf.startNodeId).toBe(coderNode.id);
	});

	test('createWorkflow respects explicit startNodeId', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Explicit Start',
			nodes: [coderNode, plannerNode],
			startNodeId: plannerNode.id,
		});
		expect(wf.startNodeId).toBe(plannerNode.id);
	});

	test('createWorkflow stores transitions', () => {
		const transition: WorkflowTransitionInput = {
			from: coderNode.id!,
			to: plannerNode.id!,
			condition: { type: 'always' },
			order: 0,
		};
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'With Transitions',
			nodes: [coderNode, plannerNode],
			transitions: [transition],
		});
		expect(wf.transitions).toHaveLength(1);
		expect(wf.transitions[0].from).toBe(coderNode.id);
		expect(wf.transitions[0].to).toBe(plannerNode.id);
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
			nodes: [coderNode, plannerNode],
			transitions: [{ from: coderNode.id!, to: plannerNode.id!, condition: { type: 'human' } }],
			startNodeId: coderNode.id,
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
		expect(fetched.startNodeId).toBe(coderNode.id);
		expect(fetched.transitions).toHaveLength(1);
		expect(fetched.transitions[0].condition?.type).toBe('human');
	});

	test('listWorkflows returns all workflows for a space', () => {
		repo.createWorkflow({ spaceId: 'space-1', name: 'WF1', nodes: [coderNode] });
		repo.createWorkflow({ spaceId: 'space-1', name: 'WF2', nodes: [plannerNode] });
		// Another space — should not appear; use anonymous step (no fixed id) to avoid PK collision
		seedSpace(db, 'space-2');
		repo.createWorkflow({
			spaceId: 'space-2',
			name: 'WF3',
			nodes: [{ name: 'Code', agentId: 'agent-coder' }],
		});

		const wfs = repo.listWorkflows('space-1');
		expect(wfs).toHaveLength(2);
		expect(wfs.map((w) => w.name).sort()).toEqual(['WF1', 'WF2']);
	});

	test('updateWorkflow updates name and description', () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'Old Name', nodes: [coderNode] });
		const updated = repo.updateWorkflow(wf.id, { name: 'New Name', description: 'Updated desc' });
		expect(updated?.name).toBe('New Name');
		expect(updated?.description).toBe('Updated desc');
	});

	test('updateWorkflow bumps updatedAt on step-only update', async () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		const before = wf.updatedAt;
		// Small delay to ensure timestamp difference
		await new Promise((r) => setTimeout(r, 2));
		const updated = repo.updateWorkflow(wf.id, {
			nodes: [{ id: 'new-step', name: 'Plan', agentId: 'agent-planner' }],
		});
		expect(updated?.updatedAt).toBeGreaterThan(before);
	});

	test('updateWorkflow replaces all steps on steps param', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			nodes: [coderNode, plannerNode],
		});
		expect(wf.nodes).toHaveLength(2);

		const updated = repo.updateWorkflow(wf.id, {
			nodes: [{ id: 'step-review', name: 'Review', agentId: 'agent-general' }],
		});
		expect(updated?.nodes).toHaveLength(1);
		expect(updated?.nodes[0].agentId).toBe('agent-general');
	});

	test('updateWorkflow replaces transitions when provided', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			nodes: [coderNode, plannerNode],
			transitions: [{ from: coderNode.id!, to: plannerNode.id!, condition: { type: 'always' } }],
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
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		expect(repo.deleteWorkflow(wf.id)).toBe(true);
		expect(repo.getWorkflow(wf.id)).toBeNull();

		// Nodes should be gone (CASCADE)
		const rows = db.prepare(`SELECT * FROM space_workflow_nodes WHERE workflow_id = ?`).all(wf.id);
		expect(rows).toHaveLength(0);
	});

	test('deleteWorkflow removes transitions (CASCADE)', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			nodes: [coderNode, plannerNode],
			transitions: [{ from: coderNode.id!, to: plannerNode.id! }],
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
			nodes: [{ id: 'step-1', name: 'Step', agentId: 'agent-1' }],
		});
		const results = repo.getWorkflowsReferencingAgent('agent-1');
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe(wf.id);
	});

	test('getWorkflowsReferencingAgent returns empty for unmatched agent', () => {
		repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			nodes: [coderNode],
		});
		expect(repo.getWorkflowsReferencingAgent('no-such-agent')).toHaveLength(0);
	});

	test('getWorkflowsReferencingAgent finds agent referenced via agents[] JSON config (multi-agent step)', () => {
		// Multi-agent steps store agent_id = NULL and put agent IDs in the JSON config column.
		// The LIKE-based query must catch these so deletion protection works for multi-agent steps.
		seedAgent(db, 'agent-multi-1', 'space-1', 'Multi1');
		seedAgent(db, 'agent-multi-2', 'space-1', 'Multi2');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Multi-Agent WF',
			nodes: [
				{
					id: 'step-multi',
					name: 'Parallel Step',
					agents: [{ agentId: 'agent-multi-1' }, { agentId: 'agent-multi-2' }],
				},
			],
		});
		// Both agents must be found via the config LIKE path (agent_id is NULL in DB)
		const refs1 = repo.getWorkflowsReferencingAgent('agent-multi-1');
		expect(refs1).toHaveLength(1);
		expect(refs1[0].id).toBe(wf.id);

		const refs2 = repo.getWorkflowsReferencingAgent('agent-multi-2');
		expect(refs2).toHaveLength(1);
		expect(refs2[0].id).toBe(wf.id);

		// An agent not in the step must not be returned
		expect(repo.getWorkflowsReferencingAgent('agent-coder')).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Multi-agent step persistence (agents[] and channels[] round-trips)
	// -------------------------------------------------------------------------

	test('round-trip: step with agents[] is persisted and restored correctly', () => {
		seedAgent(db, 'agent-multi-1', 'space-1', 'Multi1');
		seedAgent(db, 'agent-multi-2', 'space-1', 'Multi2');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Multi-Agent Round-Trip',
			nodes: [
				{
					id: 'step-1',
					name: 'Parallel Step',
					agents: [
						{ agentId: 'agent-multi-1', instructions: 'do A' },
						{ agentId: 'agent-multi-2' },
					],
					instructions: 'shared instructions',
				},
			],
		});

		const read = repo.getWorkflow(wf.id);
		expect(read).not.toBeNull();
		const node = read!.nodes[0];

		// agentId should be absent (multi-agent step stored with NULL agent_id)
		expect(node.agentId).toBeUndefined();

		// agents[] must be restored with all fields
		expect(node.agents).toHaveLength(2);
		expect(node.agents![0].agentId).toBe('agent-multi-1');
		expect(node.agents![0].instructions).toBe('do A');
		expect(node.agents![1].agentId).toBe('agent-multi-2');
		expect(node.agents![1].instructions).toBeUndefined();

		// shared instructions stored in the config as well
		expect(node.instructions).toBe('shared instructions');
	});

	test('round-trip: step with channels[] is persisted and restored correctly', () => {
		seedAgent(db, 'agent-multi-1', 'space-1', 'Multi1');
		seedAgent(db, 'agent-multi-2', 'space-1', 'Multi2');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Channel Round-Trip',
			nodes: [
				{
					id: 'step-1',
					name: 'Channels Step',
					agents: [{ agentId: 'agent-multi-1' }, { agentId: 'agent-multi-2' }],
					channels: [
						{ from: 'coder', to: 'reviewer', direction: 'one-way', label: 'feedback' },
						{ from: 'reviewer', to: ['coder', 'security'], direction: 'bidirectional' },
					],
				},
			],
		});

		const read = repo.getWorkflow(wf.id);
		expect(read).not.toBeNull();
		const node = read!.nodes[0];

		expect(node.channels).toHaveLength(2);
		expect(node.channels![0]).toMatchObject({
			from: 'coder',
			to: 'reviewer',
			direction: 'one-way',
			label: 'feedback',
		});
		expect(node.channels![1]).toMatchObject({
			from: 'reviewer',
			to: ['coder', 'security'],
			direction: 'bidirectional',
		});
	});

	test('round-trip: legacy single-agent step (agentId only) still works correctly', () => {
		// Regression guard: ensure the multi-agent changes do not break the existing path.
		seedAgent(db, 'agent-1', 'space-1', 'Alpha');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Legacy Round-Trip',
			nodes: [{ id: 'step-1', name: 'Step', agentId: 'agent-1' }],
		});

		const read = repo.getWorkflow(wf.id);
		expect(read).not.toBeNull();
		const node = read!.nodes[0];

		expect(node.agentId).toBe('agent-1');
		expect(node.agents).toBeUndefined();
		expect(node.channels).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// JSON round-trips
	// -------------------------------------------------------------------------

	test('JSON round-trip: condition with expression', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Condition WF',
			nodes: [coderNode, plannerNode],
			transitions: [
				{
					from: coderNode.id!,
					to: plannerNode.id!,
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
			nodes: [coderNode, plannerNode],
			transitions: [
				{
					from: coderNode.id!,
					to: plannerNode.id!,
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
			nodes: [coderNode, plannerNode],
			transitions: [{ from: coderNode.id!, to: plannerNode.id! }],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.transitions[0].condition).toBeUndefined();
	});

	test('JSON round-trip: rules with appliesTo', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			nodes: [coderNode],
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
			nodes: [{ id: 'step-99', name: 'Step', agentId: 'agent-99' }],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.nodes[0].agentId).toBe('agent-99');

		// Verify agent_id column is set
		const row = db
			.prepare('SELECT agent_id FROM space_workflow_nodes WHERE workflow_id = ?')
			.get(wf.id) as { agent_id: string };
		expect(row.agent_id).toBe('agent-99');
	});

	// -------------------------------------------------------------------------
	// Layout field
	// -------------------------------------------------------------------------

	test('createWorkflow stores layout and round-trips it', () => {
		const layout = {
			[coderNode.id!]: { x: 100, y: 200 },
			[plannerNode.id!]: { x: 300, y: 400 },
		};
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Layout WF',
			nodes: [coderNode, plannerNode],
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
			nodes: [coderNode],
		});
		expect(wf.layout).toBeUndefined();

		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.layout).toBeUndefined();
	});

	test('updateWorkflow sets layout on an existing workflow', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			nodes: [coderNode],
		});
		expect(wf.layout).toBeUndefined();

		const layout = { [coderNode.id!]: { x: 50, y: 75 } };
		const updated = repo.updateWorkflow(wf.id, { layout });
		expect(updated?.layout).toEqual(layout);

		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.layout).toEqual(layout);
	});

	test('updateWorkflow clears layout when null is passed', () => {
		const layout = { [coderNode.id!]: { x: 10, y: 20 } };
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			nodes: [coderNode],
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
			nodes: [coderNode],
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
			nodes: [coderNode],
		});
		expect(wf.maxIterations).toBeUndefined();
	});

	test('updateWorkflow sets maxIterations on an existing workflow', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF Iter',
			nodes: [coderNode],
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
			nodes: [coderNode],
			maxIterations: 5,
		});
		expect(wf.maxIterations).toBe(5);

		const updated = repo.updateWorkflow(wf.id, { maxIterations: null });
		expect(updated?.maxIterations).toBeUndefined();
	});

	test('layout column contains raw JSON in the DB', () => {
		const layout = { [coderNode.id!]: { x: 1, y: 2 } };
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF Raw',
			nodes: [coderNode],
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
		manager.createWorkflow({ spaceId: 'space-1', name: 'Dup', nodes: [coderNode] });
		expect(() =>
			manager.createWorkflow({ spaceId: 'space-1', name: 'Dup', nodes: [plannerNode] })
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow allows same name in different spaces', () => {
		seedSpace(db, 'space-2');
		manager.createWorkflow({ spaceId: 'space-1', name: 'Same', nodes: [coderNode] });
		// Use anonymous step (no fixed id) to avoid PK collision across spaces in the same DB
		const wf2 = manager.createWorkflow({
			spaceId: 'space-2',
			name: 'Same',
			nodes: [{ name: 'Code', agentId: 'agent-coder' }],
		});
		expect(wf2.name).toBe('Same');
	});

	test('updateWorkflow throws if new name conflicts with another workflow', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Existing', nodes: [coderNode] });
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF2', nodes: [plannerNode] });
		expect(() => manager.updateWorkflow(wf.id, { name: 'Existing' })).toThrow(
			WorkflowValidationError
		);
	});

	test('updateWorkflow allows keeping the same name', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		const updated = manager.updateWorkflow(wf.id, { name: 'WF' });
		expect(updated?.name).toBe('WF');
	});

	test('name is trimmed before storage — whitespace variants collide', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Foo', nodes: [coderNode] });
		expect(() =>
			manager.createWorkflow({ spaceId: 'space-1', name: '  Foo  ', nodes: [plannerNode] })
		).toThrow(WorkflowValidationError);
	});

	test('name is stored trimmed', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: '  Trimmed  ',
			nodes: [coderNode],
		});
		expect(wf.name).toBe('Trimmed');
	});

	// -------------------------------------------------------------------------
	// At-least-one-step
	// -------------------------------------------------------------------------

	test('createWorkflow throws when steps is empty', () => {
		expect(() => manager.createWorkflow({ spaceId: 'space-1', name: 'Empty', nodes: [] })).toThrow(
			WorkflowValidationError
		);
	});

	test('createWorkflow throws when steps is not provided (defaults to empty)', () => {
		expect(() => manager.createWorkflow({ spaceId: 'space-1', name: 'NoNodes' })).toThrow(
			WorkflowValidationError
		);
	});

	test('updateWorkflow throws when replacing with empty steps', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		expect(() => manager.updateWorkflow(wf.id, { nodes: [] })).toThrow(WorkflowValidationError);
	});

	test('updateWorkflow throws when steps is null (treated as empty replacement)', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		expect(() => manager.updateWorkflow(wf.id, { nodes: null as unknown as [] })).toThrow(
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
			nodes: [{ name: 'Step', agentId: 'some-uuid' }],
		});
		expect(wf.nodes[0].agentId).toBe('some-uuid');
	});

	test('createWorkflow rejects empty agentId', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad AgentId',
				nodes: [{ name: 'Step', agentId: '' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects whitespace-only agentId', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Whitespace AgentId',
				nodes: [{ name: 'Step', agentId: '   ' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow accepts agentId when agent exists in lookup', () => {
		seedAgent(db, 'agent-1', 'space-1', 'MyAgent');
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) =>
				id === 'agent-1' ? { id: 'agent-1', name: 'MyAgent', role: 'coder' } : null,
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		const wf = mgr.createWorkflow({
			spaceId: 'space-1',
			name: 'Custom WF',
			nodes: [{ name: 'Step', agentId: 'agent-1' }],
		});
		expect(wf.nodes[0].agentId).toBe('agent-1');
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
				nodes: [{ name: 'Step', agentId: 'non-existent-uuid' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow skips lookup when agentLookup is null', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'No-Lookup WF',
			nodes: [{ name: 'Step', agentId: 'anything' }],
		});
		expect(wf.nodes[0].agentId).toBe('anything');
	});

	test('updateWorkflow rejects invalid agentId via lookup', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		const lookup: SpaceAgentLookup = { getAgentById: () => null };
		const mgr = new SpaceWorkflowManager(repo, lookup);
		expect(() =>
			mgr.updateWorkflow(wf.id, {
				nodes: [{ id: 'step-x', name: 'Step', agentId: 'non-existent' }],
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
			nodes: [coderNode, plannerNode],
			transitions: [{ from: coderNode.id!, to: plannerNode.id!, condition: { type: 'always' } }],
		});
		expect(wf.transitions).toHaveLength(1);
	});

	test('createWorkflow rejects transition with empty from', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans',
				nodes: [coderNode, plannerNode],
				transitions: [{ from: '', to: plannerNode.id! }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transition with empty to', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans2',
				nodes: [coderNode, plannerNode],
				transitions: [{ from: coderNode.id!, to: '' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transition referencing non-existent from step', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans From',
				nodes: [coderNode, plannerNode],
				transitions: [{ from: 'no-such-step', to: plannerNode.id! }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transition referencing non-existent to step', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Trans To',
				nodes: [coderNode, plannerNode],
				transitions: [{ from: coderNode.id!, to: 'no-such-step' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects transitions when any step lacks an explicit id', () => {
		// Nodes without explicit IDs cannot be referenced in transitions at validation time.
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Anon Nodes Trans',
				// Neither step has an explicit id — backend would assign UUIDs at persist time
				nodes: [
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
				nodes: [coderNode, plannerNode],
				transitions: [{ from: coderNode.id!, to: plannerNode.id! }],
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
				nodes: [coderNode, plannerNode],
				transitions: [
					{
						from: coderNode.id!,
						to: plannerNode.id!,
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
			nodes: [coderNode, plannerNode],
			transitions: [
				{
					from: coderNode.id!,
					to: plannerNode.id!,
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
			nodes: [coderNode, plannerNode],
			transitions: [
				{
					from: coderNode.id!,
					to: plannerNode.id!,
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
			nodes: [coderNode, plannerNode],
			transitions: [
				{
					from: coderNode.id!,
					to: plannerNode.id!,
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
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		expect(manager.deleteWorkflow(wf.id)).toBe(true);
		expect(manager.getWorkflow(wf.id)).toBeNull();
	});

	test('deleteWorkflow returns false for non-existent workflow', () => {
		expect(manager.deleteWorkflow('no-such-id')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Nodes stored in insertion order
	// -------------------------------------------------------------------------

	test('steps are stored and retrieved in insertion order', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Ordered',
			nodes: [plannerNode, coderNode, generalNode],
		});
		expect(wf.nodes[0].name).toBe('Plan');
		expect(wf.nodes[1].name).toBe('Code');
		expect(wf.nodes[2].name).toBe('Review');
	});

	// -------------------------------------------------------------------------
	// getWorkflowsReferencingAgent
	// -------------------------------------------------------------------------

	test('getWorkflowsReferencingAgent returns workflows using given agent', () => {
		seedAgent(db, 'agent-1', 'space-1', 'Alpha');
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Uses Alpha',
			nodes: [{ id: 'step-1', name: 'Step', agentId: 'agent-1' }],
		});
		manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Uses Other',
			nodes: [coderNode],
		});
		const refs = manager.getWorkflowsReferencingAgent('agent-1');
		expect(refs).toHaveLength(1);
		expect(refs[0].id).toBe(wf.id);
	});

	// -------------------------------------------------------------------------
	// agents[] format validation (no agentLookup needed)
	// -------------------------------------------------------------------------

	test('createWorkflow rejects agents[] entry with empty agentId (no lookup)', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Agents Empty',
				nodes: [
					{
						name: 'Step',
						agents: [{ agentId: '' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects agents[] entry with whitespace-only agentId (no lookup)', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Agents Whitespace',
				nodes: [
					{
						name: 'Step',
						agents: [{ agentId: '   ' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow accepts agents[] with non-empty agentIds (no lookup)', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Valid Agents',
			nodes: [
				{
					name: 'Step',
					agents: [
						{ agentId: 'agent-a', role: 'a' },
						{ agentId: 'agent-b', role: 'b' },
					],
				},
			],
		});
		expect(wf.nodes[0].agents).toHaveLength(2);
	});

	test('updateWorkflow rejects agents[] entry with empty agentId (no lookup)', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		expect(() =>
			manager.updateWorkflow(wf.id, {
				nodes: [{ id: 'step-x', name: 'Step', agents: [{ agentId: '' }] }],
			})
		).toThrow(WorkflowValidationError);
	});

	// -------------------------------------------------------------------------
	// Channel validation — structural (no agentLookup needed)
	// -------------------------------------------------------------------------

	test('createWorkflow rejects channels with invalid direction', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Direction',
				nodes: [
					{
						name: 'Step',
						agents: [
							{ agentId: 'agent-a', role: 'a' },
							{ agentId: 'agent-b', role: 'b' },
						],
						channels: [{ from: 'coder', to: 'reviewer', direction: 'invalid' as never }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels with empty from', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Empty From',
				nodes: [
					{
						name: 'Step',
						agents: [
							{ agentId: 'agent-a', role: 'a' },
							{ agentId: 'agent-b', role: 'b' },
						],
						channels: [{ from: '', to: 'reviewer', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels with empty string to', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Empty To',
				nodes: [
					{
						name: 'Step',
						agents: [
							{ agentId: 'agent-a', role: 'a' },
							{ agentId: 'agent-b', role: 'b' },
						],
						channels: [{ from: 'coder', to: '', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels with empty array to', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Empty Array To',
				nodes: [
					{
						name: 'Step',
						agents: [
							{ agentId: 'agent-a', role: 'a' },
							{ agentId: 'agent-b', role: 'b' },
						],
						channels: [{ from: 'coder', to: [], direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels when no agents[] provided (agentId-only step)', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Channels No Agents',
				nodes: [
					{
						name: 'Step',
						agentId: 'agent-a',
						channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels when agents[] is explicitly empty', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Channels Empty Agents Array',
				nodes: [
					{
						id: 'step-x',
						name: 'Step',
						agentId: 'agent-a',
						agents: [],
						channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels with whitespace-only from', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Whitespace From',
				nodes: [
					{
						name: 'Step',
						agents: [
							{ agentId: 'agent-a', role: 'a' },
							{ agentId: 'agent-b', role: 'b' },
						],
						channels: [{ from: '   ', to: 'reviewer', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels with whitespace-only string to', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Whitespace To',
				nodes: [
					{
						name: 'Step',
						agents: [
							{ agentId: 'agent-a', role: 'a' },
							{ agentId: 'agent-b', role: 'b' },
						],
						channels: [{ from: 'coder', to: '   ', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channels with whitespace-only element in array to', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Whitespace Array To Element',
				nodes: [
					{
						name: 'Step',
						agents: [
							{ agentId: 'agent-a', role: 'a' },
							{ agentId: 'agent-b', role: 'b' },
						],
						channels: [{ from: 'coder', to: ['reviewer', '   '], direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow accepts valid channels with * wildcard (no lookup)', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Wildcard Channels',
			nodes: [
				{
					name: 'Step',
					agents: [
						{ agentId: 'agent-a', role: 'a' },
						{ agentId: 'agent-b', role: 'b' },
					],
					channels: [
						{ from: '*', to: 'reviewer', direction: 'one-way' },
						{ from: 'coder', to: '*', direction: 'bidirectional' },
						{ from: '*', to: '*', direction: 'one-way' },
					],
				},
			],
		});
		expect(wf.nodes[0].channels).toHaveLength(3);
	});

	test('createWorkflow accepts valid one-way channel with array to (no lookup)', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Array To Channels',
			nodes: [
				{
					name: 'Step',
					agents: [
						{ agentId: 'agent-a', role: 'a' },
						{ agentId: 'agent-b', role: 'b' },
					],
					channels: [{ from: 'hub', to: ['spoke-a', 'spoke-b'], direction: 'bidirectional' }],
				},
			],
		});
		expect(wf.nodes[0].channels).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// Channel role validation — requires agentLookup
	// -------------------------------------------------------------------------

	test('createWorkflow validates channel roles against agent roles (with lookup)', () => {
		seedAgent(db, 'agent-coder-id', 'space-1', 'CoderAgent');
		seedAgent(db, 'agent-reviewer-id', 'space-1', 'ReviewerAgent');
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'CoderAgent', role: 'coder' };
				if (id === 'agent-reviewer-id') return { id, name: 'ReviewerAgent', role: 'reviewer' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		const wf = mgr.createWorkflow({
			spaceId: 'space-1',
			name: 'Valid Role Channels',
			nodes: [
				{
					name: 'Step',
					agents: [
						{ agentId: 'agent-coder-id', role: 'coder' },
						{ agentId: 'agent-reviewer-id', role: 'reviewer' },
					],
					channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
				},
			],
		});
		expect(wf.nodes[0].channels).toHaveLength(1);
	});

	test('createWorkflow rejects channel from referencing unknown role (with lookup)', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'CoderAgent', role: 'coder' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		expect(() =>
			mgr.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Role From',
				nodes: [
					{
						name: 'Step',
						agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
						channels: [{ from: 'unknown-role', to: 'coder', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects channel to referencing unknown role (with lookup)', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'CoderAgent', role: 'coder' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		expect(() =>
			mgr.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Role To',
				nodes: [
					{
						name: 'Step',
						agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
						channels: [{ from: 'coder', to: 'unknown-role', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow accepts * wildcard in channel roles even with lookup', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'CoderAgent', role: 'coder' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		const wf = mgr.createWorkflow({
			spaceId: 'space-1',
			name: 'Wildcard With Lookup',
			nodes: [
				{
					name: 'Step',
					agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
					channels: [{ from: '*', to: 'coder', direction: 'one-way' }],
				},
			],
		});
		expect(wf.nodes[0].channels).toHaveLength(1);
	});

	test('updateWorkflow validates channel roles in step replacement (with lookup)', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', nodes: [coderNode] });
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'CoderAgent', role: 'coder' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		expect(() =>
			mgr.updateWorkflow(wf.id, {
				nodes: [
					{
						id: 'step-x',
						name: 'Step',
						agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
						channels: [{ from: 'coder', to: 'bad-role', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	// -------------------------------------------------------------------------
	// Multi-agent step CRUD round-trip via manager
	// -------------------------------------------------------------------------

	test('createWorkflow with multi-agent step and channels persists and reads back correctly', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Multi-Agent CRUD',
			nodes: [
				{
					id: 'step-1',
					name: 'Parallel Review',
					agents: [
						{ agentId: 'agent-coder', role: 'coder', instructions: 'write code' },
						{ agentId: 'agent-reviewer', role: 'reviewer' },
					],
					channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way', label: 'submit' }],
					instructions: 'shared context',
				},
			],
		});

		const read = manager.getWorkflow(wf.id)!;
		const node = read.nodes[0];
		expect(node.agentId).toBeUndefined();
		expect(node.agents).toHaveLength(2);
		expect(node.agents![0].agentId).toBe('agent-coder');
		expect(node.agents![0].instructions).toBe('write code');
		expect(node.agents![1].agentId).toBe('agent-reviewer');
		expect(node.channels).toHaveLength(1);
		expect(node.channels![0]).toMatchObject({
			from: 'coder',
			to: 'reviewer',
			direction: 'one-way',
			label: 'submit',
		});
		expect(node.instructions).toBe('shared context');
	});

	test('updateWorkflow replaces multi-agent step with channels correctly', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Update Multi-Agent',
			nodes: [coderNode],
		});

		const updated = manager.updateWorkflow(wf.id, {
			nodes: [
				{
					id: 'step-new',
					name: 'New Parallel Step',
					agents: [
						{ agentId: 'agent-a', role: 'a' },
						{ agentId: 'agent-b', role: 'b' },
					],
					channels: [{ from: 'security', to: ['coder', 'reviewer'], direction: 'bidirectional' }],
				},
			],
		})!;

		const node = updated.nodes[0];
		expect(node.agentId).toBeUndefined();
		expect(node.agents).toHaveLength(2);
		expect(node.channels).toHaveLength(1);
		expect(node.channels![0].direction).toBe('bidirectional');
		expect(node.channels![0].to).toEqual(['coder', 'reviewer']);
	});

	test('deleteWorkflow with multi-agent step cleans up correctly', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Delete Multi-Agent',
			nodes: [
				{
					id: 'step-1',
					name: 'Parallel Step',
					agents: [
						{ agentId: 'agent-a', role: 'a' },
						{ agentId: 'agent-b', role: 'b' },
					],
					channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
				},
			],
		});

		expect(manager.deleteWorkflow(wf.id)).toBe(true);
		expect(manager.getWorkflow(wf.id)).toBeNull();
	});

	test('legacy single-agent workflow continues to work alongside multi-agent workflows', () => {
		// Create a mix of single-agent and multi-agent workflows
		const single = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Single Agent',
			nodes: [coderNode],
		});
		const multi = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Multi Agent',
			nodes: [
				{
					id: 'step-m',
					name: 'Parallel',
					agents: [
						{ agentId: 'agent-x', role: 'x' },
						{ agentId: 'agent-y', role: 'y' },
					],
					channels: [{ from: 'x', to: 'y', direction: 'bidirectional' }],
				},
			],
		});

		const workflows = manager.listWorkflows('space-1');
		expect(workflows).toHaveLength(2);

		const readSingle = manager.getWorkflow(single.id)!;
		expect(readSingle.nodes[0].agentId).toBe('agent-coder');
		expect(readSingle.nodes[0].agents).toBeUndefined();
		expect(readSingle.nodes[0].channels).toBeUndefined();

		const readMulti = manager.getWorkflow(multi.id)!;
		expect(readMulti.nodes[0].agents).toHaveLength(2);
		expect(readMulti.nodes[0].channels).toHaveLength(1);
	});
});
