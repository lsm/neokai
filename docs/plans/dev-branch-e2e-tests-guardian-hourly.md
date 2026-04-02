# Dev Branch E2E Tests Guardian (Hourly)

## Goal Summary

Set up a recurring hourly mission that monitors E2E test health on the `dev` branch. Each run executes a single discovery task that checks CI results and reports failures. After discovery completes, the Leader agent dynamically creates one fix task per failure found -- no pre-defined fix tasks are needed.

This replaces the previous rigid multi-task plan with a simpler, adaptive approach that trusts the agent to determine the right fix strategy per failure.

## Approach

1. Configure a recurring mission in the NeoKai room with `@hourly` schedule and `semi_autonomous` autonomy.
2. The mission description serves as the discovery task prompt -- it contains the exact CI query commands, failure categorization guidance, and reporting format.
3. On the first execution, the Planner agent expands the discovery prompt into a single concrete task.
4. On subsequent executions, the mission reuses the same plan (task cloning).
5. After the discovery task completes and reports failures, the Leader agent creates one fix task per failure, choosing `general` or `coder` type based on the failure category.
6. Each fix task is assigned to the agent who owns the failing area and linked to this mission.

---

## Mission Configuration

Create a recurring mission with these parameters:

| Parameter | Value |
|-----------|-------|
| `missionType` | `recurring` |
| `schedule.expression` | `@hourly` |
| `autonomyLevel` | `semi_autonomous` |
| `title` | `Dev Branch E2E Tests Guardian` |

### Mission Description (Discovery Task Prompt)

Use the following as the mission description. This is what the Planner agent sees when creating the first execution's task plan.

