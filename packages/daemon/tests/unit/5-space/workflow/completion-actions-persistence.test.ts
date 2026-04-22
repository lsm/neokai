/**
 * Regression tests for completionActions + templateName/templateHash persistence.
 *
 * Context: two silent field-drop bugs prevented `completionActions` from
 * reaching the database:
 *   - Bug A: `seedBuiltInWorkflows()` mapped template nodes without threading
 *     `completionActions`, so MERGE_PR_COMPLETION_ACTION never landed on the
 *     end node. Reviewer's `report_result()` completed the run but the PR
 *     stayed open.
 *   - Bug B: `updateWorkflow()` built its `effectiveNodes` list for validation
 *     without preserving `completionActions`. Any subsequent update call (even
 *     a plain rename) would silently strip the action if the field threading
 *     were extended to the persistence layer.
 *
 * These tests lock in:
 *   1. Seed path: end nodes in Coding Workflow and Research Workflow land in
 *      the DB with MERGE_PR_COMPLETION_ACTION attached.
 *   2. Update path: a rename/update preserves both completionActions and
 *      templateName/templateHash on disk.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
	CODING_WORKFLOW,
	RESEARCH_WORKFLOW,
	REVIEW_ONLY_WORKFLOW,
	seedBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { computeWorkflowHash } from '../../../../src/lib/space/workflows/template-hash.ts';

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

const SPACE_ID = 'space-capp';
const AGENT_IDS = {
	planner: 'agent-planner',
	coder: 'agent-coder',
	general: 'agent-general',
	research: 'agent-research',
	reviewer: 'agent-reviewer',
	qa: 'agent-qa',
};
const roleMap: Record<string, string> = {
	planner: AGENT_IDS.planner,
	coder: AGENT_IDS.coder,
	general: AGENT_IDS.general,
	research: AGENT_IDS.research,
	reviewer: AGENT_IDS.reviewer,
	qa: AGENT_IDS.qa,
};
const resolveAgentId = (role: string): string | undefined => roleMap[role.toLowerCase()];

function seedWithAllAgents(db: BunDatabase): void {
	seedSpace(db, SPACE_ID);
	seedAgent(db, AGENT_IDS.planner, SPACE_ID, 'Planner');
	seedAgent(db, AGENT_IDS.coder, SPACE_ID, 'Coder');
	seedAgent(db, AGENT_IDS.general, SPACE_ID, 'General');
	seedAgent(db, AGENT_IDS.research, SPACE_ID, 'Research');
	seedAgent(db, AGENT_IDS.reviewer, SPACE_ID, 'Reviewer');
	seedAgent(db, AGENT_IDS.qa, SPACE_ID, 'QA');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('completionActions persistence — seed path (Bug A regression)', () => {
	let db: BunDatabase;
	let manager: SpaceWorkflowManager;

	beforeEach(() => {
		db = makeDb();
		seedWithAllAgents(db);
		manager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
	});

	test('Coding Workflow end node has MERGE_PR_COMPLETION_ACTION attached', () => {
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		const endNode = wf!.nodes.find((n) => n.id === wf!.endNodeId);
		expect(endNode).toBeDefined();
		expect(endNode!.completionActions).toBeDefined();
		const mergePr = endNode!.completionActions!.find((a) => a.id === 'merge-pr');
		expect(mergePr).toBeDefined();
		expect(mergePr!.type).toBe('script');
		expect(mergePr!.artifactType).toBe('pr');
		expect(mergePr!.requiredLevel).toBe(4);
	});

	test('Research Workflow end node has MERGE_PR_COMPLETION_ACTION attached', () => {
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
		expect(wf).toBeDefined();
		const endNode = wf!.nodes.find((n) => n.id === wf!.endNodeId);
		expect(endNode).toBeDefined();
		expect(endNode!.completionActions?.some((a) => a.id === 'merge-pr')).toBe(true);
	});

	test('Review-Only Workflow end node has VERIFY_REVIEW_POSTED_COMPLETION_ACTION attached', () => {
		// Stage-2: the Review-Only end node now ships with a verification action
		// that confirms the Reviewer actually posted review feedback on the PR.
		// Without it, a Reviewer agent could call `report_result` without doing
		// anything and the task would terminate `done` on trust alone. The
		// completion-action pipeline closes that "agent lies" gap.
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name);
		expect(wf).toBeDefined();
		const endNode = wf!.nodes.find((n) => n.id === wf!.endNodeId);
		expect(endNode).toBeDefined();
		expect(endNode!.completionActions).toBeDefined();
		const verify = endNode!.completionActions!.find((a) => a.id === 'verify-review-posted');
		expect(verify).toBeDefined();
		expect(verify!.type).toBe('script');
		expect(verify!.artifactType).toBe('pr');
	});

	test('seeded workflows persist templateName + canonical templateHash', () => {
		const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		expect(wf).toBeDefined();
		expect(wf!.templateName).toBe(CODING_WORKFLOW.name);
		expect(wf!.templateHash).toBe(computeWorkflowHash(CODING_WORKFLOW));
	});
});

describe('completionActions persistence — updateWorkflow round-trip (Bug B regression)', () => {
	let db: BunDatabase;
	let manager: SpaceWorkflowManager;

	beforeEach(() => {
		db = makeDb();
		seedWithAllAgents(db);
		manager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
		seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
	});

	test('rename-only update preserves completionActions on end node', () => {
		const before = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const beforeEndNode = before.nodes.find((n) => n.id === before.endNodeId)!;
		expect(beforeEndNode.completionActions?.some((a) => a.id === 'merge-pr')).toBe(true);

		const updated = manager.updateWorkflow(before.id, { name: 'Coding Workflow (renamed)' });
		expect(updated).toBeDefined();

		const after = manager.getWorkflow(before.id)!;
		expect(after.name).toBe('Coding Workflow (renamed)');
		const afterEndNode = after.nodes.find((n) => n.id === after.endNodeId)!;
		expect(afterEndNode.completionActions?.some((a) => a.id === 'merge-pr')).toBe(true);
		// Full action survives unchanged
		const action = afterEndNode.completionActions!.find((a) => a.id === 'merge-pr')!;
		const beforeAction = beforeEndNode.completionActions!.find((a) => a.id === 'merge-pr')!;
		expect(action).toEqual(beforeAction);
	});

	test('rename-only update preserves templateName + templateHash', () => {
		const before = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const beforeName = before.templateName;
		const beforeHash = before.templateHash;
		expect(beforeName).toBe(CODING_WORKFLOW.name);
		expect(beforeHash).toBe(computeWorkflowHash(CODING_WORKFLOW));

		manager.updateWorkflow(before.id, { name: 'Coding Workflow v2' });

		const after = manager.getWorkflow(before.id)!;
		expect(after.templateName).toBe(beforeName);
		expect(after.templateHash).toBe(beforeHash);
	});

	test('node update that omits completionActions on one node preserves the one that has them', () => {
		// Caller sends nodes without specifying completionActions → manager should
		// not silently clobber existing completionActions on other nodes. This is
		// a defensive test for a class of bugs in the update path.
		const before = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const codingNode = before.nodes.find((n) => n.name === 'Coding')!;
		const reviewNode = before.nodes.find((n) => n.name === 'Review')!;
		expect(reviewNode.completionActions?.some((a) => a.id === 'merge-pr')).toBe(true);

		// Pass nodes back as-is (mimicking a UI that re-emits the full node list
		// on every save, preserving each node's completionActions).
		manager.updateWorkflow(before.id, {
			nodes: [
				{
					id: codingNode.id,
					name: codingNode.name,
					agents: codingNode.agents,
				},
				{
					id: reviewNode.id,
					name: reviewNode.name,
					agents: reviewNode.agents,
					completionActions: reviewNode.completionActions,
				},
			],
		});

		const after = manager.getWorkflow(before.id)!;
		const afterReview = after.nodes.find((n) => n.name === 'Review')!;
		expect(afterReview.completionActions?.some((a) => a.id === 'merge-pr')).toBe(true);
	});

	test('update with explicit completionActions=[] on a node clears them (caller intent honored)', () => {
		// Complements the test above — confirms that when a caller explicitly
		// passes an empty completionActions array, the update path respects that.
		const before = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
		const reviewNode = before.nodes.find((n) => n.name === 'Review')!;
		const codingNode = before.nodes.find((n) => n.name === 'Coding')!;

		manager.updateWorkflow(before.id, {
			nodes: [
				{
					id: codingNode.id,
					name: codingNode.name,
					agents: codingNode.agents,
				},
				{
					id: reviewNode.id,
					name: reviewNode.name,
					agents: reviewNode.agents,
					completionActions: [],
				},
			],
		});

		const after = manager.getWorkflow(before.id)!;
		const afterReview = after.nodes.find((n) => n.name === 'Review')!;
		// Empty array → end node has no actions (repo stores `undefined` when
		// empty array). Either empty array or undefined is acceptable; assert
		// that no action is present.
		expect(afterReview.completionActions?.length ?? 0).toBe(0);
	});
});
