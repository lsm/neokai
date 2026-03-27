/**
 * Space Happy Path — Full Pipeline End-to-End Test
 *
 * Single end-to-end integration test that drives the entire CODING_WORKFLOW_V2
 * pipeline from run start to completion, simulating every agent action via gate
 * writes rather than real LLM sessions.
 *
 * ## Full pipeline under test
 *
 *   Planning (start)
 *     └─► plan-pr-gate       — planner writes PR URL
 *   Plan Review
 *     └─► plan-approval-gate — human approves plan
 *   Coding
 *     └─► code-pr-gate       — coder writes PR URL
 *   Reviewer 1 + 2 + 3  (parallel)
 *     └─► review-votes-gate  — all 3 approve
 *   QA
 *     └─► qa-result-gate     — QA writes passed
 *   Done
 *     └─► run.status = completed
 *
 * ## Test scenarios
 *
 *  1. Happy path — full pipeline completes; run.status becomes completed
 *     Verifies every stage in order and confirms the completion summary.
 *
 *  2. Failure-and-recovery — one reviewer rejects (cycles Coding back),
 *     then QA fails once (cycles Coding back again), then happy path completes.
 *     Verifies iteration counter increments, gate resets, and eventual completion.
 *
 * ## Running
 *
 *   NEOKAI_USE_DEV_PROXY=1 bun test \
 *     packages/daemon/tests/online/space/space-happy-path-full-pipeline.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { SpaceWorkflowRun } from '@neokai/shared';
import {
	createTestSpace,
	startWorkflowRun,
	writeGateData,
	readGateData,
	approveGate,
	rejectGate,
	waitForNodeActivated,
	waitForNewNodeTask,
	waitForRunStatus,
	getTasksForNode,
	mockAgentDone,
} from './helpers/space-test-helpers';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;

const NODE_ACTIVATION_TIMEOUT = IS_MOCK ? 3_000 : 15_000;
// Run completion requires a SpaceRuntime tick (default 5s interval), so we
// allow up to 15s in mock mode to safely cover two tick periods.
const RUN_STATUS_TIMEOUT = IS_MOCK ? 15_000 : 30_000;
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 30_000;
const TEST_TIMEOUT = IS_MOCK ? 60_000 : 180_000;

// ---------------------------------------------------------------------------
// Reusable pipeline driver
// ---------------------------------------------------------------------------

/**
 * Drive the workflow from start through QA activation.
 *
 * Steps executed:
 *   1. Create space → start run → Planning task appears
 *   2. Write plan-pr-gate → Plan Review activates → complete it
 *   3. Approve plan-approval-gate → Coding activates → complete it
 *   4. Write code-pr-gate → Reviewer 1/2/3 activate (parallel) → complete all
 *   5. Write all 3 approval votes to review-votes-gate → QA activates
 *
 * Returns context needed to continue the pipeline.
 */
