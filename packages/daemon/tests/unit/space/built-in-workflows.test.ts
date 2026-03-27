/**
 * Built-in Workflow Templates Unit Tests
 *
 * Covers:
 * - Template structure: correct agentId placeholders, transition conditions, step count
 * - agentId placeholders are valid builtin role names (no 'leader')
 * - getBuiltInWorkflows() returns all three templates
 * - seedBuiltInWorkflows(): seeds all three templates with real agent IDs
 * - seedBuiltInWorkflows(): idempotent — no re-seed if workflows already exist
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
	CODING_WORKFLOW_V2,
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

function seedAgent(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	name: string,
	role: string
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     role, config, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, null, ?, ?)`
	).run(agentId, spaceId, name, role, Date.now(), Date.now());
}

/** Valid builtin roles — 'leader' must NOT appear in any template step. */
const VALID_BUILTIN_ROLES = new Set<string>(['planner', 'coder', 'general', 'reviewer', 'qa']);

/**
 * Returns true if any step in the workflow has 'leader' as its agentId placeholder.
 */
function hasLeaderAgentId(wf: SpaceWorkflow): boolean {
	return wf.nodes.some((s) => s.agentId === 'leader');
}

// ---------------------------------------------------------------------------
// Template structure tests
// ---------------------------------------------------------------------------

