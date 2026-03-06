/**
 * Lifecycle Hooks - Deterministic runtime gates for room autonomous mode
 *
 * Two gate points:
 * 1. Worker Exit Gate: checked in onWorkerTerminalState() before routing to Leader
 * 2. Leader Complete Gate: checked in handleLeaderTool('complete_task') before completing
 *
 * All git/gh hooks gracefully pass when external tools are unavailable.
 */

import { Logger } from '../../logger';

const log = new Logger('lifecycle-hooks');

// --- Types ---

export interface HookResult {
	pass: boolean;
	/** Human-readable reason (for logs/group timeline) */
	reason?: string;
	/** Message injected back to the agent to fix the issue */
	bounceMessage?: string;
}

export interface HookOptions {
	/** Override shell command runner for testing */
	runCommand?: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
}

export interface WorkerExitHookContext {
	workspacePath: string;
	taskType: string;
	workerRole: string;
	taskId: string;
	groupId: string;
	/** For planner tasks: how many draft tasks exist */
	draftTaskCount?: number;
	/** Whether a human has approved the task (plan or PR) */
	approved?: boolean;
}

export interface LeaderCompleteHookContext {
	workspacePath: string;
	taskType: string;
	workerRole: string;
	taskId: string;
	groupId: string;
	/** Whether the room has sub-agent reviewers configured */
	hasReviewers: boolean;
	/** For planning tasks: how many draft tasks exist */
	draftTaskCount?: number;
	/** Whether a human has approved the task (plan or PR) */
	approved?: boolean;
}

// --- Shell Command Helper ---

const BASE_BRANCHES = ['main', 'master', 'dev', 'develop'];

async function defaultRunCommand(
	args: string[],
	cwd: string
): Promise<{ stdout: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		return { stdout: stdout.trim(), exitCode };
	} catch {
		return { stdout: '', exitCode: 1 };
	}
}

function getRunner(opts?: HookOptions) {
	return opts?.runCommand ?? defaultRunCommand;
}

// --- Individual Hook Functions ---

/**
 * Check that the coder is NOT on a base branch (main/master/dev/develop).
 * Must have created a feature branch.
 */
