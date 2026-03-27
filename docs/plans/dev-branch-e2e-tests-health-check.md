# Dev Branch E2E Tests Health Check

## Goal

Recurring mission to monitor and fix e2e test failures on the `dev` branch CI. Ensure all e2e tests pass reliably, document flaky tests, and maintain test stability.

## Approach

Each run follows a structured workflow: check CI status, verify build succeeded, identify e2e failures, analyze root causes, apply fixes, and verify. Only e2e test failures are addressed; other CI job failures are noted and delegated.

## Task Types

- **general**: Investigation, monitoring, and documentation tasks
- **coder**: Implementation tasks requiring code changes

---

## Task 1: Check CI Status and Identify Failing E2E Tests

**Type:** general

**Description:**
Check the latest CI run on the dev branch and identify any failing e2e test jobs. First verify that the build and discover jobs succeeded, as e2e tests depend on them.

**Subtasks:**
1. Query the latest CI run on dev branch and capture the run ID:
   ```bash
   gh run list --repo lsm/neokai --branch dev --limit 1 --json databaseId,name,status,conclusion
   RUN_ID=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json databaseId --jq '.[0].databaseId')
   echo "Run ID: $RUN_ID"
   ```
2. If the run is still in progress (`status: "in_progress"`), report "CI still running" and stop.
3. If the run completed, check if build and discover jobs succeeded first (note: `gh run view` takes a run ID, not `--branch`):
   ```bash
   gh run view --repo lsm/neokai $RUN_ID --json jobs --jq '.jobs[] | select(.name == "build" or .name == "discover") | "\(.name): \(.conclusion)"'
   ```
   - If `build` or `discover` failed, report "Build failure — e2e tests did not run" and stop. Note the build failure for reporting but do not investigate it (outside scope).
4. If build succeeded, check for failing e2e jobs (note: `gh run view --json jobs` returns `databaseId`, not `id`):
   ```bash
   gh run view --repo lsm/neokai $RUN_ID --json jobs --jq '.jobs[] | select(.conclusion == "failure") | "\(.name): \(.conclusion)"'
   ```
5. Filter to only `e2e-no-llm` and `e2e-llm` job failures. If none, report success and skip to Task 5.
6. For each failing e2e job, extract job details for artifact download:
   ```bash
   gh run view --repo lsm/neokai $RUN_ID --json jobs --jq '.jobs[] | select(.conclusion == "failure") | select(.name | startswith("e2e-")) | {name, databaseId, url}'
   ```
7. Check the mission log from the previous run for known flaky tests:
   ```bash
   # Check docs/e2e-health-check-log.md or mission execution record
   cat docs/e2e-health-check-log.md 2>/dev/null | grep -A2 "flaky" || echo "No previous flaky test records found"
   ```

**Acceptance Criteria:**
- Clear list of failing e2e test job names and databaseIds.
- Confirmation that build/discover jobs succeeded before e2e failures are investigated.
- Known flaky tests from previous runs are flagged for priority analysis.
- If all e2e tests pass, mission is complete for this run.
- If CI is still running, mission pauses until next run.
- If build failed, mission reports build failure and stops (e2e tests did not run).

**Dependencies:** None

---

## Task 2: Download Artifacts and Analyze Failures

**Type:** general

**Description:**
Download test artifacts from failed e2e jobs and analyze failure patterns. Compare with previous run findings to identify known flaky tests quickly.

**Subtasks:**
1. Download test results using the run ID from Task 1 (note: `gh run download` takes a **run ID**, not a job ID. Use `--pattern` for glob matching (e.g., `e2e-no-llm-results-*`) or `--name` for exact artifact names):
   ```bash
   RUN_ID=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json databaseId --jq '.[0].databaseId')
   # Download all e2e artifacts using glob patterns
   gh run download $RUN_ID --repo lsm/neokai --pattern "e2e-no-llm-results-*"
   gh run download $RUN_ID --repo lsm/neokai --pattern "e2e-results-llm-*"
   ```
   Artifacts are downloaded to `packages/e2e/test-results/` (raw JSON) and `packages/e2e/playwright-report/` (HTML report).
2. Read failure summaries:
   - `playwright-report/index.html` — human-readable test report with screenshots
   - `test-results/**/*.json` — structured Playwright result files containing error messages, stack traces, and failure details
