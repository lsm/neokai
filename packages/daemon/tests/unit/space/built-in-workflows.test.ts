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

	test('has no transitions (routing is channel-based)', () => {
		expect(CODING_WORKFLOW.transitions).toHaveLength(0);
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

	test('has no transitions (routing is channel-based)', () => {
		expect(RESEARCH_WORKFLOW.transitions).toHaveLength(0);
	});

	test('has one channel (Plan Research → Research) with always gate', () => {
		expect(RESEARCH_WORKFLOW.channels).toHaveLength(1);
		const ch = RESEARCH_WORKFLOW.channels![0];
		expect(ch.from).toBe('Plan Research');
		expect(ch.to).toBe('Research');
		expect(ch.direction).toBe('one-way');
		expect(ch.gate?.type).toBe('always');
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

	test('CODING_WORKFLOW seeded with no transitions (routing is channel-based)', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf!.transitions).toHaveLength(0);
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

	test('RESEARCH_WORKFLOW seeded correctly — planner + general, no transitions', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.nodes).toHaveLength(2);
		expect(wf!.nodes[0].agentId).toBe(PLANNER_ID);
		expect(wf!.nodes[1].agentId).toBe(GENERAL_ID);
		expect(wf!.transitions).toHaveLength(0);
	});

	test('REVIEW_ONLY_WORKFLOW seeded with no channels', async () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
		expect(wf.channels ?? []).toHaveLength(0);
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

	test('exported Coding Workflow has no transitions (routing is channel-based)', () => {
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

		const exported = exportWorkflow(wf, mockAgents);
		expect(exported.transitions).toHaveLength(0);
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
		expect(reimported.transitions).toHaveLength(0);
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
