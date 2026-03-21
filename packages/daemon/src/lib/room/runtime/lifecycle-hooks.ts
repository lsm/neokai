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

// --- Bypass Markers ---

/**
 * Special markers that workers can use to bypass git/PR gates
 * for read-only tasks that produce no file changes.
 * DOCUMENTATION_COMPLETE is intentionally excluded: writing docs requires file changes
 * and should follow the normal git/PR workflow.
 */
export const BYPASS_GATES_MARKERS = {
	RESEARCH_ONLY: 'RESEARCH_ONLY:',
	VERIFICATION_COMPLETE: 'VERIFICATION_COMPLETE:',
	INVESTIGATION_RESULT: 'INVESTIGATION_RESULT:',
	ANALYSIS_COMPLETE: 'ANALYSIS_COMPLETE:',
} as const;

export type BypassMarker = (typeof BYPASS_GATES_MARKERS)[keyof typeof BYPASS_GATES_MARKERS];

/**
 * Check if worker output starts with a bypass marker.
 * Only the first non-empty line of the output is checked to prevent false positives
 * from markers mentioned inside code blocks, analysis text, or quoted content.
 * Returns the marker if found, null otherwise.
 */
export function detectBypassMarker(workerOutput: string): BypassMarker | null {
	const lines = workerOutput.split('\n');
	const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
	if (!firstNonEmptyLine) return null;

	for (const marker of Object.values(BYPASS_GATES_MARKERS)) {
		if (firstNonEmptyLine.trim().startsWith(marker)) {
			return marker as BypassMarker;
		}
	}

	return null;
}

// --- Types ---

export interface HookResult {
	pass: boolean;
	/** Set to true when the worker used a bypass marker to skip git/PR gates */
	bypassed?: boolean;
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
	/** Worker's final output text (for detecting bypass markers) */
	workerOutput?: string;
}

export interface LeaderCompleteHookContext {
	workspacePath: string;
	/**
	 * The room's root workspace path (the main repository, NOT the task's isolated worktree).
	 * Used by checkLeaderRootRepoSynced to pull the root repo after PR merge.
	 * Falls back to workspacePath if not provided.
	 */
	rootWorkspacePath?: string;
	taskType: string;
	workerRole: string;
	taskId: string;
	groupId: string;
	/** Whether the room has sub-agent reviewers configured */
	hasReviewers: boolean;
	/** For planning tasks: how many draft tasks exist */
	draftTaskCount?: number;
	/**
	 * Whether a human has approved the task (plan or PR).
	 * NOTE: runLeaderCompleteGate does not read this field — human approval is enforced
	 * by the state machine gate in room-runtime.ts before this hook is reached.
	 * The field is kept here for context/logging purposes only.
	 */
	approved?: boolean;
	/**
	 * Whether the worker used a bypass marker (RESEARCH_ONLY, VERIFICATION_COMPLETE, etc.)
	 * to skip git/PR gates. When true, checkLeaderPrMerged fails open even with approved=true
	 * because bypass tasks have no PR. When false/undefined and approved=true, gh failures
	 * are treated as fail-closed to prevent completing a PR task without merge verification.
	 */
	workerBypassed?: boolean;
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
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0 && stderr.trim()) {
			log.debug(`command failed (exit ${exitCode}): ${args.join(' ')}: ${stderr.trim()}`);
		}
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
 * Check that the PR was actually merged (for post-approval PR-based tasks in worker exit gate).
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
				`A closed PR cannot be merged directly. To fix this:\n` +
				`1. Reopen the PR: \`gh pr reopen ${branch}\`\n` +
				`2. Then merge: \`gh pr merge ${branch}\`\n` +
				`3. Verify: \`gh pr view ${branch} --json state --jq .state\` (must return "MERGED")\n` +
				`4. Then finish your response.`,
		};
	}

	return {
		pass: false,
		reason: `PR on branch "${branch}" is not merged (state: ${prState}). Worker must merge before exiting.`,
		bounceMessage:
			`The PR for branch "${branch}" is not merged yet (state: ${prState}).\n\n` +
			`You were asked to merge the PR. Please complete this step:\n` +
			`1. Run: \`gh pr merge ${branch}\`\n` +
			`2. Verify: \`gh pr view ${branch} --json state --jq .state\` (must return "MERGED")\n` +
			`3. Then finish your response.`,
	};
}

