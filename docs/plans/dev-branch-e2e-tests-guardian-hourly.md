# Dev Branch E2E Tests Guardian (Hourly)

## Goal

Recurring mission to continuously ensure all E2E tests on the `dev` branch are passing. Runs every hour to catch regressions early since E2E tests are not run on PRs during rapid development.

## Context

The team rapidly ships new features and E2E tests are NOT run on PRs. This means the dev branch frequently accumulates broken E2E tests. This mission acts as a safety net -- monitoring, diagnosing, and fixing E2E failures as they appear.

## Approach

Each hourly run follows a structured workflow: check CI status, investigate failures using local runs (preferred) or CI artifacts, apply targeted fixes, push to dev, and report. This mission focuses on local verification to save CI resources.

---

## Task 1: Check CI Status

**Type:** general

**Description:**
Check the latest CI runs on the dev branch and identify any failing e2e test jobs.

**Subtasks:**
1. Query the latest CI runs on dev branch:
   ```bash
   gh run list --repo lsm/neokai --branch dev --limit 3 --json databaseId,status,conclusion,createdAt
   ```
2. Identify the most recent completed run (not in_progress).
3. If the latest run is still in_progress, report "CI still running" and stop.
4. Check which e2e jobs failed in the completed run. **Note**: CI job names use `E2E No-LLM` and `E2E LLM` (capitalized):
   ```bash
   RUN_ID=<run-id>
   gh run view --repo lsm/neokai $RUN_ID --json jobs --jq '.jobs[] | select(.conclusion == "failure") | select(.name | test("E2E")) | {name, databaseId, url}'
   ```
5. If no e2e jobs failed, report "All green" and stop.

**Acceptance Criteria:**
- Clear list of failing e2e job names and databaseIds.
- If CI is still running, mission pauses until next run.
- If all e2e tests pass, mission is complete for this run.

**Dependencies:** None

---

## Task 2: Investigate Failures

**Type:** general

**Description:**
For each failing e2e test, determine the root cause. Prefer local reproduction over CI artifact analysis. Download CI artifacts only when local reproduction is not feasible.

**Subtasks:**
1. Verify devproxy availability before attempting local reproduction:
   ```bash
   # Check if devproxy is running
   curl -s http://127.0.0.1:25588/health || echo "DEVPROXY_NOT_RUNNING"
   ```
   - If devproxy is NOT running, start it first: `devproxy start` (or use the Makefile target)
   - If devproxy cannot be started, fall back to downloading CI artifacts only
2. For each failing test, attempt local reproduction:
   ```bash
   REPO_ROOT="/Users/lsm/focus/dev-neokai"
   cd $REPO_ROOT
   git checkout dev && git pull origin dev
   # Create a fresh worktree for testing
   WORKTREE_NAME="guardian-$(date +%Y%m%d%H%M%S)"
   WORKTREE_PATH="$REPO_ROOT/../worktrees/$WORKTREE_NAME"
   git worktree add -b "guardian/$WORKTREE_NAME" "$WORKTREE_PATH" origin/dev
   cd "$WORKTREE_PATH"
   bun install
   # Run the failing test with devproxy
   NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/<path>.e2e.ts
   ```
3. If local run reproduces the failure, analyze the error directly.
4. If local run does NOT reproduce (test passes locally but failed in CI):
   - This is likely a flaky test or CI environment issue.
   - Download CI artifacts for analysis:
     ```bash
     gh run download $RUN_ID --repo lsm/neokai --pattern "e2e-no-llm-results-*" --pattern "e2e-results-llm-*"
     ```
   - Read `packages/e2e/playwright-report/index.html` for failure details.
5. Categorize each failure:
   - **Test bug**: Test assumptions no longer match product behavior (most common during rapid dev).
   - **Product bug**: Underlying code is broken.
   - **Flaky test**: Intermittent failure, timing-dependent.
   - **Environment issue**: CI infrastructure problem.
6. For flaky tests, check failure history in `docs/e2e-health-check-log.md`.

