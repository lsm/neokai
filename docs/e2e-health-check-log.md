# E2E Test Health Check Log

This document tracks findings from recurring CI health check missions on the `dev` branch.

## 2026-03-22 — Check Run #23408422793 (first analysis)

### CI Run Overview
- **Run ID**: 23408422793
- **Branch**: dev (commit 1eb2cf653 — before fixes)
- **Status**: Completed with e2e failures

### Build/Discover Jobs
All passed:
- `build` — Build web bundle: **PASSED**
- `discover` — Discover E2E tests: **PASSED**
- `All Tests Pass` — Status aggregator: **PASSED** (but downstream jobs had failures)

### E2E Test Failures at #23408422793

**11 failing tests** — all in `features-mission-terminology` suite. Root causes identified and fixed in PR #717 (see below).

---

## 2026-03-22 — Check Run #23408701119 (post-fix push)

### CI Run Overview
- **Run ID**: 23408701119
- **Branch**: dev (commit 1eb2cf653 — same as above, pre-fix baseline)
- **Event**: push to dev
- **Status**: Completed with **1 failure**

### Build/Discover Jobs
- `Discover Tests`: **PASSED**
- `Build Binary (linux-x64)`: **PASSED**
- `Lint, Knip, Format & Type Check`: **SKIPPED** (likely gated by build)
- All unit test jobs: **SKIPPED**

### E2E Test Failures at #23408701119

**1 failing test**: `E2E LLM (features-worktree-isolation)` → `should cleanup worktree when session is deleted`

**Failure**: After deleting a session and confirming deletion, the page URL still contains the deleted session ID:
```
Expect "not toHaveURL" with timeout 10000ms
14 × unexpected value "http://localhost:39747/session/461d5dd2-7c5c-4a22-bccf-7bf11e853df2"
at worktree-isolation.e2e.ts:113
```

**Root cause**: Race condition in session deletion flow — after clicking confirm delete, the app does not immediately navigate away from the deleted session page. The `toHaveURL` assertion fires before the redirect completes (or the redirect never fires).

**Impact**: Pre-existing flake, unrelated to the Goals→Missions / LiveQuery changes in PR #717.

