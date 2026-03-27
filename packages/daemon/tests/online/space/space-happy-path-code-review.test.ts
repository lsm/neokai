/**
 * Space Happy Path — Code Review with Parallel Reviewers
 *
 * Integration tests for the Coding → code-pr-gate → 3 Reviewers (parallel) →
 * review-votes-gate segment of CODING_WORKFLOW_V2.
 *
 * No real LLM sessions are started. Gate data is written directly via RPC to
 * simulate agent actions, exercising the gate/channel machinery deterministically.
 *
 * ## Workflow segment under test
 *
 *   code-pr-gate     (coder writes `pr_url`)
 *     └─► Reviewer 1, Reviewer 2, Reviewer 3 activate simultaneously
 *   review-votes-gate (all 3 write `approved` votes; count >= 3)
 *     └─► QA node activates
 *   review-reject-gate (any reviewer writes `rejected` vote; count >= 1)
 *     └─► Coding re-activates (cyclic), iteration counter increments
 *
 * ## Scenarios
 *
 * 1. Writing pr_url to code-pr-gate activates all 3 reviewers in parallel
 * 2. All 3 reviewers approve → review-votes-gate opens → QA activates
 * 3. Partial approval (2/3) → review-votes-gate stays blocked, QA not activated
 * 4. Single rejection → review-reject-gate opens → Coding re-activates (cyclic)
 * 5. Iteration counter increments when a reject cycle fires
 * 6. review-votes-gate resets after a reject cycle (resetOnCycle = true)
 * 7. Max iterations cap prevents further reject cycles
 *
 * ## Running
 *
 *   NEOKAI_USE_DEV_PROXY=1 bun test \
 *     packages/daemon/tests/online/space/space-happy-path-code-review.test.ts
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
	waitForNodeActivated,
	waitForRunStatus,
	getTasksForNode,
	mockAgentDone,
} from './helpers/space-test-helpers';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;

const NODE_ACTIVATION_TIMEOUT = IS_MOCK ? 3_000 : 15_000;
const RUN_STATUS_TIMEOUT = IS_MOCK ? 3_000 : 10_000;
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 30_000;
const TEST_TIMEOUT = IS_MOCK ? 25_000 : 90_000;

// ---------------------------------------------------------------------------
// Shared test fixture setup
// ---------------------------------------------------------------------------

/**
 * Brings the run to the point where code-pr-gate has been written and all
 * three reviewer nodes should be activating.
 *
 * Mirrors real agent behavior:
 *   1. Create space + start run
 *   2. Open plan-pr-gate (simulate planner done)
 *   3. Wait for Plan Review to activate
 *   4. Approve plan-approval-gate (simulate reviewer approved)
 *   5. Wait for Coding to activate
 *   6. Complete the Coding task (simulate coder finishing — agent completes before writing gate)
 *   7. Write code-pr-gate (simulate coder writing PR URL after completing work)
 *
 * Completing the Coding task in step 6 is essential: `onGateDataChanged` only increments
 * the iteration counter when a node is *newly* activated (activatedTasks.length > 0).
 * If the Coding task is still pending when a reject cycle fires, the node already has
 * an active task and no new activation occurs — so the counter would not increment.
 * Completing the task first lets the cyclic channel create a fresh Coding task on rejection.
 */