**Acceptance Criteria:**
- Each failure has a category and root cause hypothesis.
- Local reproduction attempted for all failures (or documented reason for skipping).
- CI artifacts downloaded when local reproduction fails.

**Dependencies:** Task 1

---

## Task 3: Fix Issues

**Type:** coder

**Description:**
Fix failures based on their category. Apply targeted fixes directly in the worktree.

**Subtasks:**

### For Test Bugs (most common):
1. Read the relevant UI component or source code to understand actual behavior.
2. Update test selectors, assertions, or flows to match current UI.
3. Common patterns:
   - Dropdown menu changed to inline buttons
   - Navigation flow changed
   - UI text or selectors changed (`data-testid` values)
4. Run the fixed test locally to confirm:
   ```bash
   NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/<path>.e2e.ts
   ```

### For Product Bugs:
1. Fix the underlying code.
2. Run the test to confirm the fix works.
3. If the fix is large or risky, create a separate tracking task and apply a minimal test workaround (e.g., `test.skip` with reason).

### For Flaky Tests:
1. Identify the timing issue: fixed sleep, missing wait, race condition.
2. Replace `waitForTimeout` calls with proper Playwright auto-retrying assertions.
3. Add explicit waits for elements when DOM state depends on async operations.
4. If a test fails 3+ consecutive runs without clear progress, flag for potential disable.

### For Environment Issues:
1. Document the issue and skip with a TODO comment.
2. Note if CI infrastructure changes are needed.

**Acceptance Criteria:**
- Each failing test has a fix applied or a documented workaround.
- All fixes pass locally before pushing.

**Dependencies:** Task 2

---

## Task 4: Validate and Push

**Type:** general

**Description:**
After applying fixes in the worktree, validate locally, cherry-pick commits to dev, and push. Do not re-trigger full CI to save resources. Note: Pushing to dev will cancel any in-progress CI run on that branch (CI has `cancel-in-progress: true`).

**Subtasks:**
1. Ensure all fixes pass locally:
   ```bash
   NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/<path>.e2e.ts
   ```
2. Check if CI is currently running on dev. If so, defer the push to avoid cancellation:
   ```bash
   CI_STATUS=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json status --jq '.[0].status')
   if [ "$CI_STATUS" = "in_progress" ]; then
     # Retry up to 2 times, 5 minutes apart
     for i in 1 2; do
       echo "CI still in progress, waiting 5 minutes (attempt $i/2)..."
       sleep 300
       CI_STATUS=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json status --jq '.[0].status')
       [ "$CI_STATUS" != "in_progress" ] && break
     done
     if [ "$CI_STATUS" = "in_progress" ]; then
       echo "CI still running after retries. Deferring push to next hourly run."
       exit 0  # Clean exit, will retry next hour
     fi
   fi
   ```
3. Commit changes in the worktree. Stage only the actual changed test files:
   ```bash
   # Stage specific changed files (examples for multiple files)
   git add packages/e2e/tests/features/mission-terminology.e2e.ts
   git add packages/e2e/tests/features/mission-creation.e2e.ts
   # Add more files as needed...
   git commit -m "fix(e2e): <description of fix>"
   ```
4. Cherry-pick to dev and push:
   ```bash
   REPO_ROOT="/Users/lsm/focus/dev-neokai"
   WORKTREE_BRANCH="guardian/$WORKTREE_NAME"
   # Get the commit hash from the worktree
   COMMIT_HASH=$(git rev-parse HEAD)
   # Switch to dev, pull latest, rebase worktree branch onto dev
   cd $REPO_ROOT
   git checkout dev
   git pull origin dev
   # Rebase the worktree branch onto latest dev (resolves conflicts early)
   git checkout "guardian/$WORKTREE_NAME"
   git rebase origin/dev
   # Get the rebased commit hash
   COMMIT_HASH=$(git rev-parse HEAD)
   # Switch to dev and cherry-pick
   git checkout dev
   git cherry-pick $COMMIT_HASH
   # Push directly to dev
   git push origin dev
   ```
