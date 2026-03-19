/**
 * Built-in Workflow Templates Unit Tests
 *
 * Covers:
 * - Template structure: correct agentId placeholders, gate types, step count
 * - agentId placeholders are valid builtin role names (no 'leader')
 * - getBuiltInWorkflows() returns all three templates
 * - seedBuiltInWorkflows(): seeds all three templates with real agent IDs
 * - seedBuiltInWorkflows(): idempotent — no re-seed if workflows already exist
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
import type { SpaceWorkflow } from '@neokai/shared';

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
	return wf.steps.some((s) => s.agentId === 'leader');
}

// ---------------------------------------------------------------------------
// Template structure tests
// ---------------------------------------------------------------------------

describe('CODING_WORKFLOW template', () => {
	test('has two steps', () => {
		expect(CODING_WORKFLOW.steps).toHaveLength(2);
	});

	test('first step agentId placeholder is planner', () => {
		expect(CODING_WORKFLOW.steps[0].agentId).toBe('planner');
	});

	test('second step agentId placeholder is coder', () => {
		expect(CODING_WORKFLOW.steps[1].agentId).toBe('coder');
	});

	test('planner step exit gate is human_approval', () => {
		expect(CODING_WORKFLOW.steps[0].exitGate?.type).toBe('human_approval');
	});

	test('coder step exit gate is pr_review', () => {
		expect(CODING_WORKFLOW.steps[1].exitGate?.type).toBe('pr_review');
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(CODING_WORKFLOW)).toBe(false);
	});

	test('steps have ascending order values', () => {
		const orders = CODING_WORKFLOW.steps.map((s) => s.order);
		expect(orders).toEqual([0, 1]);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(CODING_WORKFLOW.id).toBe('');
		expect(CODING_WORKFLOW.spaceId).toBe('');
	});
});

describe('RESEARCH_WORKFLOW template', () => {
	test('has two steps', () => {
		expect(RESEARCH_WORKFLOW.steps).toHaveLength(2);
	});

	test('first step agentId placeholder is planner', () => {
		expect(RESEARCH_WORKFLOW.steps[0].agentId).toBe('planner');
	});

	test('second step agentId placeholder is general', () => {
		expect(RESEARCH_WORKFLOW.steps[1].agentId).toBe('general');
	});

	test('planner step exit gate is auto', () => {
		expect(RESEARCH_WORKFLOW.steps[0].exitGate?.type).toBe('auto');
	});

	test('general step exit gate is auto', () => {
		expect(RESEARCH_WORKFLOW.steps[1].exitGate?.type).toBe('auto');
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(RESEARCH_WORKFLOW)).toBe(false);
	});

	test('steps have ascending order values', () => {
		const orders = RESEARCH_WORKFLOW.steps.map((s) => s.order);
		expect(orders).toEqual([0, 1]);
	});

	test('template id and spaceId are empty (not space-specific)', () => {
		expect(RESEARCH_WORKFLOW.id).toBe('');
		expect(RESEARCH_WORKFLOW.spaceId).toBe('');
	});
});

describe('REVIEW_ONLY_WORKFLOW template', () => {
	test('has one step', () => {
		expect(REVIEW_ONLY_WORKFLOW.steps).toHaveLength(1);
	});

	test('step agentId placeholder is coder', () => {
		expect(REVIEW_ONLY_WORKFLOW.steps[0].agentId).toBe('coder');
	});

	test('coder step exit gate is pr_review', () => {
		expect(REVIEW_ONLY_WORKFLOW.steps[0].exitGate?.type).toBe('pr_review');
	});

	test('does not reference leader', () => {
		expect(hasLeaderAgentId(REVIEW_ONLY_WORKFLOW)).toBe(false);
	});

	test('step order is 0', () => {
		expect(REVIEW_ONLY_WORKFLOW.steps[0].order).toBe(0);
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
			for (const step of wf.steps) {
				expect(VALID_BUILTIN_ROLES.has(step.agentId)).toBe(true);
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
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(3);
	});

	test('seeded workflow names match all three templates', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
		expect(names).toContain(CODING_WORKFLOW.name);
		expect(names).toContain(RESEARCH_WORKFLOW.name);
		expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
	});

	test('CODING_WORKFLOW seeded correctly — planner + coder steps with real agent IDs', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.steps).toHaveLength(2);
		expect(wf!.steps[0].agentId).toBe(PLANNER_ID);
		expect(wf!.steps[1].agentId).toBe(CODER_ID);
	});

	test('CODING_WORKFLOW seeded with human_approval + pr_review gates', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf!.steps[0].exitGate?.type).toBe('human_approval');
		expect(wf!.steps[1].exitGate?.type).toBe('pr_review');
	});

	test('RESEARCH_WORKFLOW seeded correctly — planner + general with auto gates', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.steps).toHaveLength(2);
		expect(wf!.steps[0].agentId).toBe(PLANNER_ID);
		expect(wf!.steps[1].agentId).toBe(GENERAL_ID);
		expect(wf!.steps[0].exitGate?.type).toBe('auto');
		expect(wf!.steps[1].exitGate?.type).toBe('auto');
	});

	test('REVIEW_ONLY_WORKFLOW seeded correctly — single coder step with pr_review gate', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.steps).toHaveLength(1);
		expect(wf!.steps[0].agentId).toBe(CODER_ID);
		expect(wf!.steps[0].exitGate?.type).toBe('pr_review');
	});

	test('all seeded workflows have the real spaceId assigned', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			expect(wf.spaceId).toBe(SPACE_ID);
		}
	});

	test('all seeded workflows have non-empty ids assigned', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		for (const wf of manager.listWorkflows(SPACE_ID)) {
			expect(wf.id).toBeTruthy();
		}
	});

	test('is idempotent — second call does not create additional workflows', async () => {
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(3);
	});

	test('is idempotent — leaves user-created workflows untouched', async () => {
		// User already created a custom workflow before seeding
		manager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'My Custom Workflow',
			steps: [{ name: 'Code', agentId: CODER_ID }],
		});

		await seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(1);
		expect(workflows[0].name).toBe('My Custom Workflow');
	});

	test('throws if resolveAgentId returns undefined for a required role', async () => {
		// Resolver that cannot resolve 'planner'
		const brokenResolver = (role: string): string | undefined =>
			role === 'planner' ? undefined : roleMap[role];

		await expect(seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver)).rejects.toThrow(
			"no SpaceAgent found for role 'planner'"
		);
	});

	test('does not persist any workflow when resolveAgentId fails on first-template role', async () => {
		// Resolver fails on 'planner' — first template's first step
		const brokenResolver = (role: string): string | undefined =>
			role === 'planner' ? undefined : roleMap[role];

		try {
			await seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
		} catch {
			// expected
		}
		// Pre-validation throws before any workflow is committed
		expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
	});

	test('does not persist any workflow when resolveAgentId fails on a later-template role', async () => {
		// 'general' is only needed by RESEARCH_WORKFLOW (2nd template).
		// Without pre-validation, CODING_WORKFLOW would already be committed when this throws.
		const brokenResolver = (role: string): string | undefined =>
			role === 'general' ? undefined : roleMap[role];

		try {
			await seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
		} catch {
			// expected
		}
		// Pre-validation catches the missing role before any workflow is persisted
		expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
	});
});
