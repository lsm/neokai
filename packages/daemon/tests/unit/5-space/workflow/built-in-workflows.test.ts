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
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
	CODING_WORKFLOW,
	PLAN_AND_DECOMPOSE_WORKFLOW,
	FULLSTACK_QA_LOOP_WORKFLOW,
	RESEARCH_WORKFLOW,
	REVIEW_ONLY_WORKFLOW,
	getBuiltInWorkflows,
	getBuiltInGateScript,
	seedBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { computeWorkflowHash } from '../../../../src/lib/space/workflows/template-hash.ts';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import {
	exportWorkflow,
	validateExportedWorkflow,
} from '../../../../src/lib/space/export-format.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	// Use in-memory SQLite — faster than file-based DB and avoids filesystem
	// I/O contention that caused beforeEach hook timeouts in CI.
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
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
	test('has two nodes: Coding, Review', () => {
		expect(CODING_WORKFLOW.nodes).toHaveLength(2);
		expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual(['Coding', 'Review']);
	});

	test('step agentId placeholders are correct', () => {
		expect(CODING_WORKFLOW.nodes[0].agents[0]?.name).toBe('coder');
		expect(CODING_WORKFLOW.nodes[1].agents[0]?.name).toBe('reviewer');
	});

	test('has two channels', () => {
		expect(CODING_WORKFLOW.channels).toHaveLength(2);
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

	test('has two gates: code-ready-gate and review-posted-gate', () => {
		expect(CODING_WORKFLOW.gates).toHaveLength(2);
		const gateIds = CODING_WORKFLOW.gates!.map((g) => g.id).sort();
		expect(gateIds).toEqual(['code-ready-gate', 'review-posted-gate']);
		for (const gate of CODING_WORKFLOW.gates!) {
			expect(gate.fields).toHaveLength(1);
		}
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
		// Primary check: query GitHub for the formal reviews list via the PR URL.
		expect(gate.script!.source).toContain('gh pr view "$PR_URL" --json reviews');
		expect(gate.script!.source).toContain('submittedAt');
		// Must fail loudly when neither review nor PR comment has landed since start.
		expect(gate.script!.source).toContain('exit 1');
		// Must echo pr_url/review_count on success for downstream consumers.
		expect(gate.script!.source).toContain('pr_url');
		expect(gate.script!.source).toContain('review_count');
	});

	test('review-posted-gate falls back to PR comments when no formal review exists', () => {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
		const src = gate.script!.source;
		// Fallback: check PR conversation comments when no formal review is found.
		// This handles same-account setups where GitHub blocks self-reviews.
		expect(src).toContain('gh pr view "$PR_URL" --json comments');
		expect(src).toContain('createdAt');
		// Must also filter comments by workflow start timestamp.
		expect(src).toContain('NEOKAI_WORKFLOW_START_ISO');
		// Gate passes via comments fallback — outputs the same pr_url/review_count shape.
		expect(src).toContain('pr_url');
		expect(src).toContain('review_count');
		// Error message must mention both "review" and "PR comment" so operators understand what was checked.
		expect(src).toContain('PR comment');
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

describe('PLAN_AND_DECOMPOSE_WORKFLOW template', () => {
	test('has three nodes', () => {
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.nodes).toHaveLength(3);
	});

	test('node names are correct', () => {
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((n) => n.name)).toEqual([
			'Planning',
			'Plan Review',
			'Task Dispatcher',
		]);
	});

	test('node agent placeholders are correct', () => {
		const nodes = PLAN_AND_DECOMPOSE_WORKFLOW.nodes;
		// Planning: single Planner
		expect(nodes[0].agents).toHaveLength(1);
		expect(nodes[0].agents[0]?.agentId).toBe('Planner');
		expect(nodes[0].agents[0]?.name).toBe('planner');
		// Plan Review: four Reviewers (architecture, security, correctness, ux)
		expect(nodes[1].agents).toHaveLength(4);
		expect(nodes[1].agents.map((a) => a.agentId)).toEqual([
			'Reviewer',
			'Reviewer',
			'Reviewer',
			'Reviewer',
		]);
		expect(nodes[1].agents.map((a) => a.name)).toEqual([
			'architecture-reviewer',
			'security-reviewer',
			'correctness-reviewer',
			'ux-reviewer',
		]);
		// Task Dispatcher: single General agent
		expect(nodes[2].agents).toHaveLength(1);
		expect(nodes[2].agents[0]?.agentId).toBe('General');
		expect(nodes[2].agents[0]?.name).toBe('task-dispatcher');
	});

	test('all nodes define explicit custom prompts', () => {
		for (const node of PLAN_AND_DECOMPOSE_WORKFLOW.nodes) {
			for (const agent of node.agents) {
				expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
			}
		}
	});

	test('startNodeId points to the Planning node', () => {
		const planningNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Planning');
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.startNodeId).toBe(planningNode?.id);
	});

	test('endNodeId points to the Task Dispatcher node', () => {
		const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
			(n) => n.name === 'Task Dispatcher'
		);
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.endNodeId).toBe(dispatcherNode?.id);
	});

	test('endNodeId references a valid node in the graph', () => {
		const nodeIds = new Set(PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((n) => n.id));
		expect(nodeIds.has(PLAN_AND_DECOMPOSE_WORKFLOW.endNodeId!)).toBe(true);
	});

	test('has two gates', () => {
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.gates).toHaveLength(2);
	});

	test('gate IDs are correct', () => {
		const ids = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.map((g) => g.id);
		expect(ids).toContain('plan-pr-gate');
		expect(ids).toContain('plan-approval-gate');
	});

	test('plan-pr-gate has script-based PR check with pr_url output', () => {
		const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-pr-gate')!;
		expect(gate.fields).toHaveLength(1);
		expect(gate.fields[0].name).toBe('pr_url');
		expect(gate.fields[0].type).toBe('string');
		expect(gate.fields[0].check.op).toBe('exists');
		expect(gate.fields[0].writers).toEqual(['*']);
		expect(gate.script?.interpreter).toBe('bash');
		expect(gate.script?.source.length).toBeGreaterThan(0);
		// Planning can cycle back from Plan Review; PR state must be re-verified each cycle.
		expect(gate.resetOnCycle).toBe(true);
	});

	test('plan-approval-gate requires all four reviewers to approve', () => {
		const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
		expect(gate.fields).toHaveLength(1);
		expect(gate.fields[0].name).toBe('approvals');
		expect(gate.fields[0].type).toBe('map');
		expect(gate.fields[0].check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
		expect(gate.fields[0].writers).toContain('reviewer');
		expect(gate.resetOnCycle).toBe(true);
	});

	test('has three channels', () => {
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.channels).toHaveLength(3);
	});

	test('main progression channels have correct gateIds', () => {
		const ch = PLAN_AND_DECOMPOSE_WORKFLOW.channels!;

		const planningToReview = ch.find((c) => c.from === 'Planning' && c.to === 'Plan Review');
		expect(planningToReview?.gateId).toBe('plan-pr-gate');

		const reviewToDispatcher = ch.find(
			(c) => c.from === 'Plan Review' && c.to === 'Task Dispatcher'
		);
		expect(reviewToDispatcher?.gateId).toBe('plan-approval-gate');
	});

	test('feedback channel Plan Review → Planning is ungated and cyclic', () => {
		const ch = PLAN_AND_DECOMPOSE_WORKFLOW.channels!;
		const reviewToPlanning = ch.find((c) => c.from === 'Plan Review' && c.to === 'Planning');
		expect(reviewToPlanning).toBeDefined();
		expect(reviewToPlanning?.gateId).toBeUndefined();
		expect(reviewToPlanning?.maxCycles).toBe(5);
	});

	test('all channels have direction one-way', () => {
		for (const ch of PLAN_AND_DECOMPOSE_WORKFLOW.channels!) {
			expect('direction' in ch).toBe(false); // direction field removed
		}
	});

	test('all channel from/to fields reference valid node names or agent slot names', () => {
		const refs = new Set<string>();
		for (const node of PLAN_AND_DECOMPOSE_WORKFLOW.nodes) {
			refs.add(node.name);
			for (const agent of node.agents ?? []) refs.add(agent.name);
		}
		for (const ch of PLAN_AND_DECOMPOSE_WORKFLOW.channels!) {
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

	test('Plan Review node lens names cover architecture / security / correctness / ux', () => {
		const reviewNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
		expect(reviewNode.agents).toHaveLength(4);
		const expected = [
			{ name: 'architecture-reviewer', lens: 'architecture' },
			{ name: 'security-reviewer', lens: 'security' },
			{ name: 'correctness-reviewer', lens: 'correctness' },
			{ name: 'ux-reviewer', lens: 'ux' },
		];
		for (let i = 0; i < expected.length; i++) {
			const slot = reviewNode.agents[i];
			expect(slot.name).toBe(expected[i].name);
			// Each reviewer's prompt should reference their lens name and the approval gate
			expect(slot.customPrompt?.value.toLowerCase()).toContain(expected[i].lens);
			expect(slot.customPrompt?.value).toContain('plan-approval-gate');
		}
	});

	test('Task Dispatcher prompt instructs use of create_standalone_task and save_artifact', () => {
		const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
			(n) => n.name === 'Task Dispatcher'
		)!;
		const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
		expect(prompt).toContain('create_standalone_task');
		expect(prompt).toContain('save_artifact');
		expect(prompt).toContain('created_task_ids');
	});

	test('Task Dispatcher prompt embeds Stacked PR Instructions in task descriptions', () => {
		const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
			(n) => n.name === 'Task Dispatcher'
		)!;
		const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
		// Must embed stacked PR instructions in each task description
		expect(prompt).toContain('Stacked PR Instructions');
		// Must specify branch naming convention using plan/ prefix
		expect(prompt).toContain('plan/');
		// Evidence must include stack metadata
		expect(prompt).toContain('stack_prefix');
		expect(prompt).toContain('stack_branches');
	});

	test('Task Dispatcher prompt uses dev (not main) as the base branch for the bottom PR', () => {
		const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
			(n) => n.name === 'Task Dispatcher'
		)!;
		const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
		// Bottom item must target dev as base branch
		expect(prompt).toContain('Base branch: dev');
		// Must never reference main as the trunk
		expect(prompt).not.toContain('Base branch: main');
	});

	test('Task Dispatcher prompt instructs building stacked PR chain bottom-up', () => {
		const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
			(n) => n.name === 'Task Dispatcher'
		)!;
		const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
		// Must instruct bottom-up ordering (item 1 first)
		expect(prompt).toMatch(/BOTTOM.UP order|bottom.up/i);
		// Subsequent items must reference the previous item's branch as base
		expect(prompt).toContain('item-(N-1)-slug');
	});

	test('Task Dispatcher prompt instructs Task Dispatcher NOT to create branches or PRs itself', () => {
		const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
			(n) => n.name === 'Task Dispatcher'
		)!;
		const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
		// The dispatcher delegates branch/PR creation to downstream coders
		expect(prompt).toContain('downstream coder');
	});

	test('Task Dispatcher node carries no completionActions (pipeline deleted in PR 4/5)', () => {
		const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
			(n) => n.name === 'Task Dispatcher'
		)!;
		// The completion-action runtime pipeline (including
		// `verify-tasks-created`) was removed in PR 4/5 — post-approval work is
		// now handled by `PostApprovalRouter` via the `postApproval` field.
		// `completionActions` is either undefined or empty.
		expect(dispatcherNode.completionActions ?? []).toEqual([]);
	});

	test('workflow description describes stacked PR chain output', () => {
		// The workflow description must convey that the output is a stacked PR chain
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.description).toMatch(/stacked PR/i);
		// Must mention that PRs are built bottom-up from dev
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.description).toContain('dev');
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(PLAN_AND_DECOMPOSE_WORKFLOW)).toBe(false);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.id).toBe('');
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.spaceId).toBe('');
	});

	test('does NOT have the default tag — selected explicitly for planning goals', () => {
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.tags).not.toContain('default');
	});

	test('has the planning and decomposition tags', () => {
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.tags).toContain('planning');
		expect(PLAN_AND_DECOMPOSE_WORKFLOW.tags).toContain('decomposition');
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

	test('includes PLAN_AND_DECOMPOSE_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
	});

	test('does NOT include the legacy Full-Cycle Coding Workflow', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).not.toContain('Full-Cycle Coding Workflow');
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
		db = makeDb();
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
		expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
		expect(names).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);
		expect(names).toContain(RESEARCH_WORKFLOW.name);
		expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
	});

	test('Plan & Decompose Workflow seeding preserves explicit node custom prompts', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name);
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

	test('CODING_WORKFLOW seeded correctly — two nodes with real agent IDs', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(2);
		expect(wf!.nodes[0].agents[0]?.agentId).toBe(CODER_ID);
		expect(wf!.nodes[1].agents[0]?.agentId).toBe(roleMap.reviewer);
	});

	test('CODING_WORKFLOW seeded with two channels (gated Coding→Review, gated Review→Coding)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(2);

		const codeToReview = wf.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
		expect(codeToReview).toBeDefined();
		expect(codeToReview!.gateId).toBe('code-ready-gate');

		const reviewToCode = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
		expect(reviewToCode).toBeDefined();
		// Review → Coding is now gated by review-posted-gate so the reviewer's
		// message cannot be delivered until a GitHub review is visible.
		expect(reviewToCode!.gateId).toBe('review-posted-gate');
		expect(reviewToCode!.maxCycles).toBe(5);
	});

	test('CODING_WORKFLOW seeded with two gates (code-ready-gate + review-posted-gate)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(wf.gates).toHaveLength(2);
		const gateIds = wf.gates!.map((g) => g.id).sort();
		expect(gateIds).toEqual(['code-ready-gate', 'review-posted-gate']);
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

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded correctly — three nodes with 4 parallel reviewers', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(3);
		expect(wf!.nodes[0].agents[0]?.agentId).toBe(PLANNER_ID); // Planning
		// Plan Review has four agents (all reviewer)
		expect(wf!.nodes[1].agents).toHaveLength(4);
		expect(wf!.nodes[1].agents?.map((a) => a.agentId)).toEqual([
			roleMap.reviewer,
			roleMap.reviewer,
			roleMap.reviewer,
			roleMap.reviewer,
		]);
		expect(wf!.nodes[1].agents?.map((a) => a.name)).toEqual([
			'architecture-reviewer',
			'security-reviewer',
			'correctness-reviewer',
			'ux-reviewer',
		]);
		expect(wf!.nodes[2].agents[0]?.agentId).toBe(GENERAL_ID); // Task Dispatcher
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with 3 node-level channels', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		expect(wf.channels).toHaveLength(3);
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with 2 gates', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		expect(wf.gates).toHaveLength(2);
		const gateIds = wf.gates!.map((g) => g.id);
		expect(gateIds).toContain('plan-pr-gate');
		expect(gateIds).toContain('plan-approval-gate');
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded channels split into 2 gated + 1 ungated feedback', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		const gatedChannels = wf.channels!.filter((c) => c.gateId !== undefined);
		expect(gatedChannels).toHaveLength(2);
		const cyclicChannels = wf.channels!.filter((c) => c.maxCycles !== undefined);
		// One cyclic feedback channel: Plan Review → Planning
		expect(cyclicChannels).toHaveLength(1);
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded channels reference node names or reviewer slot names', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
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

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded without default tag — picked explicitly for planning', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		expect(wf.tags).not.toContain('default');
		expect(wf.tags).toContain('planning');
		expect(wf.tags).toContain('decomposition');
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded alongside CODING_WORKFLOW — both present', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
		expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded Task Dispatcher carries no completionActions', async () => {
		// Completion actions were deleted in PR 4/5 — the seeded workflow's
		// nodes must not carry any. Post-approval work runs through
		// `PostApprovalRouter` on the `approved → done` boundary instead.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		const dispatcherNode = wf.nodes.find((n) => n.name === 'Task Dispatcher')!;
		expect(dispatcherNode.completionActions ?? []).toEqual([]);
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

	// ─── PR 3/5: postApproval threading ─────────────────────────────────────

	test('threads postApproval through to Coding, Research, QA seeded rows', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		const assertPostApproval = (name: string) => {
			const wf = workflows.find((w) => w.name === name);
			expect(wf, `workflow "${name}" must be seeded`).toBeDefined();
			expect(wf!.postApproval, `"${name}" must have postApproval persisted`).toBeDefined();
			expect(wf!.postApproval!.targetAgent).toBe('reviewer');
			// Non-empty instructions — we don't snapshot the full template here
			// because end-node-handoff.test.ts already asserts the exact content.
			expect(wf!.postApproval!.instructions.length).toBeGreaterThan(0);
		};
		assertPostApproval('Coding Workflow');
		assertPostApproval('Research Workflow');
		assertPostApproval('Coding with QA Workflow');
	});

	test('leaves postApproval undefined on Review-Only and Plan & Decompose', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		for (const name of ['Review-Only Workflow', 'Plan & Decompose Workflow']) {
			const wf = workflows.find((w) => w.name === name);
			expect(wf, `workflow "${name}" must be seeded`).toBeDefined();
			expect(wf!.postApproval).toBeUndefined();
		}
	});

	// ─── PR 3/5: drift re-stamp path ────────────────────────────────────────

	test('result exposes restamped=[] on a fresh seed', () => {
		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		expect(result.skipped).toBe(false);
		expect(result.seeded).toHaveLength(5);
		expect(result.restamped).toEqual([]);
	});

	test('result exposes restamped=[] when all rows already match current template hashes', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const second = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		// Second call finds no drift — no re-stamps needed.
		expect(second.skipped).toBe(true);
		expect(second.seeded).toEqual([]);
		expect(second.restamped).toEqual([]);
	});

	test('re-stamps existing rows when stored templateHash differs from current template', () => {
		// Seed fresh — rows now carry the current template hash.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		// Simulate a prior seed that predated PR 3/5 by clearing `postApproval`
		// and rewriting `template_hash` to a stale value. The re-stamp path
		// should detect the hash drift and push the current `postApproval`
		// (+ current hash) onto the row.
		const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		db.prepare(
			`UPDATE space_workflows
			    SET template_hash = ?, post_approval = NULL
			  WHERE id = ?`
		).run('stale-hash-from-a-prior-pr', coding.id);

		// Verify the simulated drift landed.
		const before = manager.getWorkflow(coding.id)!;
		expect(before.postApproval).toBeUndefined();
		expect(before.templateHash).toBe('stale-hash-from-a-prior-pr');

		// Re-run the seeder — re-stamp branch fires.
		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		expect(result.seeded).toEqual([]);
		expect(result.restamped).toContain(CODING_WORKFLOW.name);
		expect(result.skipped).toBe(false);

		// Row now carries the current template's postApproval + hash.
		const after = manager.getWorkflow(coding.id)!;
		expect(after.postApproval).toBeDefined();
		expect(after.postApproval!.targetAgent).toBe('reviewer');
		expect(after.templateHash).not.toBe('stale-hash-from-a-prior-pr');
	});

	test('re-stamp does NOT touch rows without a templateName (user-created)', () => {
		// Seed the 5 built-ins.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		// Create a user-owned workflow with no templateName/templateHash.
		const userWf = manager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'My Custom Review',
			nodes: [{ name: 'Review', agentId: REVIEWER_ID }],
			completionAutonomyLevel: 2,
			// Intentionally no templateName — a bespoke workflow
		});

		// Run seeder again — should be a no-op for the user row.
		const before = manager.getWorkflow(userWf.id)!;
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const after = manager.getWorkflow(userWf.id)!;

		expect(after.name).toBe(before.name);
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(after.completionAutonomyLevel).toBe(before.completionAutonomyLevel);
		expect(after.postApproval).toBeUndefined();
	});

	test('re-stamp updates each node agent `customPrompt.value` in-place', () => {
		// Regression guard for PR 3/5: without this, existing spaces get the
		// new `postApproval` wired but keep stale end-node prompts — so the
		// reviewer sub-session fires the merge template against a task-agent
		// that never sent `{ pr_url }` in its handoff, leaving `{{pr_url}}`
		// uninterpolated. Proof: force-drift the stored hash AND manually
		// stomp the end-node's customPrompt to an old value; after re-stamp
		// the prompt must match the current template verbatim.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		// Find the end node and its first (task-agent) slot on the persisted row.
		const endNode = coding.nodes.find((n) => n.id === coding.endNodeId)!;
		const endAgent = endNode.agents[0];
		const originalPrompt = endAgent.customPrompt?.value ?? '';
		const staleMarker = '### STALE PROMPT FROM A PRIOR PR ###';
		expect(originalPrompt).not.toContain(staleMarker);

		// Simulate an old-template row: rewrite this node's agent prompt and
		// mark the row's hash stale so the seeder takes the re-stamp branch.
		manager.updateWorkflow(coding.id, {
			nodes: coding.nodes.map((n) =>
				n.id !== endNode.id
					? n
					: {
							id: n.id,
							name: n.name,
							agents: n.agents.map((a, i) =>
								i === 0 ? { ...a, customPrompt: { value: staleMarker } } : a
							),
						}
			),
		});
		db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
			'stale-hash',
			coding.id
		);

		// Sanity: the stale write landed.
		const stalled = manager.getWorkflow(coding.id)!;
		const stalledAgent = stalled.nodes.find((n) => n.id === endNode.id)!.agents[0];
		expect(stalledAgent.customPrompt?.value).toBe(staleMarker);

		// Re-run the seeder — should take the re-stamp branch.
		const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		expect(result.restamped).toContain(CODING_WORKFLOW.name);

		// Prompt restored to the current template verbatim (not the stale marker).
		const after = manager.getWorkflow(coding.id)!;
		const afterEndNode = after.nodes.find((n) => n.id === endNode.id)!;
		const afterAgent = afterEndNode.agents[0];
		expect(afterAgent.customPrompt?.value).not.toContain(staleMarker);
		expect(afterAgent.customPrompt?.value).toBe(originalPrompt);

		// Critical invariant: the node UUID and agent UUID were preserved, so
		// any in-flight run referencing them continues to resolve.
		expect(afterEndNode.id).toBe(endNode.id);
		expect(afterAgent.agentId).toBe(endAgent.agentId);

		// And after the re-stamp, the drift detector's hash check matches: the
		// full-template hash (which includes nodePrompts) now aligns with the
		// re-stamped row, so operators are not spammed with false drift warnings.
		const expectedHash = computeWorkflowHash(CODING_WORKFLOW);
		expect(after.templateHash).toBe(expectedHash);
	});

	test('re-stamp preserves node UUIDs (safe for in-flight runs)', () => {
		// The narrow re-stamp explicitly does NOT regenerate node UUIDs because
		// live workflow_run rows reference them. This test locks that behaviour
		// in: forcing a re-stamp must not shift any node ID.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const originalNodeIds = coding.nodes.map((n) => n.id).sort();

		db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
			'force-drift',
			coding.id
		);
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		const after = manager.getWorkflow(coding.id)!;
		const afterNodeIds = after.nodes.map((n) => n.id).sort();
		expect(afterNodeIds).toEqual(originalNodeIds);
	});

	test('is idempotent — leaves user-created workflows untouched', async () => {
		// User already created a custom workflow before seeding
		manager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'My Custom Workflow',
			nodes: [{ name: 'Code', agentId: CODER_ID }],
			completionAutonomyLevel: 3,
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
		// 'qa' is used by FULLSTACK_QA_LOOP_WORKFLOW and is a shared role across
		// multiple templates. Pre-validation catches missing roles before any
		// workflow is persisted.
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
		expect(result.seeded).toContain('Plan & Decompose Workflow');
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
			'tpl-pd-',
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
		const reviewNode = wf.nodes.find((n) => n.name === 'Review');
		expect(reviewNode?.agents[0].customPrompt?.value).toContain('save_artifact');
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded nodes preserve customPrompt content', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		const planNode = wf.nodes.find((n) => n.name === 'Planning');
		expect(planNode?.agents[0].customPrompt?.value).toContain('plan-pr-gate');
		const planReviewNode = wf.nodes.find((n) => n.name === 'Plan Review');
		expect(planReviewNode?.agents[0].customPrompt?.value).toContain('plan-approval-gate');
		const dispatcherNode = wf.nodes.find((n) => n.name === 'Task Dispatcher');
		expect(dispatcherNode?.agents[0].customPrompt?.value).toContain('create_standalone_task');
		expect(dispatcherNode?.agents[0].customPrompt?.value).toContain('save_artifact');
	});

	test('RESEARCH_WORKFLOW seeded nodes preserve customPrompt content', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
		const researchNode = wf.nodes.find((n) => n.name === 'Research');
		expect(researchNode?.agents[0].customPrompt?.value).toContain('gh pr create');
		const reviewNode = wf.nodes.find((n) => n.name === 'Review');
		expect(reviewNode?.agents[0].customPrompt?.value).toContain('save_artifact');
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

	test('PLAN_AND_DECOMPOSE_WORKFLOW gate resetOnCycle flags are preserved', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		const planPr = wf.gates!.find((g) => g.id === 'plan-pr-gate')!;
		// Planning cycles back on feedback; PR state must be re-verified per cycle.
		expect(planPr.resetOnCycle).toBe(true);
		const planApproval = wf.gates!.find((g) => g.id === 'plan-approval-gate')!;
		expect(planApproval.resetOnCycle).toBe(true);
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

	test('PLAN_AND_DECOMPOSE_WORKFLOW plan-approval-gate requires four reviewer approvals', () => {
		const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
		const approvalsField = gate.fields.find((f) => f.name === 'approvals')!;
		expect(approvalsField.type).toBe('map');
		expect(approvalsField.writers).toContain('reviewer');
		expect(approvalsField.check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
	});

	test('seeded plan-approval-gate preserves map-count check with min=4', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		const gate = wf.gates!.find((g) => g.id === 'plan-approval-gate')!;
		const approvalsField = gate.fields.find((f) => f.name === 'approvals')!;
		expect(approvalsField.type).toBe('map');
		expect(approvalsField.writers).toContain('reviewer');
		expect(approvalsField.check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
	});

	// ─── getBuiltInWorkflows ordering ────────────────────────────────────────

	test('getBuiltInWorkflows returns CODING_WORKFLOW first', () => {
		// CODING_WORKFLOW is first so spaceWorkflowRun.start (which picks
		// workflows[0] ordered by created_at ASC) defaults to the single-task
		// coding loop. PLAN_AND_DECOMPOSE_WORKFLOW is opt-in (no `default` tag).
		const templates = getBuiltInWorkflows();
		expect(templates[0].name).toBe(CODING_WORKFLOW.name);
	});

	test('listWorkflows returns CODING_WORKFLOW first after DB seeding', () => {
		// Verifies the DB-level ordering guarantee: listWorkflows uses
		// ORDER BY created_at ASC, rowid ASC. When all workflows are seeded within
		// the same millisecond, rowid (insertion order) is the tiebreaker, so
		// CODING_WORKFLOW (seeded first) must be returned at index 0.
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows[0].name).toBe(CODING_WORKFLOW.name);
	});

	test('getBuiltInWorkflows returns all five templates', () => {
		const templates = getBuiltInWorkflows();
		expect(templates).toHaveLength(5);
		const names = templates.map((t) => t.name);
		expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
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
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		// Templates use title-case role placeholders that must resolve case-insensitively.
		// Plan & Decompose: Planning(Planner) → Plan Review(4×Reviewer) → Task Dispatcher(General)
		expect(wf.nodes[0].agents[0]?.agentId).toBe(PLANNER_ID);
		expect(wf.nodes[1].agents[0]?.agentId).toBe(REVIEWER_ID);
		expect(wf.nodes[2].agents[0]?.agentId).toBe(GENERAL_ID);
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

	test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with non-empty customPrompt on all agent slots', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		for (const node of wf.nodes) {
			for (const agent of node.agents) {
				expect(agent.customPrompt).toBeDefined();
				expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW Plan Review node reviewer slots have lens-specific customPrompt', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		const planReviewNode = wf.nodes.find((n) => n.name === 'Plan Review')!;
		expect(planReviewNode.agents).toHaveLength(4);
		const seenLenses = new Set<string>();
		for (const agent of planReviewNode.agents) {
			expect(agent.customPrompt).toBeDefined();
			expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
			// Each reviewer's lens should be embedded as reviewer_name "<lens>" inside the prompt
			for (const lens of ['architecture', 'security', 'correctness', 'ux']) {
				if (agent.customPrompt!.value.includes(`"${lens}"`)) {
					seenLenses.add(lens);
				}
			}
		}
		expect(seenLenses.size).toBe(4);
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW non-Plan-Review nodes have non-empty customPrompt', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
		const otherNodes = wf.nodes.filter((n) => n.name !== 'Plan Review');
		expect(otherNodes.length).toBe(2); // Planning, Task Dispatcher
		for (const node of otherNodes) {
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
	];

	beforeEach(() => {
		db = makeDb();
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
	});

	test('exported Coding Workflow passes Zod validation', () => {
		// Seed and retrieve the persisted workflow (with real UUIDs)
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);
		const result = validateExportedWorkflow(exported);
		expect(result.ok).toBe(true);
	});

	test('exported Coding Workflow preserves two channels and Review→Coding cycle', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);
		expect(exported.channels).toBeDefined();
		// gateId is stripped during export (gates are separate entities)
		expect(exported.channels).toHaveLength(2);

		const reviewToCode = exported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
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
			completionAutonomyLevel: exported.completionAutonomyLevel ?? 3,
		});

		// Verify the re-imported workflow
		const reimported = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(reimported).toBeDefined();
		expect(reimported.nodes).toHaveLength(2);
		expect(reimported.channels).toHaveLength(2);

		// Coding → Review channel preserved
		const codeToReview = reimported.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
		expect(codeToReview).toBeDefined();

		// Review → Coding channel preserved with maxCycles
		const reviewToCode = reimported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
		expect(reviewToCode).toBeDefined();
		expect(reviewToCode!.maxCycles).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// getBuiltInGateScript()
// ---------------------------------------------------------------------------
// Tests for the live gate-script resolution helper. This function returns the
// *current* script for a given built-in template + gate ID combination so that
// gate evaluations always use the latest script rather than the version that was
// baked into the database at seed time.

describe('getBuiltInGateScript()', () => {
	test('returns the bash script for code-ready-gate in Coding Workflow', () => {
		const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'code-ready-gate');
		expect(script).toBeDefined();
		expect(script?.interpreter).toBe('bash');
		expect(script?.source.length).toBeGreaterThan(0);
		// The PR-ready script references gh pr view and checks mergeability
		expect(script?.source).toContain('gh pr view');
		expect(script?.source).toContain('MERGEABLE');
	});

	test('returns the bash script for review-posted-gate in Coding Workflow', () => {
		const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
		expect(script).toBeDefined();
		expect(script?.interpreter).toBe('bash');
		// The review-posted script should include the PR comment fallback path
		expect(script?.source).toContain('gh pr view');
		expect(script?.source).toContain('comments');
		// Confirm the current fallback message is present (not the stale "No review submitted on…")
		expect(script?.source).toContain('No review or PR comment found on');
	});

	test('returns the bash script for plan-pr-gate in Plan & Decompose Workflow', () => {
		const script = getBuiltInGateScript(PLAN_AND_DECOMPOSE_WORKFLOW.name, 'plan-pr-gate');
		expect(script).toBeDefined();
		expect(script?.interpreter).toBe('bash');
	});

	test('returns undefined for a field-only gate (plan-approval-gate has no script)', () => {
		const script = getBuiltInGateScript(PLAN_AND_DECOMPOSE_WORKFLOW.name, 'plan-approval-gate');
		expect(script).toBeUndefined();
	});

	test('returns undefined when the template name does not match any built-in', () => {
		const script = getBuiltInGateScript('Unknown Template', 'code-ready-gate');
		expect(script).toBeUndefined();
	});

	test('returns undefined when the gate ID does not exist in the template', () => {
		const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'nonexistent-gate-id');
		expect(script).toBeUndefined();
	});

	test('returned script matches the gate definition directly from the template', () => {
		// Verify the helper returns the exact same object reference as the template defines
		const templateGate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
		const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
		expect(script).toBe(templateGate.script); // same object reference
	});

	test('returns scripts for all script-based gates in all templates', () => {
		// Every gate that has a script in any built-in template should be resolvable
		for (const template of getBuiltInWorkflows()) {
			for (const gate of template.gates ?? []) {
				if (!gate.script) continue;
				const script = getBuiltInGateScript(template.name, gate.id);
				expect(script).toBeDefined();
				expect(script?.interpreter).toBe(gate.script.interpreter);
				expect(script?.source).toBe(gate.script.source);
			}
		}
	});

	test('review-posted-gate script includes NEOKAI_WORKFLOW_START_ISO usage', () => {
		const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
		// The review-posted-gate script must use NEOKAI_WORKFLOW_START_ISO to filter
		// reviews that were posted after the workflow started
		expect(script?.source).toContain('NEOKAI_WORKFLOW_START_ISO');
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

	test('Review node reviewer has non-empty customPrompt', () => {
		const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
		const reviewer = reviewNode.agents[0];
		expect(reviewer.customPrompt?.value).toBeDefined();
		expect(reviewer.customPrompt?.value).toContain('save_artifact');
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

describe('REVIEW_ONLY_WORKFLOW reviewer customPrompt requires gh pr review before save_artifact', () => {
	test('reviewer prompt mandates gh pr review before handoff', () => {
		const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
		const prompt = agent.customPrompt!.value;
		expect(prompt).toContain('gh pr review');
		expect(prompt).toContain('save_artifact');
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
		expect(agent.customPrompt?.value).toContain('save_artifact');
	});
});

describe('REVIEW_ONLY_WORKFLOW agent slot customPrompt', () => {
	test('Review node has non-empty customPrompt', () => {
		const reviewNode = REVIEW_ONLY_WORKFLOW.nodes[0];
		const agent = reviewNode.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('save_artifact');
	});

	test('Review node has agent slot customPrompt (no separate node-level instructions)', () => {
		const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
		expect(agent.customPrompt).toBeDefined();
	});
});

describe('PLAN_AND_DECOMPOSE_WORKFLOW agent slot customPrompt', () => {
	test('Planning node planner has non-empty customPrompt referencing plan-pr-gate', () => {
		const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Planning')!;
		const agent = node.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('plan-pr-gate');
	});

	test('Plan Review node has 4 lens-specific reviewers, each referencing plan-approval-gate and its lens', () => {
		const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
		expect(node.agents).toHaveLength(4);
		const lenses = ['architecture', 'security', 'correctness', 'ux'];
		const seenLenses: string[] = [];
		for (const agent of node.agents) {
			expect(agent.customPrompt?.value).toBeDefined();
			expect(agent.customPrompt?.value).toContain('plan-approval-gate');
			// Each reviewer's prompt references its specific lens
			const lensForAgent = lenses.find((l) => agent.customPrompt!.value.includes(`"${l}"`));
			expect(lensForAgent).toBeDefined();
			seenLenses.push(lensForAgent!);
		}
		// All four lenses must be represented exactly once
		expect(seenLenses.sort()).toEqual([...lenses].sort());
	});

	test('Task Dispatcher node prompt references create_standalone_task and save_artifact', () => {
		const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Task Dispatcher')!;
		expect(node.agents).toHaveLength(1);
		const agent = node.agents[0];
		expect(agent.customPrompt?.value).toBeDefined();
		expect(agent.customPrompt?.value).toContain('create_standalone_task');
		expect(agent.customPrompt?.value).toContain('save_artifact');
	});
});