/**
 * Check that the PR was actually merged (for post-approval PR-based tasks in leader complete gate).
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
		// Bypass tasks (RESEARCH_ONLY, VERIFICATION_COMPLETE, etc.) have no PR — fail open.
		// For PR-based roles with human approval, fail closed: if gh is unavailable we cannot
		// verify merge state, and allowing completion would silently skip the merge invariant.
		if (ctx.approved && !ctx.workerBypassed) {
			log.warn(`checkLeaderPrMerged: gh command failed and task is approved — failing closed`);
			return {
				pass: false,
				reason:
					'Cannot verify PR merge state: gh command failed. Merge verification is required when human approval is present.',
				bounceMessage:
					'Cannot verify whether the PR was merged — the `gh` command is unavailable or failed.\n\n' +
					'This task has been approved by a human, so merge verification is required.\n' +
					'Please ensure `gh` is installed and authenticated, then call `complete_task` again.',
			};
		}
		log.debug(`checkLeaderPrMerged: gh command failed, skipping check (bypass/unapproved task)`);
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
				`Reopen it with \`gh pr reopen ${branch}\`, then merge with \`gh pr merge ${branch}\`, ` +
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
			`Please run \`gh pr merge ${branch}\` and verify with \`gh pr view ${branch} --json state --jq .state\`"\n` +
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
 * Check that a PR exists before the leader can complete a PR-based task.
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
 * Check that the PR is mergeable before submitting for human review.
 * Validates: no conflicts, mergeable state, CI passing.
 */
export async function checkPrIsMergeable(
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
		log.debug(`checkPrIsMergeable: git command failed, skipping check`);
		return { pass: true }; // Can't check, allow to proceed
	}

	// Get PR details with mergeable status and CI status
	const { stdout: prJson, exitCode: ghExit } = await run(
		['gh', 'pr', 'view', branch, '--json', 'mergeable,mergeStateStatus,statusCheckRollup'],
		ctx.workspacePath
	);
	if (ghExit !== 0) {
		log.debug(`checkPrIsMergeable: gh command failed, skipping check`);
		return { pass: true }; // Can't check, allow to proceed
	}

	try {
		const pr = JSON.parse(prJson);

		// Check mergeStateStatus for DIRTY or CONFLICTING (both indicate conflicts)
		// Note: mergeable field is deprecated and returns a string enum, but mergeStateStatus is more reliable
		if (pr.mergeStateStatus === 'DIRTY' || pr.mergeStateStatus === 'CONFLICTING') {
			return {
				pass: false,
				reason: 'PR has merge conflicts. Please resolve conflicts before submitting for review.',
				bounceMessage:
					'Fix merge conflicts: `git fetch && git rebase origin/main` (or base branch), ' +
					'resolve conflicts, force push, then try again.',
			};
		}

		// Check CI status (if available)
		if (pr.statusCheckRollup && Array.isArray(pr.statusCheckRollup)) {
			// Check for failed checks
			const failedChecks = pr.statusCheckRollup.filter(
				(check: { conclusion?: string }) =>
					check.conclusion === 'FAILURE' || check.conclusion === 'TIMED_OUT'
			);
			if (failedChecks.length > 0) {
				const checkNames = failedChecks.map((c: { name: string }) => c.name).join(', ');
				return {
					pass: false,
					reason: `CI checks failing: ${checkNames}. Please fix failing checks before submitting for review.`,
					bounceMessage: 'View CI status: `gh pr checks`. Fix failures, push, then try again.',
				};
			}
		}

		return { pass: true };
	} catch (error) {
		log.debug(`checkPrIsMergeable: failed to parse PR data, skipping check: ${error}`);
		// Failed to parse PR data, allow to proceed (fail open)
		return { pass: true };
	}
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
			'No draft tasks were created by the planner yet. The planner must run Phase 2 to create tasks.\n\n' +
			'To fix this:\n' +
			'1. Call `send_to_worker` (mode: "queue") with: "The plan is approved. Please:\n' +
			'   1. Merge the plan PR: `gh pr merge <PR_NUMBER>`\n' +
			'   2. Read the plan file under docs/plans/\n' +
			'   3. Create all tasks 1:1 from the plan using the `create_task` tool\n' +
			'   4. Finish your response after all tasks are created"\n' +
			'2. After the planner exits with tasks created, call `complete_task` again.',
	};
}

/**
 * Sync the root repo (Room workspace path) to the latest remote HEAD after a PR merge.
 * This ensures new worktrees branch from the most recent commit, not a stale one.
 *
 * Only runs for approved, non-bypassed tasks (i.e., a PR was actually merged).
 * The `approved` guard mirrors the state machine rule in room-runtime.ts that prevents
 * `complete_task` from being reached without human approval for PR-based roles. It acts
 * as a proxy for "a real PR merge occurred that requires syncing the root repo". Do NOT
 * remove it — bypass/research tasks have no PR to sync from.
 *
 * Uses rootWorkspacePath (the main repo) rather than workspacePath (the task worktree).
 *
 * Implementation note: uses `git fetch origin` + `git update-ref` rather than `git pull`
 * to avoid modifying the working tree or failing due to an unexpected checkout state in
 * the root repo (e.g., if HEAD is on a feature branch). `git update-ref` directly moves
 * the local branch ref to match the remote-tracking ref without requiring a checkout.
 */
