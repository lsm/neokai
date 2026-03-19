/**
 * Built-in Workflow Templates Unit Tests
 *
 * Covers:
 * - Template structure: correct agent refs, gate types, step count
 * - No 'leader' agent refs in any template
 * - getBuiltInWorkflows() returns all three templates
 * - seedDefaultWorkflow(): creates CODING_WORKFLOW when space is empty
 * - seedDefaultWorkflow(): idempotent — no second workflow when one exists
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
	seedDefaultWorkflow,
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

/**
 * Returns true if any step in the workflow references 'leader'.
 */
function hasLeaderRef(wf: SpaceWorkflow): boolean {
	return wf.steps.some((s) => s.agentRef === 'leader');
}

// ---------------------------------------------------------------------------
// Template structure tests
// ---------------------------------------------------------------------------

describe('CODING_WORKFLOW template', () => {
	test('has two steps', () => {
		expect(CODING_WORKFLOW.steps).toHaveLength(2);
	});

	test('first step uses planner builtin', () => {
		const step = CODING_WORKFLOW.steps[0];
		expect(step.agentRefType).toBe('builtin');
		expect(step.agentRef).toBe('planner');
	});

	test('second step uses coder builtin', () => {
		const step = CODING_WORKFLOW.steps[1];
		expect(step.agentRefType).toBe('builtin');
		expect(step.agentRef).toBe('coder');
	});

	test('planner step exit gate is human_approval', () => {
		expect(CODING_WORKFLOW.steps[0].exitGate?.type).toBe('human_approval');
	});

	test('coder step exit gate is pr_review', () => {
		expect(CODING_WORKFLOW.steps[1].exitGate?.type).toBe('pr_review');
	});

	test('does not reference leader', () => {
		expect(hasLeaderRef(CODING_WORKFLOW)).toBe(false);
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

	test('first step uses planner builtin', () => {
		const step = RESEARCH_WORKFLOW.steps[0];
		expect(step.agentRefType).toBe('builtin');
		expect(step.agentRef).toBe('planner');
	});

	test('second step uses general builtin', () => {
		const step = RESEARCH_WORKFLOW.steps[1];
		expect(step.agentRefType).toBe('builtin');
		expect(step.agentRef).toBe('general');
	});

	test('planner step exit gate is auto', () => {
		expect(RESEARCH_WORKFLOW.steps[0].exitGate?.type).toBe('auto');
	});

	test('general step exit gate is auto', () => {
		expect(RESEARCH_WORKFLOW.steps[1].exitGate?.type).toBe('auto');
	});

	test('does not reference leader', () => {
		expect(hasLeaderRef(RESEARCH_WORKFLOW)).toBe(false);
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

	test('step uses coder builtin', () => {
		const step = REVIEW_ONLY_WORKFLOW.steps[0];
		expect(step.agentRefType).toBe('builtin');
		expect(step.agentRef).toBe('coder');
	});

	test('coder step exit gate is pr_review', () => {
		expect(REVIEW_ONLY_WORKFLOW.steps[0].exitGate?.type).toBe('pr_review');
	});

	test('does not reference leader', () => {
		expect(hasLeaderRef(REVIEW_ONLY_WORKFLOW)).toBe(false);
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

	test('no template references leader as builtin agent', () => {
		for (const wf of getBuiltInWorkflows()) {
			expect(hasLeaderRef(wf)).toBe(false);
		}
	});

	test('all builtin agent refs are valid (planner/coder/general)', () => {
		const validRoles = new Set(['planner', 'coder', 'general']);
		for (const wf of getBuiltInWorkflows()) {
			for (const step of wf.steps) {
				if (step.agentRefType === 'builtin') {
					expect(validRoles.has(step.agentRef)).toBe(true);
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// seedDefaultWorkflow()
// ---------------------------------------------------------------------------

describe('seedDefaultWorkflow()', () => {
	let db: BunDatabase;
	let dir: string;
	let manager: SpaceWorkflowManager;
	const SPACE_ID = 'seed-test-space';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID);
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

	test('creates CODING_WORKFLOW for an empty space', async () => {
		await seedDefaultWorkflow(SPACE_ID, manager);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(1);
		expect(workflows[0].name).toBe(CODING_WORKFLOW.name);
	});

	test('seeded workflow has the planner and coder steps', async () => {
		await seedDefaultWorkflow(SPACE_ID, manager);
		const [wf] = manager.listWorkflows(SPACE_ID);
		expect(wf.steps).toHaveLength(2);
		expect(wf.steps[0].agentRef).toBe('planner');
		expect(wf.steps[1].agentRef).toBe('coder');
	});

	test('seeded workflow has human_approval exit gate on planner step', async () => {
		await seedDefaultWorkflow(SPACE_ID, manager);
		const [wf] = manager.listWorkflows(SPACE_ID);
		expect(wf.steps[0].exitGate?.type).toBe('human_approval');
	});

	test('seeded workflow has pr_review exit gate on coder step', async () => {
		await seedDefaultWorkflow(SPACE_ID, manager);
		const [wf] = manager.listWorkflows(SPACE_ID);
		expect(wf.steps[1].exitGate?.type).toBe('pr_review');
	});

	test('seeded workflow gets a real spaceId assigned', async () => {
		await seedDefaultWorkflow(SPACE_ID, manager);
		const [wf] = manager.listWorkflows(SPACE_ID);
		expect(wf.spaceId).toBe(SPACE_ID);
	});

	test('seeded workflow gets a real id assigned (non-empty)', async () => {
		await seedDefaultWorkflow(SPACE_ID, manager);
		const [wf] = manager.listWorkflows(SPACE_ID);
		expect(wf.id).toBeTruthy();
	});

	test('is idempotent — second call does not create another workflow', async () => {
		await seedDefaultWorkflow(SPACE_ID, manager);
		await seedDefaultWorkflow(SPACE_ID, manager);
		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(1);
	});

	test('is idempotent — leaves user-created workflows untouched', async () => {
		// User already created a custom workflow before seeding
		manager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'My Custom Workflow',
			steps: [{ name: 'Code', agentRefType: 'builtin', agentRef: 'coder' }],
		});

		await seedDefaultWorkflow(SPACE_ID, manager);

		const workflows = manager.listWorkflows(SPACE_ID);
		expect(workflows).toHaveLength(1);
		expect(workflows[0].name).toBe('My Custom Workflow');
	});
});
