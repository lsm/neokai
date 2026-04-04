/**
 * Built-in Workflow Templates Unit Tests
 *
 * Covers:
 * - Template structure: correct agentId placeholders, transition conditions, step count
 * - agentId placeholders are valid builtin role names (no 'leader')
 * - getBuiltInWorkflows() returns all four templates
 * - seedBuiltInWorkflows(): seeds all four templates with real agent IDs
 * - seedBuiltInWorkflows(): node IDs replaced with real UUIDs (not template placeholders)
 * - seedBuiltInWorkflows(): agent ID resolution from role names to UUIDs (case-insensitive)
 * - seedBuiltInWorkflows(): descriptions, tags, instructions, gates, timestamps preserved
 * - seedBuiltInWorkflows(): 2-layer prompt override modes (expand vs override) correctly seeded
 * - seedBuiltInWorkflows(): idempotent — no re-seed if workflows already exist
 * - seedBuiltInWorkflows(): per-workflow error isolation
 * - Export/import round-trip: isCyclic and task_result conditions are preserved
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import {
	CODING_WORKFLOW,
	FULL_CYCLE_CODING_WORKFLOW,
	RESEARCH_WORKFLOW,
	REVIEW_ONLY_WORKFLOW,
	getBuiltInWorkflows,
	seedBuiltInWorkflows,
} from '../../../src/lib/space/workflows/built-in-workflows.ts';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import { exportWorkflow, validateExportedWorkflow } from '../../../src/lib/space/export-format.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-built-in-workflows',
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
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `/tmp/ws-${spaceId}`, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now());
}

/** Valid builtin roles — 'leader' must NOT appear in any template step. */
const VALID_BUILTIN_ROLES = new Set<string>([
	'planner',
	'coder',
	'general',
	'research',
	'reviewer',
	'qa',
]);

/**
 * Returns true if any step in the workflow has 'leader' as its agentId or name placeholder.
 */
function hasLeaderAgentId(wf: SpaceWorkflow): boolean {
	return wf.nodes.some((s) =>
		(s.agents ?? []).some(
			(agent) => agent.agentId === 'leader' || agent.name?.toLowerCase() === 'leader'
		)
	);
}

// ---------------------------------------------------------------------------
// Template structure tests
// ---------------------------------------------------------------------------