5. Handle cherry-pick conflicts (if any):
   - If `git cherry-pick` or `git rebase` fails with conflicts:
     ```bash
     git cherry-pick --abort  # or git rebase --abort
     # Resolve conflicts in the worktree, then:
     git add <resolved-files>
     git cherry-pick --continue  # or git rebase --continue
     ```
   - If conflicts are too complex, create a PR instead:
     ```bash
     git push origin "guardian/$WORKTREE_NAME"
     gh pr create --base dev --head "guardian/$WORKTREE_NAME"
     ```
6. Do NOT re-trigger the full CI run -- local verification is sufficient.
7. Clean up worktree after successful push:
   ```bash
   git worktree remove "$WORKTREE_PATH"
   git branch -D "guardian/$WORKTREE_NAME"
   ```
   - If push failed, still clean up the worktree before exiting.

**Acceptance Criteria:**
- All fixes pass locally.
- Changes cherry-picked and pushed to dev.
- Worktree cleaned up (success or failure path).
- No full CI re-trigger.

**Dependencies:** Task 3

---

## Task 5: Report

**Type:** general

**Description:**
Report what was checked, what failed, and what was fixed. If nothing was broken, report "All green". Append to `docs/e2e-health-check-log.md` following the existing format exactly.

**Subtasks:**
1. Record execution summary in `docs/e2e-health-check-log.md` matching the existing format:
   ```markdown
   ## $(date +%Y-%m-%d) — Check Run #<run-id>

   ### CI Run Overview
   - **Run ID**: <run-id>
   - **Branch**: dev (commit <hash> — <description>)
   - **Event**: push / scheduled
   - **Status**: Completed with e2e failures / All green

   ### Build/Discover Jobs
   - `Discover Tests`: **PASSED** / <status>
   - `Build Binary (linux-x64)`: **PASSED** / <status>
   - `Lint, Knip, Format & Type Check`: **PASSED** / **SKIPPED** / <status>
   - All unit test jobs: **PASSED** / **SKIPPED** / <status>

   ### E2E Test Failures at #<run-id>

   **N failing tests** — categorized and root causes identified.

   **Failure 1**: <test-name> — <short description>
   **Test**: <suite> (e.g., `E2E LLM (features-mission-terminology)`)
   **Problem**: <what went wrong>
   **Root cause**: <categorization: test-bug | product-bug | flaky | env>
   **Fix**: <what was changed> (commit: <hash>)

   ... (repeat for each failure)

   ### Flaky Tests (if any)
   - <test-name>: <count> consecutive failures -- needs investigation

   ### Previous Failures (if any, now fixed)
   - <test-name>: Fixed in <commit>

   ---
   ```
2. If all e2e tests passed, append a brief entry:
   ```markdown
   ## $(date +%Y-%m-%d) — Check Run #<run-id>

   ### CI Run Overview
   - **Run ID**: <run-id>
   - **Branch**: dev
   - **Status**: All green ✓

   No e2e failures detected.
   ```

**Acceptance Criteria:**
- Run documented following the existing format in `docs/e2e-health-check-log.md`.
- Includes Build/Discover Jobs section, root causes, affected files, and fix commits.
- Report is accessible for human review.

**Dependencies:** Task 4 (or Task 1 if all green)

---

## Task 6: CI Improvement -- Verify E2E on PR Branches (One-time)

**Type:** general

**Description:**
Verify whether e2e tests can be triggered on PR branches via `workflow_dispatch`. The CI workflow already has `workflow_dispatch` in its trigger, but we need to empirically verify it works for arbitrary refs.

**Subtasks:**
1. Test `workflow_dispatch` on a PR branch:
   ```bash
   # Find a recent PR branch
   PR_BRANCH=$(gh pr list --repo lsm/neokai --state open --limit 1 --json headRefName --jq '.[0].headRefName')
   # Trigger CI manually
   gh workflow run main.yml --repo lsm/neokai --ref "$PR_BRANCH"
   ```
2. Monitor the triggered run:
   ```bash
   gh run list --repo lsm/neokai --branch "$PR_BRANCH" --limit 1 --json databaseId,status
   ```