async function driveToQaActivated(daemon: DaemonServerContext): Promise<{
	spaceId: string;
	runId: string;
	qaTaskId: string;
}> {
	const { space, workflow } = await createTestSpace(daemon);
	const { runId } = await startWorkflowRun(daemon, space.id, workflow.id, 'Full pipeline test run');

	// ── Stage 1: Planning → plan-pr-gate ───────────────────────────────────
	const planningTask = await waitForNodeActivated(
		daemon,
		space.id,
		runId,
		'Planning',
		NODE_ACTIVATION_TIMEOUT
	);
	expect(['pending', 'in_progress']).toContain(planningTask.status);

	await writeGateData(daemon, runId, 'plan-pr-gate', {
		plan_submitted: 'https://github.com/example/repo/pull/10',
		pr_number: 10,
		branch: 'plan/test-feature',
	});
	await mockAgentDone(daemon, space.id, planningTask.id, 'Plan PR opened');

	// ── Stage 2: Plan Review → plan-approval-gate ──────────────────────────
	const planReviewTask = await waitForNodeActivated(
		daemon,
		space.id,
		runId,
		'Plan Review',
		NODE_ACTIVATION_TIMEOUT
	);
	await mockAgentDone(daemon, space.id, planReviewTask.id, 'Plan looks good');
	await approveGate(daemon, runId, 'plan-approval-gate', 'Approved after review');

	// ── Stage 3: Coding → code-pr-gate ─────────────────────────────────────
	const codingTask = await waitForNodeActivated(
		daemon,
		space.id,
		runId,
		'Coding',
		NODE_ACTIVATION_TIMEOUT
	);
	await mockAgentDone(daemon, space.id, codingTask.id, 'Implementation complete, PR opened');

	await writeGateData(daemon, runId, 'code-pr-gate', {
		pr_url: 'https://github.com/example/repo/pull/99',
		pr_number: 99,
		branch: 'feat/test-feature',
	});

	// ── Stage 4: Reviewer 1/2/3 (parallel) → review-votes-gate ─────────────
	// Collect reviewer task IDs BEFORE writing code-pr-gate activates them — but
	// code-pr-gate has already been written above. Collect IDs after activation
	// and complete them all.
	const [r1, r2, r3] = await Promise.all([
		waitForNodeActivated(daemon, space.id, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
		waitForNodeActivated(daemon, space.id, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
		waitForNodeActivated(daemon, space.id, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
	]);

	await mockAgentDone(daemon, space.id, r1.id, 'LGTM');
	await mockAgentDone(daemon, space.id, r2.id, 'LGTM');
	await mockAgentDone(daemon, space.id, r3.id, 'LGTM');

	await writeGateData(daemon, runId, 'review-votes-gate', {
		votes: {
			'Reviewer 1': 'approved',
			'Reviewer 2': 'approved',
			'Reviewer 3': 'approved',
		},
	});

	// ── Stage 5: QA activates ──────────────────────────────────────────────
	const qaTask = await waitForNodeActivated(daemon, space.id, runId, 'QA', NODE_ACTIVATION_TIMEOUT);

	return { spaceId: space.id, runId, qaTaskId: qaTask.id };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Space Happy Path — Full Pipeline End-to-End', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	// -------------------------------------------------------------------------
	// Test 1: Full happy path — every stage completes; run reaches completed
	// -------------------------------------------------------------------------
	test(
		'Full pipeline happy path: Planning → Plan Review → Coding → 3 Reviewers → QA → Done',
		async () => {
			const { spaceId, runId, qaTaskId } = await driveToQaActivated(daemon);

			// Verify run is still in_progress while QA has not yet passed
			const { run: runMid } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(runMid.status).toBe('in_progress');

			// Done must NOT be active yet
			const doneBefore = await getTasksForNode(daemon, spaceId, runId, 'Done');
			expect(doneBefore.length).toBe(0);

			// ── Stage 6: QA passes → qa-result-gate → Done activates ────────────
			await mockAgentDone(daemon, spaceId, qaTaskId, 'All CI checks green, PR mergeable');
			await writeGateData(daemon, runId, 'qa-result-gate', {
				result: 'passed',
				summary: 'All tests pass, CI green, PR in mergeable state',
			});

			const doneTask = await waitForNodeActivated(
				daemon,
				spaceId,
				runId,
				'Done',
				NODE_ACTIVATION_TIMEOUT
			);
			expect(doneTask.title).toBe('Done');
			expect(['pending', 'in_progress']).toContain(doneTask.status);

			// ── Stage 7: Complete Done → run reaches completed ─────────────────
			const completionSummary =
				'Feature implemented: PR #99 merged, all tests pass, CI green. ' +
				'Reviewed by 3 reviewers. QA confirmed mergeable state.';
			await mockAgentDone(daemon, spaceId, doneTask.id, completionSummary);

			const completedRun = await waitForRunStatus(daemon, runId, ['completed'], RUN_STATUS_TIMEOUT);
			expect(completedRun.status).toBe('completed');
			expect(completedRun.completedAt).toBeDefined();

			// ── Verify completion summary ──────────────────────────────────────
			// The Done node task's result field should contain the summary
			const doneTasks = await getTasksForNode(daemon, spaceId, runId, 'Done');
			const completedDoneTask = doneTasks.find((t) => t.status === 'completed');
			expect(completedDoneTask).toBeDefined();
			expect(completedDoneTask?.result).toBe(completionSummary);

			// Verify gate data is still accessible after completion
			const prGate = await readGateData(daemon, runId, 'code-pr-gate');
			expect(prGate).not.toBeNull();
			expect(prGate?.data.pr_number).toBe(99);

			const qaResultGate = await readGateData(daemon, runId, 'qa-result-gate');
			expect(qaResultGate).not.toBeNull();
			expect(qaResultGate?.data.result).toBe('passed');

			// Confirm iteration count stayed at 0 (no cycles needed)
			expect(completedRun.iterationCount).toBe(0);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 2: Failure-and-recovery — reviewer rejects, QA fails, then completes
	// -------------------------------------------------------------------------
	test(
		'Failure-and-recovery: reviewer rejection + QA failure → eventual completion',
		async () => {
			const { space, workflow } = await createTestSpace(daemon);
			const { runId } = await startWorkflowRun(
				daemon,
				space.id,
				workflow.id,
				'Failure-and-recovery pipeline test'
			);
			const spaceId = space.id;

			// ── Stage 1: Planning ────────────────────────────────────────────────
			const planningTask = await waitForNodeActivated(
				daemon,
				spaceId,
				runId,
				'Planning',
				NODE_ACTIVATION_TIMEOUT
			);
			await writeGateData(daemon, runId, 'plan-pr-gate', {
				plan_submitted: 'https://github.com/example/repo/pull/10',
				pr_number: 10,
				branch: 'plan/test-feature',
			});
			await mockAgentDone(daemon, spaceId, planningTask.id, 'Plan PR opened');

			// ── Stage 2: Plan Review → approve ──────────────────────────────────
			const planReviewTask = await waitForNodeActivated(
				daemon,
				spaceId,
				runId,
				'Plan Review',
				NODE_ACTIVATION_TIMEOUT
			);
			await mockAgentDone(daemon, spaceId, planReviewTask.id, 'Plan looks good');
			await approveGate(daemon, runId, 'plan-approval-gate');

			// ── Stage 3: First Coding pass ──────────────────────────────────────
			const codingTask1 = await waitForNodeActivated(
				daemon,
				spaceId,
				runId,
				'Coding',
				NODE_ACTIVATION_TIMEOUT
			);
			await mockAgentDone(daemon, spaceId, codingTask1.id, 'First implementation attempt');

			// Collect reviewer task IDs BEFORE writing code-pr-gate (activation is synchronous)
			const reviewerTasksBefore1 = [
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
			];
			const reviewerIdsBefore1 = new Set(reviewerTasksBefore1.map((t) => t.id));

			await writeGateData(daemon, runId, 'code-pr-gate', {
				pr_url: 'https://github.com/example/repo/pull/99',
				pr_number: 99,
				branch: 'feat/test-feature',
			});

			// ── Stage 4: Reviewers (first round) — Reviewer 1 rejects ───────────
			const [r1a, r2a, r3a] = await Promise.all([
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 1',
					reviewerIdsBefore1,
					NODE_ACTIVATION_TIMEOUT
				),
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 2',
					reviewerIdsBefore1,
					NODE_ACTIVATION_TIMEOUT
				),
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 3',
					reviewerIdsBefore1,
					NODE_ACTIVATION_TIMEOUT
				),
			]);

			await mockAgentDone(daemon, spaceId, r1a.id, 'Needs refactoring');
			await mockAgentDone(daemon, spaceId, r2a.id, 'LGTM');
			await mockAgentDone(daemon, spaceId, r3a.id, 'LGTM');

			// Record iteration count before reject cycle
			const { run: runBeforeReject } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			const iterBefore = runBeforeReject.iterationCount;

			// Reviewer 1 rejects — review-reject-gate opens → Coding cycles back.
			// Write to review-reject-gate (min: 1 rejected vote triggers the cyclic channel).
			const codingTasksBefore1 = await getTasksForNode(daemon, spaceId, runId, 'Coding');
			const codingIdsBefore1 = new Set(codingTasksBefore1.map((t) => t.id));

			await writeGateData(daemon, runId, 'review-reject-gate', {
				votes: { 'Reviewer 1': 'rejected' },
			});

			const codingTask2 = await waitForNewNodeTask(
				daemon,
				spaceId,
				runId,
				'Coding',
				codingIdsBefore1,
				NODE_ACTIVATION_TIMEOUT
			);
			expect(codingTask2.title).toBe('Coding');

			// Iteration counter must have incremented
			const { run: runAfterReject } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(runAfterReject.iterationCount).toBe(iterBefore + 1);

			// Run must still be in_progress (rejection is a cyclic correction)
			expect(runAfterReject.status).toBe('in_progress');

			// review-votes-gate must be reset after the cycle
			const votesGateAfterReject = await readGateData(daemon, runId, 'review-votes-gate');
			if (votesGateAfterReject !== null) {
				const votes = votesGateAfterReject.data.votes as Record<string, string> | undefined;
				expect(votes == null || Object.keys(votes).length === 0).toBe(true);
			}

			// ── Stage 5: Second Coding pass → all 3 reviewers approve ───────────
			await mockAgentDone(daemon, spaceId, codingTask2.id, 'Refactored as requested');

			// Collect reviewer task IDs BEFORE writing code-pr-gate (activation is synchronous)
			const reviewerTasksBefore2 = [
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
			];
			const reviewerIdsBefore2 = new Set(reviewerTasksBefore2.map((t) => t.id));

			await writeGateData(daemon, runId, 'code-pr-gate', {
				pr_url: 'https://github.com/example/repo/pull/99',
				pr_number: 99,
				branch: 'feat/test-feature',
			});

			const [r1b, r2b, r3b] = await Promise.all([
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 1',
					reviewerIdsBefore2,
					NODE_ACTIVATION_TIMEOUT
				),
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 2',
					reviewerIdsBefore2,
					NODE_ACTIVATION_TIMEOUT
				),
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 3',
					reviewerIdsBefore2,
					NODE_ACTIVATION_TIMEOUT
				),
			]);

			await mockAgentDone(daemon, spaceId, r1b.id, 'Looks good now');
			await mockAgentDone(daemon, spaceId, r2b.id, 'LGTM');
			await mockAgentDone(daemon, spaceId, r3b.id, 'LGTM');

			// Collect QA task IDs BEFORE writing votes (activation is synchronous)
			const qaBefore = await getTasksForNode(daemon, spaceId, runId, 'QA');
			const qaIdsBefore = new Set(qaBefore.map((t) => t.id));

			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: {
					'Reviewer 1': 'approved',
					'Reviewer 2': 'approved',
					'Reviewer 3': 'approved',
				},
			});

			// ── Stage 6: QA activates → QA fails once ───────────────────────────
			const qaTask1 = await waitForNewNodeTask(
				daemon,
				spaceId,
				runId,
				'QA',
				qaIdsBefore,
				NODE_ACTIVATION_TIMEOUT
			);

			// QA fails — cycles back to Coding
			await mockAgentDone(daemon, spaceId, qaTask1.id, 'Tests failing: 3 assertions broken');

			const codingTasksBefore2 = await getTasksForNode(daemon, spaceId, runId, 'Coding');
			const codingIdsBefore2 = new Set(codingTasksBefore2.map((t) => t.id));

			const { run: runBeforeQaFail } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			const iterBeforeQaFail = runBeforeQaFail.iterationCount;

			await writeGateData(daemon, runId, 'qa-fail-gate', {
				result: 'failed',
				summary: 'Test suite failed: 3 assertions breaking',
			});

			const codingTask3 = await waitForNewNodeTask(
				daemon,
				spaceId,
				runId,
				'Coding',
				codingIdsBefore2,
				NODE_ACTIVATION_TIMEOUT
			);

			// Iteration counter must have incremented again
			const { run: runAfterQaFail } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(runAfterQaFail.iterationCount).toBe(iterBeforeQaFail + 1);
			expect(runAfterQaFail.status).toBe('in_progress');

			// ── Stage 7: Third Coding pass → all 3 approve → QA passes → Done ───
			await mockAgentDone(daemon, spaceId, codingTask3.id, 'Fixed failing tests');

			// Collect reviewer task IDs BEFORE writing code-pr-gate
			const reviewerTasksBefore3 = [
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
				...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
			];
			const reviewerIdsBefore3 = new Set(reviewerTasksBefore3.map((t) => t.id));

			await writeGateData(daemon, runId, 'code-pr-gate', {
				pr_url: 'https://github.com/example/repo/pull/99',
				pr_number: 99,
				branch: 'feat/test-feature',
			});

			const [r1c, r2c, r3c] = await Promise.all([
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 1',
					reviewerIdsBefore3,
					NODE_ACTIVATION_TIMEOUT
				),
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 2',
					reviewerIdsBefore3,
					NODE_ACTIVATION_TIMEOUT
				),
				waitForNewNodeTask(
					daemon,
					spaceId,
					runId,
					'Reviewer 3',
					reviewerIdsBefore3,
					NODE_ACTIVATION_TIMEOUT
				),
			]);

			await mockAgentDone(daemon, spaceId, r1c.id, 'LGTM');
			await mockAgentDone(daemon, spaceId, r2c.id, 'LGTM');
			await mockAgentDone(daemon, spaceId, r3c.id, 'LGTM');

			// Collect QA task IDs BEFORE writing votes
			const qaTasksBefore2 = await getTasksForNode(daemon, spaceId, runId, 'QA');
			const qaIdsBefore2 = new Set(qaTasksBefore2.map((t) => t.id));

			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: {
					'Reviewer 1': 'approved',
					'Reviewer 2': 'approved',
					'Reviewer 3': 'approved',
				},
			});

			const qaTask2 = await waitForNewNodeTask(
				daemon,
				spaceId,
				runId,
				'QA',
				qaIdsBefore2,
				NODE_ACTIVATION_TIMEOUT
			);

			// Collect Done task IDs BEFORE writing qa-result-gate (activation is synchronous)
			const doneTasksBefore = await getTasksForNode(daemon, spaceId, runId, 'Done');
			const doneIdsBefore = new Set(doneTasksBefore.map((t) => t.id));

			// QA passes this time
			const completionSummary = 'Fixed tests pass; CI green; PR #99 mergeable.';
			await mockAgentDone(daemon, spaceId, qaTask2.id, 'All checks green');
			await writeGateData(daemon, runId, 'qa-result-gate', { result: 'passed' });

			// Done activates
			const doneTask = await waitForNewNodeTask(
				daemon,
				spaceId,
				runId,
				'Done',
				doneIdsBefore,
				NODE_ACTIVATION_TIMEOUT
			);
			expect(doneTask.title).toBe('Done');

			await mockAgentDone(daemon, spaceId, doneTask.id, completionSummary);

			// ── Final assertions ─────────────────────────────────────────────────
			const completedRun = await waitForRunStatus(daemon, runId, ['completed'], RUN_STATUS_TIMEOUT);
			expect(completedRun.status).toBe('completed');
			expect(completedRun.completedAt).toBeDefined();

			// Iteration count must be at least 2 (one reviewer reject + one QA fail)
			expect(completedRun.iterationCount).toBeGreaterThanOrEqual(2);

			// Completion summary available on the Done task
			const doneTasks = await getTasksForNode(daemon, spaceId, runId, 'Done');
			const completedDoneTask = doneTasks.find((t) => t.status === 'completed');
			expect(completedDoneTask).toBeDefined();
			expect(completedDoneTask?.result).toBe(completionSummary);
		},
		TEST_TIMEOUT
	);
});
