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
   gh run list --repo lsm/neokai --branch dev --limit 3 --json databaseId,status,conclusion,createdAt,headSha
   ```

2. Pick the most recent completed run (status != "in_progress"). If the latest is still running, wait up to 10 minutes polling every 2 minutes:
   ```bash
   CI_STATUS=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json status --jq '.[0].status')
   if [ "$CI_STATUS" = "in_progress" ]; then
     for i in $(seq 1 5); do
       echo "CI still in progress, waiting 2 minutes (attempt $i/5)..."
       sleep 120
       CI_STATUS=$(gh run list --repo lsm/neokai --branch dev --limit 1 --json status --jq '.[0].status')
       [ "$CI_STATUS" != "in_progress" ] && break
     done
     if [ "$CI_STATUS" = "in_progress" ]; then
       echo "CI still running after 10 minutes. Reporting status and stopping."
       # Report which run is in progress and stop — will retry next hourly run
       exit 0
     fi
   fi
   ```

3. List failed E2E jobs (names contain "E2E"):
   ```bash
   RUN_ID=<run-id>
   gh run view --repo lsm/neokai $RUN_ID --json jobs --jq '.jobs[] | select(.conclusion == "failure") | select(.name | test("E2E")) | {name, databaseId, url}'
   ```

4. If no E2E jobs failed, report "All green" and stop.

5. For each failed E2E job, download the test report artifact and extract failure details:
   ```bash
   gh run download $RUN_ID --repo lsm/neokai --pattern "e2e-no-llm-results-*" --pattern "e2e-results-llm-*"
   # Read playwright-report/index.html for failure details
   ```

6. For each failure, report:
   - Test file path (e.g., `tests/features/mission-terminology.e2e.ts`)
   - CI job name (e.g., `E2E No-LLM (features-mission-terminology)`)
   - Failure message / error snippet
   - Commit hash from `headSha` (links failure to specific commit)
   - Suspected root cause category: `test-bug` | `product-bug` | `flaky` | `env`
   - Whether it is a pre-existing issue (check `docs/e2e-health-check-log.md` for prior occurrences)

7. Append the results to `docs/e2e-health-check-log.md` following the existing format (see the log file for examples).

## Excluded Tests (do not investigate)
- `features/space-export-import`
- `features/space-workflow-rules`

## Known Pre-existing Issues (check if still failing)
These issues were documented in prior health check runs (see `docs/e2e-health-check-log.md`):
- `features-worktree-isolation`: session deletion race condition
- `features-space-session-groups`: workspace path initialization race
- `features-reference-autocomplete` / `features-task-lifecycle`: E2E temp workspace lacks `.git` directory

## CI Notes
- **cancel-in-progress**: CI has `cancel-in-progress: true`. Before pushing any fix, always check if a CI run is in progress (see step 2 wait strategy). Pushing while CI runs will cancel the in-progress run.
- E2E test categories: `no-llm` (UI-only, fully parallel) and `llm` (requires LLM API, max 4 parallel).
- The CI `discover` job auto-categorizes tests; artifact names follow `e2e-no-llm-results-<name>` and `e2e-results-llm-<name>`.
```

---

## Subsequent Executions (Plan Reuse)

The mission system uses **plan reuse** for execution 2+:

1. **First execution**: The Planner agent expands the mission description into a concrete task plan (the discovery task). The task runs, reports failures, and the Leader creates fix tasks.
2. **Second execution onwards**: The mission runtime **clones** the discovery task from the first execution (same prompt, fresh run). The cloned task checks the latest CI state at that point in time — it does not repeat old results.
3. **Fix tasks are NOT cloned** — each execution's fix tasks are created fresh by the Leader based on what the discovery task finds in that specific run.

This means: if execution #1 finds 3 failures and the Leader creates 3 fix tasks, execution #2 will only create new fix tasks for failures that still exist (or new failures introduced since the last run). Fixed tests should no longer appear in the discovery output.

---

## Fix Task Creation Guidance (For the Leader Agent)

After the discovery task completes, the Leader agent reviews the failure report and creates one task per failure. This section documents the expected behavior.

### How the Leader Receives Discovery Output

The mission system's execution pipeline works as follows:

1. The Planner agent creates the discovery task for the first execution. The task agent runs it and produces a failure report as its task output.
2. The mission runtime marks the discovery task as completed and records its output in the execution record.
3. The Leader agent (the room's orchestrator) reads the completed task output from the execution state.
4. Based on the failure report, the Leader calls `mcp__planner-tools__create_task` to create one fix task per distinct failure, linking each to this mission via `depends_on`.

For subsequent hourly executions, the mission system reuses the plan from the first successful execution (task cloning). The cloned discovery task runs again, produces a fresh failure report, and the Leader creates new fix tasks for any new or recurring failures.

### Autonomy Level and Push Workflow

The mission uses `semi_autonomous` autonomy, which means:
- Fix tasks **must create a PR** via `gh pr create` targeting `dev` (the standard supervised workflow for code changes).
- The Leader can **merge approved PRs** without waiting for human confirmation.
- This does NOT mean direct push to `dev` — all code changes go through PRs for traceability.

> **Why PRs instead of direct push**: Even though `semi_autonomous` allows skipping human review on merge, PRs provide a commit history trail, enable CI verification before merge, and avoid the `cancel-in-progress` race condition that direct pushes to dev trigger.

### Task Creation Rules

1. One task per distinct failure (not per test assertion -- group related failures from the same root cause into a single task).
2. Task type is `coder` if source code changes are needed (test fixes, product fixes). Task type is `general` if it is investigation-only, environment issue, or skip-with-reason.
3. Each task should include:
   - The failure details from the discovery report
   - Clear acceptance criteria (the specific test must pass)
   - A reference to the CI run ID and test file path
4. For `flaky` or `env` category failures, the task should document findings and either fix the flakiness or skip with a reason comment. Do not create fix tasks for known pre-existing issues that are already documented in `docs/e2e-health-check-log.md` unless they have worsened.

### Fix Task Description Template

```
Fix E2E test failure: <test-name>

**CI Run**: <run-id>
**Commit**: <head-sha>
**Job**: <job-name>
**Test file**: packages/e2e/tests/<path>.e2e.ts
**Error**: <failure message>
**Root cause**: <category and explanation>

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
- Discovery task runs each hour and checks the latest completed CI run on dev.
- Failure report includes test name, failure message, relevant commit hash, and root cause category.
- Leader agent creates one fix task per distinct failure.
- Fix tasks reference the CI run and include clear acceptance criteria.
- Discovery results are appended to `docs/e2e-health-check-log.md`.
- Known pre-existing issues documented in `docs/e2e-health-check-log.md` are not re-investigated unless they have worsened.
- Excluded tests (`space-export-import`, `space-workflow-rules`) are not investigated.