3. For each failing test, identify:
   - Which specific tests fail (not just the file)
   - Error type: assertion failure, timeout, element not found, network error, etc.
   - Failure context: timing-related patterns (suspicious if: waits, timeouts, element not found after wait)
4. Categorize each failure honestly based on single-run evidence:
   - **Suspected flaky** (single-run indication): timeout, race condition, element not found with async timing patterns
   - **Likely genuine bug**: assertion mismatch, wrong text/content, broken functionality
   - **Env issue**: CI environment problem (port binding, resource constraints, missing deps)
   - **Test code bug**: wrong selector, incorrect assertion logic
   - **Test design issue**: test accesses internal state, has race conditions, or tests implementation details
5. Cross-reference with previous run log (`docs/e2e-health-check-log.md`) to confirm or update flaky test status.
6. Check if the failing test is in `EXCLUDED_TESTS` (intentionally disabled in CI). If so, note it and skip investigation.

**Acceptance Criteria:**
- Each failure has a category and initial root cause hypothesis.
- Failures are compared against previous runs for flaky test pattern detection.
- Excluded tests are identified and skipped.
- Failure artifacts are downloaded and accessible for deeper investigation.
- Document findings in the mission log (see Task 5).

**Dependencies:** Task 1

---

## Task 3: Investigate and Fix Failures by Category

**Type:** coder

**Description:**
Fix failures based on their category. Each fix targets a specific test file. Apply small targeted fixes where possible; flag tests needing major restructuring for separate tracking.

**Subtasks:**

### For Suspected Flaky Tests:
1. Identify the timing issue: fixed sleep, missing wait, race condition, network dependency
2. Replace `waitForTimeout` calls with proper Playwright auto-retrying assertions (`expect(locator).toBeVisible()`)
3. Add explicit waits for elements when DOM state depends on async operations
4. Threshold for flagging: if a test fails 3+ times across different health check runs, flag it for potential major rewrite or disable
5. If the test needs major restructuring (not a simple patch), document it as a separate stabilization task — do not block the current health check run on a large rewrite

### For Genuine Bug (Product Code):
1. Investigate the underlying product code causing the failure
2. Create a separate task tracking the product bug fix (use `mcp__planner-tools__create_task`)
3. Apply a minimal test workaround to unblock CI (e.g., `test.skip` with reason, or adjusted assertion)
4. Do not let a product bug block all e2e tests from running

### For Env Issue:
1. Check if the issue is infrastructure-related (server startup, port binding, resource limits)
2. If fixable in CI config (`.github/workflows/main.yml`), apply the change
3. If not fixable (e.g., temporary resource constraints), document and retry on next run
4. Watch for cancelled runs (CI has `cancel-in-progress: true`). If the fix run was cancelled, re-trigger with `gh workflow run "CI" --repo lsm/neokai --ref dev`

### For Test Bug (Incorrect UI Assumptions):
1. Read the relevant UI component to understand actual behavior
2. Update test selectors, assertions, or flows to match current UI
3. Common patterns:
   - Dropdown menu changed to inline buttons
   - Navigation flow changed (e.g., page redirected after action)
   - UI text or selectors changed (`data-testid` values)

### For Test Design Issue (Major Restructuring Needed):
1. If the test has fundamental issues (accesses internal state, has race conditions, tests implementation details), this requires more than a patch
2. Create a separate task for test rewrite/fix
3. Apply a minimal `test.skip` workaround to unblock CI in the meantime
4. Document the architectural issue in the mission log

**Acceptance Criteria:**
- Each failing test has a fix applied, a documented workaround, or a separate tracking task.
- Flaky tests are tracked with failure counts across runs.
- Tests needing major restructuring are flagged separately and given workarounds.
- If a test is disabled/skipped, the reason is documented with a tracking link.
- All fixes are committed to a feature branch targeting `dev`.

**Dependencies:** Task 2

---

## Task 4: Verify Fixes Pass CI

**Type:** general

**Description:**
After applying fixes, verify they pass CI. Always use PRs for review and safety — no direct pushes to dev.

**Subtasks:**
1. Create a feature branch for fixes:
   ```bash
   git checkout dev && git pull origin dev
   git checkout -b fix/e2e-<test-name>-<date>
   # apply fixes
   git add . && git commit -m "fix(e2e): <description>"
   git push origin fix/e2e-<test-name>-<date>
   ```
