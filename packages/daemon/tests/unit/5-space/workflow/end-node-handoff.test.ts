/**
 * End-node handoff prompt tests (PR 3/5, updated in PR 5/5)
 *
 * Verifies that every built-in workflow's end-node `customPrompt` agrees with
 * the post-approval routing contract:
 *
 *   - Coding / Research / QA end nodes each signal the Task Agent with
 *     `send_message(task-agent, data:{ pr_url })` BEFORE calling
 *     `approve_task`. These three workflows MUST also declare a
 *     `postApproval: { targetAgent: 'reviewer', instructions: <merge template> }`
 *     route so the runtime dispatches the merge. PR 5/5 removed the legacy
 *     `post_approval_action: "merge_pr"` discriminator from the data payload —
 *     post-approval routing is now fully declarative on the workflow's
 *     `postApproval` field and nothing consumed the runtime discriminator.
 *
 *   - QA no longer embeds `gh pr merge` / worktree-sync instructions — the
 *     reviewer post-approval session runs the merge instead. The QA workflow's
 *     `completionAutonomyLevel` is dropped from 4 → 3 accordingly (no more
 *     auto-merge at QA-approve time).
 *
 *   - Review-Only intentionally does NOT declare `postApproval` (no PR to
 *     merge) and its prompt no longer carries the "runtime verifies" boilerplate.
 *
 *   - Plan & Decompose is unchanged: it closes on its own end-node directive
 *     (verify-tasks-created) and has no `postApproval` route.
 *
 * These tests protect against silent regressions where someone edits an end-
 * node prompt and accidentally removes the Task Agent handoff, or adds a
 * `gh pr merge` back into QA, or drops one of the `postApproval` routes.
 */