```
Run E2E CI checks on recent dev branch commits. For each failing test suite, report: test name, failure message, and relevant commit hash. Output a summary of all failures found.

## Steps

1. Query the latest CI runs on dev (include `headSha` for commit hash reporting):
   ```bash
   gh run list --repo lsm/neokai --branch dev --limit 5 --json databaseId,status,conclusion,createdAt,headSha
   ```

2. Pick the most recent completed run. Skip runs with `conclusion` = `"cancelled"` (these were superseded by a newer push). If the latest run has `status` = `"in_progress"`, wait up to 10 minutes polling every 2 minutes:
   ```bash
   # Query latest run status (check for empty output from network errors)
   CI_RESULT=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json status,conclusion --jq '.[0]')
   if [ -z "$CI_RESULT" ]; then
     echo "ERROR: Failed to query CI status (network error or auth issue)."
     exit 1
   fi

   CI_STATUS=$(echo "$CI_RESULT" | jq -r '.status')
   CI_CONCLUSION=$(echo "$CI_RESULT" | jq -r '.conclusion')

   if [ "$CI_STATUS" = "in_progress" ]; then
     echo "CI is in progress. Polling for up to 10 minutes (5 attempts × 2 min)..."
     for i in $(seq 1 5); do
       echo "Waiting 2 minutes (attempt $i/5)..."
       sleep 120
       POLL_RESULT=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json status,conclusion --jq '.[0]')
       if [ -z "$POLL_RESULT" ]; then
         echo "WARNING: Poll failed (network error). Retrying next iteration."
         continue
       fi
       CI_STATUS=$(echo "$POLL_RESULT" | jq -r '.status')
       CI_CONCLUSION=$(echo "$POLL_RESULT" | jq -r '.conclusion')
       [ "$CI_STATUS" != "in_progress" ] && break
     done
     if [ "$CI_STATUS" = "in_progress" ]; then
       echo "CI still running after 10 minutes. Reporting current status and stopping."
       echo "Latest run is still in_progress — no completed results to report."
       exit 0
     fi
   fi
   ```

   If the most recent run is `cancelled`, check the next older run, and so on up to 5 runs. The 5-run limit covers the common case where a burst of commits causes several consecutive cancellations (each push cancels the previous run due to `cancel-in-progress: true`).

   If all recent runs (last 5) are cancelled or in-progress, report "No completed CI runs available — all recent runs were cancelled or still in progress" and stop.

3. **Verify E2E jobs actually ran** before checking for failures. E2E jobs are gated on `build` and `discover` succeeding. If either upstream job fails, E2E jobs are skipped — not failed. A run with zero E2E failures and zero E2E jobs run is NOT "all green"; it means E2E never executed.

   Check for skipped E2E jobs and upstream failures:
   ```bash
   RUN_ID=<run-id>
   # Check if build and discover succeeded (prerequisite for E2E)
   UPSTREAM=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.name == "Build Binary (linux-x64)" or .name == "Discover Tests") | {name, conclusion, status}')

   echo "Upstream jobs:"
   echo "$UPSTREAM"

   # Count E2E jobs that actually ran (not skipped)
   E2E_TOTAL=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '[.jobs[] | select(.name | startswith("E2E"))] | length')
   E2E_SKIPPED=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '[.jobs[] | select(.name | startswith("E2E")) | select(.conclusion == "skipped")] | length')
   E2E_RAN=$((E2E_TOTAL - E2E_SKIPPED))

   echo "E2E jobs: $E2E_RAN ran, $E2E_SKIPPED skipped out of $E2E_TOTAL total"

   if [ "$E2E_RAN" -eq 0 ]; then
     echo "WARNING: No E2E jobs actually ran. Upstream job may have failed or been skipped."
     echo "Report this as a CI infrastructure issue rather than 'all green'."
     # Include upstream job status in the report
     exit 0
   fi
   ```

4. List failed E2E jobs from the chosen run (only jobs that actually ran, not skipped):
   ```bash
   gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.conclusion == "failure") | select(.name | startswith("E2E")) | {name, databaseId, steps: [.steps[] | select(.conclusion == "failure") | {name, conclusion}]}'
   ```

5. If no E2E jobs failed (and E2E jobs did run), report "All green" and stop.

6. For each failed E2E job, extract the failure message. Use step 6a first (fast, no download). Use step 6b if more detail is needed.

   **6a. Get failure summary from job logs (fast, recommended first)** — gets the name of the failing step(s):
   ```bash
   # Get the failing step name(s) and summary
   gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.name == "<job-name>") | .steps[] | select(.conclusion == "failure") | .name'
   ```

   **6b. Download test report artifact (for detailed failure messages)** — downloads per-test Playwright output:
   ```bash
   # Artifact naming convention:
   #   No-LLM jobs: e2e-no-llm-results-<test-name>
   #   LLM jobs:    e2e-results-llm-<test-name>
   # where <test-name> matches the matrix.test.name value (e.g., "features-mission-terminology")
   mkdir -p /tmp/e2e-guardian
   gh run download $RUN_ID --repo lsm/neokai --name "e2e-no-llm-results-<test-name>" --dir "/tmp/e2e-guardian/<test-name>"
   ```

   **Artifact directory structure** (confirmed from CI workflow `upload-artifact@v4` with `if: failure()`):
   ```
   /tmp/e2e-guardian/<test-name>/
   ├── test-results/           # Playwright internal output (per-test directories)
   │   └── <test-name>/
   │       └── .last-run.json  # Structured test result with error messages
   └── playwright-report/      # HTML reporter output
       └── index.html          # Self-contained HTML report
   ```

   **Reading failure messages from `.last-run.json`**:
   Playwright's `test-results/` contains per-test directories, each with a `.last-run.json` file that holds the most recent test run result including `errors[]` with structured error data. This is the best source for programmatic failure message extraction:
   ```bash
   # Extract all error messages from test results
   find /tmp/e2e-guardian/<test-name>/test-results/ -name ".last-run.json" \
     -exec jq -r '.suites[]?.specs[]?.tests[]?.results[]?.error // empty | .message // empty' {} \; 2>/dev/null
   ```

   **Batch download for all failed jobs**:
   ```bash
   FAILED_JOBS=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.conclusion == "failure") | select(.name | startswith("E2E")) | .name')
   for JOB in $FAILED_JOBS; do
     # Extract test name from job name: "E2E No-LLM (features-foo)" -> "features-foo"
     TEST_NAME=$(echo "$JOB" | sed -n 's/.*(\(.*\)).*/\1/p')
     if [ -z "$TEST_NAME" ]; then
       echo "WARNING: Could not extract test name from job: $JOB"
       continue
     fi
     # Determine artifact name based on job prefix
     if echo "$JOB" | grep -q "No-LLM"; then
       ARTIFACT="e2e-no-llm-results-$TEST_NAME"
     else
       ARTIFACT="e2e-results-llm-$TEST_NAME"
     fi
     echo "Downloading artifact: $ARTIFACT"
     mkdir -p "/tmp/e2e-guardian/$TEST_NAME"
     if ! gh run download $RUN_ID --repo lsm/neokai --name "$ARTIFACT" --dir "/tmp/e2e-guardian/$TEST_NAME" 2>&1; then
       echo "  Artifact download failed (may have expired or upload failed). Use step 6a logs instead."
     fi
   done
   ```

   **Artifact retention**: Failed job artifacts are retained for 7 days (explicitly set via `retention-days: 7` in the workflow). Artifacts older than 7 days are auto-deleted by GitHub Actions.

7. For each failure, report:
   - Test file path (e.g., `tests/features/mission-terminology.e2e.ts`)
   - CI job name (e.g., `E2E No-LLM (features-mission-terminology)`)
   - Failure message / error snippet (from step 6a logs or step 6b artifacts)
   - Commit hash from `headSha` (links failure to specific commit)
   - Suspected root cause category: `test-bug` | `product-bug` | `flaky` | `env`
   - Whether it is a pre-existing issue (check `docs/e2e-health-check-log.md` for prior occurrences)

8. Append the results to `docs/e2e-health-check-log.md` following the existing format (see the log file for examples).

## Excluded Tests (do not investigate)
- `features/space-export-import`
- `features/space-workflow-rules`

## Known Pre-existing Issues (check if still failing)
These issues were documented in prior health check runs (see `docs/e2e-health-check-log.md`):
- `features-worktree-isolation`: session deletion race condition
- `features-space-session-groups`: workspace path initialization race
- `features-reference-autocomplete` / `features-task-lifecycle`: E2E temp workspace lacks `.git` directory
- Neo panel doesn't close on Escape key (affects 7 suites, first seen 2026-04-02)
- Space UNIQUE constraint on retry (affects 7 suites, first seen 2026-04-02)
- Ambiguous locators / strict mode violations (affects 5 suites, first seen 2026-04-02)
- AI-dependent tests in No-LLM matrix (1 suite, first seen 2026-04-02)

## CI Notes
- **cancel-in-progress**: CI has `cancel-in-progress: true` with group `ci-${{ github.ref }}`. Pushing to dev while CI is running will cancel the in-progress run. Always check for cancelled runs and skip them (step 2).
- E2E test categories: `no-llm` (UI-only, fully parallel) and `llm` (requires LLM API, max 4 parallel).
- The CI `discover` job auto-categorizes tests; artifact names follow `e2e-no-llm-results-<name>` and `e2e-results-llm-<name>`.
- **Artifact naming**: Jobs are `E2E No-LLM (<name>)` and `E2E LLM (<name>)`. Strip the prefix and parentheses to get the artifact name suffix.
```