export async function checkLeaderRootRepoSynced(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	// Only sync when a PR was merged (approved task, not a bypass/research-only task).
	// approved=false/undefined is the pre-approval phase; workerBypassed means no real PR exists.
	if (!ctx.approved || ctx.workerBypassed) {
		log.debug(
			`checkLeaderRootRepoSynced: skipping root sync (approved=${ctx.approved}, workerBypassed=${ctx.workerBypassed})`
		);
		return { pass: true };
	}

	const rootPath = ctx.rootWorkspacePath ?? ctx.workspacePath;
	const run = getRunner(opts);

	// Detect default branch via git symbolic-ref
	let defaultBranch = '';
	const { stdout: symref, exitCode: symrefExit } = await run(
		['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'],
		rootPath
	);
	if (symrefExit === 0 && symref) {
		defaultBranch = symref.trim().replace('refs/remotes/origin/', '');
	}

	if (!defaultBranch) {
		// Fallback: check well-known base branches by trying to resolve them
		for (const candidate of BASE_BRANCHES) {
			const { exitCode } = await run(
				['git', 'rev-parse', '--verify', `origin/${candidate}`],
				rootPath
			);
			if (exitCode === 0) {
				defaultBranch = candidate;
				break;
			}
		}
	}

	if (!defaultBranch) {
		log.warn(`checkLeaderRootRepoSynced: could not determine default branch, skipping root sync`);
		return { pass: true };
	}

	// Fetch latest from origin (updates remote-tracking refs like origin/main)
	const { exitCode: fetchExit } = await run(['git', 'fetch', 'origin'], rootPath);
	if (fetchExit !== 0) {
		log.warn(`checkLeaderRootRepoSynced: git fetch origin failed (exit ${fetchExit})`);
		return {
			pass: false,
			reason: 'Root repo sync failed: git fetch origin returned a non-zero exit code.',
			bounceMessage:
				'Could not sync the root repository — `git fetch origin` failed.\n\n' +
				'Please check network connectivity and ensure the remote is reachable, ' +
				'then call `complete_task` again.',
		};
	}

	// Advance the local branch ref to match origin without touching the working tree.
	// `git update-ref` is safe regardless of which branch HEAD currently points to and
	// avoids the merge-commit / conflict risk of `git pull origin <branch>`.
	const { exitCode: updateRefExit } = await run(
		['git', 'update-ref', `refs/heads/${defaultBranch}`, `origin/${defaultBranch}`],
		rootPath
	);
	if (updateRefExit !== 0) {
		log.warn(
			`checkLeaderRootRepoSynced: git update-ref refs/heads/${defaultBranch} origin/${defaultBranch} failed (exit ${updateRefExit})`
		);
		return {
			pass: false,
			reason: `Root repo sync failed: could not advance refs/heads/${defaultBranch} to origin/${defaultBranch}.`,
			bounceMessage:
				`Could not sync the root repository — updating \`refs/heads/${defaultBranch}\` to \`origin/${defaultBranch}\` failed.\n\n` +
				'This is required so new worktrees branch from the latest commit.\n' +
				`Run \`git update-ref refs/heads/${defaultBranch} origin/${defaultBranch}\` in the root repo ` +
				'and call `complete_task` again.',
		};
	}

	log.info(`checkLeaderRootRepoSynced: root repo synced to origin/${defaultBranch}`);
	return { pass: true };
}

// --- PR URL Utility ---

/**
 * Close a stale PR when a new PR has been created to replace it.
 *
 * Called when submit_for_review is invoked with a PR URL that differs from the
 * task's existing prUrl. Closes the old PR with a comment pointing to the new one.
 *
 * Fails open: if the close command fails (e.g., PR already closed, gh unavailable),
 * the error is logged but does not block the submit_for_review flow.
 *
 * Uses the PR URL directly with `gh pr close` — gh accepts both numbers and URLs,
 * and URLs are unambiguous across multi-remote/forked repo setups.
 *
 * @param oldPrUrl - The existing PR URL stored in the task
 * @param newPrUrl - The new PR URL being submitted for review
 * @param workspacePath - The workspace path to run gh commands from
 * @param opts - Optional hook options (for testing)
 * @returns true if closed successfully, false otherwise
 */
