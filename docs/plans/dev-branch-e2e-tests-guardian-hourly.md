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

1. Query the latest completed CI runs on dev:
   ```bash
   gh run list --repo lsm/neokai --branch dev --limit 3 --json databaseId,status,conclusion,createdAt
   ```

2. Pick the most recent completed run (status != "in_progress"). If the latest is still running, report "CI still running" and stop.

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
   - Suspected root cause category: `test-bug` | `product-bug` | `flaky` | `env`
   - Whether it is a pre-existing known flaky test (check `packages/e2e/tests/KNOWN_ISSUES.md`)

7. Append the results to `docs/e2e-health-check-log.md` following the existing format (see the log file for examples).

## Excluded Tests (do not investigate)
- `features/space-export-import`
- `features/space-workflow-rules`

## Known Pre-existing Issues (check if still failing)
- `features-worktree-isolation`: session deletion race condition
- `features-space-session-groups`: workspace path initialization race
- `features-reference-autocomplete` / `features-task-lifecycle`: E2E temp workspace lacks `.git` directory

## CI Notes
- CI has `cancel-in-progress: true` -- pushing to dev cancels any running CI.
- E2E test categories: `no-llm` (UI-only, fully parallel) and `llm` (requires LLM API, max 4 parallel).
- The CI `discover` job auto-categorizes tests; artifact names follow `e2e-no-llm-results-<name>` and `e2e-results-llm-<name>`.
```

---

## Fix Task Creation Guidance (For the Leader Agent)

After the discovery task completes, the Leader agent reviews the failure report and creates one task per failure. This section documents the expected behavior.

### Task Creation Rules

1. One task per distinct failure (not per test assertion -- group related failures from the same root cause into a single task).
2. Task type is `coder` if source code changes are needed (test fixes, product fixes). Task type is `general` if it is investigation-only, environment issue, or skip-with-reason.
3. Each task should include:
   - The failure details from the discovery report
   - Clear acceptance criteria (the specific test must pass)
   - A reference to the CI run ID and test file path
4. For `flaky` or `env` category failures, the task should document findings and either fix the flakiness or skip with a reason comment. Do not create fix tasks for known pre-existing issues that are already documented in `KNOWN_ISSUES.md` unless they have worsened.

### Fix Task Description Template

```
Fix E2E test failure: <test-name>

**CI Run**: <run-id>
**Job**: <job-name>
**Test file**: packages/e2e/tests/<path>.e2e.ts
**Error**: <failure message>
**Root cause**: <category and explanation>

Fix the test (or underlying product code) so it passes in CI. Verify locally with:
```bash
NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/<path>.e2e.ts
```

After fixing, commit with message: `fix(e2e): <description>`
Push to dev branch. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
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
- Known pre-existing issues in `KNOWN_ISSUES.md` are not re-investigated unless they have worsened.
- Excluded tests (`space-export-import`, `space-workflow-rules`) are not investigated.
