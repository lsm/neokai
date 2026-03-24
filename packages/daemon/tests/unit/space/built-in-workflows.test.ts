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
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `/tmp/ws-${spaceId}`, `Space ${spaceId}`, Date.now(), Date.now());
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
const VALID_BUILTIN_ROLES = new Set<string>(['planner', 'coder', 'general', 'reviewer']);

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

	test('has four transitions forming Plan→Code→Verify→Plan/Done graph', () => {
		expect(CODING_WORKFLOW.transitions).toHaveLength(4);

		const planToCode = CODING_WORKFLOW.transitions.find((t) => t.id === 'tpl-coding-plan-to-code');
		expect(planToCode?.condition?.type).toBe('human');

		const codeToVerify = CODING_WORKFLOW.transitions.find(
			(t) => t.id === 'tpl-coding-code-to-verify'
		);
		expect(codeToVerify?.condition?.type).toBe('always');

		const verifyToPlan = CODING_WORKFLOW.transitions.find(
			(t) => t.id === 'tpl-coding-verify-to-plan'
		);
		expect(verifyToPlan?.condition?.type).toBe('task_result');
		expect(verifyToPlan?.condition?.expression).toBe('failed');
		expect(verifyToPlan?.isCyclic).toBe(true);

		const verifyToDone = CODING_WORKFLOW.transitions.find(
			(t) => t.id === 'tpl-coding-verify-to-done'
		);
		expect(verifyToDone?.condition?.type).toBe('task_result');
		expect(verifyToDone?.condition?.expression).toBe('passed');
		expect(verifyToDone?.isCyclic).toBeUndefined();
	});

	test('Verify→Plan transition has lower order than Verify→Done', () => {
		const verifyToPlan = CODING_WORKFLOW.transitions.find(
			(t) => t.id === 'tpl-coding-verify-to-plan'
		);
		const verifyToDone = CODING_WORKFLOW.transitions.find(
			(t) => t.id === 'tpl-coding-verify-to-done'
		);
		expect(verifyToPlan!.order).toBeLessThan(verifyToDone!.order);
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

	test('has one transition (planner → general) with always condition', () => {
		expect(RESEARCH_WORKFLOW.transitions).toHaveLength(1);
		expect(RESEARCH_WORKFLOW.transitions[0].condition?.type).toBe('always');
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

	test('has no transitions (terminal step — run completes immediately on advance)', () => {
		expect(REVIEW_ONLY_WORKFLOW.transitions).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// getBuiltInWorkflows()
// ---------------------------------------------------------------------------

describe('getBuiltInWorkflows()', () => {
	test('returns exactly three templates', () => {
		expect(getBuiltInWorkflows()).toHaveLength(3);
	});

	test('includes CODING_WORKFLOW', () => {
		const names = getBuiltInWorkflows().map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
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
	const roleMap: Record<string, string> = {
		planner: PLANNER_ID,
		coder: CODER_ID,
		general: GENERAL_ID,
		reviewer: 'agent-reviewer-uuid',
	};
	const resolveAgentId = (role: string): string | undefined => roleMap[role];

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID);
		// Seed preset agents so the manager's agentLookup (when wired) would find them
		seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner', 'planner');
		seedAgent(db, CODER_ID, SPACE_ID, 'Coder', 'coder');
		seedAgent(db, GENERAL_ID, SPACE_ID, 'General', 'general');

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

	test('seeds all three built-in templates for an empty space', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(3);
	});

	test('seeded workflow names match all three templates', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
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

	test('CODING_WORKFLOW seeded with four transitions and correct conditions', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf!.transitions).toHaveLength(4);

		// Find transitions by condition type and expression
		const humanTransition = wf!.transitions.find((t) => t.condition?.type === 'human');
		expect(humanTransition).toBeDefined();

		const alwaysTransition = wf!.transitions.find((t) => t.condition?.type === 'always');
		expect(alwaysTransition).toBeDefined();

		const failedTransition = wf!.transitions.find(
			(t) => t.condition?.type === 'task_result' && t.condition?.expression === 'failed'
		);
		expect(failedTransition).toBeDefined();

		const passedTransition = wf!.transitions.find(
			(t) => t.condition?.type === 'task_result' && t.condition?.expression === 'passed'
		);
		expect(passedTransition).toBeDefined();
	});

	test('CODING_WORKFLOW seeded with isCyclic on Verify→Plan transition', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		const failedTransition = wf!.transitions.find(
			(t) => t.condition?.type === 'task_result' && t.condition?.expression === 'failed'
		);
		expect(failedTransition!.isCyclic).toBe(true);

		// Verify→Done should NOT be cyclic
		const passedTransition = wf!.transitions.find(
			(t) => t.condition?.type === 'task_result' && t.condition?.expression === 'passed'
		);
		expect(passedTransition!.isCyclic).toBeUndefined();
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

	test('RESEARCH_WORKFLOW seeded correctly — planner + general with always transition', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(2);
		expect(wf!.nodes[0].agentId).toBe(PLANNER_ID);
		expect(wf!.nodes[1].agentId).toBe(GENERAL_ID);
		expect(wf!.transitions).toHaveLength(1);
		expect(wf!.transitions[0].condition?.type).toBe('always');
	});

	test('REVIEW_ONLY_WORKFLOW seeded correctly — single coder step, no transitions', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(1);
		expect(wf!.nodes[0].agentId).toBe(CODER_ID);
		expect(wf!.transitions).toHaveLength(0);
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
		expect(workflows).toHaveLength(3);
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

	const roleMap: Record<string, string> = {
		planner: PLANNER_ID,
		coder: CODER_ID,
		general: GENERAL_ID,
		reviewer: 'agent-reviewer-uuid',
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

	test('exported Coding Workflow preserves isCyclic on Verify→Plan transition', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);

		const verifyToPlan = exported.transitions.find(
			(t) => t.fromNode === 'Verify & Test' && t.toNode === 'Plan'
		);
		expect(verifyToPlan).toBeDefined();
		expect(verifyToPlan!.isCyclic).toBe(true);

		// Non-cyclic transitions should not have isCyclic
		const verifyToDone = exported.transitions.find(
			(t) => t.fromNode === 'Verify & Test' && t.toNode === 'Done'
		);
		expect(verifyToDone).toBeDefined();
		expect(verifyToDone!.isCyclic).toBeUndefined();
	});

	test('exported Coding Workflow preserves task_result conditions', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);

		const taskResultTransitions = exported.transitions.filter(
			(t) => t.condition?.type === 'task_result'
		);
		expect(taskResultTransitions).toHaveLength(2);

		const failedTransition = taskResultTransitions.find(
			(t) => t.condition?.expression === 'failed'
		);
		expect(failedTransition).toBeDefined();

		const passedTransition = taskResultTransitions.find(
			(t) => t.condition?.expression === 'passed'
		);
		expect(passedTransition).toBeDefined();
	});

	test('re-imported Coding Workflow preserves isCyclic and task_result conditions', () => {
		// Seed → export → re-import → verify round-trip fidelity
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const exported = exportWorkflow(wf, mockAgents);

		// Delete all workflows so we can re-import
		for (const w of manager.listWorkflows(SPACE_ID)) {
			manager.deleteWorkflow(w.id);
		}
		expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);

		// Re-import using the same mechanism as seedBuiltInWorkflows but from the exported format
		const stepNameToId = new Map<string, string>();
		for (const step of exported.nodes) {
			stepNameToId.set(step.name, `reimport-${step.name}`);
		}

		// Build agent name → ID map for resolving agentRef
		const agentNameToId = new Map<string, string>(mockAgents.map((a) => [a.name, a.id]));

		manager.createWorkflow({
			spaceId: SPACE_ID,
			name: exported.name,
			description: exported.description,
			nodes: exported.nodes.map((s) => ({
				id: stepNameToId.get(s.name)!,
				name: s.name,
				agentId: agentNameToId.get(s.agentRef) ?? s.agentRef,
				instructions: s.instructions,
			})),
			transitions: exported.transitions.map((t) => ({
				from: stepNameToId.get(t.fromNode)!,
				to: stepNameToId.get(t.toNode)!,
				condition: t.condition,
				order: t.order,
				isCyclic: t.isCyclic,
			})),
			startNodeId: stepNameToId.get(exported.startNode),
			rules: [],
			tags: exported.tags,
		});

		// Verify the re-imported workflow
		const reimported = manager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === CODING_WORKFLOW.name)!;
		expect(reimported).toBeDefined();
		expect(reimported.nodes).toHaveLength(4);
		expect(reimported.transitions).toHaveLength(4);

		// isCyclic preserved on Verify→Plan
		const verifyToPlan = reimported.transitions.find(
			(t) => t.condition?.type === 'task_result' && t.condition?.expression === 'failed'
		);
		expect(verifyToPlan).toBeDefined();
		expect(verifyToPlan!.isCyclic).toBe(true);

		// Non-cyclic transition should not have isCyclic
		const verifyToDone = reimported.transitions.find(
			(t) => t.condition?.type === 'task_result' && t.condition?.expression === 'passed'
		);
		expect(verifyToDone).toBeDefined();
		expect(verifyToDone!.isCyclic).toBeUndefined();

		// task_result conditions preserved
		expect(verifyToPlan!.condition?.type).toBe('task_result');
		expect(verifyToPlan!.condition?.expression).toBe('failed');
		expect(verifyToDone!.condition?.type).toBe('task_result');
		expect(verifyToDone!.condition?.expression).toBe('passed');
	});

	test('Zod schema accepts task_result condition type with expression', () => {
		// Construct a minimal exported workflow with task_result and validate
		const minimal = {
			version: 1,
			type: 'workflow',
			name: 'Test Workflow',
			nodes: [
				{ agentRef: 'Planner', name: 'Plan' },
				{ agentRef: 'General', name: 'Verify' },
			],
			transitions: [
				{
					fromNode: 'Verify',
					toNode: 'Plan',
					condition: { type: 'task_result', expression: 'failed' },
					order: 0,
					isCyclic: true,
				},
			],
			startNode: 'Plan',
			rules: [],
			tags: ['test'],
		};
		const result = validateExportedWorkflow(minimal);
		expect(result.ok).toBe(true);
	});

	test('Zod schema rejects task_result condition without expression', () => {
		const invalid = {
			version: 1,
			type: 'workflow',
			name: 'Test Workflow',
			nodes: [
				{ agentRef: 'Planner', name: 'Plan' },
				{ agentRef: 'General', name: 'Verify' },
			],
			transitions: [
				{
					fromNode: 'Verify',
					toNode: 'Plan',
					condition: { type: 'task_result' },
					order: 0,
				},
			],
			startNode: 'Plan',
			rules: [],
			tags: ['test'],
		};
		const result = validateExportedWorkflow(invalid);
		expect(result.ok).toBe(false);
	});
});