**Note**: This run (#23408701119) was on the same pre-fix baseline (1eb2cf653). The fixes from PR #717 have not yet been merged to dev. A new run will be triggered once PR #717 is merged.

### Previous E2E Failures (from #23408422793, now fixed in PR #717)

#### Root Cause 1: UI Terminology Mismatch
E2E tests (mission-terminology suite, 11 failing tests) were written expecting **"Missions"** labels in the UI, but the actual UI implementation used **"Goals"** terminology. This is inconsistent with the Mission System documentation in `CLAUDE.md` which specifies "Mission" as the canonical V2 term.

**Files changed**: `packages/web/src/islands/Room.tsx`, `packages/web/src/islands/RoomContextPanel.tsx`, `packages/web/src/components/room/GoalsEditor.tsx`

**Fix**: Renamed all UI labels from "Goals" to "Missions" to match test expectations and Mission System terminology.

#### Root Cause 2: LiveQuery Task Notification Gap
`TaskRepository` was missing `reactiveDb.notifyChange('tasks')` calls after all mutation methods:
- `createTask` — no notifyChange
- `updateTask` — no notifyChange
- `deleteTask` — no notifyChange
- `archiveTask` — no notifyChange
- `promoteDraftTasksByCreator` — no notifyChange

This meant LiveQuery subscriptions never fired when tasks were created/modified via RPC handlers, causing `roomStore.tasks.value` to remain empty in e2e tests.

**Files changed**:
- `packages/daemon/src/storage/repositories/task-repository.ts` — added `reactiveDb` param + notifyChange calls
- `packages/daemon/src/lib/room/managers/task-manager.ts` — pass `this.reactiveDb`
- `packages/daemon/src/lib/room/managers/room-manager.ts` — add `reactiveDb` param, pass to TaskRepository
- `packages/daemon/src/lib/room/managers/goal-manager.ts` — pass `reactiveDb` to TaskRepository
- `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` — pass `reactiveDb` to TaskRepository
- `packages/daemon/src/lib/rpc-handlers/index.ts` — pass `reactiveDb` to RoomManager
- Unit/integration tests: all updated to pass `reactiveDb` / `noOpReactiveDb`

### PR
- **PR**: https://github.com/lsm/neokai/pull/717
- **Status**: Open, fixes committed — awaiting merge to dev to trigger post-fix CI run

### Pre-existing Flake: worktree-isolation session deletion
- **Test**: `should cleanup worktree when session is deleted` (features/worktree-isolation.e2e.ts:113)
- **Issue**: Race condition — page URL still contains deleted session ID after deletion confirmation
- **Action needed**: Increase timeout or add explicit wait for navigation after session deletion

---

## 2026-03-22 — Check Run #23412078420 (post-PR#717 merge)

### CI Run Overview
- **Run ID**: 23412078420
- **Branch**: dev (commit 0ad39bc01 — after PR #717 fix)
- **Event**: push
- **Status**: Completed with e2e failures

### E2E Test Failures at #23412078420

**17 failing tests** across 4 test suites. All failures are **test code bugs** introduced by PR #717, not genuine product bugs.

#### Root Cause: Ambiguous Playwright Locator for "Missions" Button

**Problem**: After renaming "Goals" → "Missions" in the UI, the locator `button:has-text("Missions")` now resolves to **2 elements** in strict mode:
1. `<button aria-label="Missions section">` — sidebar CollapsibleSection header button
2. `<button>Missions</button>` — room tab bar button

Playwright's strict mode fails when a locator matches multiple elements. This affects all tests that use the ambiguous locator in room page contexts.

**Fix**: Replace `button:has-text("Missions")` with `getByRole('button', { name: 'Missions', exact: true })` in all affected test files. The sidebar button has `aria-label="Missions section"` (accessible name = "Missions section"), so it will NOT match the exact name selector.

**Affected tests** (all failing due to ambiguous locator):
| Test Suite | Failing Tests | Root Cause |
|---|---|---|
| `features-mission-terminology` | 5/5 | Ambiguous `button:has-text("Missions")` locator |
| `features-mission-creation` | 9/9 | Same — shared `openMissionsTab` helper |
| `features-livequery-task-goal-updates` | 2/2 | Same — direct locator use |
| `features-mission-detail` | (not failing in this run but affected) | Same — shared helper |
| `features-task-goal-indicator` | (passing but affected) | Same — uses `h2:has-text("Missions")` (safe) |

#### Root Cause 2: Space Workspace Path Issue (features-space-session-groups)

**1 failing test**: `Working Agents section is hidden when no session groups exist`

```
Error: page.evaluate: TypeError: Cannot read properties of undefined (reading 'id')
at createTestSpaceWithTask (/home/runner/work/neokai/neokai/packages/e2e/tests/features/space-session-groups.e2e.ts:55:14)
```

**Root cause**: The `space.create` RPC returns `undefined` because the workspace path (`/tmp/tmp.3fwp0Bczum`) is not a git repository. The daemon rejects space creation in non-git directories.

**Context**: The test uses `getWorkspaceRoot(page)` to get the workspace path, which returns the server's workspace root. In CI, this may be a temp path that isn't properly initialized as a git repo.

**Status**: Only 1 test in the suite failed (the first test, `Working Agents section is hidden when no session groups exist`). All other tests in the suite passed (implying the space creation succeeded in subsequent runs). This is a **suspected flaky** issue — likely a race condition or environment initialization timing issue in CI.

**Action needed**: Investigate whether `space.create` should gracefully handle non-git workspace paths, or whether the test should use a dedicated git workspace. This may be an env issue rather than a test code bug.

#### Pre-existing Flakes (still present)

- **worktree-isolation session deletion**: Race condition in session deletion navigation (still failing)
- **space-session-groups workspace path**: Likely env/race condition issue (1 failure in this run)

---

## 2026-03-27 — Check Run #23660910158

### CI Run Overview
- **Run ID**: 23660910158
- **Branch**: dev (commit 8fe82aaf — `feat(space): implement completion flow with Done node summary (M5.2) (#1050)`)
- **Event**: push
- **Status**: Completed with e2e failures

### Build/Discover Jobs
- `Discover Tests`: **PASSED**
- `Build Binary (linux-x64)`: **PASSED**
- All unit test jobs: **SKIPPED** (gated by build prerequisites)

### E2E Test Failures at #23660910158

**4 failing tests** across 3 suites. All failures were on a pre-PR#1044 baseline.

#### 1. `features-space-agent-centric-workflow` — `clickedNode is not defined`
**Test**: `Multi-agent node renders agent badges and completion state structure`
**Error**: `ReferenceError: clickedNode is not defined` at line 243

```
241 | // addStep double-invocation issue, nodes.first() picks the old/duplicate node
242 | // rather than the one that was just configured in the panel.
243 > const node = clickedNode;
```

**Root cause**: Test code bug — `clickedNode` variable was never defined. Left over from PR #1011 `hasNot`→`:not()` selector refactor which removed the variable declaration but left the reference.

**Fix**: Already fixed in PR #1044 (`d7145d27f`) — replaced `clickedNode` with `nodes.first()`.

---

#### 2. `features-space-creation` — `text=Quick Actions` not visible (flaky)
**Test**: `creates space and shows tabbed dashboard layout`
**Error**: `locator('text=Quick Actions').toBeVisible()` timeout after 5s

**Root cause**: Timing/race condition — the dashboard tabbed layout loaded but "Quick Actions" text wasn't visible in time. The next CI run at commit `3885cb5` (`#23659893244`) had the same suite **pass** (5/5), confirming this is a flaky/timing issue, not a code bug.

**Status**: Flaky — no action needed; monitoring.

---

#### 3. `features-reference-autocomplete` — Worktree creation fails (no git repo)
**Tests**: `clicking a task result inserts @ref{task:…}`, `clicking a goal result inserts @ref{goal:…}`, `keyboard navigation`, `task and goal both appear`, and `does not show autocomplete for plain text input` (12+ failures with retries)

**Error** (repeating for every test):
```
[kai:daemon:worktreemanager] No .git found traversing from: /tmp/tmp.zRQ3QaHVJs
[kai:daemon:worktreemanager] createWorktree: no git root found for repoPath=/tmp/tmp.zRQ3QaHVJs
[kai:daemon:room-runtime] Failed to spawn planning group for goal <id>: Error: Worktree creation failed — task requires isolation
[kai:daemon:room-runtime] Goal <id> (Insert Goal) exceeded max planning attempts (1), marking needs_human
```

**Root cause**: The E2E test workspace path (`/tmp/tmp.*`) is not a git repository. `WorktreeManager.findGitRoot()` returns `null`, causing `createWorktree` to fail. This cascades: tasks can't be created → autocomplete results are empty → tests time out waiting for dropdown items.

**Impact**: All reference-autocomplete tests that navigate to room agent chat fail. Also triggers cascade failures in task-lifecycle (see below).

**Status**: Unresolved — this issue was already noted in the 2026-03-22 health check log. The root cause has not been addressed. Also see Root Cause 2 below.

**PR#1044 context**: PR #1044 moved `reference-autocomplete` from discover-only (No-LLM) to `LLM_TESTS` in the workflow matrix. This means it now runs in E2E LLM jobs alongside LLM-required tests. However, the underlying worktree/git-repo issue persists — the test still fails in both LLM and No-LLM matrices because task creation (via the room agent) requires isolated git worktrees.

---

#### 4. `features-task-lifecycle` — Cascade from worktree failure
**Tests**: `archives completed task and it disappears from Done tab`, `archived task appears in Archived tab, not Done tab`

**Error**:
```
TimeoutError: locator.click: Timeout 60000ms exceeded.
Call log: waiting for getByRole('button', { name: /Done/ })
```

**Root cause**: Cascade failure — the preceding test (or test setup) creates tasks via the room agent, which requires isolated git worktrees. Since the E2E workspace has no `.git`, tasks are never created → the Done tab never shows a completed task → archive assertions fail.

**Fix**: Resolves automatically when the `features-reference-autocomplete` worktree issue is fixed.

---

### Previous Failures (from #23412078420, now fixed)

| Test | Root Cause | Fix |
|---|---|---|
| `features-space-agent-centric-workflow` | `clickedNode` undefined | PR #1044 — `d7145d27f` |
| `features-task-lifecycle` (archive tests) | Archived tab removed in #1016, LiveQuery filtering | PR #1044 — `d7145d27f` |

### Unresolved Issue: Worktree/GitRepo in E2E CI

The `features-reference-autocomplete` suite and its cascade failures (`features-task-lifecycle` archive tests) both stem from the same root cause: **E2E temp workspaces lack a `.git` directory**, preventing `WorktreeManager` from creating isolated worktrees for task planning.

This was first documented in the 2026-03-22 health check log and remains unresolved.

**Options to resolve**:
1. **Test fix**: Initialize the E2E temp workspace as a git repo before running tests (e.g., `git init` in the test setup)
2. **Backend fix**: Allow task creation without git worktree isolation for non-git workspaces
3. **Skip**: Mark tests requiring task isolation as LLM-only and ensure the No-LLM matrix excludes them
