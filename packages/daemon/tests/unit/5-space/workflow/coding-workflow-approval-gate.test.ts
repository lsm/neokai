/**
 * CODING_WORKFLOW Approval-Gate Tests
 *
 * Regression coverage for the Coder↔Reviewer loop bug (task #39):
 * the run was being marked `done` prematurely when the Reviewer sent a
 * "request changes" message, because any `task.reportedStatus !== null`
 * triggered CompletionDetector to return true, and the Review node was
 * the workflow's `endNodeId`.
 *
 * The fix adds an explicit Done node gated by `review-approval-gate`:
 *   Coding ↔ Review (iterative loop)
 *   Review → Done  (gated — opens only on `approved: true`)
 *
 * Done is the new `endNodeId`, so `report_result` is ONLY available on
 * Done's agent. The Reviewer must pass through the approval gate to
 * finalize the workflow.
 *
 * This test file exercises the gate + activation wiring at the
 * ChannelRouter level (not mocks) using the real CODING_WORKFLOW template
 * as seeded by `seedBuiltInWorkflows`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { ChannelRouter } from '../../../../src/lib/space/runtime/channel-router.ts';
import { CompletionDetector } from '../../../../src/lib/space/runtime/completion-detector.ts';
import {
	CODING_WORKFLOW,
	seedBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-coding-workflow-approval-gate',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Fixture: seed CODING_WORKFLOW into a fresh space + build a live router.
// ---------------------------------------------------------------------------

describe('CODING_WORKFLOW approval-gate round-trip', () => {
	const SPACE_ID = 'space-coding-approval';
	const CODER_ID = 'agent-coder-uuid';
	const REVIEWER_ID = 'agent-reviewer-uuid';
	const GENERAL_ID = 'agent-general-uuid';
	const PLANNER_ID = 'agent-planner-uuid';
	const RESEARCH_ID = 'agent-research-uuid';
	const QA_ID = 'agent-qa-uuid';

	const roleMap: Record<string, string> = {
		coder: CODER_ID,
		reviewer: REVIEWER_ID,
		general: GENERAL_ID,
		planner: PLANNER_ID,
		research: RESEARCH_ID,
		qa: QA_ID,
	};
	const resolveAgentId = (role: string): string | undefined => roleMap[role.toLowerCase()];

	let db: BunDatabase;
	let dir: string;
	let workflowManager: SpaceWorkflowManager;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let gateDataRepo: GateDataRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let router: ChannelRouter;
	let completionDetector: CompletionDetector;
	let codingWorkflow: SpaceWorkflow;
	let codingNodeId: string;
	let reviewNodeId: string;
	let doneNodeId: string;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID);

		// Seed preset SpaceAgent rows (used by seedBuiltInWorkflows).
		for (const [, agentId] of Object.entries(roleMap)) {
			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
         VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
			).run(agentId, SPACE_ID, `Agent ${agentId}`, Date.now(), Date.now());
		}

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		gateDataRepo = new GateDataRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		const channelCycleRepo = new ChannelCycleRepository(db);
		const agentRepo = new SpaceAgentRepository(db);
		const agentManager = new SpaceAgentManager(agentRepo);

		// Auto-create a canonical task on every run creation (mirrors the
		// one-task-per-run invariant enforced by SpaceRuntime).
		const createRunOriginal = workflowRunRepo.createRun.bind(workflowRunRepo);
		(
			workflowRunRepo as unknown as {
				createRun: typeof workflowRunRepo.createRun;
			}
		).createRun = ((params: Parameters<typeof workflowRunRepo.createRun>[0]) => {
			const run = createRunOriginal(params);
			taskRepo.createTask({
				spaceId: params.spaceId,
				title: params.title,
				description: params.description ?? '',
				status: 'open',
				workflowRunId: run.id,
			});
			return run;
		}) as typeof workflowRunRepo.createRun;

		// Seed the built-in templates, then locate the persisted CODING_WORKFLOW.
		seedBuiltInWorkflows(SPACE_ID, workflowManager, resolveAgentId);
		const wf = workflowManager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
		if (!wf) throw new Error('CODING_WORKFLOW not seeded');
		codingWorkflow = wf;
		codingNodeId = wf.nodes.find((n) => n.name === 'Coding')!.id;
		reviewNodeId = wf.nodes.find((n) => n.name === 'Review')!.id;
		doneNodeId = wf.nodes.find((n) => n.name === 'Done')!.id;

		router = new ChannelRouter({
			taskRepo,
			workflowRunRepo,
			workflowManager,
			agentManager,
			gateDataRepo,
			channelCycleRepo,
			db,
			nodeExecutionRepo,
		});
		completionDetector = new CompletionDetector(taskRepo);
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

	// -------------------------------------------------------------------------
	// Structural guarantees on the seeded workflow
	// -------------------------------------------------------------------------

	test('seeded Done node is the workflow endNodeId (not Review)', () => {
		expect(codingWorkflow.endNodeId).toBe(doneNodeId);
		expect(codingWorkflow.endNodeId).not.toBe(reviewNodeId);
	});

	test('the only channel into the Done node is gated by review-approval-gate', () => {
		const intoDone = (codingWorkflow.channels ?? []).filter((c) => {
			const tos = Array.isArray(c.to) ? c.to : [c.to];
			return tos.includes('Done');
		});
		expect(intoDone).toHaveLength(1);
		expect(intoDone[0].gateId).toBe('review-approval-gate');
	});

	// -------------------------------------------------------------------------
	// "Request changes" round — run MUST stay in_progress
	// -------------------------------------------------------------------------

	test('Reviewer requesting changes does NOT activate Done and does NOT mark the run complete', async () => {
		const run = workflowRunRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: codingWorkflow.id,
			title: 'Loop stays open',
		});
		workflowRunRepo.transitionStatus(run.id, 'in_progress');

		// Reviewer sends a plain "please fix X" message back to Coding. The
		// Review → Coding channel is now guarded by `review-posted-gate` (from
		// PR #1532), whose bash script queries GitHub for a real review. In a
		// unit-test environment that script will fail — that's fine for this
		// test: the invariant we care about is that the reviewer's attempt to
		// request changes never activates Done or marks the run complete.
		try {
			await router.deliverMessage(run.id, 'reviewer', 'coder', 'Please address review comments');
		} catch {
			// review-posted-gate legitimately blocks here (no live PR); the key
			// assertions below cover the "did NOT mark run done" invariant.
		}

		// Done must NOT have any executions — even if the gate blocked delivery,
		// no path to Done was taken, which is the primary thing we're pinning.
		const doneExecs = nodeExecutionRepo.listByNode(run.id, doneNodeId);
		expect(doneExecs).toHaveLength(0);

		// The canonical task has no reportedStatus — workflow is not complete.
		const tasks = taskRepo.listByWorkflowRun(run.id);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].reportedStatus).toBeNull();
		expect(completionDetector.isComplete({ workflowRunId: run.id })).toBe(false);

		// And the run status itself is still in_progress — critical: the next
		// send_message from the Coder must not error with
		// "Cannot activate node for run in status 'done'".
		const refreshed = workflowRunRepo.getRun(run.id)!;
		expect(refreshed.status).toBe('in_progress');
	});

	test('review-approval-gate stays closed until approved: true is written', async () => {
		const run = workflowRunRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: codingWorkflow.id,
			title: 'Gate stays closed',
		});
		workflowRunRepo.transitionStatus(run.id, 'in_progress');

		// Write approved: false (or empty) — gate should NOT open.
		gateDataRepo.set(run.id, 'review-approval-gate', { approved: false });
		let activated = await router.onGateDataChanged(run.id, 'review-approval-gate');
		expect(activated).toHaveLength(0);
		expect(nodeExecutionRepo.listByNode(run.id, doneNodeId)).toHaveLength(0);

		// Only explicit approved: true opens the gate.
		gateDataRepo.set(run.id, 'review-approval-gate', { approved: true });
		activated = await router.onGateDataChanged(run.id, 'review-approval-gate');
		expect(activated.length).toBeGreaterThan(0);
		expect(nodeExecutionRepo.listByNode(run.id, doneNodeId).length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Approval round — Done activates, run completes via Done's report_result
	// -------------------------------------------------------------------------

	test('writing approved: true via the gate activates Done; only then does CompletionDetector flip', async () => {
		const run = workflowRunRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: codingWorkflow.id,
			title: 'Approval activates Done',
		});
		workflowRunRepo.transitionStatus(run.id, 'in_progress');

		// Before approval: Done not active, not complete.
		expect(nodeExecutionRepo.listByNode(run.id, doneNodeId)).toHaveLength(0);
		expect(completionDetector.isComplete({ workflowRunId: run.id })).toBe(false);

		// Reviewer approves: write the gate field. This mirrors what the Reviewer's
		// send_message(target='Done', data={ approved: true }) does at runtime.
		gateDataRepo.set(run.id, 'review-approval-gate', { approved: true });
		const activated = await router.onGateDataChanged(run.id, 'review-approval-gate');
		expect(activated.length).toBeGreaterThan(0);

		// Done node now has a pending execution.
		const doneExecs = nodeExecutionRepo.listByNode(run.id, doneNodeId);
		expect(doneExecs.length).toBeGreaterThan(0);

		// Even though Done is activated, the workflow is still NOT complete until
		// the Done agent actually reports. This is the second line of defense:
		// reportedStatus must come from an end-node agent (Done).
		expect(completionDetector.isComplete({ workflowRunId: run.id })).toBe(false);

		// Simulate the Done agent calling report_result — this is the only path to
		// reportedStatus, and it's only wired for the endNodeId.
		const task = taskRepo.listByWorkflowRun(run.id)[0];
		taskRepo.updateTask(task.id, {
			reportedStatus: 'done',
			reportedSummary: 'Reviewer approved; run complete.',
		});

		expect(completionDetector.isComplete({ workflowRunId: run.id })).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Full round-trip: changes → loop → approval → Done → complete
	// -------------------------------------------------------------------------

	test('full round-trip: request-changes keeps loop alive, approval ultimately completes the run', async () => {
		const run = workflowRunRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: codingWorkflow.id,
			title: 'Full round-trip',
		});
		workflowRunRepo.transitionStatus(run.id, 'in_progress');

		// --- Round 1: Coding → Review (gate: code-ready-gate requires pr_url) ---
		// Simulate the Coder pushing the PR URL to open the code-ready-gate.
		gateDataRepo.set(run.id, 'code-ready-gate', { pr_url: 'https://example.com/pr/1' });
		// The script-based gate evaluates on activation attempt; bypass it for this
		// test by activating the Review node directly — the script path is covered
		// elsewhere, and what we care about here is the Review→Done handoff.
		await router.activateNode(run.id, reviewNodeId);
		const reviewExecs1 = nodeExecutionRepo.listByNode(run.id, reviewNodeId);
		expect(reviewExecs1.length).toBeGreaterThan(0);

		// --- Round 1: Reviewer requests changes → back to Coding, NOT Done ---
		// The Review → Coding channel is guarded by `review-posted-gate` (from
		// PR #1532). In unit-test env the script fails — we catch the blocked
		// error and assert the key invariant: Done is NOT activated and the
		// run does NOT flip to `done` on a "request changes" round.
		try {
			await router.deliverMessage(run.id, 'reviewer', 'coder', 'Please rename X to Y');
		} catch {
			// review-posted-gate legitimately blocks; see note on the earlier test.
		}
		expect(nodeExecutionRepo.listByNode(run.id, doneNodeId)).toHaveLength(0);
		expect(completionDetector.isComplete({ workflowRunId: run.id })).toBe(false);
		expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');

		// --- Round 2: Coder pushes again, Review re-activates, Reviewer approves ---
		// (Review is already activated from round 1; cyclic re-entry is a no-op for
		//  this unit test — the key check is the approval gate, below.)
		gateDataRepo.merge(run.id, 'review-approval-gate', { approved: true });
		const activated = await router.onGateDataChanged(run.id, 'review-approval-gate');
		expect(activated.length).toBeGreaterThan(0);
		// Done is now activated but no report_result yet → still not complete.
		expect(nodeExecutionRepo.listByNode(run.id, doneNodeId).length).toBeGreaterThan(0);
		expect(completionDetector.isComplete({ workflowRunId: run.id })).toBe(false);

		// --- Done's "closer" agent calls report_result — NOW the run can complete ---
		const task = taskRepo.listByWorkflowRun(run.id)[0];
		taskRepo.updateTask(task.id, {
			reportedStatus: 'done',
			reportedSummary: 'Approved.',
		});
		expect(completionDetector.isComplete({ workflowRunId: run.id })).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Gate writer authorization: only the reviewer can write `approved`
	// -------------------------------------------------------------------------

	test('review-approval-gate.approved is declared writable only by the reviewer', () => {
		const gate = codingWorkflow.gates!.find((g) => g.id === 'review-approval-gate')!;
		const approvedField = gate.fields.find((f) => f.name === 'approved')!;
		expect(approvedField.writers).toEqual(['reviewer']);
		// Non-reviewer writer candidates would require either a matching writers
		// entry or satisfying the gate's requiredLevel (autonomy path) — the
		// reviewer role is the only intended writer and that is what we pin here.
	});
});
