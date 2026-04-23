/**
 * Task Agent `merge_pr` MCP tool handler.
 *
 * Single-purpose post-approval executor for end nodes that signalled
 * `post_approval_action: 'merge_pr'` via `send_message(target: 'task-agent')`.
 *
 * Contract (see
 *   `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * for the full plan):
 *
 *   1. Validate `pr_url` against the GitHub PR URL regex.
 *   2. Cross-check `pr_url` against the URL signalled by the end node for the
 *      current task. A prompt-injected or hallucinated URL cannot be merged
 *      even at autonomy >= 4.
 *   3. Read the live space autonomy level via the injected resolver.
 *      Threshold: `MERGE_AUTONOMY_THRESHOLD = 4`.
 *   4. At `level < MERGE_AUTONOMY_THRESHOLD`:
 *      - `human_approval_reason` is required.
 *      - A recent `request_human_input` artifact for this task must exist
 *        with a non-rejecting human response. This protects against a
 *        hallucinating agent inventing a reason string without a real human
 *        approval.
 *   5. Idempotency: scan existing `task-agent` `result` artifacts for a row
 *      whose `data.merged_pr_url === pr_url`. If found → short-circuit with
 *      `alreadyMerged: true` (no script execution).
 *   6. Execute `PR_MERGE_BASH_SCRIPT` via `bash -c` with `cwd = space.workspacePath`,
 *      env `NEOKAI_ARTIFACT_DATA_JSON` / `NEOKAI_WORKSPACE_PATH`, and a 120 s
 *      timeout. The script never sees interpolated inputs — `pr_url` is
 *      passed only via env + parsed inside the script with `jq -r`.
 *   7. On success: write a `task-agent` `result` artifact recording
 *      `{ merged_pr_url, status: 'merged', mergedAt, approval, approvalReason }`.
 *   8. On failure: return `{ success: false, error, stderr }` so the Task
 *      Agent can surface the issue to the human via its normal coordination
 *      path.
 *
 * Security:
 *   - `pr_url` is regex-validated before use.
 *   - The bash script parses `NEOKAI_ARTIFACT_DATA_JSON` via `jq -r` — no
 *     `eval` or `$()` expansion of untrusted input.
 *   - The audit log line is emitted via a key-value logger call (not a
 *     format-string concatenation) so `approvalReason` cannot forge
 *     additional log lines even if it contains newlines or ANSI escapes.
 *
 * This handler is registered as the `merge_pr` MCP tool on the Task Agent's
 * MCP server only when the `NEOKAI_TASK_AGENT_MERGE_EXECUTOR` feature flag
 * (env var or `Space.experimentalFeatures['taskAgentMergeExecutor']`) is set.
 * During Stage 1 rollout the flag is off — the tool is defined + tested but
 * not visible to agents.
 */

import type { Space } from '@neokai/shared';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import { Logger } from '../../logger';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import type { MergePrInput } from './task-agent-tool-schemas';
import { PR_MERGE_BASH_SCRIPT, PR_MERGE_SCRIPT_TIMEOUT_MS } from './pr-merge-script';

const log = new Logger('task-agent-merge');

/** Autonomy threshold at which `merge_pr` may auto-approve without a human reason. */
export const MERGE_AUTONOMY_THRESHOLD = 4;

/** Strict GitHub PR URL validation. Matches `https://github.com/<owner>/<repo>/pull/<n>`. */
export const GITHUB_PR_URL_REGEX = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

/**
 * Canonical `request_human_input` question for a post-approval merge.
 *
 * The Task Agent system prompt (updated in Work Item 2) instructs the agent
 * to use this exact question string when asking the human to approve a
 * merge at `autonomyLevel < MERGE_AUTONOMY_THRESHOLD`. Pinning the format
 * here keeps snapshot tests authoritative — if the string drifts, the
 * snapshot test in `task-agent-merge-handler.test.ts` will fail.
 */
export function buildMergeApprovalQuestion(prUrl: string): string {
	return `Approve merging PR ${prUrl}?`;
}

/**
 * Canonical context hint the Task Agent passes to `request_human_input`
 * alongside the question above. Intentionally terse — the Task Agent is
 * expected to append reviewer / CI detail from its existing context.
 */
export function buildMergeApprovalContextHint(prUrl: string): string {
	return (
		`The end node of this workflow signalled a post-approval action:\n` +
		`  action: merge_pr\n` +
		`  pr_url: ${prUrl}\n` +
		`Space autonomy level is below the auto-merge threshold (${MERGE_AUTONOMY_THRESHOLD}), ` +
		`so a human must confirm before the Task Agent runs the merge.`
	);
}

