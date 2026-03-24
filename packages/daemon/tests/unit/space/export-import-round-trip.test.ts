/**
 * Export/Import Round-Trip Integration Tests
 *
 * Tests the full pipeline: exportWorkflow → validateExportBundle →
 * buildWorkflowCreateParams → SpaceWorkflowManager.createWorkflow → DB read-back.
 *
 * Verifies that per-slot override fields (role, model, systemPrompt) survive the
 * complete export → import cycle and are persisted correctly in the database.
 *
 * Also verifies backward compatibility: exports without per-slot override fields
 * (old format) import cleanly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import {
	exportWorkflow,
	exportBundle,
	validateExportBundle,
} from '../../../src/lib/space/export-format.ts';
import { buildWorkflowCreateParams } from '../../../src/lib/rpc-handlers/space-export-import-handlers.ts';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-export-import-round-trip',
		`t-${Date.now()}-${Math.random()}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId: string): void {
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTestAgent(id: string, name: string, overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name,
		role: 'coder',
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeWorkflowWithOverrides(): SpaceWorkflow {
	return {
		id: 'wf-overrides',
		spaceId: 'space-1',
		name: 'Overrides Workflow',
		nodes: [
			{
				id: 'node-1',
				name: 'Parallel Review',
				agents: [
					{
						agentId: 'agent-1',
						role: 'strict-reviewer',
						model: 'claude-opus-4-6',
						systemPrompt: 'Review with extreme care.',
					},
					{
						agentId: 'agent-2',
						role: 'quick-reviewer',
						model: 'claude-haiku-4-5',
						systemPrompt: 'Review quickly.',
					},
					{
						agentId: 'agent-1',
						role: 'coder',
						// no overrides — uses agent defaults
					},
				],
			},
		],
		transitions: [],
		startNodeId: 'node-1',
		rules: [],
		tags: ['review'],
		createdAt: 1000,
		updatedAt: 2000,
	};
}

function makeWorkflowWithoutOverrides(): SpaceWorkflow {
	return {
		id: 'wf-basic',
		spaceId: 'space-1',
		name: 'Basic Workflow',
		nodes: [
			{
				id: 'node-1',
				name: 'Code Step',
				agents: [
					{ agentId: 'agent-1', role: 'coder' },
					{ agentId: 'agent-2', role: 'reviewer' },
				],
			},
		],
		transitions: [],
		startNodeId: 'node-1',
		rules: [],
		tags: [],
		createdAt: 1000,
		updatedAt: 2000,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildWorkflowCreateParams — per-slot overrides', () => {
	const agent1 = makeTestAgent('agent-1', 'Coder Agent');
	const agent2 = makeTestAgent('agent-2', 'Reviewer Agent');
	const agents = [agent1, agent2];

	test('maps model override to WorkflowNodeInput agents', () => {
		const workflow = makeWorkflowWithOverrides();
		const exported = exportWorkflow(workflow, agents);
		const exportedWf = exported;

		const importedNameToId = new Map([
			['Coder Agent', 'new-agent-1'],
			['Reviewer Agent', 'new-agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params } = buildWorkflowCreateParams(
			'space-import',
			'Overrides Workflow',
			exportedWf,
			importedNameToId,
			existingNameToId
		);

		const nodeAgents = params.nodes[0].agents!;
		expect(nodeAgents).toHaveLength(3);

		// strict-reviewer slot has model override
		const strictReviewer = nodeAgents.find((a) => a.role === 'strict-reviewer');
		expect(strictReviewer).toBeDefined();
		expect(strictReviewer!.model).toBe('claude-opus-4-6');

		// quick-reviewer slot has model override
		const quickReviewer = nodeAgents.find((a) => a.role === 'quick-reviewer');
		expect(quickReviewer).toBeDefined();
		expect(quickReviewer!.model).toBe('claude-haiku-4-5');

		// coder slot has no model override
		const coder = nodeAgents.find((a) => a.role === 'coder');
		expect(coder).toBeDefined();
		expect(coder!.model).toBeUndefined();
	});

	test('maps systemPrompt override to WorkflowNodeInput agents', () => {
		const workflow = makeWorkflowWithOverrides();
		const exported = exportWorkflow(workflow, agents);

		const importedNameToId = new Map([
			['Coder Agent', 'new-agent-1'],
			['Reviewer Agent', 'new-agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params } = buildWorkflowCreateParams(
			'space-import',
			'Overrides Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);

		const nodeAgents = params.nodes[0].agents!;

		const strictReviewer = nodeAgents.find((a) => a.role === 'strict-reviewer');
		expect(strictReviewer!.systemPrompt).toBe('Review with extreme care.');

		const quickReviewer = nodeAgents.find((a) => a.role === 'quick-reviewer');
		expect(quickReviewer!.systemPrompt).toBe('Review quickly.');

		const coder = nodeAgents.find((a) => a.role === 'coder');
		expect(coder!.systemPrompt).toBeUndefined();
	});

	test('backward compat: imports agents without model/systemPrompt cleanly', () => {
		const workflow = makeWorkflowWithoutOverrides();
		const exported = exportWorkflow(workflow, agents);

		const importedNameToId = new Map([
			['Coder Agent', 'new-agent-1'],
			['Reviewer Agent', 'new-agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params, warnings } = buildWorkflowCreateParams(
			'space-import',
			'Basic Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);

		expect(warnings).toHaveLength(0);
		const nodeAgents = params.nodes[0].agents!;
		expect(nodeAgents).toHaveLength(2);

		// No overrides — model and systemPrompt must be absent
		for (const a of nodeAgents) {
			expect(a.model).toBeUndefined();
			expect(a.systemPrompt).toBeUndefined();
		}
	});

	test('preserves role field for each agent slot', () => {
		const workflow = makeWorkflowWithOverrides();
		const exported = exportWorkflow(workflow, agents);

		const importedNameToId = new Map([
			['Coder Agent', 'new-agent-1'],
			['Reviewer Agent', 'new-agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params } = buildWorkflowCreateParams(
			'space-import',
			'Overrides Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);

		const roles = params.nodes[0].agents!.map((a) => a.role);
		expect(roles).toContain('strict-reviewer');
		expect(roles).toContain('quick-reviewer');
		expect(roles).toContain('coder');
	});

	test('resolves agentRef names to new UUIDs on import', () => {
		const workflow = makeWorkflowWithOverrides();
		const exported = exportWorkflow(workflow, agents);

		const importedNameToId = new Map([
			['Coder Agent', 'imported-uuid-1'],
			['Reviewer Agent', 'imported-uuid-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params, warnings } = buildWorkflowCreateParams(
			'space-import',
			'Overrides Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);

		expect(warnings).toHaveLength(0);
		const nodeAgents = params.nodes[0].agents!;

		// Both agents resolve to their new UUIDs
		for (const a of nodeAgents) {
			expect(a.agentId).toBeTruthy();
			expect(a.agentId).not.toBe('');
			expect(['imported-uuid-1', 'imported-uuid-2']).toContain(a.agentId);
		}
	});

	test('maps instructions override to WorkflowNodeInput agents', () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-instr',
			spaceId: 'space-1',
			name: 'Instructions Workflow',
			nodes: [
				{
					id: 'node-1',
					name: 'Step',
					agents: [
						{
							agentId: 'agent-1',
							role: 'coder',
							instructions: 'Focus on auth module only.',
						},
						{
							agentId: 'agent-2',
							role: 'reviewer',
							// no instructions
						},
					],
				},
			],
			transitions: [],
			startNodeId: 'node-1',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};
		const exported = exportWorkflow(workflow, agents);

		const importedNameToId = new Map([
			['Coder Agent', 'new-agent-1'],
			['Reviewer Agent', 'new-agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params, warnings } = buildWorkflowCreateParams(
			'space-import',
			'Instructions Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);

		expect(warnings).toHaveLength(0);
		const nodeAgents = params.nodes[0].agents!;

		const coder = nodeAgents.find((a) => a.role === 'coder');
		expect(coder!.instructions).toBe('Focus on auth module only.');

		const reviewer = nodeAgents.find((a) => a.role === 'reviewer');
		expect(reviewer!.instructions).toBeUndefined();
	});

	test('warns when agentRef cannot be resolved', () => {
		const workflow = makeWorkflowWithoutOverrides();
		const exported = exportWorkflow(workflow, agents);

		// Only provide one agent — the other will be unresolvable
		const importedNameToId = new Map([['Coder Agent', 'uuid-1']]);
		const existingNameToId = new Map<string, string>();

		const { warnings } = buildWorkflowCreateParams(
			'space-import',
			'Basic Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);

		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain('Reviewer Agent');
	});
});

// ---------------------------------------------------------------------------
// Full round-trip: export → validate → import → DB read-back
// ---------------------------------------------------------------------------

describe('full round-trip: export → import → DB read-back', () => {
	let db: BunDatabase;
	let dir: string;
	let repo: SpaceWorkflowRepository;
	let manager: SpaceWorkflowManager;

	const SPACE_ID = 'space-rt';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID);
		seedAgent(db, 'agent-1', SPACE_ID, 'Coder Agent');
		seedAgent(db, 'agent-2', SPACE_ID, 'Reviewer Agent');
		repo = new SpaceWorkflowRepository(db);
		manager = new SpaceWorkflowManager(repo);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test('per-slot model and systemPrompt persist after import', () => {
		const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
		const agent2 = makeTestAgent('agent-2', 'Reviewer Agent', { spaceId: SPACE_ID });
		const agents = [agent1, agent2];

		const originalWorkflow = makeWorkflowWithOverrides();
		originalWorkflow.spaceId = SPACE_ID;

		// Export
		const exported = exportWorkflow(originalWorkflow, agents);
		const bundle = exportBundle(agents, [originalWorkflow], 'Test Bundle');

		// Validate (simulates the import pipeline's validation step)
		const validation = validateExportBundle(bundle);
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		// Build import params with the exported workflow
		const importedNameToId = new Map([
			['Coder Agent', 'agent-1'],
			['Reviewer Agent', 'agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params, warnings } = buildWorkflowCreateParams(
			SPACE_ID,
			'Overrides Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);
		expect(warnings).toHaveLength(0);

		// Create workflow via manager (same path as spaceImport.execute)
		const created = manager.createWorkflow(params);

		// Read back from DB and verify per-slot overrides are persisted
		const readBack = repo.getWorkflow(created.id);
		expect(readBack).not.toBeNull();
		const nodeAgents = readBack!.nodes[0].agents!;
		expect(nodeAgents).toHaveLength(3);

		const strictReviewer = nodeAgents.find((a) => a.role === 'strict-reviewer');
		expect(strictReviewer).toBeDefined();
		expect(strictReviewer!.model).toBe('claude-opus-4-6');
		expect(strictReviewer!.systemPrompt).toBe('Review with extreme care.');

		const quickReviewer = nodeAgents.find((a) => a.role === 'quick-reviewer');
		expect(quickReviewer).toBeDefined();
		expect(quickReviewer!.model).toBe('claude-haiku-4-5');
		expect(quickReviewer!.systemPrompt).toBe('Review quickly.');

		const coder = nodeAgents.find((a) => a.role === 'coder');
		expect(coder).toBeDefined();
		expect(coder!.model).toBeUndefined();
		expect(coder!.systemPrompt).toBeUndefined();
	});

	test('backward compat: old export without overrides imports and persists cleanly', () => {
		const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
		const agent2 = makeTestAgent('agent-2', 'Reviewer Agent', { spaceId: SPACE_ID });
		const agents = [agent1, agent2];

		const originalWorkflow = makeWorkflowWithoutOverrides();
		originalWorkflow.spaceId = SPACE_ID;

		// Simulate an old export: export normally (no overrides in source)
		const exported = exportWorkflow(originalWorkflow, agents);

		// Verify exported format has no model/systemPrompt
		const entry0 = exported.nodes[0].agents![0] as Record<string, unknown>;
		expect('model' in entry0).toBe(false);
		expect('systemPrompt' in entry0).toBe(false);

		// Build import params
		const importedNameToId = new Map([
			['Coder Agent', 'agent-1'],
			['Reviewer Agent', 'agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params, warnings } = buildWorkflowCreateParams(
			SPACE_ID,
			'Basic Workflow',
			exported,
			importedNameToId,
			existingNameToId
		);
		expect(warnings).toHaveLength(0);

		// Import and read back — should succeed without errors
		const created = manager.createWorkflow(params);
		const readBack = repo.getWorkflow(created.id);
		expect(readBack).not.toBeNull();

		const nodeAgents = readBack!.nodes[0].agents!;
		expect(nodeAgents).toHaveLength(2);

		// No overrides stored — model and systemPrompt should be absent/undefined
		for (const a of nodeAgents) {
			expect(a.model).toBeUndefined();
			expect(a.systemPrompt).toBeUndefined();
		}
	});

	test('same agent added multiple times with different roles and overrides', () => {
		const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
		const agents = [agent1];

		// Same agent twice in one node, different per-slot configs
		const workflow: SpaceWorkflow = {
			id: 'wf-same-agent',
			spaceId: SPACE_ID,
			name: 'Same Agent Twice',
			nodes: [
				{
					id: 'node-1',
					name: 'Multi Slot',
					agents: [
						{
							agentId: 'agent-1',
							role: 'strict-coder',
							model: 'claude-opus-4-6',
							systemPrompt: 'Write perfect code.',
						},
						{
							agentId: 'agent-1',
							role: 'fast-coder',
							model: 'claude-haiku-4-5',
							systemPrompt: 'Write quick code.',
						},
					],
				},
			],
			transitions: [],
			startNodeId: 'node-1',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const exported = exportWorkflow(workflow, agents);

		// Verify both slots exported with distinct overrides
		const exportedAgents = exported.nodes[0].agents!;
		expect(exportedAgents).toHaveLength(2);
		expect(exportedAgents[0].agentRef).toBe('Coder Agent');
		expect(exportedAgents[0].role).toBe('strict-coder');
		expect(exportedAgents[0].model).toBe('claude-opus-4-6');
		expect(exportedAgents[1].agentRef).toBe('Coder Agent');
		expect(exportedAgents[1].role).toBe('fast-coder');
		expect(exportedAgents[1].model).toBe('claude-haiku-4-5');

		// Build import params and persist
		const importedNameToId = new Map([['Coder Agent', 'agent-1']]);
		const existingNameToId = new Map<string, string>();

		const { params, warnings } = buildWorkflowCreateParams(
			SPACE_ID,
			'Same Agent Twice',
			exported,
			importedNameToId,
			existingNameToId
		);
		expect(warnings).toHaveLength(0);

		const created = manager.createWorkflow(params);
		const readBack = repo.getWorkflow(created.id);
		expect(readBack).not.toBeNull();

		const nodeAgents = readBack!.nodes[0].agents!;
		expect(nodeAgents).toHaveLength(2);

		const strictCoder = nodeAgents.find((a) => a.role === 'strict-coder');
		expect(strictCoder!.agentId).toBe('agent-1');
		expect(strictCoder!.model).toBe('claude-opus-4-6');
		expect(strictCoder!.systemPrompt).toBe('Write perfect code.');

		const fastCoder = nodeAgents.find((a) => a.role === 'fast-coder');
		expect(fastCoder!.agentId).toBe('agent-1');
		expect(fastCoder!.model).toBe('claude-haiku-4-5');
		expect(fastCoder!.systemPrompt).toBe('Write quick code.');
	});

	test('instructions per-slot override persists after import (DB round-trip)', () => {
		const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
		const agent2 = makeTestAgent('agent-2', 'Reviewer Agent', { spaceId: SPACE_ID });
		const agents = [agent1, agent2];

		const workflow: SpaceWorkflow = {
			id: 'wf-instr',
			spaceId: SPACE_ID,
			name: 'Instructions Round Trip',
			nodes: [
				{
					id: 'node-1',
					name: 'Step',
					agents: [
						{
							agentId: 'agent-1',
							role: 'coder',
							instructions: 'Focus on auth module only.',
						},
						{
							agentId: 'agent-2',
							role: 'reviewer',
							// no instructions
						},
					],
				},
			],
			transitions: [],
			startNodeId: 'node-1',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const exported = exportWorkflow(workflow, agents);

		const importedNameToId = new Map([
			['Coder Agent', 'agent-1'],
			['Reviewer Agent', 'agent-2'],
		]);
		const existingNameToId = new Map<string, string>();

		const { params, warnings } = buildWorkflowCreateParams(
			SPACE_ID,
			'Instructions Round Trip',
			exported,
			importedNameToId,
			existingNameToId
		);
		expect(warnings).toHaveLength(0);

		const created = manager.createWorkflow(params);
		const readBack = repo.getWorkflow(created.id);
		expect(readBack).not.toBeNull();

		const nodeAgents = readBack!.nodes[0].agents!;
		const coder = nodeAgents.find((a) => a.role === 'coder');
		expect(coder!.instructions).toBe('Focus on auth module only.');

		const reviewer = nodeAgents.find((a) => a.role === 'reviewer');
		expect(reviewer!.instructions).toBeUndefined();
	});
});
