/**
 * Built-in Workflow Templates Unit Tests
 *
 * Covers:
 * - Template structure: correct agentId placeholders, transition conditions, step count
 * - agentId placeholders are valid builtin role names (no 'leader')
 * - getBuiltInWorkflows() returns all built-in templates
 * - seedBuiltInWorkflows(): seeds all built-in templates with real agent IDs
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
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
	CODING_WORKFLOW,
	FULL_CYCLE_CODING_WORKFLOW,
	FULLSTACK_QA_LOOP_WORKFLOW,
	RESEARCH_WORKFLOW,
	REVIEW_ONLY_WORKFLOW,
	getBuiltInWorkflows,
	seedBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import {
	exportWorkflow,
	validateExportedWorkflow,
} from '../../../../src/lib/space/export-format.ts';

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
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, custom_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', null, ?, ?)`
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
	test('has three nodes: Coding, Review, Done', () => {
		expect(CODING_WORKFLOW.nodes).toHaveLength(3);
		expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual(['Coding', 'Review', 'Done']);
	});

	test('step agentId placeholders are correct', () => {
		expect(CODING_WORKFLOW.nodes[0].agents[0]?.name).toBe('coder');
		expect(CODING_WORKFLOW.nodes[1].agents[0]?.name).toBe('reviewer');
		expect(CODING_WORKFLOW.nodes[2].agents[0]?.name).toBe('closer');
	});

	test('Done node uses the General preset agent so any space has it', () => {
		const doneNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Done')!;
		expect(doneNode.agents[0]?.agentId).toBe('General');
	});

	test('Done node carries the merge-pr completion action (not Review)', () => {
		const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
		const doneNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Done')!;
		expect(reviewNode.completionActions ?? []).toEqual([]);
		expect(doneNode.completionActions).toBeDefined();
		expect(doneNode.completionActions!.map((a) => a.id)).toContain('merge-pr');
	});

	test('has three channels', () => {
		expect(CODING_WORKFLOW.channels).toHaveLength(3);
	});

	test('Coding → Review channel is gated by code-ready-gate', () => {
		const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
		expect(ch).toBeDefined();
		expect(ch!.gateId).toBe('code-ready-gate');
		// direction field removed from WorkflowChannel
		expect(ch!.maxCycles).toBeUndefined();
	});

	test('Review → Coding channel is gated by review-posted-gate with maxCycles', () => {
		const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
		expect(ch).toBeDefined();
		// The review-posted-gate closes the feedback-loop gap where the reviewer
		// summarizes feedback internally without posting to GitHub.
		expect(ch!.gateId).toBe('review-posted-gate');
		// direction field removed from WorkflowChannel
		expect(ch!.maxCycles).toBe(5);
	});

	test('Review → Done channel is gated by review-approval-gate', () => {
		const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Review' && c.to === 'Done');
		expect(ch).toBeDefined();
		expect(ch!.gateId).toBe('review-approval-gate');
		// Not cyclic — one-shot approval handoff
		expect(ch!.maxCycles).toBeUndefined();
	});

	test('all channels have direction one-way', () => {
		for (const ch of CODING_WORKFLOW.channels!) {
			expect('direction' in ch).toBe(false); // direction field removed
		}
	});

	test('all channel from/to fields reference valid node names', () => {
		const nodeNames = new Set(CODING_WORKFLOW.nodes.map((n) => n.name));
		for (const ch of CODING_WORKFLOW.channels!) {
			expect(nodeNames.has(ch.from as string)).toBe(true);
			expect(nodeNames.has(ch.to as string)).toBe(true);
		}
	});

	test('has three gates: code-ready-gate, review-posted-gate, and review-approval-gate', () => {
		expect(CODING_WORKFLOW.gates).toHaveLength(3);
		const gateIds = CODING_WORKFLOW.gates!.map((g) => g.id).sort();
		expect(gateIds).toEqual(['code-ready-gate', 'review-approval-gate', 'review-posted-gate']);
	});

	test('review-posted-gate has review_url field writable only by reviewer', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
		const field = gate.fields.find((f) => f.name === 'review_url')!;
		expect(field.type).toBe('string');
		expect(field.writers).toEqual(['reviewer']);
		expect(field.check.op).toBe('exists');
	});

	test('review-posted-gate has bash script verifying a review submitted after workflow start', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
		expect(gate.script).toBeDefined();
		expect(gate.script!.interpreter).toBe('bash');
		expect(gate.script!.timeoutMs).toBe(30000);
		// The script must consult the workflow start timestamp injected by the runner.
		expect(gate.script!.source).toContain('NEOKAI_WORKFLOW_START_ISO');
		// And query GitHub for the reviews list via the PR URL.
		expect(gate.script!.source).toContain('gh pr view "$PR_URL" --json reviews');
		expect(gate.script!.source).toContain('submittedAt');
		// Must fail loudly when no review has landed since start.
		expect(gate.script!.source).toContain('exit 1');
		// Must echo pr_url/review_count on success for downstream consumers.
		expect(gate.script!.source).toContain('pr_url');
		expect(gate.script!.source).toContain('review_count');
	});

	test('review-posted-gate resets on cycle so each feedback round is re-verified', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
		expect(gate.resetOnCycle).toBe(true);
	});

	test('code-ready-gate has pr_url field writable only by Coding', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
		const prField = gate.fields.find((f) => f.name === 'pr_url')!;
		expect(prField.type).toBe('string');
		expect(prField.writers).toEqual(['Coding']);
		expect(prField.check.op).toBe('exists');
	});

	test('review-approval-gate has an approved boolean field writable by reviewer', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
		expect(gate.fields).toHaveLength(1);
		const approved = gate.fields.find((f) => f.name === 'approved')!;
		expect(approved).toBeDefined();
		expect(approved.type).toBe('boolean');
		expect(approved.writers).toEqual(['reviewer']);
		expect(approved.check).toEqual({ op: '==', value: true });
	});

	test('review-approval-gate does NOT reset on cycle (terminal approval)', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
		expect(gate.resetOnCycle).toBe(false);
	});

	test('review-approval-gate has no script (pure boolean approval, not a PR check)', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
		expect(gate.script).toBeUndefined();
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

	test('startNodeId points to the Coding step', () => {
		const codeStep = CODING_WORKFLOW.nodes.find((s) => s.agents[0]?.name === 'coder');
		expect(CODING_WORKFLOW.startNodeId).toBe(codeStep?.id);
	});

	test('endNodeId points to the Done step (not Review — approval gate must open first)', () => {
		const doneStep = CODING_WORKFLOW.nodes.find((s) => s.name === 'Done');
		expect(CODING_WORKFLOW.endNodeId).toBe(doneStep?.id);
	});

	test('endNodeId references a valid node in the graph', () => {
		const nodeIds = new Set(CODING_WORKFLOW.nodes.map((n) => n.id));
		expect(nodeIds.has(CODING_WORKFLOW.endNodeId!)).toBe(true);
	});

	test('the only path into the endNode is the approval-gated Review → Done channel', () => {
		const doneNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Done')!;
		const channelsIntoDone = CODING_WORKFLOW.channels!.filter((c) => {
			const tos = Array.isArray(c.to) ? c.to : [c.to];
			return tos.includes(doneNode.name);
		});
		expect(channelsIntoDone).toHaveLength(1);
		expect(channelsIntoDone[0].gateId).toBe('review-approval-gate');
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(CODING_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(CODING_WORKFLOW.id).toBe('');
		expect(CODING_WORKFLOW.spaceId).toBe('');
	});
});

test('CODING_WORKFLOW nodes define customPrompt with non-empty value', () => {
	for (const node of CODING_WORKFLOW.nodes) {
		for (const agent of node.agents) {
			expect(agent.customPrompt).toBeDefined();
			expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
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
		// direction field removed from WorkflowChannel

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

	test('nodes have agents with non-empty customPrompt', () => {
		for (const node of RESEARCH_WORKFLOW.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
			}
		}
	});

	test('RESEARCH_WORKFLOW nodes define customPrompt with non-empty value', () => {
		for (const node of RESEARCH_WORKFLOW.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
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

	test('REVIEW_ONLY_WORKFLOW node defines customPrompt with non-empty value', () => {
		const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
		expect(agent.customPrompt).toBeDefined();
		expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
	});
});

describe('FULL_CYCLE_CODING_WORKFLOW template', () => {
	test('has five nodes', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.nodes).toHaveLength(5);
	});

	test('node names are correct', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.nodes.map((n) => n.name)).toEqual([
			'Planning',
			'Plan Review',
			'Coding',
			'Code Review',
			'QA',
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
	});

	test('all V2 nodes define explicit custom prompts', () => {
		// customPrompt is on each WorkflowNodeAgent, not on WorkflowNode
		for (const node of FULL_CYCLE_CODING_WORKFLOW.nodes) {
			for (const agent of node.agents) {
				expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('startNodeId points to the Planning (planner) node', () => {
		const planningNode = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Planning');
		expect(FULL_CYCLE_CODING_WORKFLOW.startNodeId).toBe(planningNode?.id);
	});

	test('endNodeId points to the QA node', () => {
		const qaNode = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'QA');
		expect(FULL_CYCLE_CODING_WORKFLOW.endNodeId).toBe(qaNode?.id);
	});

	test('endNodeId references a valid node in the graph', () => {
		const nodeIds = new Set(FULL_CYCLE_CODING_WORKFLOW.nodes.map((n) => n.id));
		expect(nodeIds.has(FULL_CYCLE_CODING_WORKFLOW.endNodeId!)).toBe(true);
	});

	test('has four gates', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.gates).toHaveLength(4);
	});

	test('gate IDs are correct', () => {
		const ids = FULL_CYCLE_CODING_WORKFLOW.gates!.map((g) => g.id);
		expect(ids).toContain('plan-pr-gate');
		expect(ids).toContain('plan-approval-gate');
		expect(ids).toContain('code-pr-gate');
		expect(ids).toContain('review-votes-gate');
	});

	test('plan-pr-gate has script-based PR check with pr_url output', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'plan-pr-gate')!;
		expect(gate.fields).toHaveLength(1);
		expect(gate.fields[0].name).toBe('pr_url');
		expect(gate.fields[0].type).toBe('string');
		expect(gate.fields[0].check.op).toBe('exists');
		expect(gate.fields[0].writers).toEqual(['*']);
		expect(gate.script?.interpreter).toBe('bash');
		expect(gate.script?.source.length).toBeGreaterThan(0);
		expect(gate.resetOnCycle).toBe(false);
	});

	test('plan-approval-gate has boolean == true field with requiredLevel for auto-approval', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
		expect(gate.fields[0].name).toBe('approved');
		expect(gate.fields[0].check).toMatchObject({ op: '==', value: true });
		expect(gate.fields[0].writers).toEqual([]);
		expect(gate.label).toBe('Approval');
		expect(gate.requiredLevel).toBe(3);
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

	test('has 8 node-level channels', () => {
		expect(FULL_CYCLE_CODING_WORKFLOW.channels).toHaveLength(8);
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

	test('cyclic channels have maxCycles set', () => {
		const ch = FULL_CYCLE_CODING_WORKFLOW.channels!;

		const qaToCoding = ch.find((c) => c.from === 'QA' && c.to === 'Coding');
		expect(qaToCoding?.gateId).toBeUndefined();
		expect(qaToCoding?.maxCycles).toBe(5);

		const reviewToCoding = ch.find((c) => c.from === 'Code Review' && c.to === 'Coding');
		expect(reviewToCoding?.gateId).toBeUndefined();
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
		const reviewToCoding = ch.find((c) => c.from === 'Code Review' && c.to === 'Coding');
		expect(reviewToCoding).toBeDefined();
		expect(reviewToCoding?.gateId).toBeUndefined();

		const qaToCoding = ch.find((c) => c.from === 'QA' && c.to === 'Coding');
		expect(qaToCoding).toBeDefined();
		expect(qaToCoding?.gateId).toBeUndefined();

		const reviewToPlanning = ch.find((c) => c.from === 'Plan Review' && c.to === 'Planning');
		expect(reviewToPlanning).toBeDefined();
		expect(reviewToPlanning?.gateId).toBeUndefined();

		const codingToPlanning = ch.find((c) => c.from === 'Coding' && c.to === 'Planning');
		expect(codingToPlanning).toBeDefined();
		expect(codingToPlanning?.gateId).toBeUndefined();
	});

	test('all channels have direction one-way', () => {
		for (const ch of FULL_CYCLE_CODING_WORKFLOW.channels!) {
			expect('direction' in ch).toBe(false); // direction field removed
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

	test('code review node contains three reviewer slots with read-merge-write customPrompt', () => {
		const reviewNode = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Code Review')!;
		expect(reviewNode.agents).toHaveLength(3);
		for (const slot of reviewNode.agents ?? []) {
			// slot.customPrompt contains the task instructions
			expect(slot.customPrompt?.value).toContain('read_gate');
			expect(slot.customPrompt?.value).toContain('write_gate');
			// Must warn against writing only own entry to prevent overwriting peers.
			expect(slot.customPrompt?.value).toContain('overwriting');
		}
	});

	test('QA node agent slot customPrompt describes pass and fail actions', () => {
		const qa = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'QA')!;
		// Node-level instructions were removed; agent slots carry the task instructions
		expect(qa.agents[0].customPrompt?.value).toContain('report_result');
	});

	test('review-votes-gate description mentions read-merge-write requirement', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'review-votes-gate')!;
		expect(gate.description).toContain('read-merge-write');
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
	test('returns exactly five templates', () => {
		expect(getBuiltInWorkflows()).toHaveLength(5);
	});

	test('includes CODING_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
	});

	test('includes FULL_CYCLE_CODING_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(FULL_CYCLE_CODING_WORKFLOW.name);
	});

	test('includes FULLSTACK_QA_LOOP_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);
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

	test('seeds all built-in templates for an empty space', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(5);
	});

	test('seeded workflow names match all templates', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
		expect(names).toContain(FULL_CYCLE_CODING_WORKFLOW.name);
		expect(names).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);
		expect(names).toContain(RESEARCH_WORKFLOW.name);
		expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
	});

	test('Full-Cycle Coding Workflow seeding preserves explicit node custom prompts', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		// customPrompt is on each WorkflowNodeAgent, not on WorkflowNode
		for (const node of wf!.nodes) {
			for (const agent of node.agents) {
				expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('CODING_WORKFLOW seeding preserves node custom prompts with non-empty value', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		for (const node of wf!.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('RESEARCH_WORKFLOW seeding preserves node custom prompts with non-empty value', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		for (const node of wf!.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('CODING_WORKFLOW seeded correctly — three nodes with real agent IDs', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(3);
		expect(wf!.nodes[0].agents[0]?.agentId).toBe(CODER_ID);
		expect(wf!.nodes[1].agents[0]?.agentId).toBe(roleMap.reviewer);
		// Done node uses the General preset agent
		expect(wf!.nodes[2].agents[0]?.agentId).toBe(roleMap.general);
	});

	test('CODING_WORKFLOW seeded with three channels (Coding→Review gated, Review→Coding cyclic, Review→Done approval-gated)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(3);

		const codeToReview = wf.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
		expect(codeToReview).toBeDefined();
		expect(codeToReview!.gateId).toBe('code-ready-gate');

		const reviewToCode = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
		expect(reviewToCode).toBeDefined();
		// Review → Coding is now gated by review-posted-gate so the reviewer's
		// message cannot be delivered until a GitHub review is visible.
		expect(reviewToCode!.gateId).toBe('review-posted-gate');
		expect(reviewToCode!.maxCycles).toBe(5);

		const reviewToDone = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Done');
		expect(reviewToDone).toBeDefined();
		expect(reviewToDone!.gateId).toBe('review-approval-gate');
	});

	test('CODING_WORKFLOW seeded with three gates (code-ready-gate, review-posted-gate, review-approval-gate)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.gates).toHaveLength(3);
		const gateIds = wf.gates!.map((g) => g.id).sort();
		expect(gateIds).toEqual(['code-ready-gate', 'review-approval-gate', 'review-posted-gate']);
	});

	test('CODING_WORKFLOW seeded channels all have direction one-way', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		for (const ch of wf.channels!) {
			expect('direction' in ch).toBe(false); // direction field removed
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
			expect('direction' in ch).toBe(false); // direction field removed
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

	test('FULL_CYCLE_CODING_WORKFLOW seeded correctly — five nodes with code-review agents[]', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(5);
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
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded with 8 node-level channels', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(8);
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded with 4 gates', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		expect(wf.gates).toHaveLength(4);
		const gateIds = wf.gates!.map((g) => g.id);
		expect(gateIds).toContain('plan-pr-gate');
		expect(gateIds).toContain('plan-approval-gate');
		expect(gateIds).toContain('code-pr-gate');
		expect(gateIds).toContain('review-votes-gate');
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded channels use gateId (not legacy gate)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const gatedChannels = wf.channels!.filter((c) => c.gateId !== undefined);
		// 4 channels have gateIds (8 total minus 4 ungated feedback/cycle channels)
		expect(gatedChannels).toHaveLength(4);
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
		expect(workflows).toHaveLength(5);
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
		// 'qa' is used by FULL_CYCLE_CODING_WORKFLOW and FULLSTACK_QA_LOOP_WORKFLOW.
		// Pre-validation catches missing roles before any workflow is persisted.
		const brokenResolver = (role: string): string | undefined =>
			role === 'qa' ? undefined : roleMap[role];

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
		expect(result.seeded).toHaveLength(5);
		expect(result.seeded).toContain('Coding Workflow');
		expect(result.seeded).toContain('Full-Cycle Coding Workflow');
		expect(result.seeded).toContain('Coding with QA Workflow');
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

		// 4 of 5 succeed, 1 fails
		expect(result.seeded).toHaveLength(4);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain('Simulated DB constraint error');
		expect(result.skipped).toBe(false);

		// Verify 4 workflows were actually persisted
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(4);
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
		expect(result.errors).toHaveLength(5);
		expect(result.skipped).toBe(false);
		for (const err of result.errors) {
			expect(err.error).toContain('DB is read-only');
		}
	});

	// ─── Node ID replacement tests ─────────────────────────────────────────

	test('seeded node IDs are real UUIDs, not template placeholders', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const templatePrefixes = [
			'tpl-coding-',
			'tpl-v2-',
			'tpl-fullstack-',
			'tpl-research-',
			'tpl-review-',
		];
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

	test('CODING_WORKFLOW seeded nodes preserve customPrompt content', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const codeNode = wf.nodes.find((n) => n.name === 'Coding');
		expect(codeNode?.agents[0].customPrompt?.value).toContain('gh pr create');
		// Reviewer hands off via send_message to Done with an approval payload —
		// it does NOT call report_result (that tool is only wired for the end node).
		const reviewNode = wf.nodes.find((n) => n.name === 'Review');
		expect(reviewNode?.agents[0].customPrompt?.value).toContain('target="Done"');
		expect(reviewNode?.agents[0].customPrompt?.value).toContain('approved: true');
		// Done node is the one that calls report_result to finalize the workflow.
		const doneNode = wf.nodes.find((n) => n.name === 'Done');
		expect(doneNode?.agents[0].customPrompt?.value).toContain('report_result(');
	});

	test('CODING_WORKFLOW seeded Done node carries the merge-pr completion action', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const doneNode = wf.nodes.find((n) => n.name === 'Done')!;
		expect(doneNode.completionActions).toBeDefined();
		expect(doneNode.completionActions!.map((a) => a.id)).toContain('merge-pr');
		// Review node no longer holds the completion action — it's been moved to Done.
		const reviewNode = wf.nodes.find((n) => n.name === 'Review')!;
		expect(reviewNode.completionActions ?? []).toEqual([]);
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded nodes preserve customPrompt content', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const planNode = wf.nodes.find((n) => n.name === 'Planning');
		expect(planNode?.agents[0].customPrompt?.value).toContain('plan-pr-gate');
		const codingNode = wf.nodes.find((n) => n.name === 'Coding');
		expect(codingNode?.agents[0].customPrompt?.value).toContain('code-pr-gate');
		const qaNode = wf.nodes.find((n) => n.name === 'QA');
		expect(qaNode?.agents[0].customPrompt?.value).toContain('report_result');
	});

	test('RESEARCH_WORKFLOW seeded nodes preserve customPrompt content', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		const researchNode = wf.nodes.find((n) => n.name === 'Research');
		expect(researchNode?.agents[0].customPrompt?.value).toContain('gh pr create');
		const reviewNode = wf.nodes.find((n) => n.name === 'Review');
		expect(reviewNode?.agents[0].customPrompt?.value).toContain('report_result(');
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

	// ─── Channel ID assignment ──────────────────────────────────────────────

	test('all seeded channels have non-empty id fields', () => {
		// WorkflowCanvas filters channels without an id (ch.id must be truthy).
		// seedBuiltInWorkflows must assign UUIDs so all channels are visible.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			for (const ch of wf.channels ?? []) {
				expect(ch.id).toBeTruthy();
				expect(ch.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			}
		}
	});

	test('seeded channels retain all original fields plus a UUID id', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const codeToReview = wf.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
		expect(codeToReview).toBeDefined();
		expect(codeToReview!.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
		expect(codeToReview!.gateId).toBe('code-ready-gate');
		// direction field removed from WorkflowChannel schema
	});

	// ─── plan-approval-gate auto-approval via requiredLevel ──────────────────

	test('FULL_CYCLE_CODING_WORKFLOW plan-approval-gate uses requiredLevel instead of human writer', () => {
		const gate = FULL_CYCLE_CODING_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
		const approvedField = gate.fields.find((f) => f.name === 'approved')!;
		expect(approvedField.writers).toEqual([]);
		expect(gate.requiredLevel).toBe(3);
	});

	test('seeded plan-approval-gate preserves requiredLevel and external-only writers', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const gate = wf.gates!.find((g) => g.id === 'plan-approval-gate')!;
		const approvedField = gate.fields.find((f) => f.name === 'approved')!;
		expect(approvedField.writers).toEqual([]);
		expect(gate.requiredLevel).toBe(3);
	});

	// ─── getBuiltInWorkflows ordering ────────────────────────────────────────

	test('getBuiltInWorkflows returns FULL_CYCLE_CODING_WORKFLOW first', () => {
		// FULL_CYCLE_CODING_WORKFLOW is first so spaceWorkflowRun.start (which picks
		// workflows[0] ordered by created_at ASC) defaults to the comprehensive workflow.
		const templates = getBuiltInWorkflows();
		expect(templates[0].name).toBe(FULL_CYCLE_CODING_WORKFLOW.name);
	});

	test('listWorkflows returns FULL_CYCLE_CODING_WORKFLOW first after DB seeding', () => {
		// Verifies the DB-level ordering guarantee: listWorkflows uses
		// ORDER BY created_at ASC, rowid ASC. When all workflows are seeded within
		// the same millisecond, rowid (insertion order) is the tiebreaker, so
		// FULL_CYCLE_CODING_WORKFLOW (seeded first) must be returned at index 0.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows[0].name).toBe(FULL_CYCLE_CODING_WORKFLOW.name);
	});

	test('getBuiltInWorkflows returns all five templates', () => {
		const templates = getBuiltInWorkflows();
		expect(templates).toHaveLength(5);
		const names = templates.map((t) => t.name);
		expect(names).toContain(FULL_CYCLE_CODING_WORKFLOW.name);
		expect(names).toContain(CODING_WORKFLOW.name);
		expect(names).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);
		expect(names).toContain(RESEARCH_WORKFLOW.name);
		expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
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
		// Templates use title-case role placeholders that must resolve case-insensitively.
		expect(wf.nodes[0].agents[0]?.agentId).toBe(PLANNER_ID);
		expect(wf.nodes[2].agents[0]?.agentId).toBe(CODER_ID);
		expect(wf.nodes[4].agents[0]?.agentId).toBe(QA_ID);
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

	// ─── customPrompt design ─────────────────────────────────────────────────

	test('CODING_WORKFLOW seeded with non-empty customPrompt on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('RESEARCH_WORKFLOW seeded with non-empty customPrompt on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('REVIEW_ONLY_WORKFLOW seeded with non-empty customPrompt on reviewer slot', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.nodes).toHaveLength(1);
		const agent = wf.nodes[0].agents[0];
		expect(agent.customPrompt).toBeDefined();
		expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
	});

	test('FULL_CYCLE_CODING_WORKFLOW seeded with non-empty customPrompt on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('FULL_CYCLE_CODING_WORKFLOW Code Review node reviewer slots have customPrompt containing slot name', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const codeReviewNode = wf.nodes.find((n) => n.name === 'Code Review')!;
		expect(codeReviewNode.agents).toHaveLength(3);
		for (const agent of codeReviewNode.agents) {
			expect(agent.customPrompt).toBeDefined();
			expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
			// Each reviewer's customPrompt should contain their specific slot name
			expect(agent.customPrompt!.value).toContain(agent.name);
		}
	});

	test('FULL_CYCLE_CODING_WORKFLOW non-Code-Review nodes have non-empty customPrompt', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === FULL_CYCLE_CODING_WORKFLOW.name)!;
		const nonReviewNodes = wf.nodes.filter((n) => n.name !== 'Code Review');
		expect(nonReviewNodes.length).toBe(4); // Planning, Plan Review, Coding, QA
		for (const node of nonReviewNodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('all seeded workflows have non-empty customPrompt on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);

		for (const wf of workflows) {
			for (const node of wf.nodes) {
				for (const agent of node.agents) {
					expect(agent.customPrompt).toBeDefined();
					expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
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
			customPrompt: null,
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: RESEARCH_ID,
			spaceId: SPACE_ID,
			name: 'Research',
			customPrompt: null,
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: REVIEWER_ID,
			spaceId: SPACE_ID,
			name: 'Reviewer',
			customPrompt: null,
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: GENERAL_ID,
			spaceId: SPACE_ID,
			name: 'General',
			customPrompt: null,
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

	test('exported Coding Workflow preserves three channels including the Review→Done approval handoff', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);
		expect(exported.channels).toBeDefined();
		// gateId is stripped during export (gates are separate entities)
		expect(exported.channels).toHaveLength(3);

		const reviewToCode = exported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
		expect(reviewToCode).toBeDefined();
		expect(reviewToCode!.maxCycles).toBe(5);

		const reviewToDone = exported.channels!.find((c) => c.from === 'Review' && c.to === 'Done');
		expect(reviewToDone).toBeDefined();
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
		expect(reimported.nodes).toHaveLength(3);
		expect(reimported.channels).toHaveLength(3);

		// Coding → Review channel preserved
		const codeToReview = reimported.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
		expect(codeToReview).toBeDefined();

		// Review → Coding channel preserved with maxCycles
		const reviewToCode = reimported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
		expect(reviewToCode).toBeDefined();
		expect(reviewToCode!.maxCycles).toBe(5);

		// Review → Done approval-gated handoff preserved
		const reviewToDone = reimported.channels!.find((c) => c.from === 'Review' && c.to === 'Done');
		expect(reviewToDone).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Agent slot prompt completeness tests
// ---------------------------------------------------------------------------

describe('all built-in workflows have non-empty agent slot prompts', () => {
	const workflows = getBuiltInWorkflows();

	test('every workflow template node has at least one agent', () => {
		for (const wf of workflows) {
			for (const node of wf.nodes) {
				expect(node.agents.length).toBeGreaterThan(0);
			}
		}
	});

	test('every agent slot has a non-empty customPrompt override', () => {
		for (const wf of workflows) {
			for (const node of wf.nodes) {
				for (const agent of node.agents) {
					expect(agent.customPrompt).toBeDefined();
					expect(agent.customPrompt?.value?.trim().length).toBeGreaterThan(0);
				}
			}
		}
	});

	test('customPrompt values contain meaningful content (at least 50 chars)', () => {
		for (const wf of workflows) {
			for (const node of wf.nodes) {
				for (const agent of node.agents) {
					const len = agent.customPrompt?.value?.trim().length ?? 0;
					expect(len).toBeGreaterThanOrEqual(50);
				}
			}
		}
	});
});

describe('CODING_WORKFLOW agent slot customPrompt', () => {
	test('Coding node coder has non-empty customPrompt', () => {
		const codeNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
		const coder = codeNode.agents[0];
		expect(coder.customPrompt?.value).toBeDefined();
		expect(coder.customPrompt?.value.trim().length).toBeGreaterThan(0);
	});

	test('Coding node coder customPrompt teaches inline reply via gh api when re-activated', () => {
		const codeNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
		const coder = codeNode.agents[0];
		const prompt = coder.customPrompt!.value;
		// The coder must be told where to find the review links on re-activation
		// and how to reply inline so each GitHub thread gets a visible response.
		expect(prompt).toContain('review_url');
		expect(prompt).toContain('comment_urls');
		expect(prompt).toContain('/replies');
	});

	test('Review node reviewer prompt instructs approval via send_message to Done (not report_result)', () => {
		const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
		const reviewer = reviewNode.agents[0];
		expect(reviewer.customPrompt?.value).toBeDefined();
		expect(reviewer.customPrompt!.value).toContain('target="Done"');
		expect(reviewer.customPrompt!.value).toContain('approved: true');
		// The Reviewer does NOT call report_result — it's an end-node-only tool now,
		// and the end node is Done.
		expect(reviewer.customPrompt!.value).not.toContain('report_result(status');
	});

	test('Done node closer prompt instructs immediate report_result', () => {
		const doneNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Done')!;
		const closer = doneNode.agents[0];
		expect(closer.customPrompt?.value).toBeDefined();
		expect(closer.customPrompt!.value).toContain('report_result(');
	});

	test('Done node closer prompt does NOT instruct passing a `status` field (schema is .strict())', () => {
		// ReportResultSchema in task-agent-tool-schemas.ts uses `.strict()` and
		// does not declare a `status` field — passing one fails Zod validation.
		// The runtime records `reportedStatus: 'done'` internally, so the agent
		// must call `report_result({ summary: ... })` only.
		const doneNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Done')!;
		const closer = doneNode.agents[0];
		const prompt = closer.customPrompt!.value;
		// Catch both `report_result(status=...)` and `report_result({ status: ... })`
		// style instructions — either would be a bug.
		expect(prompt).not.toMatch(/report_result\s*\(\s*status\s*[:=]/);
		expect(prompt).not.toMatch(/report_result\s*\(\s*\{\s*status\s*:/);
	});

	test('Review node reviewer customPrompt requires posting to GitHub and echoing review_url', () => {
		const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
		const reviewer = reviewNode.agents[0];
		const prompt = reviewer.customPrompt!.value;
		// Reviewer must post to GitHub via gh pr review / gh api.
		expect(prompt).toContain('gh pr review');
		expect(prompt).toContain('gh api');
		// And on the changes-requested path, send_message to Coding must carry
		// the review URL + comment URLs so the coder can reply inline.
		expect(prompt).toContain('review_url');
		expect(prompt).toContain('comment_urls');
		// The gate name must be mentioned so the reviewer understands the contract.
		expect(prompt).toContain('review-posted-gate');
	});
});

describe('REVIEW_ONLY_WORKFLOW reviewer customPrompt requires gh pr review before report_result', () => {
	test('reviewer prompt mandates gh pr review before handoff', () => {
		const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
		const prompt = agent.customPrompt!.value;
		expect(prompt).toContain('gh pr review');
		expect(prompt).toContain('report_result');
		// The ordering matters: post BEFORE calling report_result.
		expect(prompt).toMatch(/post.*before|BEFORE calling.*report_result/i);
	});
});

describe('RESEARCH_WORKFLOW agent slot customPrompt', () => {
	test('Research node has non-empty customPrompt', () => {
		const researchNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Research')!;
		const agent = researchNode.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value.trim().length).toBeGreaterThan(0);
	});

	test('Review node has non-empty customPrompt', () => {
		const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
		const agent = reviewNode.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('report_result');
	});
});

describe('REVIEW_ONLY_WORKFLOW agent slot customPrompt', () => {
	test('Review node has non-empty customPrompt', () => {
		const reviewNode = REVIEW_ONLY_WORKFLOW.nodes[0];
		const agent = reviewNode.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('report_result');
	});

	test('Review node has agent slot customPrompt (no separate node-level instructions)', () => {
		const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
		expect(agent.customPrompt).toBeDefined();
	});
});

describe('FULL_CYCLE_CODING_WORKFLOW agent slot customPrompt', () => {
	test('Planning node planner has non-empty customPrompt', () => {
		const node = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Planning')!;
		const agent = node.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('plan-pr-gate');
	});

	test('Plan Review node reviewer has non-empty customPrompt', () => {
		const node = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
		const agent = node.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('plan-approval-gate');
	});

	test('Coding node coder has non-empty customPrompt', () => {
		const node = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
		const agent = node.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('code-pr-gate');
	});

	test('Code Review node all 3 reviewers have customPrompt with vote guidance', () => {
		const node = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Code Review')!;
		expect(node.agents).toHaveLength(3);
		for (const agent of node.agents) {
			expect(agent.customPrompt?.value).toBeDefined();
			expect(agent.customPrompt?.value).toContain('vote');
			expect(agent.customPrompt?.value).toContain(agent.name);
		}
	});

	test('QA node has non-empty customPrompt', () => {
		const node = FULL_CYCLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'QA')!;
		const agent = node.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('report_result');
	});
});