export async function checkNotOnBaseBranch(
	ctx: WorkerExitHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	const run = getRunner(opts);
	const { stdout: branch, exitCode } = await run(
		['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
		ctx.workspacePath
	);

	if (exitCode !== 0) {
		log.debug(`checkNotOnBaseBranch: git command failed, skipping check`);
		return { pass: true };
	}

	if (BASE_BRANCHES.includes(branch)) {
		return {
			pass: false,
			reason: `Worker is on base branch "${branch}" — feature branch required.`,
			bounceMessage:
				`You are still on the base branch "${branch}". You MUST create a feature branch before finishing.\n\n` +
				'Run these commands:\n' +
				'1. `git checkout -b feat/<short-task-description>`\n' +
				'2. `git add -A && git commit -m "<description>"`\n' +
				'3. Then finish your response.\n\n' +
				'Do NOT commit directly to the main/dev/master branch.',
		};
	}

	return { pass: true };
}

/**
 * Check that a GitHub PR exists for the current branch.
 */
export async function checkPrExists(
	ctx: WorkerExitHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	const run = getRunner(opts);

	// Get current branch name
	const { stdout: branch, exitCode: branchExit } = await run(
		['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
		ctx.workspacePath
	);
	if (branchExit !== 0) {
		log.debug(`checkPrExists: git command failed, skipping check`);
		return { pass: true };
	}

	// Check for open PR on this branch
	const { stdout: prJson, exitCode: ghExit } = await run(
		['gh', 'pr', 'list', '--head', branch, '--json', 'number,url', '--state', 'open'],
		ctx.workspacePath
	);
	if (ghExit !== 0) {
		log.debug(`checkPrExists: gh command failed, skipping check`);
		return { pass: true };
	}

	try {
		const prs = JSON.parse(prJson);
		if (Array.isArray(prs) && prs.length > 0) {
			return { pass: true };
		}
	} catch {
		log.debug(`checkPrExists: failed to parse gh output, skipping check`);
		return { pass: true };
	}

	return {
		pass: false,
		reason: `No GitHub PR found for branch "${branch}".`,
		bounceMessage:
			'No GitHub pull request exists for your branch. You MUST create a PR before finishing.\n\n' +
			'Run: `git push -u origin HEAD && gh pr create --fill`\n' +
			'Then finish your response.',
	};
}

/**
 * Check that local HEAD matches the PR head SHA (all commits pushed).
 */
export async function checkPrSynced(
	ctx: WorkerExitHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	const run = getRunner(opts);

	// Get local HEAD
	const { stdout: localSha, exitCode: gitExit } = await run(
		['git', 'rev-parse', 'HEAD'],
		ctx.workspacePath
	);
	if (gitExit !== 0) {
		return { pass: true };
	}

	// Get PR head SHA
	const { stdout: remoteSha, exitCode: ghExit } = await run(
		['gh', 'pr', 'view', '--json', 'headRefOid', '--jq', '.headRefOid'],
		ctx.workspacePath
	);
	if (ghExit !== 0) {
		return { pass: true };
	}

	if (localSha !== remoteSha) {
		return {
			pass: false,
			reason: `Local HEAD (${localSha.slice(0, 8)}) differs from PR head (${remoteSha.slice(0, 8)}).`,
			bounceMessage:
				'Your local commits are not synced to the PR. Run `git push` to sync your branch, then finish your response.',
		};
	}

	return { pass: true };
}

/**
 * Check that the PR was actually merged (for post-approval coder tasks in worker exit gate).
 * Verifies the worker successfully ran `gh pr merge` before exiting.
 */
export async function checkWorkerPrMerged(
	ctx: WorkerExitHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	const run = getRunner(opts);

	const { stdout: branch, exitCode: branchExit } = await run(
		['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
		ctx.workspacePath
	);
	if (branchExit !== 0) {
		log.debug(`checkWorkerPrMerged: git command failed, skipping check`);
		return { pass: true };
	}

	const { stdout: state, exitCode: ghExit } = await run(
		['gh', 'pr', 'view', branch, '--json', 'state', '--jq', '.state'],
		ctx.workspacePath
	);
	if (ghExit !== 0) {
		log.debug(`checkWorkerPrMerged: gh command failed, skipping check`);
		return { pass: true };
	}

	const prState = state.trim();
	if (prState === 'MERGED') {
		return { pass: true };
	}
	// Empty/unexpected state is indeterminate — fail open rather than block with confusing message
	if (!prState) {
		log.debug(`checkWorkerPrMerged: gh returned empty state, skipping check`);
		return { pass: true };
	}

	if (prState === 'CLOSED') {
		return {
			pass: false,
			reason: `PR on branch "${branch}" is CLOSED (closed without merging). Cannot merge a closed PR directly.`,
			bounceMessage:
				`The PR for branch "${branch}" is CLOSED — it was closed without merging.\n\n` +
				'A closed PR cannot be merged directly. To fix this:\n' +
				'1. Reopen the PR: `gh pr reopen ${branch}`\n' +
				'2. Then merge: `gh pr merge ${branch} --merge`\n' +
				'3. Verify: `gh pr view ${branch} --json state --jq .state` (must return "MERGED")\n' +
				'4. Then finish your response.',
		};
	}

	return {
		pass: false,
		reason: `PR on branch "${branch}" is not merged (state: ${prState}). Worker must merge before exiting.`,
		bounceMessage:
			`The PR for branch "${branch}" is not merged yet (state: ${prState}).\n\n` +
			'You were asked to merge the PR. Please complete this step:\n' +
			'1. Run: `gh pr merge ${branch} --merge`\n' +
			'2. If that fails, try: `gh pr merge ${branch} --squash`\n' +
			'3. Verify: `gh pr view ${branch} --json state --jq .state` (must return "MERGED")\n' +
			'4. Then finish your response.',
	};
}

/**
 * Check that the PR was actually merged (for post-approval coding tasks in leader complete gate).
 * Prevents the leader from marking a task complete when the PR merge didn't succeed.
 */
export async function checkLeaderPrMerged(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	const run = getRunner(opts);

	const { stdout: branch, exitCode: branchExit } = await run(
		['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
		ctx.workspacePath
	);
	if (branchExit !== 0) {
		log.debug(`checkLeaderPrMerged: git command failed, skipping check`);
		return { pass: true };
	}

	const { stdout: state, exitCode: ghExit } = await run(
		['gh', 'pr', 'view', branch, '--json', 'state', '--jq', '.state'],
		ctx.workspacePath
	);
	if (ghExit !== 0) {
		log.debug(`checkLeaderPrMerged: gh command failed, skipping check`);
		return { pass: true };
	}

	const prState = state.trim();
	if (prState === 'MERGED') {
		return { pass: true };
	}
	// Empty/unexpected state is indeterminate — fail open rather than block with confusing message
	if (!prState) {
		log.debug(`checkLeaderPrMerged: gh returned empty state, skipping check`);
		return { pass: true };
	}

	if (prState === 'CLOSED') {
		return {
			pass: false,
			reason: `PR on branch "${branch}" is CLOSED (closed without merging). Task cannot be completed.`,
			bounceMessage:
				`The PR for this task is CLOSED — it was closed without merging.\n\n` +
				'A closed PR cannot be merged directly. To fix this:\n' +
				'1. Use `send_to_worker` with: "The PR was closed without merging. ' +
				`Reopen it with \`gh pr reopen ${branch}\`, then merge with \`gh pr merge ${branch} --merge\`, ` +
				`and verify with \`gh pr view ${branch} --json state --jq .state\`"\n` +
				'2. After the worker confirms the merge (state: MERGED), call `complete_task` again.',
		};
	}

	return {
		pass: false,
		reason: `PR on branch "${branch}" is not merged (state: ${prState}). Task cannot be completed until the PR is merged.`,
		bounceMessage:
			`The PR for this task is not merged (state: ${prState}). You cannot mark the task complete until the PR is actually merged.\n\n` +
			'To fix this:\n' +
			'1. Use `send_to_worker` to ask the worker: "The PR merge did not complete. ' +
			`Please run \`gh pr merge ${branch} --merge\` and verify with \`gh pr view ${branch} --json state --jq .state\`"\n` +
			'2. After the worker confirms the merge (state: MERGED), call `complete_task` again.',
	};
}

/**
 * Check that at least one draft task was created (for planner tasks).
 */
export async function checkDraftTasksCreated(
	ctx: WorkerExitHookContext,
	_opts?: HookOptions
): Promise<HookResult> {
	if ((ctx.draftTaskCount ?? 0) > 0) {
		return { pass: true };
	}

	return {
		pass: false,
		reason: 'Planner created no tasks.',
		bounceMessage:
			'You have not created any tasks yet. Use the `create_task` tool to record your task breakdown, then finish your response.',
	};
}

/**
 * Check that a PR exists before the leader can complete a coding task.
 */
export async function checkLeaderPrExists(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	const run = getRunner(opts);

	// Get current branch
	const { stdout: branch, exitCode: branchExit } = await run(
		['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
		ctx.workspacePath
	);
	if (branchExit !== 0) {
		return { pass: true };
	}

	// Check for open PR
	const { stdout: prJson, exitCode: ghExit } = await run(
		['gh', 'pr', 'list', '--head', branch, '--json', 'number', '--state', 'open'],
		ctx.workspacePath
	);
	if (ghExit !== 0) {
		return { pass: true };
	}

	try {
		const prs = JSON.parse(prJson);
		if (Array.isArray(prs) && prs.length > 0) {
			return { pass: true };
		}
	} catch {
		return { pass: true };
	}

	return {
		pass: false,
		reason: 'No PR exists for this branch. Cannot complete task without a PR.',
		bounceMessage:
			'No PR exists for this branch. Use `send_to_worker` to ask the worker to create a PR, then try again.',
	};
}

/**
 * Check that at least one review is posted on the PR (when sub-agents are configured).
 */
export async function checkPrHasReviews(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	const run = getRunner(opts);

	// Get current branch
	const { stdout: branch, exitCode: branchExit } = await run(
		['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
		ctx.workspacePath
	);
	if (branchExit !== 0) {
		return { pass: true };
	}

	// Get review count from PR
	const { stdout: reviewCount, exitCode: ghExit } = await run(
		['gh', 'pr', 'view', branch, '--json', 'reviews', '--jq', '.reviews | length'],
		ctx.workspacePath
	);
	if (ghExit !== 0) {
		return { pass: true };
	}

	const count = parseInt(reviewCount, 10);
	if (isNaN(count) || count > 0) {
		// NaN means parse failed → pass gracefully; count > 0 → reviews exist
		return { pass: true };
	}

	return {
		pass: false,
		reason: 'No reviews posted on PR. Reviewer sub-agents must review before completion.',
		bounceMessage:
			'No reviews have been posted on this PR yet. You have reviewer sub-agents configured — ' +
			'dispatch them to review the PR first, then call `complete_task` again after reviews are posted.',
	};
}

/**
 * Check that draft tasks exist before leader can complete a planning task.
 */
export async function checkLeaderDraftsExist(
	ctx: LeaderCompleteHookContext,
	_opts?: HookOptions
): Promise<HookResult> {
	if ((ctx.draftTaskCount ?? 0) > 0) {
		return { pass: true };
	}

	return {
		pass: false,
		reason: 'No draft tasks exist for this planning task.',
		bounceMessage:
			'No draft tasks were created. Use `send_to_worker` to ask the planner to create tasks using `create_task`.',
	};
}

// --- Gate Runners ---

/**
 * Run all applicable worker exit hooks for the given context.
 * Returns the first failing hook result, or { pass: true }.
 */
export async function runWorkerExitGate(
	ctx: WorkerExitHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	if (ctx.workerRole === 'coder' || ctx.workerRole === 'planner') {
		const isApproved = ctx.approved;
		if (isApproved) {
			// Post-approval: role-based verification
			if (ctx.workerRole === 'planner') {
				// Phase 2: planner must have created draft tasks from the approved plan
				const result = await checkDraftTasksCreated(ctx, opts);
				if (!result.pass) return result;
			}
			if (ctx.workerRole === 'coder') {
				// Phase 2: verify the worker actually merged the PR before exiting
				const result = await checkWorkerPrMerged(ctx, opts);
				if (!result.pass) return result;
			}
			return { pass: true };
		}

		// Pre-approval: must create feature branch, PR, and push commits
		const hooks = [checkNotOnBaseBranch, checkPrExists, checkPrSynced];
		for (const hook of hooks) {
			const result = await hook(ctx, opts);
			if (!result.pass) return result;
		}
	}

	return { pass: true };
}

/**
 * Run the leader submit-for-review gate.
 * For coder and planner tasks: PR must exist before submitting for review.
 * When reviewers are configured: reviews must be posted on the PR before submitting.
 * For other task types: pass through.
 */
export async function runLeaderSubmitGate(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	if (ctx.workerRole === 'coder' || ctx.workerRole === 'planner') {
		const prResult = await checkLeaderPrExists(ctx, opts);
		if (!prResult.pass) return prResult;

		// If reviewers are configured, reviews must be posted before submitting
		if (ctx.hasReviewers) {
			const reviewResult = await checkPrHasReviews(ctx, opts);
			if (!reviewResult.pass) return reviewResult;
		}
	}
	return { pass: true };
}

/**
 * Run all applicable leader complete hooks for the given context.
 * Returns the first failing hook result, or { pass: true }.
 */
export async function runLeaderCompleteGate(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	// Human-approved tasks: skip PR/review checks but verify merge for coding tasks.
	// For planning: verify draft tasks were created.
	// For coding: verify PR was actually merged (worker may have failed the merge).
	if (ctx.approved) {
		if (ctx.taskType === 'planning') {
			return checkLeaderDraftsExist(ctx, opts);
		}
		if (ctx.workerRole === 'coder') {
			return checkLeaderPrMerged(ctx, opts);
		}
		return { pass: true };
	}

	if (ctx.workerRole === 'coder' || ctx.workerRole === 'planner') {
		const prResult = await checkLeaderPrExists(ctx, opts);
		if (!prResult.pass) {
			return prResult;
		}

		if (ctx.hasReviewers) {
			const reviewResult = await checkPrHasReviews(ctx, opts);
			if (!reviewResult.pass) {
				return reviewResult;
			}
		}
	}

	if (ctx.taskType === 'planning') {
		const result = await checkLeaderDraftsExist(ctx, opts);
		if (!result.pass) {
			return result;
		}
	}

	return { pass: true };
}