describe('CODING_WORKFLOW template', () => {
	test('has two nodes: Code, Review', () => {
		expect(CODING_WORKFLOW.nodes).toHaveLength(2);
		expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual(['Code', 'Review']);
	});

	test('step agentId placeholders are correct', () => {
		expect(CODING_WORKFLOW.nodes[0].agents[0]?.name).toBe('coder');
		expect(CODING_WORKFLOW.nodes[1].agents[0]?.name).toBe('reviewer');
	});

	test('has two channels', () => {
		expect(CODING_WORKFLOW.channels).toHaveLength(2);
	});

	test('Code → Review channel is gated by code-ready-gate', () => {
		const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Code' && c.to === 'Review');
		expect(ch).toBeDefined();
		expect(ch!.gateId).toBe('code-ready-gate');
		expect(ch!.direction).toBe('one-way');
		expect(ch!.maxCycles).toBeUndefined();
	});

	test('Review → Code channel is ungated with maxCycles', () => {
		const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Review' && c.to === 'Code');
		expect(ch).toBeDefined();
		expect(ch!.gateId).toBeUndefined();
		expect(ch!.direction).toBe('one-way');
		expect(ch!.maxCycles).toBe(5);
	});

	test('all channels have direction one-way', () => {
		for (const ch of CODING_WORKFLOW.channels!) {
			expect(ch.direction).toBe('one-way');
		}
	});

	test('all channel from/to fields reference valid node names', () => {
		const nodeNames = new Set(CODING_WORKFLOW.nodes.map((n) => n.name));
		for (const ch of CODING_WORKFLOW.channels!) {
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('has one gate with one field', () => {
		expect(CODING_WORKFLOW.gates).toHaveLength(1);
		const gate = CODING_WORKFLOW.gates![0];
		expect(gate.id).toBe('code-ready-gate');
		expect(gate.fields).toHaveLength(1);
	});

	test('code-ready-gate has pr_url exists field with wildcard writer', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
		const prField = gate.fields.find((f) => f.name === 'pr_url')!;
		expect(prField.type).toBe('string');
		expect(prField.writers).toEqual(['*']);
		expect(prField.check.op).toBe('exists');
	});

	test('code-ready-gate has a bash script that checks PR mergeability and outputs pr_url', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
		expect(gate.script).toBeDefined();
		expect(gate.script!.interpreter).toBe('bash');
		expect(gate.script!.timeoutMs).toBe(30000);
		expect(gate.script!.source).toContain('gh pr view --json url,state,mergeable,mergeStateStatus');
		expect(gate.script!.source).toContain('jq -r');
		expect(gate.script!.source).toContain('.url');
		expect(gate.script!.source).toContain('"OPEN"');
		expect(gate.script!.source).toContain('.mergeable');
		expect(gate.script!.source).toContain('"MERGEABLE"');
		expect(gate.script!.source).toContain('.mergeStateStatus');
		expect(gate.script!.source).toContain('"CLEAN"');
		expect(gate.script!.source).toContain('"HAS_HOOKS"');
		expect(gate.script!.source).toContain('exit 1');
		expect(gate.script!.source).toContain('pr_url');
		expect(gate.script!.source).toContain('not authenticated');
	});

	test('code-ready-gate resets on cycle', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
		expect(gate.resetOnCycle).toBe(true);
	});

	test('startNodeId points to the Code step', () => {
		const codeStep = CODING_WORKFLOW.nodes.find((s) => s.agents[0]?.name === 'coder');
		expect(CODING_WORKFLOW.startNodeId).toBe(codeStep?.id);
	});

	test('endNodeId points to the Review step', () => {
		const reviewStep = CODING_WORKFLOW.nodes.find((s) => s.name === 'Review');
		expect(CODING_WORKFLOW.endNodeId).toBe(reviewStep?.id);
	});

	test('endNodeId references a valid node in the graph', () => {
		const nodeIds = new Set(CODING_WORKFLOW.nodes.map((n) => n.id));
		expect(nodeIds.has(CODING_WORKFLOW.endNodeId!)).toBe(true);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(CODING_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(CODING_WORKFLOW.id).toBe('');
		expect(CODING_WORKFLOW.spaceId).toBe('');
	});
});

test('CODING_WORKFLOW nodes define systemPrompt with mode expand', () => {
	for (const node of CODING_WORKFLOW.nodes) {
		for (const agent of node.agents) {
			expect(agent.systemPrompt).toBeDefined();
			expect(agent.systemPrompt?.mode).toBe('expand');
			expect(agent.systemPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
		}
	}
});

describe('RESEARCH_WORKFLOW template', () => {
	test('has two nodes (Research + Review)', () => {
		expect(RESEARCH_WORKFLOW.nodes).toHaveLength(2);
	});

	test('first node uses Research agent', () => {
		expect(RESEARCH_WORKFLOW.nodes[0].agents[0]?.name).toBe('research');
		expect(RESEARCH_WORKFLOW.nodes[0].name).toBe('Research');
	});

	test('second node uses Reviewer agent', () => {
		expect(RESEARCH_WORKFLOW.nodes[1].agents[0]?.name).toBe('reviewer');
		expect(RESEARCH_WORKFLOW.nodes[1].name).toBe('Review');
	});

	test('has two channels: gated Research→Review and ungated Review→Research', () => {
		expect(RESEARCH_WORKFLOW.channels).toHaveLength(2);
		const gated = RESEARCH_WORKFLOW.channels!.find((c) => c.gateId === 'research-ready-gate');
		expect(gated).toBeDefined();
		expect(gated!.from).toBe('Research');
		expect(gated!.to).toBe('Review');
		expect(gated!.direction).toBe('one-way');

		const backChannel = RESEARCH_WORKFLOW.channels!.find((c) => c.gateId === undefined);
		expect(backChannel).toBeDefined();
		expect(backChannel!.from).toBe('Review');
		expect(backChannel!.to).toBe('Research');
		expect(backChannel!.maxCycles).toBe(5);
	});

	test('channel from/to references match node names', () => {
		const nodeNames = new Set(RESEARCH_WORKFLOW.nodes.map((n) => n.name));
		for (const ch of RESEARCH_WORKFLOW.channels!) {
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('each channel has a label', () => {
		for (const ch of RESEARCH_WORKFLOW.channels!) {
			expect(ch.label).toBeTruthy();
		}
	});

	test('startNodeId points to the Research node', () => {
		const researchNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Research');
		expect(RESEARCH_WORKFLOW.startNodeId).toBe(researchNode?.id);
	});

	test('endNodeId points to the Review node', () => {
		const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review');
		expect(RESEARCH_WORKFLOW.endNodeId).toBe(reviewNode?.id);
	});

	test('endNodeId references a valid node in the graph', () => {
		const nodeIds = new Set(RESEARCH_WORKFLOW.nodes.map((n) => n.id));
		expect(nodeIds.has(RESEARCH_WORKFLOW.endNodeId!)).toBe(true);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(RESEARCH_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(RESEARCH_WORKFLOW.id).toBe('');
		expect(RESEARCH_WORKFLOW.spaceId).toBe('');
	});

	test('research-ready-gate has a bash script that checks PR mergeability and outputs pr_url', () => {
		const gate = RESEARCH_WORKFLOW.gates!.find((g) => g.id === 'research-ready-gate')!;
		expect(gate.script).toBeDefined();
		expect(gate.script!.interpreter).toBe('bash');
		expect(gate.script!.timeoutMs).toBe(30000);
		expect(gate.script!.source).toContain('gh pr view --json url,state,mergeable,mergeStateStatus');
		expect(gate.script!.source).toContain('jq -r');
		expect(gate.script!.source).toContain('.url');
		expect(gate.script!.source).toContain('"OPEN"');
		expect(gate.script!.source).toContain('.mergeable');
		expect(gate.script!.source).toContain('"MERGEABLE"');
		expect(gate.script!.source).toContain('.mergeStateStatus');
		expect(gate.script!.source).toContain('"CLEAN"');
		expect(gate.script!.source).toContain('"HAS_HOOKS"');
		expect(gate.script!.source).toContain('exit 1');
		expect(gate.script!.source).toContain('pr_url');
		expect(gate.script!.source).toContain('not authenticated');
	});

	test('research-ready-gate resets on cycle', () => {
		const gate = RESEARCH_WORKFLOW.gates!.find((g) => g.id === 'research-ready-gate')!;
		expect(gate.resetOnCycle).toBe(true);
	});

	test('nodes have instructions', () => {
		for (const node of RESEARCH_WORKFLOW.nodes) {
			expect(node.instructions).toBeTruthy();
		}
	});

	test('RESEARCH_WORKFLOW nodes define systemPrompt with mode expand', () => {
		for (const node of RESEARCH_WORKFLOW.nodes) {
			for (const agent of node.agents) {
				expect(agent.systemPrompt).toBeDefined();
				expect(agent.systemPrompt?.mode).toBe('expand');
				expect(agent.systemPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
			}
		}
	});
});

describe('REVIEW_ONLY_WORKFLOW template', () => {
	test('has one step', () => {
		expect(REVIEW_ONLY_WORKFLOW.nodes).toHaveLength(1);
	});

	test('step agentId placeholder is reviewer', () => {
		expect(REVIEW_ONLY_WORKFLOW.nodes[0].agents[0]?.name).toBe('reviewer');
	});

	test('has no channels (single-node workflow needs no inter-agent channels)', () => {
		expect(REVIEW_ONLY_WORKFLOW.channels ?? []).toHaveLength(0);
	});

	test('startNodeId points to the Review step', () => {
		expect(REVIEW_ONLY_WORKFLOW.startNodeId).toBe(REVIEW_ONLY_WORKFLOW.nodes[0].id);
	});

	test('endNodeId points to the Review step (same as startNodeId)', () => {
		expect(REVIEW_ONLY_WORKFLOW.endNodeId).toBe(REVIEW_ONLY_WORKFLOW.nodes[0].id);
	});

	test('startNodeId equals endNodeId (single-node workflow)', () => {
		expect(REVIEW_ONLY_WORKFLOW.startNodeId).toBe(REVIEW_ONLY_WORKFLOW.endNodeId);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(REVIEW_ONLY_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(REVIEW_ONLY_WORKFLOW.id).toBe('');
		expect(REVIEW_ONLY_WORKFLOW.spaceId).toBe('');
	});

	test('REVIEW_ONLY_WORKFLOW node defines systemPrompt with mode expand', () => {
		const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
		expect(agent.systemPrompt).toBeDefined();
		expect(agent.systemPrompt?.mode).toBe('expand');
		expect(agent.systemPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
	});
});

describe('FULL_CYCLE_CODING_WORKFLOW template', () => {
	test('has six nodes', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.nodes).toHaveLength(6);
	});

	test('node names are correct', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.nodes.map((n) => n.name)).toEqual([
			'Planning',
			'Plan Review',
			'Coding',
			'Code Review',
			'QA',
			'Done',
		]);
	});

	test('node agent placeholders are correct', () => {
		const nodes = FULL_CYCLE_CODING_WORKFLOW.nodes;
		// agents[0].name is the role string (lowercase); agentId is the capitalized placeholder
		expect(nodes[0].agents[0]?.name).toBe('planner'); // Planning
		expect(nodes[1].agents[0]?.name).toBe('reviewer'); // Plan Review
		expect(nodes[2].agents[0]?.name).toBe('coder'); // Coding
		// Code Review uses three agents[]
		expect(nodes[3].agents).toHaveLength(3);
		expect(nodes[3].agents?.map((a) => a.agentId)).toEqual(['Reviewer', 'Reviewer', 'Reviewer']);
		expect(nodes[3].agents?.map((a) => a.name)).toEqual(['Reviewer 1', 'Reviewer 2', 'Reviewer 3']);
		expect(nodes[4].agents[0]?.name).toBe('qa'); // QA
		expect(nodes[5].agents[0]?.name).toBe('general'); // Done
	});

	test('all V2 nodes define explicit system prompts', () => {
		// systemPrompt is on each WorkflowNodeAgent, not on WorkflowNode
		for (const node of FULL_CYCLE_CODING_WORKFLOW.nodes) {
			for (const agent of node.agents) {
				expect((agent.systemPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('startNodeId points to the Planning (planner) node', () => {
		const planningNode = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Planning');
		expect(FULL_CYCLE_CODING_WORKFLOW.startNodeId).toBe(planningNode?.id);
	});

	test('endNodeId points to the Done node', () => {
		const doneNode = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Done');
		expect(FULL_CYCLE_CODING_WORKFLOW.endNodeId).toBe(doneNode?.id);
	});

	test('endNodeId references a valid node in the graph', () => {
		const nodeIds = new Set(FULL_CYCLE_CODING_WORKFLOW.nodes.map((n) => n.id));
		expect(nodeIds.has(FULL_CYCLE_CODING_WORKFLOW.endNodeId!)).toBe(true);
	});

	test('has seven gates', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.gates).toHaveLength(7);
	});

	test('gate IDs are correct', () => {
		const ids = FULL_CYCLE_CODING_WORKFLOW.gates!.map((g) => g.id);
		expect(ids).toContain('plan-pr-gate');
		expect(ids).toContain('plan-approval-gate');
		expect(ids).toContain('code-pr-gate');
		expect(ids).toContain('review-votes-gate');
		expect(ids).toContain('review-reject-gate');
		expect(ids).toContain('qa-result-gate');
		expect(ids).toContain('qa-fail-gate');
	});

	test('plan-pr-gate has boolean exists field with planner writer', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'plan-pr-gate')!;
		expect(gate.fields).toHaveLength(1);
		expect(gate.fields[0].name).toBe('plan_submitted');
		expect(gate.fields[0].check.op).toBe('exists');
		expect(gate.fields[0].writers).toContain('planner');
		expect(gate.resetOnCycle).toBe(false);
	});

	test('plan-approval-gate has boolean == true field with reviewer writer', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
		expect(gate.fields[0].name).toBe('approved');
		expect(gate.fields[0].check).toMatchObject({ op: '==', value: true });
		expect(gate.fields[0].writers).toContain('reviewer');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('code-pr-gate has string exists field with coder writer', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'code-pr-gate')!;
		expect(gate.fields[0].name).toBe('pr_url');
		expect(gate.fields[0].type).toBe('string');
		expect(gate.fields[0].check.op).toBe('exists');
		expect(gate.fields[0].writers).toContain('coder');
		// Preserved across fix cycles -- coder updates the existing PR rather than opening a new one
		expect(gate.resetOnCycle).toBe(false);
	});

	test('review-votes-gate has map count field requiring min 3 approved', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'review-votes-gate')!;
		expect(gate.fields[0].type).toBe('map');
		expect(gate.fields[0].check).toMatchObject({ op: 'count', match: 'approved', min: 3 });
		expect(gate.fields[0].writers).toContain('reviewer');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('review-reject-gate has map count field requiring min 1 rejected', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'review-reject-gate')!;
		expect(gate.fields[0].type).toBe('map');
		expect(gate.fields[0].check).toMatchObject({ op: 'count', match: 'rejected', min: 1 });
		expect(gate.fields[0].writers).toContain('reviewer');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('qa-result-gate has string == passed field with qa writer', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'qa-result-gate')!;
		expect(gate.fields[0].name).toBe('result');
		expect(gate.fields[0].check).toMatchObject({ op: '==', value: 'passed' });
		expect(gate.fields[0].writers).toContain('qa');
		// Resets on QA->Coding cycle so QA starts clean each time
		expect(gate.resetOnCycle).toBe(true);
	});

	test('qa-fail-gate has string == failed field with qa writer', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'qa-fail-gate')!;
		expect(gate.fields[0].name).toBe('result');
		expect(gate.fields[0].check).toMatchObject({ op: '==', value: 'failed' });
		expect(gate.fields[0].writers).toContain('qa');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('has 9 node-level channels', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.channels).toHaveLength(9);
	});

	test('main progression channels have correct gateIds', () => {
		const ch = FULL_CYCLE_CODING_WORKFLOW.channels!;

		const planToReview = ch.find((c) => c.from === 'Planning' && c.to === 'Plan Review');
		expect(planToReview?.gateId).toBe('plan-pr-gate');

		const reviewToCoding = ch.find((c) => c.from === 'Plan Review' && c.to === 'Coding');
		expect(reviewToCoding?.gateId).toBe('plan-approval-gate');

		const codingToReview = ch.find((c) => c.from === 'Coding' && c.to === 'Code Review');
		expect(codingToReview?.gateId).toBe('code-pr-gate');
	});

	test('Code Review-to-QA uses review-votes-gate', () => {
		const ch = FULL_CYCLE_CODING_WORKFLOW.channels!;
		const reviewToQA = ch.find((c) => c.from === 'Code Review' && c.to === 'QA');
		expect(reviewToQA?.gateId).toBe('review-votes-gate');
	});

	test('QA-to-Done uses qa-result-gate', () => {
		const ch = FULL_CYCLE_CODING_WORKFLOW.channels!.find((c) => c.from === 'QA' && c.to === 'Done');
		expect(ch?.gateId).toBe('qa-result-gate');
		expect(ch?.maxCycles).toBeUndefined();
	});

	test('cyclic channels have maxCycles set', () => {
		const ch = FULL_CYCLE_CODING_WORKFLOW.channels!;

		const qaToCoding = ch.find((c) => c.from === 'QA' && c.to === 'Coding');
		expect(qaToCoding?.gateId).toBe('qa-fail-gate');
		expect(qaToCoding?.maxCycles).toBe(5);

		const reviewToCoding = ch.find((c) => c.from === 'Code Review' && c.to === 'Coding');
		expect(reviewToCoding?.gateId).toBe('review-reject-gate');
		expect(reviewToCoding?.maxCycles).toBe(5);

		const reviewToPlanning = ch.find((c) => c.from === 'Plan Review' && c.to === 'Planning');
		expect(reviewToPlanning?.gateId).toBeUndefined();
		expect(reviewToPlanning?.maxCycles).toBe(5);

		const codingToPlanning = ch.find((c) => c.from === 'Coding' && c.to === 'Planning');
		expect(codingToPlanning?.gateId).toBeUndefined();
		expect(codingToPlanning?.maxCycles).toBe(5);
	});

	test('ungated feedback channels have no gateId', () => {
		const ch = FULL_CYCLE_CODING_WORKFLOW.channels!;
		const reviewToPlanning = ch.find((c) => c.from === 'Plan Review' && c.to === 'Planning');
		expect(reviewToPlanning).toBeDefined();
		expect(reviewToPlanning?.gateId).toBeUndefined();

		const codingToPlanning = ch.find((c) => c.from === 'Coding' && c.to === 'Planning');
		expect(codingToPlanning).toBeDefined();
		expect(codingToPlanning?.gateId).toBeUndefined();
	});

	test('all channels have direction one-way', () => {
		for (const ch of FULL_CYCLE_CODING_WORKFLOW.channels!) {
			expect(ch.direction).toBe('one-way');
		}
	});

	test('all channel from/to fields reference valid node names or agent slot names', () => {
		const refs = new Set<string>();
		for (const node of FULL_CYCLE_CODING_WORKFLOW.nodes) {
			refs.add(node.name);
			for (const agent of node.agents ?? []) refs.add(agent.name);
		}
		for (const ch of FULL_CYCLE_CODING_WORKFLOW.channels!) {
			expect(refs.has(ch.from as string)).toBe(true);
			if (Array.isArray(ch.to)) {
				for (const target of ch.to) {
					expect(refs.has(target)).toBe(true);
				}
			} else {
				expect(refs.has(ch.to as string)).toBe(true);
			}
		}
	});

	test('code review node contains three reviewer slots with read-merge-write instructions', () => {
		const reviewNode = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Code Review')!;
		expect(reviewNode.agents).toHaveLength(3);
		for (const slot of reviewNode.agents ?? []) {
			// slot.instructions is a WorkflowNodeAgentOverride {mode, value} object
			expect(slot.instructions?.value).toContain('read_gate');
			expect(slot.instructions?.value).toContain('write_gate');
			// Must warn against writing only own entry to prevent overwriting peers
			expect(slot.instructions?.value).toContain('overwriting');
		}
	});

	test('QA node instructions describe both pass and fail write targets', () => {
		const qa = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'QA')!;
		expect(qa.instructions).toContain('qa-result-gate');
		expect(qa.instructions).toContain('qa-fail-gate');
	});

	test('review-votes-gate description mentions read-merge-write requirement', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'review-votes-gate')!;
		expect(gate.description).toContain('read-merge-write');
	});

	test('qa-result-gate description explains it resets on cycle', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'qa-result-gate')!;
		expect(gate.description).toContain('clean state');
	});

	test('code-pr-gate description explains it is preserved across fix cycles', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'code-pr-gate')!;
		expect(gate.description).toContain('resetOnCycle');
		expect(gate.description).toMatch(/fix cycles/i);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(FULL_CYCLE_CODING_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.id).toBe('');
		expect(FULL_CYCLE_CODING_WORKFLOW.spaceId).toBe('');
	});

	// maxIterations removed from CreateSpaceWorkflowParams; per-channel maxCycles used instead.

	test('has the default tag so workflow selector ranks it first for coding requests', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.tags).toContain('default');
	});

	test('has the coding tag', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.tags).toContain('coding');
	});
});

