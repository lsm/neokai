/**
 * PR merge bash script.
 *
 * Hoisted out of `built-in-workflows.ts` so it can be reused by the
 * Task Agent `merge_pr` MCP tool handler (`task-agent-merge-handler.ts`).
 *
 * Security contract:
 *   - Input is exposed to the script **only** via the environment variable
 *     `NEOKAI_ARTIFACT_DATA_JSON`, parsed inside the script via `jq -r`.
 *     Callers MUST NOT interpolate `pr_url` (or any other untrusted value)
 *     into the script source — doing so would enable command injection.
 *   - `pr_url` itself is regex-validated upstream in
 *     `task-agent-merge-handler.ts` before the script runs.
 *
 * Environment variables read by the script:
 *   NEOKAI_ARTIFACT_DATA_JSON — JSON payload containing `{ pr_url }`
 *   NEOKAI_WORKSPACE_PATH    — workspace root (parent process sets as cwd)
 *
 * Behaviour:
 *   - Resolves PR URL from `NEOKAI_ARTIFACT_DATA_JSON` (via `jq`), falling
 *     back to `gh pr view --json url` for the current branch.
 *   - Skips the merge if `gh pr view` reports `state = MERGED` (idempotent
 *     re-entry from the script's perspective — complements the handler's
 *     artifact-store idempotency check).
 *   - Squash-merges via `gh pr merge --squash`, then syncs the worktree.
 *   - Emits a JSON summary on stdout: `{"merged_pr_url":"…","status":"merged"|"already_merged"}`.
 *   - Exits non-zero on failure with the error on stderr.
 */

export const PR_MERGE_BASH_SCRIPT = [
	'# Resolve PR URL from artifact data (parsed via jq — never eval/$()-expanded) or current branch',
	'PR_URL=$(jq -r \'.pr_url // .url // empty\' <<< "${NEOKAI_ARTIFACT_DATA_JSON:-{}}" 2>/dev/null || true)',
	'if [ -z "$PR_URL" ]; then',
	'  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
	'fi',
	'if [ -z "$PR_URL" ]; then',
	'  echo "No PR URL found — cannot merge" >&2',
	'  exit 1',
	'fi',
	'# Idempotency guard: skip merge if PR is already merged',
	'PR_STATE=$(gh pr view "$PR_URL" --json state -q .state 2>/dev/null || true)',
	'if [ "$PR_STATE" = "MERGED" ]; then',
	'  echo "PR already merged: $PR_URL"',
	'  BASE_BRANCH=$(gh pr view "$PR_URL" --json baseRefName -q .baseRefName 2>/dev/null || echo "main")',
	'  git checkout "$BASE_BRANCH" 2>/dev/null && git pull --ff-only 2>/dev/null || true',
	'  jq -n --arg url "$PR_URL" \'{"merged_pr_url":$url,"status":"already_merged"}\'',
	'  exit 0',
	'fi',
	'echo "Merging PR: $PR_URL"',
	'if ! gh pr merge "$PR_URL" --squash; then',
	'  echo "Failed to merge PR: $PR_URL" >&2',
	'  exit 1',
	'fi',
	'# Sync worktree with base branch after merge',
	'BASE_BRANCH=$(gh pr view "$PR_URL" --json baseRefName -q .baseRefName 2>/dev/null || echo "main")',
	'git checkout "$BASE_BRANCH" 2>/dev/null && git pull --ff-only 2>/dev/null || true',
	'echo "PR merged and worktree synced"',
	'jq -n --arg url "$PR_URL" \'{"merged_pr_url":$url,"status":"merged"}\'',
].join('\n');

/** Default timeout (ms) for the PR merge script. Matches the legacy completion-action timeout. */
export const PR_MERGE_SCRIPT_TIMEOUT_MS = 120_000;