async function setupToCodePrGate(daemon: DaemonServerContext): Promise<{
	spaceId: string;
	runId: string;
}> {
	const { space, workflow } = await createTestSpace(daemon);
	const { runId } = await startWorkflowRun(daemon, space.id, workflow.id, 'Code-review test run');

	// Open plan-pr-gate → Plan Review activates
	await writeGateData(daemon, runId, 'plan-pr-gate', {
		plan_submitted: 'https://github.com/example/repo/pull/10',
		pr_number: 10,
		branch: 'plan/test-feature',
	});
	const planReviewTask = await waitForNodeActivated(
		daemon,
		space.id,
		runId,
		'Plan Review',
		NODE_ACTIVATION_TIMEOUT
	);
	// Complete Plan Review task so it doesn't block future gate resets
	await mockAgentDone(daemon, space.id, planReviewTask.id);

	// Approve plan-approval-gate → Coding activates
	await approveGate(daemon, runId, 'plan-approval-gate');
	const codingTask = await waitForNodeActivated(
		daemon,
		space.id,
		runId,
		'Coding',
		NODE_ACTIVATION_TIMEOUT
	);

	// Complete the Coding task before writing code-pr-gate.
	// This mirrors real agent behavior: the agent finishes work, then writes the gate.
	// It is also required for reject cycles: `onGateDataChanged` only increments the
	// iteration counter when a node is *newly* activated. If the Coding task is still
	// pending, the cyclic channel sees an active node and skips activation + counter.
	await mockAgentDone(daemon, space.id, codingTask.id, 'PR opened at feat/test-feature');

	// Coder writes code-pr-gate (triggers Reviewer 1/2/3 activation in parallel)
	await writeGateData(daemon, runId, 'code-pr-gate', {
		pr_url: 'https://github.com/example/repo/pull/99',
		pr_number: 99,
		branch: 'feat/test-feature',
	});

	return { spaceId: space.id, runId };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Space Happy Path — Code Review with Parallel Reviewers', () => {
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
	// Test 1: All 3 reviewers activate simultaneously after code-pr-gate opens
	// -------------------------------------------------------------------------
	test(
		'Writing pr_url to code-pr-gate activates all 3 reviewer nodes simultaneously',
		async () => {
			const { spaceId, runId } = await setupToCodePrGate(daemon);

			// All three reviewer nodes must activate after code-pr-gate is written.
			// Use Promise.all to confirm they all come up within the same timeout window,
			// demonstrating parallel (not sequential) activation.
			const [r1, r2, r3] = await Promise.all([
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
			]);

			expect(r1.title).toBe('Reviewer 1');
			expect(r2.title).toBe('Reviewer 2');
			expect(r3.title).toBe('Reviewer 3');
			for (const task of [r1, r2, r3]) {
				expect(task.workflowRunId).toBe(runId);
				expect(['pending', 'in_progress']).toContain(task.status);
			}

			// QA must NOT be active yet — review-votes-gate still blocked
			const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
			expect(qaTasks.length).toBe(0);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 2: code-pr-gate data is readable and contains the PR fields
	// -------------------------------------------------------------------------
	test(
		'code-pr-gate data is readable after coder writes it',
		async () => {
			const { runId } = await setupToCodePrGate(daemon);

			const gate = await readGateData(daemon, runId, 'code-pr-gate');
			expect(gate).not.toBeNull();
			expect(gate!.gateId).toBe('code-pr-gate');
			expect(gate!.data.pr_url).toBe('https://github.com/example/repo/pull/99');
			expect(gate!.data.pr_number).toBe(99);
			expect(gate!.data.branch).toBe('feat/test-feature');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 3: Partial approval (2/3) — review-votes-gate stays blocked
	// -------------------------------------------------------------------------
	test(
		'Partial approval (2 out of 3 votes) does not open review-votes-gate',
		async () => {
			const { spaceId, runId } = await setupToCodePrGate(daemon);

			// Wait for all reviewers to activate
			await Promise.all([
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
			]);

			// Reviewer 1 votes approved
			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: { 'Reviewer 1': 'approved' },
			});

			// Reviewer 2 votes approved (read-merge-write: include existing votes)
			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
			});

			// Gate has 2 approvals — condition requires min: 3. QA must NOT activate.
			const voteGate = await readGateData(daemon, runId, 'review-votes-gate');
			expect(voteGate).not.toBeNull();
			expect(voteGate!.data.votes).toEqual({
				'Reviewer 1': 'approved',
				'Reviewer 2': 'approved',
			});

			// QA must remain inactive
			const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
			expect(qaTasks.length).toBe(0);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 4: All 3 approve → review-votes-gate opens → QA activates
	// -------------------------------------------------------------------------
	test(
		'All 3 reviewers approving opens review-votes-gate and activates QA',
		async () => {
			const { spaceId, runId } = await setupToCodePrGate(daemon);

			await Promise.all([
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
			]);

			// All three vote approved (read-merge-write pattern)
			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: { 'Reviewer 1': 'approved' },
			});
			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
			});
			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: {
					'Reviewer 1': 'approved',
					'Reviewer 2': 'approved',
					'Reviewer 3': 'approved',
				},
			});

			// QA must now activate — review-votes-gate condition (count >= 3) satisfied
			const qaTask = await waitForNodeActivated(
				daemon,
				spaceId,
				runId,
				'QA',
				NODE_ACTIVATION_TIMEOUT
			);

			expect(qaTask.title).toBe('QA');
			expect(qaTask.workflowRunId).toBe(runId);
			expect(['pending', 'in_progress']).toContain(qaTask.status);

			// Run is still in_progress — QA hasn't finished yet
			const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(run.status).toBe('in_progress');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 5: Any reviewer rejects → review-reject-gate fires → Coding re-activates
	// -------------------------------------------------------------------------
	test(
		'A single reviewer rejection opens review-reject-gate and cycles back to Coding',
		async () => {
			const { spaceId, runId } = await setupToCodePrGate(daemon);

			const [r1, r2, r3] = await Promise.all([
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
			]);

			// Complete reviewer tasks so their node has no active tasks when the
			// cyclic channel tries to re-activate Coding. Without this, onGateDataChanged
			// sees the existing reviewer tasks and skips incrementAndResetCyclicGates.
			// Note: we only need to complete the reviewer that will reject; completing
			// all three ensures the cycle counter is not blocked by lingering tasks.
			await mockAgentDone(daemon, spaceId, r1.id);
			await mockAgentDone(daemon, spaceId, r2.id);
			await mockAgentDone(daemon, spaceId, r3.id);

			// Reviewer 1 writes a rejection vote to review-reject-gate.
			// The reject gate condition: count field "votes" matchValue "rejected" min: 1
			await writeGateData(daemon, runId, 'review-reject-gate', {
				votes: { 'Reviewer 1': 'rejected' },
			});

			// Coding must re-activate (cyclic channel fires)
			const codingTask = await waitForNodeActivated(
				daemon,
				spaceId,
				runId,
				'Coding',
				NODE_ACTIVATION_TIMEOUT
			);
			expect(codingTask.title).toBe('Coding');
			expect(codingTask.workflowRunId).toBe(runId);
			expect(['pending', 'in_progress']).toContain(codingTask.status);

			// QA must NOT have activated — the happy path did not complete
			const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
			expect(qaTasks.length).toBe(0);

			// Run must remain in_progress (not needs_attention — rejection is a cycle, not a human-reject)
			const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(run.status).toBe('in_progress');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 6: Iteration counter increments after a reject cycle
	// -------------------------------------------------------------------------
	test(
		'Iteration counter increments by 1 when a reject cycle fires via review-reject-gate',
		async () => {
			const { spaceId, runId } = await setupToCodePrGate(daemon);

			// Capture iteration count before the cycle
			const { run: runBefore } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			const beforeCount = runBefore.iterationCount;

			// Complete all reviewer tasks so Coding can be freshly activated on cycle
			const [r1, r2, r3] = await Promise.all([
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
			]);
			await mockAgentDone(daemon, spaceId, r1.id);
			await mockAgentDone(daemon, spaceId, r2.id);
			await mockAgentDone(daemon, spaceId, r3.id);

			// Trigger a reject cycle
			await writeGateData(daemon, runId, 'review-reject-gate', {
				votes: { 'Reviewer 2': 'rejected' },
			});

			// Wait for Coding to re-activate (confirms the cycle completed)
			await waitForNodeActivated(daemon, spaceId, runId, 'Coding', NODE_ACTIVATION_TIMEOUT);

			// Iteration counter must be exactly one more than before
			const { run: runAfter } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(runAfter.iterationCount).toBe(beforeCount + 1);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 7: review-votes-gate resets after a reject cycle (resetOnCycle: true)
	// -------------------------------------------------------------------------
	test(
		'review-votes-gate is reset after a reject cycle so reviewers must re-vote',
		async () => {
			const { spaceId, runId } = await setupToCodePrGate(daemon);

			await Promise.all([
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
			]);

			// Complete all reviewer tasks before writing votes (mirrors real agent behavior)
			for (const reviewerName of ['Reviewer 1', 'Reviewer 2', 'Reviewer 3']) {
				const tasks = await getTasksForNode(daemon, spaceId, runId, reviewerName);
				if (tasks.length > 0) {
					await mockAgentDone(daemon, spaceId, tasks[0].id);
				}
			}

			// Write partial approvals to review-votes-gate
			await writeGateData(daemon, runId, 'review-votes-gate', {
				votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
			});

			// Trigger reject cycle — Reviewer 3 rejects
			await writeGateData(daemon, runId, 'review-reject-gate', {
				votes: { 'Reviewer 3': 'rejected' },
			});

			// Wait for Coding to re-activate (cycle complete)
			await waitForNodeActivated(daemon, spaceId, runId, 'Coding', NODE_ACTIVATION_TIMEOUT);

			// review-votes-gate must have been reset to its default data ({})
			// After reset, either no record exists or the record data equals the gate's
			// default (empty object — no `votes` field).
			const votesGate = await readGateData(daemon, runId, 'review-votes-gate');
			if (votesGate !== null) {
				// The gate was reset to {} — the `votes` key should be absent or empty
				const votes = votesGate.data.votes as Record<string, string> | undefined;
				expect(votes == null || Object.keys(votes).length === 0).toBe(true);
			}
			// QA still not activated — review-votes-gate was reset, needs 3 new approvals
			const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
			expect(qaTasks.length).toBe(0);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 8: Max iterations cap prevents further reject cycles
	// -------------------------------------------------------------------------
	test(
		'Reject cycles stop being accepted once the run reaches maxIterations',
		async () => {
			const { space, workflow } = await createTestSpace(daemon);

			// Start a run with maxIterations=1 so the first reject cycle exhausts the cap
			const { run: initialRun } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
				spaceId: space.id,
				workflowId: workflow.id,
				title: 'Max-iterations test run',
				maxIterations: 1,
			})) as { run: SpaceWorkflowRun };
			const runId = initialRun.id;

			// Advance to code-pr-gate (complete tasks along the way to enable cyclic re-activation)
			await writeGateData(daemon, runId, 'plan-pr-gate', {
				plan_submitted: 'https://github.com/example/repo/pull/11',
			});
			const planReviewTask2 = await waitForNodeActivated(
				daemon,
				space.id,
				runId,
				'Plan Review',
				NODE_ACTIVATION_TIMEOUT
			);
			await mockAgentDone(daemon, space.id, planReviewTask2.id);
			await approveGate(daemon, runId, 'plan-approval-gate');
			const codingTask2 = await waitForNodeActivated(
				daemon,
				space.id,
				runId,
				'Coding',
				NODE_ACTIVATION_TIMEOUT
			);
			// Complete the Coding task before writing code-pr-gate so the cyclic channel
			// can create a fresh Coding task when the reject cycle fires
			await mockAgentDone(daemon, space.id, codingTask2.id, 'PR opened');
			await writeGateData(daemon, runId, 'code-pr-gate', {
				pr_url: 'https://github.com/example/repo/pull/101',
				pr_number: 101,
				branch: 'feat/max-iter',
			});

			// Trigger the first (and last allowed) reject cycle
			await writeGateData(daemon, runId, 'review-reject-gate', {
				votes: { 'Reviewer 1': 'rejected' },
			});
			await waitForNodeActivated(daemon, space.id, runId, 'Coding', NODE_ACTIVATION_TIMEOUT);

			// iterationCount should now equal maxIterations (1)
			const { run: afterCycle } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(afterCycle.iterationCount).toBe(1);

			// Attempting another reject cycle must fail with an error (iteration cap)
			// Write code-pr-gate again (code-pr-gate has resetOnCycle: false, so it persists)
			await writeGateData(daemon, runId, 'code-pr-gate', {
				pr_url: 'https://github.com/example/repo/pull/102',
				pr_number: 102,
				branch: 'feat/max-iter-v2',
			});

			// Wait for reviewers to be created for the second round (if they were reset)
			// Then try to write another rejection — should be blocked by iteration cap
			let errorThrown = false;
			try {
				await writeGateData(daemon, runId, 'review-reject-gate', {
					votes: { 'Reviewer 1': 'rejected' },
				});
				// If the write itself doesn't throw, check that Coding did NOT re-activate
				// (the iteration cap should prevent the cyclic channel from firing)
			} catch {
				errorThrown = true;
			}

			// Either an error was thrown (strict enforcement) OR the write succeeded but
			// Coding was NOT activated again (cap enforced at activation time).
			// Either outcome satisfies the "max iterations prevents further cycles" invariant.
			if (!errorThrown) {
				// Give a brief window to confirm Coding did not appear as a new pending task
				await new Promise((resolve) => setTimeout(resolve, 500));
				const { run: finalRun } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
					id: runId,
				})) as { run: SpaceWorkflowRun };
				// iterationCount must not have incremented further
				expect(finalRun.iterationCount).toBe(1);
			}
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 9: Reviewers not activated before code-pr-gate is written
	// -------------------------------------------------------------------------
	test(
		'Reviewer nodes are not activated before code-pr-gate is written',
		async () => {
			const { space, workflow } = await createTestSpace(daemon);
			const { runId } = await startWorkflowRun(
				daemon,
				space.id,
				workflow.id,
				'Reviewers-blocked test run'
			);

			// Open plan-pr-gate and approve plan-approval-gate to reach Coding
			await writeGateData(daemon, runId, 'plan-pr-gate', {
				plan_submitted: 'https://github.com/example/repo/pull/12',
			});
			await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);
			await approveGate(daemon, runId, 'plan-approval-gate');
			await waitForNodeActivated(daemon, space.id, runId, 'Coding', NODE_ACTIVATION_TIMEOUT);

			// code-pr-gate has NOT been written yet — reviewers must be inactive
			for (const reviewerName of ['Reviewer 1', 'Reviewer 2', 'Reviewer 3']) {
				const reviewerTasks = await getTasksForNode(daemon, space.id, runId, reviewerName);
				expect(reviewerTasks.length).toBe(0);
			}

			// Verify gate data is absent
			const codePrGate = await readGateData(daemon, runId, 'code-pr-gate');
			expect(codePrGate).toBeNull();
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 10: review-reject-gate opens with just 1 rejected vote (min: 1)
	// -------------------------------------------------------------------------
	test(
		'review-reject-gate opens with just 1 rejected vote (min: 1)',
		async () => {
			const { spaceId, runId } = await setupToCodePrGate(daemon);

			const [r1, r2, r3] = await Promise.all([
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
				waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
			]);
			// Complete reviewer tasks to enable fresh Coding activation on cycle
			await mockAgentDone(daemon, spaceId, r1.id);
			await mockAgentDone(daemon, spaceId, r2.id);
			await mockAgentDone(daemon, spaceId, r3.id);

			// Reviewer 3 is the only one to reject — that is enough
			await writeGateData(daemon, runId, 'review-reject-gate', {
				votes: { 'Reviewer 3': 'rejected' },
			});

			// Coding must re-activate despite only 1 out of 3 rejections
			const codingTask = await waitForNodeActivated(
				daemon,
				spaceId,
				runId,
				'Coding',
				NODE_ACTIVATION_TIMEOUT
			);
			expect(codingTask.title).toBe('Coding');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 11: Run stays in_progress during the entire review phase
	// -------------------------------------------------------------------------
	test(
		'Run status remains in_progress throughout the review phase',
		async () => {
			const { runId } = await setupToCodePrGate(daemon);

			// Immediately after code-pr-gate is written, run is still in_progress
			const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
				id: runId,
			})) as { run: SpaceWorkflowRun };
			expect(run.status).toBe('in_progress');

			// Also verify after run status poll helper
			const polled = await waitForRunStatus(daemon, runId, ['in_progress'], RUN_STATUS_TIMEOUT);
			expect(polled.status).toBe('in_progress');
		},
		TEST_TIMEOUT
	);
});