---

## Subsequent Executions (Plan Reuse)

The mission system uses **plan reuse** for execution 2+:

1. **First execution**: The Planner agent expands the mission description into a concrete task plan (the discovery task). The task runs, reports failures, and the Leader creates fix tasks.
2. **Second execution onwards**: The mission runtime **clones** the discovery task from the first execution (same prompt, fresh run). The cloned task checks the latest CI state at that point in time -- it does not repeat old results.
3. **Fix tasks are NOT cloned** -- each execution's fix tasks are created fresh by the Leader based on what the discovery task finds in that specific run.

This means: if execution #1 finds 3 failures and the Leader creates 3 fix tasks, execution #2 will only create new fix tasks for failures that still exist (or new failures introduced since the last run). Fixed tests should no longer appear in the discovery output.

---

## Fix Task Creation Guidance (For the Leader Agent)

After the discovery task completes, the Leader agent reviews the failure report and creates one task per failure. This section documents the expected behavior.

### How the Leader Receives Discovery Output

The discovery task produces a **structured failure report** as its output text. The Leader agent reads this output to create fix tasks. The data flow is:

```
Discovery task runs → produces failure report (text output)
    ↓
Leader agent reads the completed task output
    ↓
For each failure entry, Leader calls create_task() with fix details
    ↓
Fix tasks are dispatched to appropriate agents
```

**What the Leader looks for in the discovery output:**

The discovery task must output a machine-parseable failure report. Each failure entry should include these fields (the discovery task prompt above specifies this format):

| Field | Example |
|-------|---------|
| Test file path | `tests/features/mission-terminology.e2e.ts` |
| CI job name | `E2E No-LLM (features-mission-terminology)` |
| Failure message | `Error: Locator.click: Timeout 30000ms exceeded` |
| Commit hash | `9a65475ce` |
| Root cause category | `test-bug` / `product-bug` / `flaky` / `env` |
| Pre-existing | `yes` (with health check log date) or `no` |

**Leader actions after reading the report:**

1. Skip entries where `pre-existing: yes` unless the issue has worsened.
2. Group entries with the same root cause into a single fix task.
3. For each distinct failure, call `create_task()` with:
   - `title`: `"Fix E2E test failure: <test-name>"` or `"Investigate E2E flaky: <test-name>"` for flaky/env categories
   - `description`: Include the failure details, CI run ID, commit hash, and acceptance criteria (test must pass)
   - `agent`: `"coder"` for test-bug/product-bug, `"general"` for flaky/env
   - `priority`: `"high"` for new failures, `"normal"` for pre-existing worsening, `"low"` for flaky tests
