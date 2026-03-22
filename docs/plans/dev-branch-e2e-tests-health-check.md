# Dev Branch E2E Tests Health Check

## Goal

Recurring mission to monitor and fix e2e test failures on the `dev` branch CI. Ensure all e2e tests pass reliably, document flaky tests, and maintain test stability.

## Approach

Each run follows a structured workflow: check CI status, identify failures, analyze root causes, apply fixes, and verify. Only e2e test failures are addressed; other CI job failures are noted and delegated.

---

## Task 1: Check CI Status and Identify Failing E2E Tests

**Type:** general

**Description:**
Check the latest CI run on the dev branch and identify any failing e2e test jobs.

**Subtasks:**
1. Query the latest CI run on dev branch:
   ```bash
   gh run list --repo lsm/neokai --branch dev --limit 1
   ```
2. If the run is still in progress, report "CI still running" and stop.
3. If the run completed, check for failing e2e jobs:
   ```bash
   gh run view --repo lsm/neokai --branch dev --json jobs --jq '.jobs[] | select(.conclusion == "failure") | "\(.name): \(.conclusion)"'
   ```
4. Filter to only `e2e-no-llm` and `e2e-llm` job failures. If none, report success.
5. For each failing e2e job, extract the job ID for artifact download:
   ```bash
   gh run view --repo lsm/neokai --branch dev --json jobs --jq '.jobs[] | select(.conclusion == "failure") | select(.name | startswith("e2e-")) | {name, id, html_url}'
   ```

**Acceptance Criteria:**
- Clear list of failing e2e test job names and IDs.
- If all e2e tests pass, mission is complete for this run.
- If CI is still running, mission pauses until next run.

**Dependencies:** None

---

## Task 2: Download Artifacts and Analyze Failures

**Type:** general

**Description:**
Download test artifacts from failed e2e jobs and analyze failure patterns.

**Subtasks:**
1. Download test results for each failing job:
   ```bash
   # For e2e-no-llm failures
   gh run download <job-id> --repo lsm/neokai --name "e2e-no-llm-results-<test-name>"
   # For e2e-llm failures
   gh run download <job-id> --repo lsm/neokai --name "e2e-results-llm-<test-name>"
   ```
   Artifacts are stored in `packages/e2e/test-results/` and `packages/e2e/playwright-report/`.
2. Read failure summaries from `playwright-report/index.html` or test result XML files.
3. For each failing test file, identify:
   - Which specific tests fail (not just the file)
   - Error type: assertion failure, timeout, element not found, etc.
   - Whether failures are consistent across runs (flaky) or always fail (genuine)
4. Categorize each failure:
   - **Flaky test**: fails intermittently, often with timing issues (waits, timeouts)
   - **Genuine bug**: test reveals a real product bug in UI or behavior
   - **Env issue**: CI environment problem (missing dependencies, resource constraints)
   - **Test bug**: test was written against incorrect UI assumptions or outdated behavior

**Acceptance Criteria:**
- Each failure has a category and initial root cause hypothesis.
- Failure artifacts are downloaded and accessible for deeper investigation.
- Document findings in the mission log (see Task 5).

**Dependencies:** Task 1

---

## Task 3: Investigate and Fix Failures by Category

**Type:** coder

**Description:**
Fix failures based on their category. Each fix targets a specific test file.

**Subtasks:**

### For Flaky Tests:
1. Identify the timing issue (fixed sleep, missing wait, race condition)
2. Replace `waitForTimeout` calls with proper Playwright auto-retrying assertions
3. Add explicit waits for elements when DOM state depends on async operations
4. If a test is fundamentally unreliable (多次 failures across different runs), flag it for potential disable or major rewrite

### For Genuine Bug (Product Code):
1. Investigate the underlying product code causing the failure
2. Create a separate task tracking the product bug fix
3. Apply a minimal test workaround (skip with reason, or adjusted assertion) to unblock CI
4. Do not let a product bug block all e2e tests from running

### For Env Issue:
1. Check if the issue is infrastructure-related (server startup, port binding, resource limits)
2. If fixable in CI config (`.github/workflows/main.yml`), apply the change
3. If not fixable (e.g., temporary resource constraints), document and retry

### For Test Bug (Incorrect UI Assumptions):
1. Read the relevant UI component to understand actual behavior
2. Update test selectors, assertions, or flows to match current UI
3. Common patterns:
   - Dropdown menu changed to inline buttons (see `task-actions-dropdown.e2e.ts`)
   - Navigation flow changed (e.g., page redirected after action)
   - UI text or selectors changed (`data-testid` values)

**Acceptance Criteria:**
- Each failing test has a fix applied or a documented workaround.
- If a product bug is found, a separate task is created for the fix.
- If a test is disabled/skipped, the reason is documented.
- All fixes are committed to a feature branch targeting `dev`.

**Dependencies:** Task 2

---

## Task 4: Verify Fixes Pass CI

**Type:** general

**Description:**
After applying fixes, verify they pass CI. Trigger re-runs as needed.

**Subtasks:**
1. Push fixes to dev branch:
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
   gh run list --repo lsm/neokai --branch fix/e2e-<test-name>-<date> --limit 1
   ```
4. If CI fails on the fix, investigate and iterate (return to Task 2/3).
5. Once CI passes, merge the PR:
   ```bash
   gh pr merge --squash --delete-branch
   ```
6. Trigger a fresh CI run on dev to confirm all e2e tests pass:
   ```bash
   gh runworkflow run CI --repo lsm/neokai --ref dev
   ```

**Alternative — Direct Push to Dev (for urgent fixes):**
If the fix is small and well-understood, push directly to dev:
```bash
git checkout dev && git pull origin dev
git merge --no-edit fix/e2e-<test-name>-<date>
git push origin dev
```
Then monitor dev CI directly.

**Acceptance Criteria:**
- Fix PR passes CI successfully.
- Dev branch CI shows all e2e tests passing.
- If CI cannot be triggered directly, verify via `gh run list --branch dev`.

**Dependencies:** Task 3

---

## Task 5: Document Findings

**Type:** general

**Description:**
Document all findings from this run for future reference and pattern tracking.

**Subtasks:**
1. Create or update a run log entry with:
   - Date of the health check run
   - CI run ID checked
   - List of failures found (test name, category, root cause)
   - Fixes applied (commit/PR links)
   - Flaky tests identified (with failure frequency if known)
   - Any product bugs filed (with task links)
2. If a test has been flagged as flaky multiple times, create a tracking issue for stabilization.
3. Store the log in the mission notes or a designated doc (e.g., `docs/e2e-health-check-log.md`).

**Acceptance Criteria:**
- Run is documented with all failures, fixes, and outcomes.
- Flaky tests are tracked across multiple runs.
- Product bugs have tracking issues or are linked to existing tasks.

**Dependencies:** Task 4

---

## Key CI Context

### E2E Test Jobs
- **e2e-no-llm**: UI-only tests that run in parallel (max-parallel not limited)
- **e2e-llm**: Tests requiring LLM API calls, max 4 parallel

### Artifact Names
- `e2e-no-llm-results-<test-name>` — test results from no-llm jobs
- `e2e-results-llm-<test-name>` — test results from llm jobs

### Running E2E Tests Locally
```bash
# Single test
make run-e2e TEST=tests/features/slash-cmd.e2e.ts

# All tests (slow)
make run-e2e
```

### Relevant Files
- CI workflow: `.github/workflows/main.yml`
- E2E tests: `packages/e2e/tests/`
- Test helpers: `packages/e2e/tests/helpers/`
- Playwright config: `packages/e2e/playwright.config.ts`