// ---------------------------------------------------------------------------
// getBuiltInWorkflows()
// ---------------------------------------------------------------------------

describe('getBuiltInWorkflows()', () => {
	test('returns exactly four templates', () => {
		expect(getBuiltInWorkflows()).toHaveLength(4);
	});

	test('includes CODING_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
	});

	test('includes FULL_CYCLE_CODING_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(FULL_CYCLE_CODING_WORKFLOW.name);
	});

	test('includes RESEARCH_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(RESEARCH_WORKFLOW.name);
	});

	test('includes REVIEW_ONLY_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
	});

	test('no template references leader as agent', () => {
		for (const wf of getBuiltInWorkflows()) {
			expect(hasLeaderAgentId(wf)).toBe(false);
		}
	});

	test('all agent placeholders are valid builtin role names', () => {
		// agent.agentId is the role placeholder (Capitalized); check lowercase version is in valid set
		for (const wf of getBuiltInWorkflows()) {
			for (const step of wf.nodes) {
				expect(step.agents.length).toBeGreaterThan(0);
				for (const agent of step.agents) {
					expect(VALID_BUILTIN_ROLES.has(agent.agentId.toLowerCase())).toBe(true);
				}
			}
		}
	});

	test('all templates define endNodeId', () => {
		for (const wf of getBuiltInWorkflows()) {
			expect(wf.endNodeId).toBeTruthy();
			expect(typeof wf.endNodeId).toBe('string');
		}
	});

	test('all templates endNodeId references a valid node', () => {
		for (const wf of getBuiltInWorkflows()) {
			const nodeIds = new Set(wf.nodes.map((n) => n.id));
			expect(nodeIds.has(wf.endNodeId!)).toBe(true);
		}
	});

	test('all nodes use agents[] array format (no bare agentId on nodes)', () => {
		for (const wf of getBuiltInWorkflows()) {
			for (const node of wf.nodes) {
				expect(Array.isArray(node.agents)).toBe(true);
				expect(node.agents.length).toBeGreaterThan(0);
				for (const agent of node.agents) {
					expect(agent.agentId).toBeTruthy();
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// seedBuiltInWorkflows()
// ---------------------------------------------------------------------------

describe('seedBuiltInWorkflows()', () => {
	let db: BunDatabase;
	let dir: string;
	let manager: SpaceWorkflowManager;
	const SPACE_ID = 'seed-test-space';

	// Preset agent IDs seeded in the space
	const PLANNER_ID = 'agent-planner-uuid';
	const CODER_ID = 'agent-coder-uuid';
	const GENERAL_ID = 'agent-general-uuid';
	const RESEARCH_ID = 'agent-research-uuid';
	const REVIEWER_ID = 'agent-reviewer-uuid';

	// Role resolver — mirrors what the real call site does
	const QA_ID = 'agent-qa-uuid';
	const roleMap: Record<string, string> = {
		planner: PLANNER_ID,
		coder: CODER_ID,
		general: GENERAL_ID,
		research: RESEARCH_ID,
		reviewer: REVIEWER_ID,
		qa: QA_ID,
	};
	const resolveAgentId = (role: string): string | undefined => roleMap[role.toLowerCase()];

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID);
		// Seed preset agents so the manager's agentLookup (when wired) would find them
		seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner');
		seedAgent(db, CODER_ID, SPACE_ID, 'Coder');
		seedAgent(db, GENERAL_ID, SPACE_ID, 'General');
		seedAgent(db, RESEARCH_ID, SPACE_ID, 'Research');
		seedAgent(db, REVIEWER_ID, SPACE_ID, 'Reviewer');
		seedAgent(db, QA_ID, SPACE_ID, 'QA');

		const repo = new SpaceWorkflowRepository(db);
		// No agentLookup — seeder bypasses lookup by passing real IDs directly
		manager = new SpaceWorkflowManager(repo);
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

	test('seeds all four built-in templates for an empty space', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(4);
	});

	test('seeded workflow names match all four templates', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
		expect(names).toContain(FULL_CYCLE_CODING_WORKFLOW.name);
		expect(names).toContain(RESEARCH_WORKFLOW.name);
		expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
	});

	test('Full-Cycle Coding Workflow seeding preserves explicit node system prompts', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		// systemPrompt is on each WorkflowNodeAgent, not on WorkflowNode
		for (const node of wf!.nodes) {
			for (const agent of node.agents) {
				expect((agent.systemPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('CODING_WORKFLOW seeding preserves node system prompts with mode expand', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		for (const node of wf!.nodes) {
			for (const agent of node.agents) {
				expect(agent.systemPrompt?.mode).toBe('expand');
				expect((agent.systemPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('RESEARCH_WORKFLOW seeding preserves node system prompts with mode expand', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		for (const node of wf!.nodes) {
			for (const agent of node.agents) {
				expect(agent.systemPrompt?.mode).toBe('expand');
				expect((agent.systemPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('CODING_WORKFLOW seeded correctly — two nodes with real agent IDs', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(2);
		expect(wf!.nodes[0].agents[0]?.agentId).toBe(CODER_ID);
		expect(wf!.nodes[1].agents[0]?.agentId).toBe(roleMap.reviewer);
	});

	test('CODING_WORKFLOW seeded with two channels (gated Code→Review, ungated Review→Code)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(2);

		const codeToReview = wf.channels!.find((c) => c.from === 'Code' && c.to === 'Review');
		expect(codeToReview).toBeDefined();
		expect(codeToReview!.gateId).toBe('code-ready-gate');

		const reviewToCode = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Code');
		expect(reviewToCode).toBeDefined();
		expect(reviewToCode!.gateId).toBeUndefined();
		expect(reviewToCode!.maxCycles).toBe(5);
	});

	test('CODING_WORKFLOW seeded with one gate (code-ready-gate)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.gates).toHaveLength(1);
		const gateIds = wf.gates!.map((g) => g.id);
		expect(gateIds).toContain('code-ready-gate');
	});

	test('CODING_WORKFLOW seeded channels all have direction one-way', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		for (const ch of wf.channels!) {
			expect(ch.direction).toBe('one-way');
		}
	});

	test('CODING_WORKFLOW seeded channels from/to fields are node names (not UUIDs)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const nodeNames = new Set(wf.nodes.map((n) => n.name));
		for (const ch of wf.channels!) {
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('RESEARCH_WORKFLOW seeded with two channels (gated Research→Review, ungated Review→Research)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(2);
		const gated = wf.channels!.find((c) => c.gateId === 'research-ready-gate');
		expect(gated).toBeDefined();
		expect(gated!.from).toBe('Research');
		expect(gated!.to).toBe('Review');
		const back = wf.channels!.find((c) => c.gateId === undefined);
		expect(back).toBeDefined();
		expect(back!.from).toBe('Review');
		expect(back!.to).toBe('Research');
	});

	test('RESEARCH_WORKFLOW seeded correctly — research + reviewer', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(2);
		expect(wf!.nodes[0].agents[0]?.agentId).toBe(RESEARCH_ID);
		expect(wf!.nodes[1].agents[0]?.agentId).toBe(REVIEWER_ID);
	});

	test('RESEARCH_WORKFLOW seeded channels reference valid node names', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		const nodeNames = new Set(wf.nodes.map((n) => n.name));
		for (const ch of wf.channels!) {
			expect(ch.direction).toBe('one-way');
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('REVIEW_ONLY_WORKFLOW seeded with no channels', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.channels ?? []).toHaveLength(0);
	});

	test('REVIEW_ONLY_WORKFLOW seeded correctly — single reviewer step', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(1);
		expect(wf!.nodes[0].agents[0]?.agentId).toBe(REVIEWER_ID);
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded correctly — six nodes with code-review agents[]', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(6);
		expect(wf!.nodes[0].agents[0]?.agentId).toBe(PLANNER_ID); // Planning
		expect(wf!.nodes[1].agents[0]?.agentId).toBe(roleMap.reviewer); // Plan Review
		expect(wf!.nodes[2].agents[0]?.agentId).toBe(CODER_ID); // Coding
		// Code Review has three agents (all reviewer)
		expect(wf!.nodes[3].agents).toHaveLength(3);
		expect(wf!.nodes[3].agents?.map((a) => a.agentId)).toEqual([
			roleMap.reviewer,
			roleMap.reviewer,
			roleMap.reviewer,
		]);
		expect(wf!.nodes[3].agents?.map((a) => a.name)).toEqual([
			'Reviewer 1',
			'Reviewer 2',
			'Reviewer 3',
		]);
		expect(wf!.nodes[4].agents[0]?.agentId).toBe(QA_ID); // QA
		expect(wf!.nodes[5].agents[0]?.agentId).toBe(GENERAL_ID); // Done
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded with 9 node-level channels', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(9);
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded with 7 gates', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		expect(wf.gates).toHaveLength(7);
		const gateIds = wf.gates!.map((g) => g.id);
		expect(gateIds).toContain('plan-pr-gate');
		expect(gateIds).toContain('plan-approval-gate');
		expect(gateIds).toContain('code-pr-gate');
		expect(gateIds).toContain('review-votes-gate');
		expect(gateIds).toContain('review-reject-gate');
		expect(gateIds).toContain('qa-result-gate');
		expect(gateIds).toContain('qa-fail-gate');
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded channels use gateId (not legacy gate)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const gatedChannels = wf.channels!.filter((c) => c.gateId !== undefined);
		// 7 channels have gateIds (9 total minus 2 ungated feedback channels)
		expect(gatedChannels).toHaveLength(7);
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded cyclic channels have maxCycles set', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const cyclicChannels = wf.channels!.filter((c) => c.maxCycles !== undefined);
		// 4 cyclic: Plan Review→Planning, Coding→Planning, QA→Coding, Code Review→Coding
		expect(cyclicChannels).toHaveLength(4);
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded channels reference node names or reviewer slot names', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const refs = new Set<string>();
		for (const node of wf.nodes) {
			refs.add(node.name);
			for (const slot of node.agents ?? []) refs.add(slot.name);
		}
		for (const ch of wf.channels!) {
			expect(refs.has(ch.from as string)).toBe(true);
			if (Array.isArray(ch.to)) {
				for (const target of ch.to) {
					expect(refs.has(target)).toBe(true);
				}
			} else {
				expect(refs.has(ch.to as string)).toBe(true);
			}
		}
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded with default tag for workflow selector ranking', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		expect(wf.tags).toContain('default');
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded alongside CODING_WORKFLOW — both present', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
		expect(names).toContain(FULL_CYCLE_CODING_WORKFLOW.name);
	});

	test('all seeded workflows have the real spaceId assigned', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			expect(wf.spaceId).toBe(SPACE_ID);
		}
	});

	test('all seeded workflows have non-empty ids assigned', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			expect(wf.id).toBeTruthy();
		}
	});

	test('all seeded workflows have endNodeId pointing to a valid node', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			expect(wf.endNodeId).toBeTruthy();
			const nodeIds = new Set(wf.nodes.map((n) => n.id));
			expect(nodeIds.has(wf.endNodeId!)).toBe(true);
		}
	});

	test('REVIEW_ONLY_WORKFLOW seeded with startNodeId === endNodeId', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.startNodeId).toBe(wf.endNodeId);
	});

	test('is idempotent — second call does not create additional workflows', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(4);
	});

	test('is idempotent — leaves user-created workflows untouched', async () => {
		// User already created a custom workflow before seeding
		manager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'My Custom Workflow',
			nodes: [{ name: 'Code', agentId: CODER_ID }],
		});

		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(1);
		expect(workflows[0].name).toBe('My Custom Workflow');
	});

	test('throws if resolveAgentId returns undefined for a required role', () => {
		// Resolver that cannot resolve any role
		const brokenResolver = (_role: string): string | undefined => undefined;

		expect(() => seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver)).toThrow(
			'no SpaceAgent found with name'
		);
	});

	test('does not persist any workflow when resolveAgentId fails on first-template role', async () => {
		// Resolver fails on 'planner' — used by RESEARCH_WORKFLOW (second template)
		const brokenResolver = (role: string): string | undefined =>
			role === 'planner' ? undefined : roleMap[role];

		try {
			seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
		} catch {
			// expected
		}
		// Pre-validation throws before any workflow is committed
		expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
	});

	test('does not persist any workflow when resolveAgentId fails on a shared role', async () => {
		// 'general' is used by FULL_CYCLE_CODING_WORKFLOW.
		// Pre-validation catches missing roles before any workflow is persisted.
		const brokenResolver = (role: string): string | undefined =>
			role === 'general' ? undefined : roleMap[role];

		try {
			seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
		} catch {
			// expected
		}
		// Pre-validation catches the missing role before any workflow is persisted
		expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
	});

	// ─── Return type tests ──────────────────────────────────────────────────

	test('returns seeded workflow names on success', () => {
		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		expect(result.skipped).toBe(false);
		expect(result.errors).toHaveLength(0);
		expect(result.seeded).toHaveLength(4);
		expect(result.seeded).toContain('Coding Workflow');
		expect(result.seeded).toContain('Full-Cycle Coding Workflow');
		expect(result.seeded).toContain('Research Workflow');
		expect(result.seeded).toContain('Review-Only Workflow');
	});

	test('returns skipped=true when workflows already exist', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		expect(result.skipped).toBe(true);
		expect(result.seeded).toHaveLength(0);
		expect(result.errors).toHaveLength(0);
	});

	test('per-workflow error isolation — remaining workflows seed when one createWorkflow throws', () => {
		// Spy on createWorkflow to make one specific workflow fail
		const originalCreate = manager.createWorkflow.bind(manager);
		let callCount = 0;
		manager.createWorkflow = (params) => {
			callCount++;
			if (callCount === 2) {
				throw new Error('Simulated DB constraint error');
			}
			return originalCreate(params);
		};

		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		// 3 of 4 succeed, 1 fails
		expect(result.seeded).toHaveLength(3);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain('Simulated DB constraint error');
		expect(result.skipped).toBe(false);

		// Verify 3 workflows were actually persisted
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(3);
	});

	test('per-workflow error isolation — captures error name correctly', () => {
		const originalCreate = manager.createWorkflow.bind(manager);
		let callCount = 0;
		const templates = getBuiltInWorkflows();
		manager.createWorkflow = (params) => {
			callCount++;
			// Fail the third workflow
			if (callCount === 3) {
				throw new Error('Unique constraint violation');
			}
			return originalCreate(params);
		};

		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		expect(result.errors).toHaveLength(1);
		// The third template name is recorded in the error
		expect(result.errors[0].name).toBe(templates[2].name);
		expect(result.errors[0].error).toContain('Unique constraint violation');
	});

	test('all workflows fail gracefully — returns all errors', () => {
		manager.createWorkflow = () => {
			throw new Error('DB is read-only');
		};

		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		expect(result.seeded).toHaveLength(0);
		expect(result.errors).toHaveLength(4);
		expect(result.skipped).toBe(false);
		for (const err of result.errors) {
			expect(err.error).toContain('DB is read-only');
		}
	});

	// ─── Node ID replacement tests ─────────────────────────────────────────

	test('seeded node IDs are real UUIDs, not template placeholders', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const templatePrefixes = ['tpl-coding-', 'tpl-v2-', 'tpl-research-', 'tpl-review-'];
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			for (const node of wf.nodes) {
				for (const prefix of templatePrefixes) {
					expect(node.id.startsWith(prefix)).toBe(false);
				}
				// UUID format: 8-4-4-4-12 hex characters
				expect(node.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			}
		}
	});

	test('seeded startNodeId is a real UUID pointing to first node', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			expect(wf.startNodeId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
			);
			const nodeIds = new Set(wf.nodes.map((n) => n.id));
			expect(nodeIds.has(wf.startNodeId)).toBe(true);
		}
	});

	// ─── Description & tags preservation ────────────────────────────────────

	test('all seeded workflows preserve their descriptions', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		const templates = getBuiltInWorkflows();
		for (const tpl of templates) {
			const wf = workflows.find((w) => w.name === tpl.name);
			expect(wf).toBeDefined();
			expect(wf!.description).toBe(tpl.description);
		}
	});

	test('CODING_WORKFLOW seeded with coding and default tags', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.tags).toContain('coding');
		expect(wf.tags).toContain('default');
	});

	test('RESEARCH_WORKFLOW seeded with research tag', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		expect(wf.tags).toContain('research');
	});

	test('REVIEW_ONLY_WORKFLOW seeded with review tag', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.tags).toContain('review');
	});

	// ─── Node instructions preservation ─────────────────────────────────────

	test('CODING_WORKFLOW seeded nodes preserve instructions', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const codeNode = wf.nodes.find((n) => n.name === 'Code');
		expect(codeNode!.instructions).toContain('gh pr create');
		const reviewNode = wf.nodes.find((n) => n.name === 'Review');
		expect(reviewNode!.instructions).toContain('report_done()');
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded nodes preserve instructions', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const planNode = wf.nodes.find((n) => n.name === 'Planning');
		expect(planNode!.instructions).toContain('plan-pr-gate');
		const codingNode = wf.nodes.find((n) => n.name === 'Coding');
		expect(codingNode!.instructions).toContain('code-pr-gate');
		const qaNode = wf.nodes.find((n) => n.name === 'QA');
		expect(qaNode!.instructions).toContain('qa-result-gate');
	});

	test('RESEARCH_WORKFLOW seeded nodes preserve instructions', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		const researchNode = wf.nodes.find((n) => n.name === 'Research');
		expect(researchNode!.instructions).toContain('research-ready-gate');
		const reviewNode = wf.nodes.find((n) => n.name === 'Review');
		expect(reviewNode!.instructions).toContain('report_done()');
	});

	// ─── Gate preservation per workflow ──────────────────────────────────────

	test('RESEARCH_WORKFLOW seeded with one gate (research-ready-gate)', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		expect(wf.gates).toHaveLength(1);
		expect(wf.gates![0].id).toBe('research-ready-gate');
	});

	test('REVIEW_ONLY_WORKFLOW seeded with no gates', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.gates ?? []).toHaveLength(0);
	});

	test('CODING_WORKFLOW gate fields are preserved during seeding', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const gate = wf.gates!.find((g) => g.id === 'code-ready-gate')!;
		expect(gate.fields).toHaveLength(1);
		expect(gate.fields[0].name).toBe('pr_url');
		expect(gate.fields[0].type).toBe('string');
		expect(gate.fields[0].check).toEqual({ op: 'exists' });
		expect(gate.script).toBeDefined();
		expect(gate.script!.interpreter).toBe('bash');
		expect(gate.script!.timeoutMs).toBe(30000);
		expect(gate.resetOnCycle).toBe(true);
	});

	test('FULL_CYCLE_CODING_WORKFLOW gate resetOnCycle flags are preserved', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const planPr = wf.gates!.find((g) => g.id === 'plan-pr-gate')!;
		expect(planPr.resetOnCycle).toBe(false);
		const codePr = wf.gates!.find((g) => g.id === 'code-pr-gate')!;
		expect(codePr.resetOnCycle).toBe(false);
		const planApproval = wf.gates!.find((g) => g.id === 'plan-approval-gate')!;
		expect(planApproval.resetOnCycle).toBe(true);
		const reviewVotes = wf.gates!.find((g) => g.id === 'review-votes-gate')!;
		expect(reviewVotes.resetOnCycle).toBe(true);
	});

	// ─── Timestamps ─────────────────────────────────────────────────────────

	test('all seeded workflows have positive timestamps', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			expect(wf.createdAt).toBeGreaterThan(0);
			expect(wf.updatedAt).toBeGreaterThan(0);
		}
	});

	// ─── Agent ID resolution edge case ──────────────────────────────────────

	test('agent ID resolution is case-insensitive via resolver', () => {
		// The real call site does: agents.find(a => a.name.toLowerCase() === name.toLowerCase())
		// Our test resolver mirrors this — verify it handles mixed-case template placeholders
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		// Templates use 'Planner', 'Coder', 'Reviewer', 'QA', 'General' (title-case)
		// Resolver maps via toLowerCase — all should resolve
		expect(wf.nodes[0].agents[0]?.agentId).toBe(PLANNER_ID);
		expect(wf.nodes[2].agents[0]?.agentId).toBe(CODER_ID);
		expect(wf.nodes[4].agents[0]?.agentId).toBe(QA_ID);
		expect(wf.nodes[5].agents[0]?.agentId).toBe(GENERAL_ID);
	});

	test('no seeded agent IDs contain template placeholder names', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const placeholders = ['Planner', 'Coder', 'General', 'Research', 'Reviewer', 'QA'];
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			for (const node of wf.nodes) {
				for (const agent of node.agents) {
					expect(placeholders).not.toContain(agent.agentId);
					// Agent ID should be a UUID, not a role name
					expect(agent.agentId).toMatch(/^agent-[a-z]+-uuid$/);
				}
			}
		}
	});

	// ─── Node name preservation ─────────────────────────────────────────────

	test('all seeded workflow node names match their template definitions', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		const templates = getBuiltInWorkflows();
		for (const tpl of templates) {
			const wf = workflows.find((w) => w.name === tpl.name)!;
			const seededNames = wf.nodes.map((n) => n.name);
			const templateNames = tpl.nodes.map((n) => n.name);
			expect(seededNames).toEqual(templateNames);
		}
	});

	// ─── 2-layer system prompt override design ──────────────────────────────

	test('CODING_WORKFLOW seeded with systemPrompt mode=expand on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.systemPrompt).toBeDefined();
				expect(agent.systemPrompt!.mode).toBe('expand');
				expect(agent.systemPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('CODING_WORKFLOW seeded agent slots have no instructions override', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.instructions).toBeUndefined();
			}
		}
	});

	test('RESEARCH_WORKFLOW seeded with systemPrompt mode=expand on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.systemPrompt).toBeDefined();
				expect(agent.systemPrompt!.mode).toBe('expand');
				expect(agent.systemPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('RESEARCH_WORKFLOW seeded agent slots have no instructions override', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.instructions).toBeUndefined();
			}
		}
	});

	test('REVIEW_ONLY_WORKFLOW seeded with systemPrompt mode=expand on reviewer slot', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.nodes).toHaveLength(1);
		const agent = wf.nodes[0].agents[0];
		expect(agent.systemPrompt).toBeDefined();
		expect(agent.systemPrompt!.mode).toBe('expand');
		expect(agent.systemPrompt!.value.trim().length).toBeGreaterThan(0);
	});

	test('REVIEW_ONLY_WORKFLOW seeded reviewer slot has no instructions override', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.nodes[0].agents[0].instructions).toBeUndefined();
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded with systemPrompt mode=override on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.systemPrompt).toBeDefined();
				expect(agent.systemPrompt!.mode).toBe('override');
				expect(agent.systemPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('FULL_CYCLE_CODING_WORKFLOW Code Review node reviewer slots have instructions mode=override', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const codeReviewNode = wf.nodes.find((n) => n.name === 'Code Review')!;
		expect(codeReviewNode.agents).toHaveLength(3);
		for (const agent of codeReviewNode.agents) {
			expect(agent.instructions).toBeDefined();
			expect(agent.instructions!.mode).toBe('override');
			expect(agent.instructions!.value.trim().length).toBeGreaterThan(0);
			// Each reviewer's instructions should contain their specific slot name
			expect(agent.instructions!.value).toContain(agent.name);
		}
	});

	test('FULL_CYCLE_CODING_WORKFLOW non-Code-Review nodes have no instructions override', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const nonReviewNodes = wf.nodes.filter((n) => n.name !== 'Code Review');
		expect(nonReviewNodes.length).toBe(5); // Planning, Plan Review, Coding, QA, Done
		for (const node of nonReviewNodes) {
			for (const agent of node.agents) {
				expect(agent.instructions).toBeUndefined();
			}
		}
	});

	test('expand-mode workflows append to agent prompts while override-mode workflows replace them', () => {
		// Structural design check: the two prompt layering strategies are correctly assigned
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);

		// Iterative workflows (Coding, Research, Review-Only) use 'expand' — they augment
		// the agent's base prompt with workflow-specific context
		const expandWorkflows = [
			CODING_WORKFLOW.name,
			RESEARCH_WORKFLOW.name,
			REVIEW_ONLY_WORKFLOW.name,
		];
		for (const name of expandWorkflows) {
			const wf = workflows.find((w) => w.name === name)!;
			for (const node of wf.nodes) {
				for (const agent of node.agents) {
					if (agent.systemPrompt) {
						expect(agent.systemPrompt.mode).toBe('expand');
					}
				}
			}
		}

		// Full-Cycle workflow uses 'override' — nodes have specialized roles that
		// completely replace the agent's generic prompt
		const fullCycle = workflows.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		for (const node of fullCycle.nodes) {
			for (const agent of node.agents) {
				if (agent.systemPrompt) {
					expect(agent.systemPrompt.mode).toBe('override');
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Export/import round-trip
// ---------------------------------------------------------------------------

describe('Coding Workflow export/import round-trip', () => {
	let db: BunDatabase;
	let dir: string;
	let manager: SpaceWorkflowManager;
	const SPACE_ID = 'roundtrip-test-space';

	const PLANNER_ID = 'agent-planner-uuid';
	const CODER_ID = 'agent-coder-uuid';
	const GENERAL_ID = 'agent-general-uuid';
	const QA_ID = 'agent-qa-uuid';
	const RESEARCH_ID = 'agent-research-uuid';

	const REVIEWER_ID = 'agent-reviewer-uuid';
	const roleMap: Record<string, string> = {
		planner: PLANNER_ID,
		research: RESEARCH_ID,
		coder: CODER_ID,
		general: GENERAL_ID,
		reviewer: REVIEWER_ID,
		qa: QA_ID,
	};
	const resolveAgentId = (role: string): string | undefined => roleMap[role.toLowerCase()];

	/** Mock SpaceAgent records for exportWorkflow's agent name resolution. */
	const mockAgents: SpaceAgent[] = [
		{
			id: CODER_ID,
			spaceId: SPACE_ID,
			name: 'Coder',
			role: 'coder',
			description: '',
			model: null,
			tools: [],
			systemPrompt: '',
			config: null,
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: RESEARCH_ID,
			spaceId: SPACE_ID,
			name: 'Research',
			role: 'research',
			description: '',
			model: null,
			tools: [],
			systemPrompt: '',
			config: null,
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: REVIEWER_ID,
			spaceId: SPACE_ID,
			name: 'Reviewer',
			role: 'reviewer',
			description: '',
			model: null,
			tools: [],
			systemPrompt: '',
			config: null,
			createdAt: 0,
			updatedAt: 0,
		},
	];

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID);
		seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner');
		seedAgent(db, CODER_ID, SPACE_ID, 'Coder');
		seedAgent(db, GENERAL_ID, SPACE_ID, 'General');
		seedAgent(db, QA_ID, SPACE_ID, 'QA');

		const repo = new SpaceWorkflowRepository(db);
		manager = new SpaceWorkflowManager(repo);
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

	test('exported Coding Workflow passes Zod validation', () => {
		// Seed and retrieve the persisted workflow (with real UUIDs)
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);
		const result = validateExportedWorkflow(exported);
		expect(result.ok).toBe(true);
	});

	test('exported Coding Workflow preserves two channels and Review→Code cycle', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);
		expect(exported.channels).toBeDefined();
		// gateId is stripped during export (gates are separate entities)
		expect(exported.channels).toHaveLength(2);

		const reviewToCode = exported.channels!.find((c) => c.from === 'Review' && c.to === 'Code');
		expect(reviewToCode).toBeDefined();
		expect(reviewToCode!.maxCycles).toBe(5);
	});

	test('exported Coding Workflow channels do not include gate field (gates are separate entities)', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);

		// Exported channels should not have a gate field (gates are separate entities not included in export)
		for (const ch of exported.channels ?? []) {
			expect((ch as Record<string, unknown>).gate).toBeUndefined();
		}
	});

	test('re-imported Coding Workflow preserves channel structure', () => {
		// Seed → export → re-import → verify round-trip fidelity
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const exported = exportWorkflow(wf, mockAgents);

		// Delete all workflows so we can re-import
		for (const w of manager.listWorkflows(SPACE_ID)) {
			manager.deleteWorkflow(w.id);
		}
		expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);

		// Build agent name → ID map for resolving agentRef
		const agentNameToId = new Map<string, string>(mockAgents.map((a) => [a.name, a.id]));

		manager.createWorkflow({
			spaceId: SPACE_ID,
			name: exported.name,
			description: exported.description,
			nodes: exported.nodes.map((s) => ({
				name: s.name,
				agents: s.agents.map((a) => ({
					agentId: agentNameToId.get(a.agentRef) ?? a.agentRef,
					name: a.name,
				})),
				instructions: s.instructions,
			})),
			startNodeId: undefined,
			tags: exported.tags,
			channels: exported.channels,
		});

		// Verify the re-imported workflow
		const reimported = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(reimported).toBeDefined();
		expect(reimported.nodes).toHaveLength(2);
		expect(reimported.channels).toHaveLength(2);

		// Code → Review channel preserved
		const codeToReview = reimported.channels!.find((c) => c.from === 'Code' && c.to === 'Review');
		expect(codeToReview).toBeDefined();

		// Review → Code channel preserved with maxCycles
		const reviewToCode = reimported.channels!.find((c) => c.from === 'Review' && c.to === 'Code');
		expect(reviewToCode).toBeDefined();
		expect(reviewToCode!.maxCycles).toBe(5);
	});
});