4. Excluded tests (`space-export-import`, `space-workflow-rules`) are never investigated — skip them entirely.

For subsequent hourly executions, the mission system reuses the plan from the first successful execution (task cloning). The cloned discovery task runs again, produces a fresh failure report, and the Leader creates new fix tasks only for failures not already covered by in-progress fix tasks from this or prior executions.

### Autonomy Level and Push Workflow

The mission uses `semi_autonomous` autonomy, which means:
- Fix tasks **must create a PR** via `gh pr create` targeting `dev` (the standard supervised workflow for code changes).
- The Leader can **merge approved PRs** without waiting for human confirmation.
- This does NOT mean direct push to `dev` -- all code changes go through PRs for traceability.

> **Why PRs instead of direct push**: Even though `semi_autonomous` allows skipping human review on merge, PRs provide a commit history trail, enable CI verification before merge, and avoid the `cancel-in-progress` race condition that direct pushes to dev trigger.

### Task Creation Rules

1. One task per distinct failure (not per test assertion -- group related failures from the same root cause into a single task).
2. Task type is `coder` if source code changes are needed (test fixes, product fixes). Task type is `general` if it is investigation-only, environment issue, or skip-with-reason.
3. Each task should include:
   - The failure details from the discovery report
   - Clear acceptance criteria (the specific test must pass)
   - A reference to the CI run ID and test file path
4. For `flaky` or `env` category failures, the task should document findings and either fix the flakiness or skip with a reason comment. Do not create fix tasks for known pre-existing issues that are already documented in `docs/e2e-health-check-log.md` unless they have worsened.
5. **Cross-reference the health check log** before creating a fix task. If the exact same failure (same test, same root cause) was documented in a prior health check entry, note it as "pre-existing, previously documented on YYYY-MM-DD" and only create a fix task if the issue has worsened (more tests affected, new error messages) or if a previous fix attempt failed.

### Fix Task Description Template

```
Fix E2E test failure: <test-name>

**CI Run**: <run-id>
**Commit**: <head-sha>
**Job**: <job-name>
**Test file**: packages/e2e/tests/<path>.e2e.ts
**Error**: <failure message>
**Root cause**: <category and explanation>
**Pre-existing**: <yes/no, reference health check log entry if yes>

Fix the test (or underlying product code) so it passes in CI. Verify locally with:
```bash
NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/<path>.e2e.ts
```

After fixing, commit on a feature branch and create a PR:
```bash
git checkout -b fix/e2e-<test-name>
git add packages/e2e/tests/<path>.e2e.ts
git commit -m "fix(e2e): <description>"
git push origin fix/e2e-<test-name>
gh pr create --base dev --title "fix(e2e): <description>" --body "Fixes E2E failure from CI run <run-id>"
```
Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
```

### Reference Material for Fix Procedures

The existing detailed plan at `docs/plans/dev-branch-e2e-tests-health-check.md` contains proven fix procedures for common failure categories. Agents should reference it when determining their approach:

- **Test bugs**: Read the relevant UI component, update selectors/assertions. Common patterns include ambiguous locators, changed UI text, changed navigation flows.
- **Flaky tests**: Replace `waitForTimeout` with auto-retrying assertions. Add explicit waits for async DOM state. If 3+ consecutive failures without progress, flag for disable.
- **Product bugs**: Fix the underlying code. If the fix is large/risky, create a tracking task and apply a minimal `test.skip` workaround.
- **Environment issues**: Document and skip with a TODO comment.

---

## Acceptance Criteria

- Mission is configured as recurring `@hourly` with `semi_autonomous` autonomy.
- Discovery task runs each hour and checks the latest completed (non-cancelled) CI run on dev.
- Discovery task verifies that E2E jobs actually ran (not skipped) before reporting "all green". If E2E jobs were skipped due to build/discover failures, this is reported as a CI infrastructure issue.
- If the latest run is in-progress, the discovery task waits up to 10 minutes before giving up.
- If all recent runs (last 5) are cancelled or in-progress, the task reports no data and stops.
- Failure report includes test name, failure message, relevant commit hash, and root cause category.
- Leader agent creates one fix task per distinct failure.
- Fix tasks reference the CI run and include clear acceptance criteria.
- Discovery results are appended to `docs/e2e-health-check-log.md`.
- Known pre-existing issues documented in `docs/e2e-health-check-log.md` are not re-investigated unless they have worsened.
- Excluded tests (`space-export-import`, `space-workflow-rules`) are not investigated.