/** Signalled post-approval action payload persisted by an end node. */
export interface PostApprovalSignal {
	/** The action type the end node requested (currently only `merge_pr`). */
	action: string;
	/** Fully-qualified PR URL the end node wants the Task Agent to merge. */
	pr_url: string;
}

/** A human-input response, surfaced by a preceding `request_human_input` call. */
export interface HumanInputResponse {
	/** Verbatim human response text. */
	response: string;
	/**
	 * Whether the response represents a rejection. Implementations may classify
	 * this upstream (e.g. a dedicated reject button, or simple substring match
	 * on "reject" / "decline" / "no"). The handler refuses the merge when true.
	 */
	rejected: boolean;
	/** Unix-ms timestamp when the response was recorded. */
	createdAt: number;
}

/** Result of running the PR merge script. Shape matches the test harness's spawn mock. */
export interface MergeScriptResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** True when the process was killed by the timeout watchdog. */
	timedOut: boolean;
}

/** Executor abstraction — lets tests stub spawn without touching the real shell. */
export type MergeScriptExecutor = (args: {
	script: string;
	env: Record<string, string>;
	cwd: string;
	timeoutMs: number;
}) => Promise<MergeScriptResult>;

/**
 * Dependencies for `createMergePrHandler`.
 *
 * Resolvers are declared as required function-shape fields so callers can't
 * forget them: the tool is feature-flagged at registration time, but if it
 * IS registered, all resolvers must be wired. Tests pass in-memory stubs.
 */
export interface MergePrHandlerDeps {
	/** Task this handler is bound to. */
	taskId: string;
	/** Space the task belongs to — `workspacePath` is the script's `cwd`. */
	space: Space;
	/** Active workflow run ID — used for artifact idempotency scans and audit writes. */
	workflowRunId: string;
	/** Artifact repo — used for both the idempotency scan and the audit write. */
	artifactRepo: WorkflowRunArtifactRepository;
	/** Returns the live space autonomy level. Re-read at every call. */
	getSpaceAutonomyLevel: (spaceId: string) => Promise<number>;
	/**
	 * Resolve the most recent post-approval signal persisted for this task
	 * (from `send_message(target: 'task-agent', data: { pr_url, post_approval_action })`).
	 * Returns `null` when no signal has been stored.
	 *
	 * In Stage 1 (Work Item 1) this resolver is plumbed through for tests; in
	 * Stage 2 (Work Item 2) it reads `SpaceTask.pendingPostApprovalAction`.
	 */
	getSignalledPostApprovalAction: (taskId: string) => Promise<PostApprovalSignal | null>;
	/**
	 * Resolve the most recent `request_human_input` response artifact for this
	 * task. Returns `null` when no human has responded to a pending question.
	 *
	 * Only consulted at `autonomyLevel < MERGE_AUTONOMY_THRESHOLD`. In Stage 1
	 * this resolver is plumbed through for tests; in Stage 2 it reads the
	 * artifact written by the updated `request_human_input` handler.
	 */
	getRecentHumanInputResponse: (taskId: string) => Promise<HumanInputResponse | null>;
	/**
	 * Merge-script executor. Defaults to a `Bun.spawn`-backed implementation.
	 * Tests supply a stub so no real `bash`/`gh` is invoked.
	 */
	runScript?: MergeScriptExecutor;
}

// ---------------------------------------------------------------------------
// Default spawn-based executor — used in production; tests override.
// ---------------------------------------------------------------------------

/**
 * Default merge-script executor. Streams stdout/stderr with a buffer cap and
 * enforces the configured timeout by SIGKILL.
 *
 * Exposed so other daemon callers can reuse the same semantics if needed; not
 * re-exported from the package index.
 */
export async function defaultMergeScriptExecutor(args: {
	script: string;
	env: Record<string, string>;
	cwd: string;
	timeoutMs: number;
}): Promise<MergeScriptResult> {
	const proc = Bun.spawn(['bash', '-c', args.script], {
		cwd: args.cwd,
		env: args.env,
		stdout: 'pipe',
		stderr: 'pipe',
	});

	let timedOut = false;
	const killTimer = setTimeout(() => {
		timedOut = true;
		proc.kill('SIGKILL');
	}, args.timeoutMs);

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr, timedOut };
	} finally {
		clearTimeout(killTimer);
	}
}