describe('CODING_WORKFLOW template', () => {
	test('has four nodes: Plan, Code, Verify & Test, Done', () => {
		expect(CODING_WORKFLOW.nodes).toHaveLength(4);
		expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual([
			'Plan',
			'Code',
			'Verify & Test',
			'Done',
		]);
	});

	test('step agentId placeholders are correct', () => {
		expect(CODING_WORKFLOW.nodes[0].agentId).toBe('planner');
		expect(CODING_WORKFLOW.nodes[1].agentId).toBe('coder');
		expect(CODING_WORKFLOW.nodes[2].agentId).toBe('general');
		expect(CODING_WORKFLOW.nodes[3].agentId).toBe('general');
	});

	test('Verify & Test step has instructions', () => {
		const verifyStep = CODING_WORKFLOW.nodes.find((s) => s.name === 'Verify & Test');
		expect(verifyStep?.instructions).toContain('Run tests');
		expect(verifyStep?.instructions).toContain('passed');
		expect(verifyStep?.instructions).toContain('failed');
	});

	test('has four channels with correct gate conditions', () => {
		expect(CODING_WORKFLOW.channels).toHaveLength(4);

		const planToCode = CODING_WORKFLOW.channels!.find((c) => c.from === 'Plan' && c.to === 'Code');
		expect(planToCode?.gate?.type).toBe('human');
		expect(planToCode?.direction).toBe('one-way');

		const codeToVerify = CODING_WORKFLOW.channels!.find(
			(c) => c.from === 'Code' && c.to === 'Verify & Test'
		);
		expect(codeToVerify?.gate?.type).toBe('always');
		expect(codeToVerify?.direction).toBe('one-way');

		const verifyToPlan = CODING_WORKFLOW.channels!.find(
			(c) => c.from === 'Verify & Test' && c.to === 'Plan'
		);
		expect(verifyToPlan?.gate?.type).toBe('task_result');
		expect((verifyToPlan?.gate as { expression?: string })?.expression).toBe('failed');
		expect(verifyToPlan?.isCyclic).toBe(true);

		const verifyToDone = CODING_WORKFLOW.channels!.find(
			(c) => c.from === 'Verify & Test' && c.to === 'Done'
		);
		expect(verifyToDone?.gate?.type).toBe('task_result');
		expect((verifyToDone?.gate as { expression?: string })?.expression).toBe('passed');
		expect(verifyToDone?.isCyclic).toBeUndefined();
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

	test('all channels have gate descriptions', () => {
		for (const ch of CODING_WORKFLOW.channels!) {
			expect(ch.gate?.description).toBeTruthy();
		}
	});

	test('maxIterations is set to 3', () => {
		expect(CODING_WORKFLOW.maxIterations).toBe(3);
	});

	test('startNodeId points to the planner step', () => {
		const plannerStep = CODING_WORKFLOW.nodes.find((s) => s.agentId === 'planner');
		expect(CODING_WORKFLOW.startNodeId).toBe(plannerStep?.id);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(CODING_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(CODING_WORKFLOW.id).toBe('');
		expect(CODING_WORKFLOW.spaceId).toBe('');
	});
});

describe('RESEARCH_WORKFLOW template', () => {
	test('has two steps', () => {
		expect(RESEARCH_WORKFLOW.nodes).toHaveLength(2);
	});

	test('first step agentId placeholder is planner', () => {
		expect(RESEARCH_WORKFLOW.nodes[0].agentId).toBe('planner');
	});

	test('second step agentId placeholder is general', () => {
		expect(RESEARCH_WORKFLOW.nodes[1].agentId).toBe('general');
	});

	test('has one channel (Plan Research → Research) with always gate', () => {
		expect(RESEARCH_WORKFLOW.channels).toHaveLength(1);
		const ch = RESEARCH_WORKFLOW.channels![0];
		expect(ch.from).toBe('Plan Research');
		expect(ch.to).toBe('Research');
		expect(ch.direction).toBe('one-way');
		expect(ch.gate?.type).toBe('always');
	});

	test('channel from/to references match node names', () => {
		const nodeNames = new Set(RESEARCH_WORKFLOW.nodes.map((n) => n.name));
		const ch = RESEARCH_WORKFLOW.channels![0];
		expect(nodeNames.has(ch.from as string)).toBe(true);
		expect(nodeNames.has(ch.to as string)).toBe(true);
	});

	test('channel has a gate description', () => {
		const ch = RESEARCH_WORKFLOW.channels![0];
		expect(ch.gate?.description).toBeTruthy();
	});

	test('startNodeId points to the planner step', () => {
		const plannerStep = RESEARCH_WORKFLOW.nodes.find((s) => s.agentId === 'planner');
		expect(RESEARCH_WORKFLOW.startNodeId).toBe(plannerStep?.id);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(RESEARCH_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(RESEARCH_WORKFLOW.id).toBe('');
		expect(RESEARCH_WORKFLOW.spaceId).toBe('');
	});
});

describe('REVIEW_ONLY_WORKFLOW template', () => {
	test('has one step', () => {
		expect(REVIEW_ONLY_WORKFLOW.nodes).toHaveLength(1);
	});

	test('step agentId placeholder is coder', () => {
		expect(REVIEW_ONLY_WORKFLOW.nodes[0].agentId).toBe('coder');
	});

	test('has no channels (single-node workflow needs no inter-agent channels)', () => {
		expect(REVIEW_ONLY_WORKFLOW.channels ?? []).toHaveLength(0);
	});

	test('startNodeId points to the coder step', () => {
		expect(REVIEW_ONLY_WORKFLOW.startNodeId).toBe(REVIEW_ONLY_WORKFLOW.nodes[0].id);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(REVIEW_ONLY_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(REVIEW_ONLY_WORKFLOW.id).toBe('');
		expect(REVIEW_ONLY_WORKFLOW.spaceId).toBe('');
	});
});

describe('CODING_WORKFLOW_V2 template', () => {
	test('has eight nodes', () => {
		expect(CODING_WORKFLOW_V2.nodes).toHaveLength(8);
	});

	test('node names are correct', () => {
		expect(CODING_WORKFLOW_V2.nodes.map((n) => n.name)).toEqual([
			'Planning',
			'Plan Review',
			'Coding',
			'Reviewer 1',
			'Reviewer 2',
			'Reviewer 3',
			'QA',
			'Done',
		]);
	});

	test('node agentId placeholders are correct', () => {
		const nodes = CODING_WORKFLOW_V2.nodes;
		expect(nodes[0].agentId).toBe('planner'); // Planning
		expect(nodes[1].agentId).toBe('reviewer'); // Plan Review
		expect(nodes[2].agentId).toBe('coder'); // Coding
		expect(nodes[3].agentId).toBe('reviewer'); // Reviewer 1
		expect(nodes[4].agentId).toBe('reviewer'); // Reviewer 2
		expect(nodes[5].agentId).toBe('reviewer'); // Reviewer 3
		expect(nodes[6].agentId).toBe('qa'); // QA
		expect(nodes[7].agentId).toBe('general'); // Done
	});

	test('startNodeId points to the Planning (planner) node', () => {
		const planningNode = CODING_WORKFLOW_V2.nodes.find((n) => n.name === 'Planning');
		expect(CODING_WORKFLOW_V2.startNodeId).toBe(planningNode?.id);
	});

	test('has seven gates', () => {
		expect(CODING_WORKFLOW_V2.gates).toHaveLength(7);
	});

	test('gate IDs are correct', () => {
		const ids = CODING_WORKFLOW_V2.gates!.map((g) => g.id);
		expect(ids).toContain('plan-pr-gate');
		expect(ids).toContain('plan-approval-gate');
		expect(ids).toContain('code-pr-gate');
		expect(ids).toContain('review-votes-gate');
		expect(ids).toContain('review-reject-gate');
		expect(ids).toContain('qa-result-gate');
		expect(ids).toContain('qa-fail-gate');
	});

	test('plan-pr-gate has check condition and planner writer role', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'plan-pr-gate')!;
		expect(gate.condition.type).toBe('check');
		expect((gate.condition as { field: string }).field).toBe('plan_submitted');
		expect(gate.allowedWriterRoles).toContain('planner');
		expect(gate.resetOnCycle).toBe(false);
	});

	test('plan-approval-gate has check==true condition and reviewer writer role', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'plan-approval-gate')!;
		expect(gate.condition.type).toBe('check');
		expect((gate.condition as { field: string; value: unknown }).value).toBe(true);
		expect(gate.allowedWriterRoles).toContain('reviewer');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('code-pr-gate has check-exists condition and coder writer role', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'code-pr-gate')!;
		expect(gate.condition.type).toBe('check');
		expect((gate.condition as { op: string }).op).toBe('exists');
		expect(gate.allowedWriterRoles).toContain('coder');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('review-votes-gate has count condition requiring min 3 approved', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'review-votes-gate')!;
		expect(gate.condition.type).toBe('count');
		const cond = gate.condition as { matchValue: unknown; min: number };
		expect(cond.matchValue).toBe('approved');
		expect(cond.min).toBe(3);
		expect(gate.allowedWriterRoles).toContain('reviewer');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('review-reject-gate has count condition requiring min 1 rejected', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'review-reject-gate')!;
		expect(gate.condition.type).toBe('count');
		const cond = gate.condition as { matchValue: unknown; min: number };
		expect(cond.matchValue).toBe('rejected');
		expect(cond.min).toBe(1);
		expect(gate.allowedWriterRoles).toContain('reviewer');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('qa-result-gate has check==passed condition and qa writer role', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'qa-result-gate')!;
		expect(gate.condition.type).toBe('check');
		expect((gate.condition as { value: unknown }).value).toBe('passed');
		expect(gate.allowedWriterRoles).toContain('qa');
		expect(gate.resetOnCycle).toBe(false);
	});

	test('qa-fail-gate has check==failed condition and qa writer role', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'qa-fail-gate')!;
		expect(gate.condition.type).toBe('check');
		expect((gate.condition as { value: unknown }).value).toBe('failed');
		expect(gate.allowedWriterRoles).toContain('qa');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('has 15 channels', () => {
		expect(CODING_WORKFLOW_V2.channels).toHaveLength(15);
	});

	test('main progression channels have correct gateIds', () => {
		const ch = CODING_WORKFLOW_V2.channels!;

		const planToReview = ch.find((c) => c.from === 'Planning' && c.to === 'Plan Review');
		expect(planToReview?.gateId).toBe('plan-pr-gate');

		const reviewToCoding = ch.find((c) => c.from === 'Plan Review' && c.to === 'Coding');
		expect(reviewToCoding?.gateId).toBe('plan-approval-gate');

		const codingToRev1 = ch.find((c) => c.from === 'Coding' && c.to === 'Reviewer 1');
		expect(codingToRev1?.gateId).toBe('code-pr-gate');

		const codingToRev2 = ch.find((c) => c.from === 'Coding' && c.to === 'Reviewer 2');
		expect(codingToRev2?.gateId).toBe('code-pr-gate');

		const codingToRev3 = ch.find((c) => c.from === 'Coding' && c.to === 'Reviewer 3');
		expect(codingToRev3?.gateId).toBe('code-pr-gate');
	});

	test('reviewer-to-QA channels share review-votes-gate', () => {
		const ch = CODING_WORKFLOW_V2.channels!;
		const rev1ToQA = ch.find((c) => c.from === 'Reviewer 1' && c.to === 'QA');
		const rev2ToQA = ch.find((c) => c.from === 'Reviewer 2' && c.to === 'QA');
		const rev3ToQA = ch.find((c) => c.from === 'Reviewer 3' && c.to === 'QA');
		expect(rev1ToQA?.gateId).toBe('review-votes-gate');
		expect(rev2ToQA?.gateId).toBe('review-votes-gate');
		expect(rev3ToQA?.gateId).toBe('review-votes-gate');
	});

	test('QA-to-Done uses qa-result-gate', () => {
		const ch = CODING_WORKFLOW_V2.channels!.find((c) => c.from === 'QA' && c.to === 'Done');
		expect(ch?.gateId).toBe('qa-result-gate');
		expect(ch?.isCyclic).toBeUndefined();
	});

	test('cyclic channels are marked isCyclic', () => {
		const ch = CODING_WORKFLOW_V2.channels!;

		const qaToCoding = ch.find((c) => c.from === 'QA' && c.to === 'Coding');
		expect(qaToCoding?.gateId).toBe('qa-fail-gate');
		expect(qaToCoding?.isCyclic).toBe(true);

		const rev1ToCoding = ch.find((c) => c.from === 'Reviewer 1' && c.to === 'Coding');
		expect(rev1ToCoding?.gateId).toBe('review-reject-gate');
		expect(rev1ToCoding?.isCyclic).toBe(true);

		const rev2ToCoding = ch.find((c) => c.from === 'Reviewer 2' && c.to === 'Coding');
		expect(rev2ToCoding?.gateId).toBe('review-reject-gate');
		expect(rev2ToCoding?.isCyclic).toBe(true);

		const rev3ToCoding = ch.find((c) => c.from === 'Reviewer 3' && c.to === 'Coding');
		expect(rev3ToCoding?.gateId).toBe('review-reject-gate');
		expect(rev3ToCoding?.isCyclic).toBe(true);
	});

	test('ungated feedback channels have no gateId', () => {
		const ch = CODING_WORKFLOW_V2.channels!;
		const reviewToPlanning = ch.find((c) => c.from === 'Plan Review' && c.to === 'Planning');
		expect(reviewToPlanning).toBeDefined();
		expect(reviewToPlanning?.gateId).toBeUndefined();

		const codingToPlanning = ch.find((c) => c.from === 'Coding' && c.to === 'Planning');
		expect(codingToPlanning).toBeDefined();
		expect(codingToPlanning?.gateId).toBeUndefined();
	});

	test('all channels have direction one-way', () => {
		for (const ch of CODING_WORKFLOW_V2.channels!) {
			expect(ch.direction).toBe('one-way');
		}
	});

	test('all channel from/to fields reference valid node names', () => {
		const nodeNames = new Set(CODING_WORKFLOW_V2.nodes.map((n) => n.name));
		for (const ch of CODING_WORKFLOW_V2.channels!) {
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('reviewer nodes instruct read-merge-write for votes (not bare write)', () => {
		for (const name of ['Reviewer 1', 'Reviewer 2', 'Reviewer 3']) {
			const node = CODING_WORKFLOW_V2.nodes.find((n) => n.name === name)!;
			expect(node.instructions).toContain('read_gate');
			expect(node.instructions).toContain('write_gate');
			// Must warn against writing only own entry to prevent overwriting peers
			expect(node.instructions).toContain('overwriting');
		}
	});

	test('QA node instructions require explicit result write on every pass', () => {
		const qa = CODING_WORKFLOW_V2.nodes.find((n) => n.name === 'QA')!;
		expect(qa.instructions).toContain('every pass');
		expect(qa.instructions).toMatch(/do not assume/i);
	});

	test('review-votes-gate description mentions read-merge-write requirement', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'review-votes-gate')!;
		expect(gate.description).toContain('read-merge-write');
	});

	test('qa-result-gate description explains why resetOnCycle is false', () => {
		const gate = CODING_WORKFLOW_V2.gates!.find((g) => g.id === 'qa-result-gate')!;
		expect(gate.description).toContain('resetOnCycle');
		expect(gate.description).toMatch(/intentionally false/i);
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(CODING_WORKFLOW_V2)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(CODING_WORKFLOW_V2.id).toBe('');
		expect(CODING_WORKFLOW_V2.spaceId).toBe('');
	});

	test('maxIterations is set to 5', () => {
		expect(CODING_WORKFLOW_V2.maxIterations).toBe(5);
	});

	test('has the default tag so workflow selector ranks it first for coding requests', () => {
		expect(CODING_WORKFLOW_V2.tags).toContain('default');
	});

	test('has the coding tag', () => {
		expect(CODING_WORKFLOW_V2.tags).toContain('coding');
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

	test('includes CODING_WORKFLOW_V2', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW_V2.name);
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

	test('all agentId placeholders are valid builtin role names', () => {
		for (const wf of getBuiltInWorkflows()) {
			for (const step of wf.nodes) {
				// Built-in workflows use single-agent steps; agentId must be defined and a valid role name.
				expect(step.agentId).toBeDefined();
				expect(VALID_BUILTIN_ROLES.has(step.agentId!)).toBe(true);
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

	// Role resolver — mirrors what the real call site does
	const QA_ID = 'agent-qa-uuid';
	const roleMap: Record<string, string> = {
		planner: PLANNER_ID,
		coder: CODER_ID,
		general: GENERAL_ID,
		reviewer: 'agent-reviewer-uuid',
		qa: QA_ID,
	};
	const resolveAgentId = (role: string): string | undefined => roleMap[role];

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID);
		// Seed preset agents so the manager's agentLookup (when wired) would find them
		seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner', 'planner');
		seedAgent(db, CODER_ID, SPACE_ID, 'Coder', 'coder');
		seedAgent(db, GENERAL_ID, SPACE_ID, 'General', 'general');
		seedAgent(db, QA_ID, SPACE_ID, 'QA', 'qa');

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
		expect(names).toContain(CODING_WORKFLOW_V2.name);
		expect(names).toContain(RESEARCH_WORKFLOW.name);
		expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
	});

	test('CODING_WORKFLOW seeded correctly — four steps with real agent IDs', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(4);
		expect(wf!.nodes[0].agentId).toBe(PLANNER_ID);
		expect(wf!.nodes[1].agentId).toBe(CODER_ID);
		expect(wf!.nodes[2].agentId).toBe(GENERAL_ID);
		expect(wf!.nodes[3].agentId).toBe(GENERAL_ID);
	});

	test('CODING_WORKFLOW seeded with four channels and correct gate types', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(4);

		const humanChannel = wf.channels!.find((c) => c.gate?.type === 'human');
		expect(humanChannel).toBeDefined();
		expect(humanChannel!.from).toBe('Plan');
		expect(humanChannel!.to).toBe('Code');

		const alwaysChannel = wf.channels!.find((c) => c.gate?.type === 'always');
		expect(alwaysChannel).toBeDefined();
		expect(alwaysChannel!.from).toBe('Code');
		expect(alwaysChannel!.to).toBe('Verify & Test');

		const failedChannel = wf.channels!.find(
			(c) =>
				c.gate?.type === 'task_result' &&
				(c.gate as { expression?: string }).expression === 'failed'
		);
		expect(failedChannel).toBeDefined();
		expect(failedChannel!.isCyclic).toBe(true);

		const passedChannel = wf.channels!.find(
			(c) =>
				c.gate?.type === 'task_result' &&
				(c.gate as { expression?: string }).expression === 'passed'
		);
		expect(passedChannel).toBeDefined();
		expect(passedChannel!.isCyclic).toBeUndefined();
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
			// Channels use node names for routing (resolved at runtime, not seeding time)
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('CODING_WORKFLOW seeded with maxIterations', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf!.maxIterations).toBe(3);
	});

	test('CODING_WORKFLOW seeded Verify step has instructions', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		const verifyStep = wf!.nodes.find((s) => s.name === 'Verify & Test');
		expect(verifyStep).toBeDefined();
		expect(verifyStep!.instructions).toContain('Run tests');
	});

	test('RESEARCH_WORKFLOW seeded with one channel (Plan Research → Research, always gate)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(1);
		const ch = wf.channels![0];
		expect(ch.from).toBe('Plan Research');
		expect(ch.to).toBe('Research');
		expect(ch.gate?.type).toBe('always');
	});

	test('RESEARCH_WORKFLOW seeded correctly — planner + general', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(2);
		expect(wf!.nodes[0].agentId).toBe(PLANNER_ID);
		expect(wf!.nodes[1].agentId).toBe(GENERAL_ID);
	});

	test('RESEARCH_WORKFLOW seeded channel direction is one-way and from/to are node names', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		const ch = wf.channels![0];
		expect(ch.direction).toBe('one-way');
		const nodeNames = new Set(wf.nodes.map((n) => n.name));
		expect(nodeNames.has(ch.from as string)).toBe(true);
		expect(nodeNames.has(ch.to as string)).toBe(true);
	});

	test('REVIEW_ONLY_WORKFLOW seeded with no channels', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.channels ?? []).toHaveLength(0);
	});

	test('REVIEW_ONLY_WORKFLOW seeded correctly — single coder step', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(1);
		expect(wf!.nodes[0].agentId).toBe(CODER_ID);
	});

	test('CODING_WORKFLOW_V2 seeded correctly — eight nodes with real agent IDs', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW_V2.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(8);
		expect(wf!.nodes[0].agentId).toBe(PLANNER_ID); // Planning
		expect(wf!.nodes[1].agentId).toBe(roleMap.reviewer); // Plan Review
		expect(wf!.nodes[2].agentId).toBe(CODER_ID); // Coding
		expect(wf!.nodes[3].agentId).toBe(roleMap.reviewer); // Reviewer 1
		expect(wf!.nodes[4].agentId).toBe(roleMap.reviewer); // Reviewer 2
		expect(wf!.nodes[5].agentId).toBe(roleMap.reviewer); // Reviewer 3
		expect(wf!.nodes[6].agentId).toBe(QA_ID); // QA
		expect(wf!.nodes[7].agentId).toBe(GENERAL_ID); // Done
	});

	test('CODING_WORKFLOW_V2 seeded with 15 channels', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW_V2.name)!;
		expect(wf.channels).toHaveLength(15);
	});

	test('CODING_WORKFLOW_V2 seeded with 7 gates', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW_V2.name)!;
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

	test('CODING_WORKFLOW_V2 seeded channels use gateId (not legacy gate)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW_V2.name)!;
		const gatedChannels = wf.channels!.filter((c) => c.gateId !== undefined);
		// 13 channels have gateIds (15 total minus 2 ungated feedback channels)
		expect(gatedChannels).toHaveLength(13);
	});

	test('CODING_WORKFLOW_V2 seeded cyclic channels are marked isCyclic', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW_V2.name)!;
		const cyclicChannels = wf.channels!.filter((c) => c.isCyclic === true);
		// 4 cyclic: QA→Coding, Reviewer1→Coding, Reviewer2→Coding, Reviewer3→Coding
		expect(cyclicChannels).toHaveLength(4);
	});

	test('CODING_WORKFLOW_V2 seeded channels from/to fields are node names (not UUIDs)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW_V2.name)!;
		const nodeNames = new Set(wf.nodes.map((n) => n.name));
		for (const ch of wf.channels!) {
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('CODING_WORKFLOW_V2 seeded with default tag for workflow selector ranking', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW_V2.name)!;
		expect(wf.tags).toContain('default');
	});

	test('CODING_WORKFLOW_V2 seeded alongside CODING_WORKFLOW_V1 — both present', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
		expect(names).toContain(CODING_WORKFLOW_V2.name);
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
		// Resolver that cannot resolve 'planner'
		const brokenResolver = (role: string): string | undefined =>
			role === 'planner' ? undefined : roleMap[role];

		expect(() => seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver)).toThrow(
			"no SpaceAgent found for role 'planner'"
		);
	});

	test('does not persist any workflow when resolveAgentId fails on first-template role', async () => {
		// Resolver fails on 'planner' — first template's first step
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
		// 'general' is used by both CODING_WORKFLOW and RESEARCH_WORKFLOW.
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

	const roleMap: Record<string, string> = {
		planner: PLANNER_ID,
		coder: CODER_ID,
		general: GENERAL_ID,
		reviewer: 'agent-reviewer-uuid',
		qa: QA_ID,
	};
	const resolveAgentId = (role: string): string | undefined => roleMap[role];

	/** Mock SpaceAgent records for exportWorkflow's agent name resolution. */
	const mockAgents: SpaceAgent[] = [
		{
			id: PLANNER_ID,
			spaceId: SPACE_ID,
			name: 'Planner',
			role: 'planner',
			description: '',
			model: null,
			tools: [],
			systemPrompt: '',
			config: null,
			createdAt: 0,
			updatedAt: 0,
		},
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
			id: GENERAL_ID,
			spaceId: SPACE_ID,
			name: 'General',
			role: 'general',
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
		seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner', 'planner');
		seedAgent(db, CODER_ID, SPACE_ID, 'Coder', 'coder');
		seedAgent(db, GENERAL_ID, SPACE_ID, 'General', 'general');
		seedAgent(db, QA_ID, SPACE_ID, 'QA', 'qa');

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

	test('exported Coding Workflow preserves isCyclic on Verify→Plan channel', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);
		expect(exported.channels).toBeDefined();

		const verifyToPlan = exported.channels!.find(
			(c) => c.from === 'Verify & Test' && c.to === 'Plan'
		);
		expect(verifyToPlan).toBeDefined();
		expect(verifyToPlan!.isCyclic).toBe(true);

		const verifyToDone = exported.channels!.find(
			(c) => c.from === 'Verify & Test' && c.to === 'Done'
		);
		expect(verifyToDone).toBeDefined();
		expect(verifyToDone!.isCyclic).toBeUndefined();
	});

	test('exported Coding Workflow preserves task_result gate conditions on channels', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);

		const taskResultChannels = (exported.channels ?? []).filter(
			(c) => c.gate?.type === 'task_result'
		);
		expect(taskResultChannels).toHaveLength(2);

		const failedChannel = taskResultChannels.find(
			(c) => (c.gate as { expression?: string }).expression === 'failed'
		);
		expect(failedChannel).toBeDefined();

		const passedChannel = taskResultChannels.find(
			(c) => (c.gate as { expression?: string }).expression === 'passed'
		);
		expect(passedChannel).toBeDefined();
	});

	test('re-imported Coding Workflow preserves channels with isCyclic and task_result gates', () => {
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
				agentId: agentNameToId.get(s.agentRef) ?? s.agentRef,
				instructions: s.instructions,
			})),
			transitions: [],
			startNodeId: undefined,
			rules: [],
			tags: exported.tags,
			channels: exported.channels,
		});

		// Verify the re-imported workflow
		const reimported = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(reimported).toBeDefined();
		expect(reimported.nodes).toHaveLength(4);
		expect(reimported.channels).toHaveLength(4);

		// isCyclic preserved on Verify→Plan channel
		const verifyToPlan = reimported.channels!.find(
			(c) =>
				c.gate?.type === 'task_result' &&
				(c.gate as { expression?: string }).expression === 'failed'
		);
		expect(verifyToPlan).toBeDefined();
		expect(verifyToPlan!.isCyclic).toBe(true);

		// Non-cyclic channel should not have isCyclic
		const verifyToDone = reimported.channels!.find(
			(c) =>
				c.gate?.type === 'task_result' &&
				(c.gate as { expression?: string }).expression === 'passed'
		);
		expect(verifyToDone).toBeDefined();
		expect(verifyToDone!.isCyclic).toBeUndefined();
	});
});