import { describe, test, expect } from 'bun:test';
import type { SpaceWorkflow } from '@neokai/shared';
import {
	CODING_WORKFLOW,
	FULLSTACK_QA_LOOP_WORKFLOW,
	PLAN_AND_DECOMPOSE_WORKFLOW,
	RESEARCH_WORKFLOW,
	REVIEW_ONLY_WORKFLOW,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an end node's single-agent prompt string.
 * Throws with a loud message if the workflow shape is wrong (no end node,
 * more than one agent on the end node) — prevents silent test passes when
 * a workflow restructuring breaks invariants this test file depends on.
 */
function endNodePrompt(wf: SpaceWorkflow): string {
	const endNode = wf.nodes.find((n) => n.id === wf.endNodeId);
	if (!endNode) {
		throw new Error(`[test-fixture] ${wf.name}: no node matches endNodeId "${wf.endNodeId}"`);
	}
	if (endNode.agents.length !== 1) {
		throw new Error(
			`[test-fixture] ${wf.name}: end node "${endNode.name}" has ${endNode.agents.length} ` +
				`agents; end-node-handoff tests assume exactly 1 reviewer-style agent`
		);
	}
	const prompt = endNode.agents[0].customPrompt?.value;
	if (!prompt) {
		throw new Error(`[test-fixture] ${wf.name}: end node "${endNode.name}" has no customPrompt`);
	}
	return prompt;
}

/** Workflows that MUST declare a reviewer post-approval merge route in PR 3/5. */
const MERGE_ROUTED_WORKFLOWS: Array<[string, SpaceWorkflow]> = [
	['CODING_WORKFLOW', CODING_WORKFLOW],
	['RESEARCH_WORKFLOW', RESEARCH_WORKFLOW],
	['FULLSTACK_QA_LOOP_WORKFLOW', FULLSTACK_QA_LOOP_WORKFLOW],
];

/** Workflows that MUST NOT declare any post-approval route. */
const NO_POST_APPROVAL_WORKFLOWS: Array<[string, SpaceWorkflow]> = [
	['REVIEW_ONLY_WORKFLOW', REVIEW_ONLY_WORKFLOW],
	['PLAN_AND_DECOMPOSE_WORKFLOW', PLAN_AND_DECOMPOSE_WORKFLOW],
];

// ---------------------------------------------------------------------------
// postApproval presence
// ---------------------------------------------------------------------------

describe('End-node post-approval declarations', () => {
	for (const [label, wf] of MERGE_ROUTED_WORKFLOWS) {
		test(`${label} declares postApproval targeting the reviewer role`, () => {
			expect(wf.postApproval).toBeDefined();
			expect(wf.postApproval!.targetAgent).toBe('reviewer');
			// Uses the canonical shared merge template — not a bespoke string.
			// Any edit to the template reaches all three workflows atomically.
			expect(wf.postApproval!.instructions).toBe(PR_MERGE_POST_APPROVAL_INSTRUCTIONS);
		});

		test(`${label} postApproval targetAgent matches an actual agent name in the workflow`, () => {
			const reviewerAgent = wf.nodes
				.flatMap((n) => n.agents)
				.find((a) => a.name === wf.postApproval!.targetAgent);
			expect(reviewerAgent).toBeDefined();
		});
	}

	for (const [label, wf] of NO_POST_APPROVAL_WORKFLOWS) {
		test(`${label} has NO postApproval route (end node closes directly)`, () => {
			expect(wf.postApproval).toBeUndefined();
		});
	}
});

// ---------------------------------------------------------------------------
// End-node prompt — task-agent handoff signalling
// ---------------------------------------------------------------------------

describe('End-node prompts signal the Task Agent before approve_task', () => {
	for (const [label, wf] of MERGE_ROUTED_WORKFLOWS) {
		test(`${label} end-node prompt includes send_message(task-agent, data:{ pr_url })`, () => {
			const prompt = endNodePrompt(wf);
			// Every merge-routed workflow must instruct its end-node agent to
			// signal the Task Agent with a structured handoff carrying the
			// PR URL. `dispatchPostApproval` reads `pr_url` from the task's
			// result artifact when interpolating `{{pr_url}}` into the merge
			// template.
			expect(prompt).toContain('send_message');
			expect(prompt).toContain('target: "task-agent"');
			expect(prompt).toContain('pr_url');
			// PR 5/5: the legacy `post_approval_action: "merge_pr"`
			// discriminator was removed — post-approval routing is fully
			// declarative on `postApproval`. Guard against accidental
			// reintroduction.
			expect(prompt).not.toContain('post_approval_action');
		});

		test(`${label} end-node prompt places the task-agent signal BEFORE the final approve_task call`, () => {
			const prompt = endNodePrompt(wf);
			// Anchor on the `send_message(` call itself — the unique shape of
			// the handoff. The earlier anchor `post_approval_action: "merge_pr"`
			// was removed in PR 5/5.
			const signalIdx = prompt.indexOf('send_message(');
			// Use lastIndexOf: the first `approve_task()` occurrence in every
			// prompt lives in the "TOOL CONTRACT" block at the top, which is a
			// description of the tool — not the operational instruction. The
			// LAST occurrence is the step-level "Call approve_task()" directive,
			// which is what must follow the task-agent signal.
			const approveIdx = prompt.lastIndexOf('approve_task()');
			expect(signalIdx).toBeGreaterThan(-1);
			expect(approveIdx).toBeGreaterThan(-1);
			// Signal must appear BEFORE the operational approve_task — ordering
			// matters because approve_task is the trigger that fires
			// PostApprovalRouter.route, which reads the pr_url the end node
			// just stashed via send_message.
			expect(signalIdx).toBeLessThan(approveIdx);
		});

		test(`${label} end-node prompt instructs the agent NOT to merge itself`, () => {
			const prompt = endNodePrompt(wf);
			// Narrow guard: the end-node agent must be told explicitly that it
			// is NOT the merger. Otherwise a careless agent might shell out to
			// `gh pr merge` and race the reviewer post-approval session.
			expect(prompt.toLowerCase()).toContain('post-approval');
			// Every merge-routed workflow's end-node prompt must contain some
			// form of "do not merge yourself" guidance.
			const mentionsSelfMergeWarning =
				prompt.includes('Do NOT attempt to merge the PR yourself') ||
				prompt.includes('Do NOT run `gh pr merge`') ||
				prompt.includes('Do NOT merge the PR yourself');
			expect(mentionsSelfMergeWarning).toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// Removed legacy instructions
// ---------------------------------------------------------------------------

describe('Legacy merge/worktree instructions removed from QA end node', () => {
	test('FULLSTACK_QA_LOOP_WORKFLOW QA prompt does NOT embed gh pr merge', () => {
		const prompt = endNodePrompt(FULLSTACK_QA_LOOP_WORKFLOW);
		// The QA agent used to shell out to `gh pr merge` directly. In PR 3/5
		// the reviewer post-approval session owns the merge, so this command
		// must not appear in the positive/instructional branch of the QA prompt.
		// Mentions in a "Do NOT run `gh pr merge`" clause are allowed because
		// they actively prohibit the command rather than prescribe it.
		const bareMergeMatches = prompt.match(/gh pr merge/g) ?? [];
		const prohibitions = prompt.match(/Do NOT run `gh pr merge`/g) ?? [];
		expect(bareMergeMatches.length).toBe(prohibitions.length);
	});

	test('FULLSTACK_QA_LOOP_WORKFLOW QA prompt does NOT instruct worktree sync', () => {
		const prompt = endNodePrompt(FULLSTACK_QA_LOOP_WORKFLOW);
		// Worktree sync (`git checkout dev && git pull --ff-only`) was part of
		// the old QA-merges-the-PR flow. Post-approval now runs it in the
		// reviewer session, so the QA prompt must not prescribe it directly.
		expect(prompt).not.toContain('git pull --ff-only');
		expect(prompt).not.toContain('git checkout dev');
	});

	test('FULLSTACK_QA_LOOP_WORKFLOW completionAutonomyLevel is 3 (dropped from 4 in PR 3/5)', () => {
		// QA-approve is now a plain "work is good" signal — auto-merge is the
		// reviewer post-approval session's concern, gated by its own autonomy
		// check inside the merge template. Level 3 matches Coding's tier.
		expect(FULLSTACK_QA_LOOP_WORKFLOW.completionAutonomyLevel).toBe(3);
	});
});

describe('Review-Only end-node prompt loses verification boilerplate', () => {
	test('REVIEW_ONLY_WORKFLOW prompt does NOT claim "runtime verifies"', () => {
		const prompt = endNodePrompt(REVIEW_ONLY_WORKFLOW);
		// The old trailing "; the runtime verifies at least one review/comment
		// exists before accepting completion" sentence was removed — the
		// agent prompt no longer duplicates the claim. PR 4/5 removed the
		// runtime verification action and PR 5/5 deleted the schema, so the
		// review check now lives entirely in agent guidance.
		expect(prompt).not.toContain('runtime verifies');
		expect(prompt).not.toContain('before accepting completion');
	});

	test('REVIEW_ONLY_WORKFLOW prompt still requires gh pr review before approve_task', () => {
		const prompt = endNodePrompt(REVIEW_ONLY_WORKFLOW);
		// Positive assertion: the core "post to GitHub first" guarantee is
		// unchanged — this test guards against over-aggressive edits that
		// strip the requirement along with the boilerplate.
		expect(prompt).toContain('gh pr review');
		expect(prompt).toContain('save_artifact');
		expect(prompt).toContain('approve_task()');
	});
});

describe('Plan & Decompose end-node is unchanged', () => {
	test('PLAN_AND_DECOMPOSE_WORKFLOW Task Dispatcher prompt does NOT signal the task-agent', () => {
		const prompt = endNodePrompt(PLAN_AND_DECOMPOSE_WORKFLOW);
		// Plan & Decompose has no PR to merge; its completion is signalled by
		// the verify-tasks-created directive, not by a Task Agent handoff. The
		// end-node prompt MUST NOT adopt the handoff-signalling convention
		// specific to the three PR-producing workflows.
		expect(prompt).not.toContain('send_message');
		// Legacy discriminator is also still absent (PR 5/5 removed it from
		// the PR-producing workflows; this negative assertion guards against
		// drift in either direction).
		expect(prompt).not.toContain('post_approval_action');
	});

	test('PLAN_AND_DECOMPOSE_WORKFLOW Task Dispatcher still calls create_standalone_task + approve_task', () => {
		const prompt = endNodePrompt(PLAN_AND_DECOMPOSE_WORKFLOW);
		// Positive assertions mirror the existing structural tests in
		// built-in-workflows.test.ts — kept here so this file reads as a
		// complete contract of the end-node-handoff behaviour per workflow.
		expect(prompt).toContain('create_standalone_task');
		expect(prompt).toContain('approve_task');
	});
});

// ---------------------------------------------------------------------------
// Merge-template snapshot (structural, not char-for-char)
// ---------------------------------------------------------------------------

describe('Shared merge template canonical content', () => {
	test('template references the documented §1.6 runtime tokens', () => {
		// The merge template is interpolated by
		// post-approval-template.ts::interpolatePostApprovalTemplate at routing
		// time. These are the runtime-populated tokens the plan guarantees (see
		// post-approval-merge-template.ts header).
		//
		// `{{reviewer_name}}` is intentionally NOT in the set: see the file-level
		// NOTE in post-approval-merge-template.ts. It was collapsed to the
		// static label `[end-node reviewer]` in PR 3/5 because nothing in
		// `dispatchPostApproval` populates `routeContext.reviewer_name`, and
		// leaving a literal placeholder in the kickoff degrades the reviewer
		// sub-session. A follow-up PR will thread the approving agent's slot
		// name through and restore the token.
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('{{pr_url}}');
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('{{autonomy_level}}');
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('{{approval_source}}');
		// Locked: `{{reviewer_name}}` must NOT appear — swap to static label.
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('{{reviewer_name}}');
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('[end-node reviewer]');
	});

	test('template instructs mark_complete (NOT approve_task) for the final step', () => {
		// Post-approval closes the `approved → done` transition via
		// `mark_complete`. Using `approve_task` here would be a double-fire
		// and the MCP tool rejects it anyway, but the prompt must use the
		// correct verb so the session calls the right tool.
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('mark_complete()');
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('DO NOT call approve_task');
	});

	test('template gates auto-merge behind autonomy_level >= 4', () => {
		// Section 2 of the template body is the human-approval fallback for
		// autonomy < 4. Dropping the fallback would silently auto-merge for
		// low-autonomy spaces, which is explicitly forbidden by the plan.
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('autonomy_level < 4');
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('request_human_input');
	});

	test('template contains the squash-merge command and conflict guard', () => {
		// Specific command shapes: protects against well-intentioned edits
		// that swap `--squash` for `--merge` or drop the conflict guard.
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain(
			'gh pr merge {{pr_url}} --squash --delete-branch'
		);
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('merge conflict');
		expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('do NOT force');
	});
});