export async function closeStalePr(
	oldPrUrl: string,
	newPrUrl: string,
	workspacePath: string,
	opts?: HookOptions
): Promise<boolean> {
	const run = getRunner(opts);

	if (!oldPrUrl || !oldPrUrl.includes('/pull/')) {
		log.warn(`closeStalePr: invalid old PR URL: ${oldPrUrl}`);
		return false;
	}

	const comment = `Superseded by ${newPrUrl}`;
	const { exitCode } = await run(
		['gh', 'pr', 'close', oldPrUrl, '--comment', comment],
		workspacePath
	);

	if (exitCode !== 0) {
		log.warn(`closeStalePr: failed to close PR ${oldPrUrl} (exit ${exitCode})`);
		return false;
	}

	log.info(`closeStalePr: closed stale PR ${oldPrUrl}, superseded by ${newPrUrl}`);
	return true;
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
	const isPlannerRole = ctx.workerRole === 'planner';
	const isPrBasedRole = ctx.workerRole === 'coder' || ctx.workerRole === 'general';
	if (isPlannerRole || isPrBasedRole) {
		const isApproved = ctx.approved;
		if (isApproved) {
			// Post-approval: role-based verification
			if (isPlannerRole) {
				// Phase 2: planner must have created draft tasks from the approved plan
				const result = await checkDraftTasksCreated(ctx, opts);
				if (!result.pass) return result;
			}
			if (isPrBasedRole) {
				// Phase 2: verify the worker actually merged the PR before exiting
				const result = await checkWorkerPrMerged(ctx, opts);
				if (!result.pass) return result;
			}
			return { pass: true };
		}

		// Check for bypass marker BEFORE running git/PR gates (only for PR-based roles).
		// Planner bypass is intentionally unsupported: planners require draft task creation,
		// and the leader gate cannot complete without tasks even in bypass mode.
		if (isPrBasedRole && ctx.workerOutput) {
			const bypassMarker = detectBypassMarker(ctx.workerOutput);
			if (bypassMarker) {
				log.info(`Worker output contains bypass marker ${bypassMarker} - skipping git/PR gates`);
				return {
					pass: true,
					bypassed: true,
					reason: `Bypassed git/PR gates: ${bypassMarker}`,
				};
			}
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
 * For PR-based and planning tasks: PR must exist before submitting for review.
 * When reviewers are configured: reviews must be posted on the PR before submitting.
 * For other task types: pass through.
 */
export async function runLeaderSubmitGate(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	if (ctx.workerRole === 'coder' || ctx.workerRole === 'planner' || ctx.workerRole === 'general') {
		const prResult = await checkLeaderPrExists(ctx, opts);
		if (!prResult.pass) return prResult;

		// Check PR is mergeable before submitting for human review
		const mergeableResult = await checkPrIsMergeable(ctx, opts);
		if (!mergeableResult.pass) return mergeableResult;

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
 *
 * Gate order:
 * 1. PR must be merged (universal — applies to all roles; fails open when gh unavailable,
 *    allowing bypass/research-only tasks to proceed without a PR)
 * 2. Root repo sync — fetch origin and advance the local default-branch ref so new
 *    worktrees branch from the latest remote HEAD (only for approved, non-bypass tasks)
 * 3. Planning tasks: draft tasks must exist (created by planner in Phase 2)
 * 4. Coder/general with reviewer sub-agents: reviews must be posted on the PR
 */
export async function runLeaderCompleteGate(
	ctx: LeaderCompleteHookContext,
	opts?: HookOptions
): Promise<HookResult> {
	// Universal: always verify the PR was merged before completing.
	// Fails open when gh is unavailable (e.g. bypass/research-only tasks with no PR).
	const mergedResult = await checkLeaderPrMerged(ctx, opts);
	if (!mergedResult.pass) return mergedResult;

	// Sync root repo after PR merge so new worktrees branch from the latest commit.
	// Only runs for approved, non-bypassed tasks; fails open on missing default branch.
	const syncResult = await checkLeaderRootRepoSynced(ctx, opts);
	if (!syncResult.pass) return syncResult;

	// Planning tasks: verify draft tasks were created from the merged plan.
	if (ctx.taskType === 'planning') {
		const draftsResult = await checkLeaderDraftsExist(ctx, opts);
		if (!draftsResult.pass) return draftsResult;
	}

	// Coder/general with reviewer sub-agents: verify reviews were posted on the PR.
	if ((ctx.workerRole === 'coder' || ctx.workerRole === 'general') && ctx.hasReviewers) {
		const reviewResult = await checkPrHasReviews(ctx, opts);
		if (!reviewResult.pass) return reviewResult;
	}

	return { pass: true };
}