// ---------------------------------------------------------------------------
// Feature-flag helper — exported so tool-registration can share the logic.
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the `NEOKAI_TASK_AGENT_MERGE_EXECUTOR` feature flag is
 * enabled — either via the env var or via the space's
 * `experimentalFeatures['taskAgentMergeExecutor']` bit.
 *
 * The env var accepts `1`, `true`, or `yes` (case-insensitive). Anything else
 * is treated as disabled. The space-level bit wins over the env var only when
 * explicitly `true`.
 *
 * The space argument is typed loosely on purpose — the shared `Space` type
 * does not yet carry `experimentalFeatures`; Stage-2 (Work Item 2) wiring
 * will add it. Until then, the env var is the production gate and the
 * space-bit branch lies dormant but ready.
 */
export function isMergeExecutorFeatureEnabled(space?: unknown): boolean {
	const envRaw = process.env.NEOKAI_TASK_AGENT_MERGE_EXECUTOR;
	if (envRaw !== undefined) {
		const normalized = envRaw.trim().toLowerCase();
		if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
	}
	if (space && typeof space === 'object') {
		const features = (space as { experimentalFeatures?: unknown }).experimentalFeatures;
		if (features && typeof features === 'object') {
			const bit = (features as Record<string, unknown>).taskAgentMergeExecutor;
			if (bit === true) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build the `merge_pr` handler closure bound to the given dependencies.
 *
 * The returned function matches the MCP handler signature used across the
 * Task Agent tool surface (`(input) => Promise<ToolResult>`), making it a
 * drop-in for `tool('merge_pr', desc, MergePrSchema.shape, handler)`.
 */
export function createMergePrHandler(deps: MergePrHandlerDeps) {
	const {
		taskId,
		space,
		workflowRunId,
		artifactRepo,
		getSpaceAutonomyLevel,
		getSignalledPostApprovalAction,
		getRecentHumanInputResponse,
		runScript = defaultMergeScriptExecutor,
	} = deps;

	return async function merge_pr(args: MergePrInput): Promise<ToolResult> {
		const prUrl = args.pr_url.trim();
		const humanApprovalReason = args.human_approval_reason?.trim();

		// ---- 1. Validate URL shape --------------------------------------------
		if (!GITHUB_PR_URL_REGEX.test(prUrl)) {
			auditLog({
				outcome: 'refused-invalid-url',
				spaceId: space.id,
				taskId,
				prUrl,
				level: null,
				autoApproved: null,
				reason: 'pr_url failed GitHub PR URL validation',
			});
			return jsonResult({
				success: false,
				error:
					'Invalid pr_url: expected a fully-qualified GitHub PR URL matching ' +
					'https://github.com/<owner>/<repo>/pull/<n>.',
			});
		}

		// ---- 2. Cross-check against the end-node's signalled URL ---------------
		// Prevents a prompt-injected or hallucinated URL from being merged even
		// at autonomy >= 4. The end node persists this signal via Work Item 2's
		// pendingPostApprovalAction plumbing; the resolver abstracts the source
		// so Stage 1 can unit-test the gate without that wiring.
		let signal: PostApprovalSignal | null = null;
		try {
			signal = await getSignalledPostApprovalAction(taskId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			auditLog({
				outcome: 'refused-signal-resolver-error',
				spaceId: space.id,
				taskId,
				prUrl,
				level: null,
				autoApproved: null,
				reason: message,
			});
			return jsonResult({
				success: false,
				error: `Failed to resolve end-node post-approval signal: ${message}`,
			});
		}

		if (!signal) {
			auditLog({
				outcome: 'refused-no-signal',
				spaceId: space.id,
				taskId,
				prUrl,
				level: null,
				autoApproved: null,
				reason: 'no end-node signal for this task',
			});
			return jsonResult({
				success: false,
				error:
					'No post-approval signal recorded for this task. ' +
					'An end node must first emit send_message(target: "task-agent", data: { pr_url, post_approval_action: "merge_pr" }) ' +
					'before merge_pr is callable.',
			});
		}

		if (signal.action !== 'merge_pr') {
			auditLog({
				outcome: 'refused-signal-action-mismatch',
				spaceId: space.id,
				taskId,
				prUrl,
				level: null,
				autoApproved: null,
				reason: `signalled action is '${signal.action}', not 'merge_pr'`,
			});
			return jsonResult({
				success: false,
				error: `Signalled post-approval action is '${signal.action}', not 'merge_pr'. merge_pr is not a valid executor for this signal.`,
			});
		}

		if (signal.pr_url !== prUrl) {
			auditLog({
				outcome: 'refused-url-mismatch',
				spaceId: space.id,
				taskId,
				prUrl,
				level: null,
				autoApproved: null,
				reason: `signalled pr_url=${signal.pr_url}`,
			});
			return jsonResult({
				success: false,
				error:
					`Refused: args.pr_url does not match the PR URL signalled by the end node. ` +
					`Signalled URL: ${signal.pr_url}. Provided URL: ${prUrl}.`,
			});
		}

		// ---- 3. Read live autonomy level --------------------------------------
		let level: number;
		try {
			level = (await getSpaceAutonomyLevel(space.id)) ?? 1;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			auditLog({
				outcome: 'refused-autonomy-resolver-error',
				spaceId: space.id,
				taskId,
				prUrl,
				level: null,
				autoApproved: null,
				reason: message,
			});
			return jsonResult({
				success: false,
				error: `Failed to resolve space autonomy level: ${message}`,
			});
		}

		const autoApproved = level >= MERGE_AUTONOMY_THRESHOLD;

		// ---- 4. At level < threshold: require human_approval_reason AND a
		//         matching request_human_input artifact with a non-rejecting
		//         response. The reason alone is model-attestable, so we verify
		//         a real response was recorded before running the merge.
		if (!autoApproved) {
			if (!humanApprovalReason) {
				auditLog({
					outcome: 'refused-missing-reason',
					spaceId: space.id,
					taskId,
					prUrl,
					level,
					autoApproved,
					reason: 'human_approval_reason missing at level < 4',
				});
				return jsonResult({
					success: false,
					error:
						`Human approval required: space autonomy level is ${level} (< ${MERGE_AUTONOMY_THRESHOLD}). ` +
						`Call request_human_input({ question: ${JSON.stringify(buildMergeApprovalQuestion(prUrl))}, context: "<reviewer + CI context>" }) ` +
						"first, wait for the human's reply, then retry merge_pr with human_approval_reason set to the human's verbatim response.",
					canonicalQuestion: buildMergeApprovalQuestion(prUrl),
					canonicalContextHint: buildMergeApprovalContextHint(prUrl),
				});
			}

			let humanResponse: HumanInputResponse | null = null;
			try {
				humanResponse = await getRecentHumanInputResponse(taskId);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				auditLog({
					outcome: 'refused-human-response-resolver-error',
					spaceId: space.id,
					taskId,
					prUrl,
					level,
					autoApproved,
					reason: message,
				});
				return jsonResult({
					success: false,
					error: `Failed to look up human-input response: ${message}`,
				});
			}

			if (!humanResponse) {
				auditLog({
					outcome: 'refused-no-human-response',
					spaceId: space.id,
					taskId,
					prUrl,
					level,
					autoApproved,
					reason: 'no request_human_input response artifact found',
				});
				return jsonResult({
					success: false,
					error:
						'No human-input response found for this task. ' +
						'Call request_human_input to ask the human, wait for their reply, then retry ' +
						'merge_pr with their verbatim response as human_approval_reason.',
				});
			}

			if (humanResponse.rejected) {
				auditLog({
					outcome: 'refused-human-rejected',
					spaceId: space.id,
					taskId,
					prUrl,
					level,
					autoApproved,
					reason: humanResponse.response,
				});
				return jsonResult({
					success: false,
					error:
						'The human rejected the merge in their response to request_human_input. ' +
						'merge_pr will not run. Save an audit artifact describing the rejection and continue.',
				});
			}
		}

		// ---- 5. Idempotency — scan task-agent result artifacts for a row
		//         with the same merged_pr_url. In-memory scan (no SQL
		//         json_extract) to keep the artifact-store API simple.
		const existingArtifacts = artifactRepo.listByRun(workflowRunId, {
			nodeId: 'task-agent',
			artifactType: 'result',
		});
		const alreadyMergedRow = existingArtifacts.find(
			(a) => typeof a.data?.merged_pr_url === 'string' && a.data.merged_pr_url === prUrl
		);
		if (alreadyMergedRow) {
			auditLog({
				outcome: 'already-merged',
				spaceId: space.id,
				taskId,
				prUrl,
				level,
				autoApproved,
				reason: 'artifact store already records a merge for this URL',
			});
			return jsonResult({
				success: true,
				alreadyMerged: true,
				merged_pr_url: prUrl,
				artifactId: alreadyMergedRow.id,
				message: `PR ${prUrl} was already merged in this workflow run (artifact ${alreadyMergedRow.id}).`,
			});
		}

		// ---- 6. Execute the merge script --------------------------------------
		const scriptEnv: Record<string, string> = {
			...buildMergeEnv(space.workspacePath),
			NEOKAI_ARTIFACT_DATA_JSON: JSON.stringify({ pr_url: prUrl }),
			NEOKAI_WORKSPACE_PATH: space.workspacePath,
		};

		let result: MergeScriptResult;
		try {
			result = await runScript({
				script: PR_MERGE_BASH_SCRIPT,
				env: scriptEnv,
				cwd: space.workspacePath,
				timeoutMs: PR_MERGE_SCRIPT_TIMEOUT_MS,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			auditLog({
				outcome: 'failed-spawn',
				spaceId: space.id,
				taskId,
				prUrl,
				level,
				autoApproved,
				reason: message,
			});
			return jsonResult({
				success: false,
				error: `Failed to spawn merge script: ${message}`,
			});
		}

		if (result.timedOut) {
			auditLog({
				outcome: 'failed-timeout',
				spaceId: space.id,
				taskId,
				prUrl,
				level,
				autoApproved,
				reason: `timed out after ${PR_MERGE_SCRIPT_TIMEOUT_MS}ms`,
			});
			return jsonResult({
				success: false,
				error: `PR merge script timed out after ${PR_MERGE_SCRIPT_TIMEOUT_MS}ms.`,
				stderr: result.stderr,
			});
		}

		if (result.exitCode !== 0) {
			auditLog({
				outcome: 'failed-script',
				spaceId: space.id,
				taskId,
				prUrl,
				level,
				autoApproved,
				reason: `exit ${result.exitCode}`,
			});
			return jsonResult({
				success: false,
				error: `PR merge script exited with code ${result.exitCode}.`,
				stderr: result.stderr,
				stdout: result.stdout,
			});
		}

		// ---- 7. Record the audit artifact on success --------------------------
		const approval: 'auto_policy' | 'human' = autoApproved ? 'auto_policy' : 'human';
		const mergedAt = Date.now();
		const artifact = artifactRepo.upsert({
			id: crypto.randomUUID(),
			runId: workflowRunId,
			nodeId: 'task-agent',
			artifactType: 'result',
			// Unique key per merge so repeated merges (should never happen after
			// the idempotency check, but be defensive) stay append-only in practice.
			artifactKey: `merge_pr:${mergedAt}:${Math.random().toString(36).slice(2, 8)}`,
			data: {
				merged_pr_url: prUrl,
				status: 'merged',
				mergedAt,
				approval,
				approvalReason: humanApprovalReason ?? null,
				taskId,
			},
		});

		auditLog({
			outcome: 'merged',
			spaceId: space.id,
			taskId,
			prUrl,
			level,
			autoApproved,
			reason: humanApprovalReason ?? null,
		});

		return jsonResult({
			success: true,
			merged_pr_url: prUrl,
			approval,
			artifactId: artifact.id,
			stdout: result.stdout,
			message: `PR ${prUrl} merged (${approval === 'auto_policy' ? 'auto-approved' : 'human-approved'}).`,
		});
	};
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the environment the merge script inherits.
 *
 * Starts from the current process env (needed so `gh`/`git` can find the
 * user's auth + PATH), then overrides the NeoKai-specific variables. Callers
 * merge `NEOKAI_ARTIFACT_DATA_JSON` / `NEOKAI_WORKSPACE_PATH` on top.
 */
function buildMergeEnv(workspacePath: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === 'string') env[key] = value;
	}
	env['NEOKAI_WORKSPACE_PATH'] = workspacePath;
	return env;
}

/**
 * Emit a single structured audit line for every merge_pr invocation.
 *
 * Uses the key-value form `logger.info('event', fields)` so that
 * agent-provided strings (`approvalReason`) cannot forge adjacent log lines
 * — even if the string contains newlines, ANSI escapes, or control chars.
 */
function auditLog(fields: {
	outcome: string;
	spaceId: string;
	taskId: string;
	prUrl: string;
	level: number | null;
	autoApproved: boolean | null;
	reason: string | null;
}): void {
	log.info('task-agent.merge_pr', {
		outcome: fields.outcome,
		spaceId: fields.spaceId,
		taskId: fields.taskId,
		prUrl: fields.prUrl,
		level: fields.level,
		autoApproved: fields.autoApproved,
		reason: fields.reason,
	});
}
