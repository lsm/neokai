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
4. Check which e2e jobs failed in the completed run:
   ```bash
   RUN_ID=<run-id>
   gh run view --repo lsm/neokai $RUN_ID --json jobs --jq '.jobs[] | select(.conclusion == "failure") | select(.name | startswith("e2e-")) | {name, databaseId, url}'
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
1. For each failing test, attempt local reproduction first:
   ```bash
   cd /Users/lsm/focus/dev-neokai
   git checkout dev && git pull origin dev
   # Create a fresh worktree for testing
   WORKTREE_NAME="guardian-$(date +%Y%m%d%H%M%S)"
   git worktree add -b "guardian/$WORKTREE_NAME" ../worktrees/$WORKTREE_NAME origin/dev
   cd ../worktrees/$WORKTREE_NAME
   bun install
   # Run the failing test
   NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/<path>.e2e.ts
   ```
2. If local run reproduces the failure, analyze the error directly.
3. If local run does NOT reproduce (test passes locally but failed in CI):
   - This is likely a flaky test or CI environment issue.
   - Download CI artifacts for analysis:
     ```bash
     gh run download $RUN_ID --repo lsm/neokai --pattern "e2e-no-llm-results-*" --pattern "e2e-results-llm-*"
     ```
   - Read `packages/e2e/playwright-report/index.html` for failure details.
4. Categorize each failure:
   - **Test bug**: Test assumptions no longer match product behavior (most common during rapid dev).
   - **Product bug**: Underlying code is broken.
   - **Flaky test**: Intermittent failure, timing-dependent.
   - **Environment issue**: CI infrastructure problem.
5. For flaky tests, check failure history in `docs/e2e-health-check-log.md`.

**Acceptance Criteria:**
- Each failure has a category and root cause hypothesis.
- Local reproduction attempted for all failures.
- CI artifacts downloaded when local reproduction fails.

**Dependencies:** Task 1

---

## Task 3: Fix Issues

**Type:** coder

**Description:**
Fix failures based on their category. Apply targeted fixes directly in the worktree and push to dev.

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
- Fixes are committed to a feature branch.

**Dependencies:** Task 2

---

## Task 4: Validate and Push

**Type:** general

**Description:**
After applying fixes, validate locally and push to dev. Do not re-trigger full CI to save resources.

**Subtasks:**
1. Ensure all fixes pass locally:
   ```bash
   NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/<path>.e2e.ts
   ```
2. Commit changes:
   ```bash
   git add .
   git commit -m "fix(e2e): <description of fix>"
   ```
3. Push to dev:
   ```bash
   git push origin dev
   ```
4. Do NOT re-trigger the full CI run -- local verification is sufficient.
5. Clean up worktree after successful push:
   ```bash
   git worktree remove ../worktrees/$WORKTREE_NAME
   git checkout dev
   ```

**Acceptance Criteria:**
- All fixes pass locally.
- Changes pushed to dev.
- Worktree cleaned up.
- No full CI re-trigger.

**Dependencies:** Task 3

---

## Task 5: Report

**Type:** general

**Description:**
Report what was checked, what failed, and what was fixed. If nothing was broken, report "All green".

**Subtasks:**
1. Record execution summary in the mission execution record or `docs/e2e-health-check-log.md`:
   ```markdown
   ## Run: $(date -u +%Y-%m-%dT%H:%M:%SZ)
   - CI Run ID: <run-id>
   - Status: <all-green | failures-fixed | investigating>
   - Failures: <list of test names and categories>
   - Fixes: <commit links>
   - Flaky tests: <test-name> (<count> consecutive failures)
   ```
2. If all e2e tests passed, report "All green" briefly.

**Acceptance Criteria:**
- Run documented with failures found, fixes applied, and outcomes.
- Report is accessible for human review.

**Dependencies:** Task 4 (or Task 1 if all green)

---

## Task 6: CI Improvement -- Enable E2E on PR Branches (One-time)

**Type:** general

**Description:**
Check if the CI workflow can be updated to support manual triggering of e2e tests on PR branches via `workflow_dispatch` with PR number as input. This would allow selective e2e runs on PRs without blocking rapid development.

**Subtasks:**
1. Review the current CI workflow (`main.yml`) `workflow_dispatch` configuration.
2. Check GitHub Actions documentation for passing PR number as input to a workflow.
3. If feasible, update the CI YAML to add:
   - A `workflow_dispatch` input for PR number
   - A separate job that can be triggered on PR branches with e2e tests enabled
4. Create a minimal implementation that enables: `gh workflow run CI --repo lsm/neokai --ref <pr-branch> -f enable_e2e=true -f pr_number=123`
5. Document the new workflow usage.

**Acceptance Criteria:**
- CI workflow can be manually triggered on PR branches with e2e tests enabled.
- Documentation of the new workflow usage added.

**Dependencies:** None (background improvement task)

---

## Key Context

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
- Local root: `/Users/lsm/focus/dev-neokai`

---

## Cron Setup (Hourly Execution)

To run this guardian mission hourly, set up a cron job or launchd task:

### Option 1: Cron (macOS/Linux)

```bash
# Add to crontab (crontab -e)
0 * * * * cd /Users/lsm/focus/dev-neokai && /Users/lsm/.local/bin/bun run packages/cli/main.ts --guardian-e2e >> logs/guardian-e2e.log 2>&1
```

Note: The `--guardian-e2e` flag would need to be implemented as a new CLI mode that runs the guardian workflow and exits.

### Option 2: Launchd (macOS, preferred for persistence)

Create `~/Library/LaunchAgents/com.neokai.e2e-guardian.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.neokai.e2e-guardian</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/lsm/.local/bin/bun</string>
    <string>run</string>
    <string>/Users/lsm/focus/dev-neokai/packages/cli/main.ts</string>
    <string>--guardian-e2e</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/lsm/focus/dev-neokai</string>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>/Users/lsm/.neokai/logs/guardian-e2e.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/lsm/.neokai/logs/guardian-e2e-error.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Load with: `launchctl load ~/Library/LaunchAgents/com.neokai.e2e-guardian.plist`

### Option 3: Recurring Mission in NeoKai

Create a recurring `hourly` mission in the NeoKai mission system with a cron schedule. This is the preferred approach as it integrates with the existing mission tracking.

---

## Reporting Template

```
## E2E Guardian Report -- $(date)

### CI Status Check
- Run ID: <id>
- Status: <in_progress | all-green | failures-found>

### Failures Found
| Test | Category | Root Cause | Fix Applied |
|------|----------|------------|-------------|
| <test-name> | test-bug/product-bug/flaky/env | <description> | <commit-link or skipped> |

### Fixes Pushed
- <commit-link>: <description>

### Flaky Tests (3+ consecutive failures)
- <test-name>: <count> failures -- tracked in <issue-link>

### Notes
- <Any other observations>

---
All green: <yes/no>
```