3. If the workflow runs successfully with e2e jobs:
   - Document the usage: `gh workflow run main.yml --repo lsm/neokai --ref <pr-branch>`
   - No CI YAML changes needed
4. If the workflow fails or skips e2e jobs:
   - Investigate the actual blocking condition in `main.yml`
   - Update job conditions to enable e2e on `workflow_dispatch` events
   - Test again until successful
5. Document findings and any changes made.

**Acceptance Criteria:**
- Empirical verification of `workflow_dispatch` behavior on PR branches.
- Documentation of usage or CI changes made.

**Dependencies:** None (background improvement task)

---

## Key Context

### Current E2E Health Status (Baseline)

As of 2026-03-22, the most recent CI run (#23412078420) had **17 failing tests** across 4 suites:
- `features-mission-terminology`: 5 failures (ambiguous "Missions" locator)
- `features-mission-creation`: 9 failures (same locator issue)
- `features-livequery-task-goal-updates`: 2 failures (same locator issue)
- `features-space-session-groups`: 1 failure (workspace path env issue)

Known pre-existing flakes:
- `features-worktree-isolation`: session deletion race condition
- `features-space-session-groups`: workspace path initialization race

See `docs/e2e-health-check-log.md` for full history.

### E2E Test Execution

```bash
# Single test with devproxy (local)
NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/features/slash-cmd.e2e.ts

# Single test against running server
make self-test TEST=tests/features/slash-cmd.e2e.ts

# All tests (slow)
NEOKAI_USE_DEV_PROXY=1 make run-e2e
```

### E2E Test Categories

- **no-llm**: UI-only tests that run fully parallel
- **llm**: Tests requiring LLM API calls (use devproxy locally to avoid API costs)

### Excluded Tests

The CI workflow has an `EXCLUDED_TESTS` array. Failures from excluded tests should be noted but not investigated:
- `features/space-export-import`
- `features/space-workflow-rules`

### Relevant Files

- CI workflow: `.github/workflows/main.yml`
- E2E tests: `packages/e2e/tests/`
- Test helpers: `packages/e2e/tests/helpers/`
- Playwright config: `packages/e2e/playwright.config.ts`
- Health check log: `docs/e2e-health-check-log.md`

### Repository

- Owner: `lsm/neokai`
- Local root: `/Users/lsm/focus/dev-neokai` (adapt to your local setup)

---

## Cron Setup (Hourly Execution)

**Preferred: Recurring Mission in NeoKai**

Create a recurring mission in the NeoKai mission system with cron schedule `0 * * * *` (hourly). This integrates with existing mission tracking and health check logging.

**Alternative (if needed):** Use a cron job or launchd task as fallback. The actual execution will be handled by an agent running the workflow defined in this plan.

---

## Reporting Template

Append entries to `docs/e2e-health-check-log.md` matching the existing format exactly:

```markdown
## $(date +%Y-%m-%d) — Check Run #<run-id>

### CI Run Overview
- **Run ID**: <run-id>
- **Branch**: dev (commit <hash> — <description>)
- **Event**: push / scheduled
- **Status**: Completed with e2e failures / All green ✓

### Build/Discover Jobs
- `Discover Tests`: **PASSED** / <status>
- `Build Binary (linux-x64)`: **PASSED** / <status>
- `Lint, Knip, Format & Type Check`: **PASSED** / **SKIPPED** / <status>
- All unit test jobs: **PASSED** / **SKIPPED** / <status>

### E2E Test Failures at #<run-id>

**N failing tests** — categorized and root causes identified.

**Failure 1**: <test-name> — <short description>
**Test**: <suite> (e.g., `E2E LLM (features-mission-terminology)`)
**Problem**: <what went wrong>
**Root cause**: <categorization: test-bug | product-bug | flaky | env>
**Fix**: <what was changed> (commit: <hash>)

... (repeat for each failure)

### Flaky Tests (if any)
- <test-name>: <count> consecutive failures -- needs investigation

### Previous Failures (if any, now fixed)
- <test-name>: Fixed in <commit>

---
```