2. Create PR targeting `dev`:
   ```bash
   gh pr create --title "fix(e2e): <description>" --body "Fixes e2e test failures on dev CI" --base dev
   ```
3. Monitor the CI run for the PR:
   ```bash
   gh run list --repo lsm/neokai --branch fix/e2e-<test-name>-<date> --limit 1 --json status,conclusion
   ```
4. If CI run was cancelled (due to another push on the same branch), re-trigger:
   ```bash
   gh workflow run "CI" --repo lsm/neokai --ref fix/e2e-<test-name>-<date>
   ```
5. If CI fails on the fix, investigate and iterate (return to Task 2/3).
6. Once CI passes, merge the PR:
   ```bash
   gh pr merge --squash --delete-branch
   ```
7. Trigger a fresh CI run on dev to confirm all e2e tests pass:
   ```bash
   gh workflow run "CI" --repo lsm/neokai --ref dev
   ```
8. Monitor dev CI directly:
   ```bash
   gh run list --repo lsm/neokai --branch dev --limit 1 --json status,conclusion
   ```

**Acceptance Criteria:**
- Fix PR passes CI successfully.
- Dev branch CI shows all e2e tests passing.
- No direct pushes to dev are made — all changes go through PR review.
- Cancelled runs are detected and re-triggered as needed.

**Dependencies:** Task 3

---

## Task 5: Document Findings

**Type:** general

**Description:**
Document all findings from this run for future reference and cross-run pattern tracking. Store findings in both the mission execution record and a markdown log for quick human review.

**Subtasks:**
1. Record execution results in the mission execution record (via `goal.listExecutions` or the mission system UI):
   - Date and CI run ID checked
   - List of failures found (test name, category, root cause hypothesis)
   - Fixes applied (commit/PR links)
   - Flaky tests identified (with failure count across runs)
   - Any product bugs filed (with task/issue links)
2. Update `docs/e2e-health-check-log.md` with the latest run summary:
   ```bash
   # Append to log
   echo "## Run: $(date -u +%Y-%m-%d)" >> docs/e2e-health-check-log.md
   echo "- CI Run: <run-id>" >> docs/e2e-health-check-log.md
   echo "- Failures: <list>" >> docs/e2e-health-check-log.md
   echo "- Fixes: <PR links>" >> docs/e2e-health-check-log.md
   echo "- Flaky: <test-name> (<count> failures)" >> docs/e2e-health-check-log.md
   ```
3. If a test has been flagged as flaky 3+ times across different runs, create a tracking issue for stabilization.
4. If a test is disabled/skipped as a workaround, record the tracking task link and planned fix timeline.

**Acceptance Criteria:**
- Run is documented in mission execution record with all failures, fixes, and outcomes.
- `docs/e2e-health-check-log.md` is updated with run summary.
- Flaky tests are tracked with cumulative failure counts across runs.
- Product bugs and test design issues have tracking tasks or issues.

**Dependencies:** Task 4

---

## Key CI Context

### CI Dependency Chain
- **On push to dev**: `build` + `discover` (run in parallel) → `e2e`. Note: check/unit/online tests are skipped on push to dev.
- **On PR to main**: `check/online tests` → `build` + `discover` (parallel) → `e2e`.

If `build` or `discover` fails, e2e tests never run — handle this in Task 1.

### E2E Test Jobs
- **e2e-no-llm**: UI-only tests that run in parallel
- **e2e-llm**: Tests requiring LLM API calls, max 4 parallel

### Excluded Tests
The CI workflow has an `EXCLUDED_TESTS` array. Failures from excluded tests should be noted but not investigated (they are intentionally disabled). Current exclusions: `features/space-export-import`, `features/space-workflow-rules`.

### Artifact Patterns
- `e2e-no-llm-results-*` — test results from no-llm jobs (glob pattern)
- `e2e-results-llm-*` — test results from llm jobs (glob pattern)
- Artifacts contain `playwright-report/index.html` (human-readable) and `test-results/*.json` (structured error data)

### Running E2E Tests Locally
```bash
# Single test
make run-e2e TEST=tests/features/slash-cmd.e2e.ts

# All tests (slow)
make run-e2e
```

### Relevant Files
- CI workflow: [`.github/workflows/main.yml`](.github/workflows/main.yml)
- E2E tests: `packages/e2e/tests/`
- Test helpers: `packages/e2e/tests/helpers/`
- Playwright config: `packages/e2e/playwright.config.ts`
