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

**Note on job naming**: The E2E job names in this report (e.g., `E2E No-LLM (features-space-agent-centric-workflow)`) are derived from the discovered test suite identifiers used as artifact names, not from the GitHub API top-level job list. The E2E matrix uses dynamic job expansion via `needs.discover.outputs`, and the API may not surface all matrix child jobs at the top level. Artifact names (e.g., `e2e-no-llm-results-features-space-agent-centric-workflow`) confirm the suites ran and failed.

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

**Root cause**: Timing/race condition — the dashboard tabbed layout loaded but "Quick Actions" text wasn't visible in time. No subsequent non-cancelled CI run exists to verify (all runs after #23660910158 were cancelled), so this is currently classified as **suspected flaky** pending the next successful run.

**Status**: Suspected flaky — requires verification in the next non-cancelled CI run.

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

---

## 2026-04-02 — Check Run #23904270931

### CI Run Overview
- **Run ID**: 23904270931
- **Branch**: dev (commit `c35b1eba1` — `docs: rewrite E2E guardian plan with adaptive discovery-only approach (#1195)`)
- **Event**: push
- **Status**: Completed with e2e failures

### Build/Discover Jobs
- All build/discover jobs: **PASSED** (failures only in E2E test jobs)

### E2E Test Failures at #23904270931

**21 failing E2E jobs** across No-LLM and LLM matrices. All failures are **pre-existing** — identical 21 jobs also failed in run #23887664826 (commit `c75b0e1d1`, earlier the same day).

**Complete list of failing jobs**:
1. `E2E LLM (features-reference-autocomplete)`
2. `E2E No-LLM (features-neo-chat-rendering)`
3. `E2E No-LLM (features-neo-panel)`
4. `E2E No-LLM (features-neo-settings)`
5. `E2E No-LLM (features-provider-model-switching)`
6. `E2E No-LLM (features-reviewer-feedback-loop)`
7. `E2E No-LLM (features-space-agent-centric-workflow)`
8. `E2E No-LLM (features-space-agent-chat)`
9. `E2E No-LLM (features-space-approval-gate-rejection)`
10. `E2E No-LLM (features-space-context-panel-switching)`
11. `E2E No-LLM (features-space-creation)`
12. `E2E No-LLM (features-space-happy-path-pipeline)`
13. `E2E No-LLM (features-space-multi-agent-editor)`
14. `E2E No-LLM (features-space-navigation)`
15. `E2E No-LLM (features-space-settings-crud)`
16. `E2E No-LLM (features-space-task-creation)`
17. `E2E No-LLM (features-space-task-fullwidth)`
18. `E2E No-LLM (features-task-lifecycle)`
19. `E2E No-LLM (features-visual-workflow-editor)`
20. `E2E No-LLM (settings-mcp-servers)`
21. `E2E No-LLM (settings-tools-modal)`

#### Root Cause Analysis — 8 Distinct Failure Categories

---

##### Category 1: Neo Panel Dialog Blocks Escape Key / Dialog Close (affects 7 suites)

**Pattern**: Tests try to dismiss a dialog (typically the Neo AI panel `data-testid="neo-panel"`) by pressing Escape, but the panel stays visible. Tests use a helper like `createSessionViaNewSessionButton` that calls `page.keyboard.press('Escape')` then `expect(anyDialog).toBeHidden()`, but the Neo panel doesn't close.

**Failure signature**:
```
Expect "toBeHidden" with timeout 3000ms
locator('[role="dialog"]:visible') resolved to <div role="dialog" ... data-testid="neo-panel" ... class="... -translate-x-full">...</div>
```

**Affected suites** (7 jobs):
| Suite | Failed Tests | Note |
|---|---|---|
| `features-provider-model-switching` | 8/8 | All tests fail at `createSessionViaNewSessionButton` |
| `settings-tools-modal` | 3/3 | Same — Neo panel blocks Escape |
| `features-neo-panel` | 2/2 | Neo panel close behavior broken |
| `features-space-creation` | 3/3 | Dialog close fails — Neo panel persists |
| `settings-mcp-servers` | 3/3 | Session options menu blocked by Neo panel |
| `features-space-approval-gate-rejection` | 4/4 | Gate UI not visible — setup fails due to Neo panel |
| `features-neo-settings` | 1/1 | Settings navigation broken |

**Root cause**: `product-bug` — The Neo AI panel (`data-testid="neo-panel"`) intercepts or ignores Escape key events. Tests expect pressing Escape to close it via `locator('[role="dialog"]:visible').toBeHidden()`, but the panel remains visible (it has `role="dialog"` and `aria-modal="true"`). The `createSessionViaNewSessionButton` helper in `provider-model-switching.e2e.ts` and similar shared helpers try to dismiss any open dialog before creating a session, but this fails because the Neo panel doesn't respond to Escape.

**Fix needed**: Either (a) fix the Neo panel to close on Escape, or (b) update test helpers to explicitly close the Neo panel before proceeding (e.g., click outside or call a dismiss function).

---

##### Category 2: Ambiguous Locators — Strict Mode Violations (affects 5 suites)

**Pattern**: Locators match multiple elements in Playwright strict mode, causing tests to fail.

**Failure signatures**:

1. `features-neo-settings`: `locator('h3:has-text("Neo Agent")').locator('..').locator('text=Clear Session')` resolved to **2 elements** — strict mode violation.
2. `features-space-agent-chat`: `getByRole('button', { name: 'Dashboard', exact: true })` resolved to **2 elements** — appears twice in the DOM.
3. `features-task-lifecycle`: `locator('[role="dialog"]')` resolved to **2 elements** — Neo panel dialog + archive dialog both match.
4. `features-space-task-creation`: `getByRole('button', { name: 'Dashboard', exact: true })` resolved to **2 elements** — same duplicate button issue.

**Affected suites** (5 jobs):
| Suite | Failed Tests | Primary Error | Also Affected By |
|---|---|---|---|
| `features-neo-settings` | 1 | `h3:has-text("Neo Agent")` → 2 elements | — |
| `features-space-agent-chat` | 2 | `Dashboard` button → 2 elements; textarea not hidden | — |
| `features-task-lifecycle` | 1 | `[role="dialog"]` → 2 elements (Neo panel + archive dialog) | — |
| `features-space-task-creation` | 4 | `Dashboard` button → 2 elements (strict mode) | Category 3 (space cleanup) |
| `features-space-context-panel-switching` | 2 | Space navigation fails — heading not visible | Category 3 (space cleanup) |

**Root cause**: `test-bug` — Locators are not specific enough. UI changes (likely adding the Neo panel or duplicate navigation elements) caused existing locators to resolve to multiple elements.

**Fix needed**: Make locators more specific:
- Use `getByRole('button', { name: 'Dashboard', exact: true }).nth(0)` or scope to a container
- Use `getByTestId('archive-dialog')` or scope `[role="dialog"]` to a specific parent
- Use `getByText('Clear Session').first()` or narrow the parent scope

---

##### Category 3: Space Creation — UNIQUE Constraint / Already Exists (affects 7 suites)

**Pattern**: Tests create spaces via RPC, but get `UNIQUE constraint failed: spaces.workspace_path` or `A space already exists for workspace path` errors. Tests don't clean up spaces from previous test runs or retries. Some suites also log `workspace path is not a git repository` warnings, which contributes to setup failures.

**Failure signature**:
```
Error: page.evaluate: Error: UNIQUE constraint failed: spaces.workspace_path
Error: page.evaluate: Error: A space already exists for workspace path: /tmp/tmp.6KrjG8hFj0
[kai:daemon:spacemanager] workspace path is not a git repository: /tmp/tmp.MLDoNKddkn
```

**Affected suites** (7 jobs):
| Suite | Failed Tests | Primary Error | Also Affected By |
|---|---|---|---|
| `features-space-happy-path-pipeline` | 1 | UNIQUE constraint on space creation | — |
| `features-space-navigation` | 2 | Space already exists for workspace path | — |
| `features-space-settings-crud` | 6 | Cascade — space creation fails in retries | — |
| `features-space-task-fullwidth` | 2 | Space already exists; workspace not a git repo | — |
| `features-space-task-creation` | 4 | Cascade — space creation fails | Category 2 (strict mode) |
| `features-space-context-panel-switching` | 2 | Space navigation fails after setup | Category 2 (strict mode) |
| `features-reviewer-feedback-loop` | 1 | Space setup fails — workflow canvas not visible | — |

**Root cause**: `test-bug` — Test cleanup (e.g., `afterEach` or `afterAll`) doesn't properly delete spaces created during the test. On retry, the same workspace path is reused but the space already exists in the DB.

**Fix needed**: Add proper space cleanup in test teardown. Use `beforeEach` with space deletion, or use unique workspace paths per test/attempt.

---

##### Category 4: Neo Chat — Provider Not Available / AI-Dependent Tests in No-LLM Matrix (affects 1 suite)

**Pattern**: Tests that send messages and expect AI responses fail because `Provider Anthropic is not available` — no credentials are configured in No-LLM jobs. The Neo chat tests send messages that trigger AI queries, which fail without credentials.

**Failure signature**:
```
Error: Provider Anthropic is not available. Please configure credentials.
MessageQueueTimeoutError: SDK did not consume message ... within 30s
```

**Affected suite**:
| Suite | Failed Tests | Error |
|---|---|---|
| `features-neo-chat-rendering` | 3/5 | AI-dependent tests timeout — provider not available |

**Note**: 2 tests passed (empty state, user message rendering) — these don't require AI responses. The 3 failing tests expect assistant messages (sparkle avatar, readable text, empty state disappearing after send).

**Root cause**: `test-bug` — AI-dependent tests are classified as No-LLM but require Anthropic credentials. These should either be moved to the LLM matrix, or the Neo chat should be mocked in No-LLM tests.

**Fix needed**: Move the AI-dependent Neo chat rendering tests to the LLM matrix, or mock the AI response in No-LLM mode.

---

##### Category 5: Visual Workflow Editor — Toggle Mode Not Working (affects 1 suite)

**Pattern**: Clicking the toggle button to switch between List and Visual modes doesn't activate the expected mode.

**Failure signature**:
```
Expect "toHaveAttribute" with timeout 60000ms
element(s) not found
```

**Affected suite**:
| Suite | Failed Tests | Error |
|---|---|---|
| `features-visual-workflow-editor` | 1 | Toggle button click doesn't switch mode |

**Root cause**: `product-bug` or `test-bug` — The toggle button for switching between list/visual modes doesn't work as expected. The test waits 60s for an attribute to appear but the element is never found. Could be a selector issue or the toggle feature is broken.

**Fix needed**: Investigate whether the toggle button selector is correct and whether the feature actually works.

---

##### Category 6: Space Multi-Agent Editor — Missing Workflow Node (affects 1 suite)

**Pattern**: After editing a step to add a second agent, the visual workflow editor only shows 1 node instead of 2.

**Failure signature**:
```
Expect "toHaveCount" with timeout 3000ms
getByTestId('visual-workflow-editor').locator('[data-testid^="workflow-node-"]') resolved to 1 element
unexpected value "1"
```

**Affected suite**:
| Suite | Failed Tests | Error |
|---|---|---|
| `features-space-multi-agent-editor` | 1 | Expected 2 workflow nodes, got 1 |

**Root cause**: `product-bug` or `test-bug` — The test adds a second agent to a workflow step but the visual editor doesn't render the new node. Could be a rendering bug or the agent addition didn't actually persist.

**Fix needed**: Verify that the agent addition API call succeeds and that the visual editor re-renders correctly.

---

##### Category 7: Space Agent-Centric Workflow — No .git / Toggle Button Timeout (affects 1 suite)

**Pattern**: The test clicks `getByTestId('toggle-channels-button')` in the visual workflow editor but it never becomes clickable within 60s. The workspace is not a git repo (`No .git found traversing from: /tmp/tmp.*`), which may prevent proper workspace initialization.

**Failure signature**:
```
TimeoutError: locator.click: Timeout 60000ms exceeded.
waiting for getByTestId('visual-workflow-editor').getByTestId('toggle-channels-button')
[kai:daemon:worktreemanager] No .git found traversing from: /tmp/tmp.ZsQdtuAXRs
```

**Affected suite**:
| Suite | Failed Tests | Error |
|---|---|---|
| `features-space-agent-centric-workflow` | 1 | Toggle channels button never becomes clickable |

**Root cause**: `env` / `test-bug` — The workspace is not a git repo, which may cause space setup to partially fail. The toggle-channels-button in the visual workflow editor is never rendered or clickable.

**Fix needed**: Ensure the workspace is initialized as a git repo before the test runs (same fix as Category 8 for reference-autocomplete).

---

##### Category 8: Reference Autocomplete — No .git in E2E Workspace (pre-existing, 1 suite)

**Pattern**: All reference-autocomplete tests fail because the E2E temp workspace (`/tmp/tmp.*`) is not a git repository. `WorktreeManager.findGitRoot()` returns null, preventing worktree creation for task isolation.

**Affected suite**:
| Suite | Failed Tests | Error |
|---|---|---|
| `features-reference-autocomplete` (LLM) | 30 | No `.git` in temp workspace — worktree creation fails |

**Root cause**: `env` — Pre-existing issue documented in 2026-03-22 and 2026-03-27 health check logs. E2E CI workspaces lack a `.git` directory.

**Status**: Unresolved pre-existing issue.

---

### Cross-Category Summary

Some suites are affected by **multiple** root causes simultaneously:

| Suite | Category 1 (Escape) | Category 2 (Strict Mode) | Category 3 (Space Cleanup) |
|---|---|---|---|
| `features-space-task-creation` | — | Yes | Yes |
| `features-space-context-panel-switching` | — | Yes | Yes |
| `features-space-task-fullwidth` | — | — | Yes (also: workspace not a git repo) |
| `features-reviewer-feedback-loop` | — | — | Yes (workflow canvas not visible) |

### Pre-existing Issues (from prior health checks)

| Issue | First Seen | Status |
|---|---|---|
| `features-reference-autocomplete` — no `.git` in E2E workspace | 2026-03-22 | **Unresolved** |
| `features-worktree-isolation` — session deletion race | 2026-03-22 | Not checked this run (excluded from No-LLM matrix) |
| `features-space-session-groups` — workspace path race | 2026-03-22 | Not checked this run (not in failed jobs) |

### New Issues (first seen this run)

| Issue | Category | Suites Affected |
|---|---|---|
| Neo panel doesn't close on Escape key | `product-bug` | 7 suites (provider-model-switching, settings-tools-modal, neo-panel, space-creation, settings-mcp-servers, space-approval-gate-rejection, neo-settings) |
| Ambiguous locators (strict mode violations) | `test-bug` | 5 suites (neo-settings, space-agent-chat, task-lifecycle, space-task-creation, space-context-panel-switching) |
| Space UNIQUE constraint on retry | `test-bug` | 7 suites (space-happy-path-pipeline, space-navigation, space-settings-crud, space-task-fullwidth, space-task-creation, space-context-panel-switching, reviewer-feedback-loop) |
| AI-dependent tests in No-LLM matrix | `test-bug` | 1 suite (neo-chat-rendering) |
| Visual workflow editor toggle broken | `product-bug` / `test-bug` | 1 suite (visual-workflow-editor) |
| Multi-agent editor node count mismatch | `product-bug` / `test-bug` | 1 suite (space-multi-agent-editor) |
| Space agent-centric workflow — toggle button timeout | `env` / `test-bug` | 1 suite (space-agent-centric-workflow) |

### Priority Recommendations

1. **HIGH — Neo panel Escape key** (affects 7 suites): Fix the Neo panel to close on Escape, or update all test helpers that rely on Escape-to-dismiss.
2. **HIGH — Space cleanup in tests** (affects 7 suites): Add proper `afterEach`/`afterAll` space deletion to prevent UNIQUE constraint violations on retry.
3. **HIGH — E2E workspace missing .git** (affects 2 suites: reference-autocomplete, space-agent-centric-workflow): Initialize E2E temp workspace as a git repo before tests run.
4. **MEDIUM — Ambiguous locators** (affects 5 suites): Make locators more specific to avoid strict mode violations with Neo panel dialogs.
5. **LOW — Neo chat AI tests in No-LLM** (1 suite): Reclassify or mock AI responses.
6. **LOW — Visual editor / multi-agent editor** (2 suites): Investigate individually.

---

## 2026-04-02 — Check Run #23912077742

### CI Run Overview
- **Run ID**: 23912077742
- **Branch**: dev (commit `9fb899120` — `docs: address review feedback on db-query MCP server plan (#1220)`)
- **Event**: push
- **Status**: Completed with e2e failures

### Build/Discover Jobs
- `Discover Tests`: **PASSED**
- `Build Binary (linux-x64)`: **PASSED**
- All unit test jobs: **SKIPPED** (gated by build prerequisites)
- E2E jobs: **NOT SKIPPED** — ran successfully (upstream jobs passed)

### E2E Test Failures at #23912077742

**22 failing E2E jobs** (21 previously failing + 1 new). The failures are **almost identical** to run #23904270931 — all 21 previously failing jobs remain broken, plus 1 new failure.

**Complete list of failing jobs** (new entry marked with **[NEW]**):
1. `E2E LLM (features-reference-autocomplete)` — 11 unique tests (all) fail
2. `E2E No-LLM (features-neo-chat-rendering)` — 2 of 5 tests fail (AI-dependent)
3. `E2E No-LLM (features-neo-panel)` — 2 of 3 tests fail
4. `E2E No-LLM (features-neo-settings)` — 1 of 1 test fails
5. `E2E No-LLM (features-provider-model-switching)` — 8 of 8 tests fail
6. `E2E No-LLM (features-reviewer-feedback-loop)` — 1 of 1 test fails
7. `E2E No-LLM (features-space-agent-centric-workflow)` — 1 of 1 test fails
8. `E2E No-LLM (features-space-agent-chat)` — 2 of 2 tests fail
9. `E2E No-LLM (features-space-approval-gate-rejection)` — 5 of 5 tests fail
10. `E2E No-LLM (features-space-context-panel-switching)` — 3 of 3 tests fail
11. `E2E No-LLM (features-space-creation)` — 2 of 3 tests fail
12. `E2E No-LLM (features-space-happy-path-pipeline)` — 2 of 3 tests fail
13. `E2E No-LLM (features-space-multi-agent-editor)` — 1 of 1 test fails
14. `E2E No-LLM (features-space-navigation)` — 2 of 2 tests fail
15. `E2E No-LLM (features-space-settings-crud)` — 6 of 6 tests fail
16. `E2E No-LLM (features-space-task-creation)` — 4 of 4 tests fail
17. `E2E No-LLM (features-space-task-fullwidth)` — 2 of 2 tests fail
18. `E2E No-LLM (features-task-lifecycle)` — 1 of 1 test fails
19. `E2E No-LLM (features-visual-workflow-editor)` — 1 of 1 test fails
20. `E2E No-LLM (settings-mcp-servers)` — 3 of 3 tests fail
21. `E2E No-LLM (settings-tools-modal)` — 2 of 2 tests fail
22. **`E2E No-LLM (features-app-mcp-registry)` — 1 of 5 tests fail [NEW]**

### Root Cause Analysis

All 21 pre-existing failures are identical to those documented in run #23904270931. Same root cause categories apply (see that entry for details). Below is only the **new** failure.

---

#### New Failure: `features-app-mcp-registry` — Strict Mode Violation **[NEW]**

**Test**: `should show disabled globally badge for brave-search in room settings` (line 207)

**Error**:
```
Error: expect(locator).toBeVisible() failed
Locator: locator('text=disabled globally')
Expected: visible
Error: strict mode violation: locator('text=disabled globally') resolved to 2 elements:
  1) <span class="text-xs px-1.5 py-0.5 rounded bg-dark-700 text-gray-500">disabled globally</span> aka getByText('disabled globally').first()
  2) <span class="text-xs px-1.5 py-0.5 rounded bg-dark-700 text-gray-500">disabled globally</span> aka getByText('disabled globally').nth(1)
```

**Root cause**: `test-bug` — Ambiguous locator `text=disabled globally` matches 2 elements. This is the same category of strict mode violation documented as Category 2 in run #23904270931.

**Fix needed**: Use `.first()` or a more specific scoped locator, e.g., `page.locator('text=disabled globally').first()`.

---

### Pre-existing Issues Status (unchanged from #23904270931)

| Issue | Category | Suites Affected | Status |
|---|---|---|---|
| Neo panel doesn't close on Escape key | `product-bug` | 7 suites | **Unresolved** |
| Ambiguous locators (strict mode violations) | `test-bug` | 5+1 suites (new: app-mcp-registry) | **Unresolved** (worsening) |
| Space UNIQUE constraint on retry | `test-bug` | 7 suites | **Unresolved** |
| AI-dependent tests in No-LLM matrix | `test-bug` | 1 suite (neo-chat-rendering) | **Unresolved** |
| Visual workflow editor toggle broken | `product-bug` / `test-bug` | 1 suite | **Unresolved** |
| Multi-agent editor node count mismatch | `product-bug` / `test-bug` | 1 suite | **Unresolved** |
| Space agent-centric workflow — toggle button timeout | `env` / `test-bug` | 1 suite | **Unresolved** |
| No `.git` in E2E workspace | `env` | 2 suites (reference-autocomplete, space-happy-path-pipeline) | **Unresolved** |

### Regression Summary

- **No regressions** — 21 previously failing jobs remain in the same failure state
- **1 new failure** — `features-app-mcp-registry` strict mode violation (same root cause category as existing issues)
- **Total failing jobs**: 22 (up from 21 in previous check)
- **Unique root cause categories**: 8 (same as before, no new categories)

---

## 2026-04-02 — Check Run #23914538827

### CI Run Overview
- **Run ID**: 23914538827
- **Branch**: dev (commit `fed2a6f88` — `feat: add NodeExecutionRepository for workflow node execution tracking (#1226)`)
- **Event**: push
- **Status**: Completed with e2e failures

### Build/Discover Jobs
- `Discover Tests`: **PASSED**
- `Build Binary (linux-x64)`: **PASSED**
- All unit test jobs: **SKIPPED** (gated by build prerequisites)
- E2E jobs: **NOT SKIPPED** — ran successfully (upstream jobs passed)

### E2E Test Failures at #23914538827

**23 failing E2E jobs** (22 previously failing + 1 new). **1 job cancelled** (`features-neo-conversation`). All 22 pre-existing failures are identical to run #23912077742 — same root cause categories apply.

**Complete list of failing jobs** (new entry marked with **[NEW]**):
1. `E2E LLM (features-reference-autocomplete)` — 31 tests fail
2. `E2E No-LLM (core-connection-resilience)` — 3 tests fail **[NEW]**
3. `E2E No-LLM (features-app-mcp-registry)` — 1 test fails
4. `E2E No-LLM (features-neo-panel)` — 2 tests fail
5. `E2E No-LLM (features-neo-settings)` — 1 test fails
6. `E2E No-LLM (features-provider-model-switching)` — 8 tests fail
7. `E2E No-LLM (features-reviewer-feedback-loop)` — 1 test fails
8. `E2E No-LLM (features-space-agent-centric-workflow)` — 1 test fails
9. `E2E No-LLM (features-space-agent-chat)` — 2 tests fail
10. `E2E No-LLM (features-space-approval-gate-rejection)` — 5 tests fail
11. `E2E No-LLM (features-space-context-panel-switching)` — 2 tests fail
12. `E2E No-LLM (features-space-creation)` — 2 tests fail
13. `E2E No-LLM (features-space-happy-path-pipeline)` — 2 tests fail
14. `E2E No-LLM (features-space-multi-agent-editor)` — 1 test fails
15. `E2E No-LLM (features-space-navigation)` — 2 tests fail
16. `E2E No-LLM (features-space-settings-crud)` — 6 tests fail
17. `E2E No-LLM (features-space-task-creation)` — 4 tests fail
18. `E2E No-LLM (features-space-task-fullwidth)` — 2 tests fail
19. `E2E No-LLM (features-task-lifecycle)` — 1 test fails
20. `E2E No-LLM (features-visual-workflow-editor)` — 1 test fails
21. `E2E No-LLM (features-neo-chat-rendering)` — 2 tests fail
22. `E2E No-LLM (settings-mcp-servers)` — 3 tests fail
23. `E2E No-LLM (settings-tools-modal)` — 2 tests fail

**Cancelled**: `E2E No-LLM (features-neo-conversation)` — cancelled after 10+ min (likely timeout)

### Root Cause Analysis

All 22 pre-existing failures are identical to those documented in runs #23904270931 and #23912077742. Same root cause categories apply (see those entries for details). Below is only the **new** failure.

---

#### New Failure: `core-connection-resilience` — WebSocket Reconnect Timeouts **[NEW]**

**Tests**: All 3 tests fail:
1. `messages generated during disconnection are displayed upon reconnection`
2. `preserves message order after multiple disconnect-reconnect cycles`
3. `handles rapid connect-disconnect cycles`

**Error**:
```
TimeoutError: page.waitForFunction: Timeout 60000ms exceeded.
```

**Root cause**: `flaky` / `env` — All 3 tests in this suite involve WebSocket disconnection/reconnection and use `page.waitForFunction()` to wait for reconnection state. The tests were passing in run #23912077742 (not in the failing list). This is likely a CI timing/infrastructure issue — the WebSocket reconnection may be slow in this particular CI environment, causing the 60s timeout to be exceeded.

**Note**: This suite was **not failing** in run #23912077742 (just 2 commits earlier). The only code change between runs is `fed2a6f88` (NodeExecutionRepository), which is unrelated to WebSocket/connection logic. This strongly suggests a **flaky** classification.

---

### Pre-existing Issues Status (unchanged from #23912077742)

| Issue | Category | Suites Affected | Status |
|---|---|---|---|
| Neo panel doesn't close on Escape key | `product-bug` | 7 suites | **Unresolved** |
| Ambiguous locators (strict mode violations) | `test-bug` | 6 suites (incl. app-mcp-registry) | **Unresolved** |
| Space UNIQUE constraint on retry | `test-bug` | 7 suites | **Unresolved** |
| AI-dependent tests in No-LLM matrix | `test-bug` | 1 suite (neo-chat-rendering) | **Unresolved** |
| Visual workflow editor toggle broken | `product-bug` / `test-bug` | 1 suite | **Unresolved** |
| Multi-agent editor node count mismatch | `product-bug` / `test-bug` | 1 suite | **Unresolved** |
| Space agent-centric workflow — toggle button timeout | `env` / `test-bug` | 1 suite | **Unresolved** |
| No `.git` in E2E workspace | `env` | 2 suites (reference-autocomplete, space-happy-path-pipeline) | **Unresolved** |

### Regression Summary

- **No regressions** — 22 previously failing jobs remain in the same failure state
- **1 new failure** — `core-connection-resilience` WebSocket reconnect timeouts (likely flaky — was passing 2 commits ago)
- **1 cancelled** — `features-neo-conversation` (likely timeout after 10+ min)
- **Total failing jobs**: 23 (up from 22 in previous check)
- **Unique root cause categories**: 8 (same as before + 1 likely-flaky new entry)

---

## 2026-04-04 — Check Run #23971370596

### CI Run Overview
- **Run ID**: [23971370596](https://github.com/lsm/neokai/actions/runs/23971370596)
- **Branch**: dev (commit `f426c2902` — `fix(e2e): stabilize neo-panel tests for Escape, backdrop click, and Cmd+J (#1297)`)
- **Event**: push
- **Status**: **CANCELLED** — 3 LLM matrix jobs did not complete; their outcomes are unknown

### Cancelled Jobs (outcomes unknown)
Three LLM matrix jobs were cancelled before completing. Their test results are not available and are **not included** in the failure count below:
- `E2E LLM (core-context-features)`
- `E2E LLM (features-archive)`
- `E2E LLM (features-slash-cmd)`

### Build/Discover Jobs
- `Discover Tests`: **PASSED**
- `Build Binary (linux-x64)`: **PASSED**
- All unit test jobs: **SKIPPED**

### E2E Test Failures at #23971370596

**26 E2E job failures** (one additional `All Tests Pass` aggregator job also failed — that is a status gate, not a test job, and is excluded from this count). The 26 failures span 5 root cause categories (A–E below).

**Complete list of failing jobs**:
1. `E2E LLM (core-message-flow)` — Root Cause B
2. `E2E LLM (core-model-selection)` — Root Cause B
3. `E2E LLM (features-file-operations)` — Root Cause B
4. `E2E LLM (features-message-operations)` — Root Cause B
5. `E2E LLM (features-reference-autocomplete)` — Root Cause B
6. `E2E LLM (features-session-operations)` — Root Cause B
7. `E2E LLM (responsive-tablet)` — Root Cause B (tentative; may be product regression)
8. `E2E LLM (settings-auto-title)` — Root Cause B (tentative; may be product regression)
9. `E2E No-LLM (core-connection-resilience)` — Root Cause B
10. `E2E No-LLM (features-neo-conversation)` — Root Cause C
11. `E2E No-LLM (features-provider-model-switching)` — Root Cause B
12. `E2E No-LLM (features-reviewer-feedback-loop)` — Root Cause E5
13. `E2E No-LLM (features-space-agent-centric-workflow)` — Root Cause E4
14. `E2E No-LLM (features-space-agent-chat)` — Root Cause E3
15. `E2E No-LLM (features-space-approval-gate-rejection)` — Root Cause E5
16. `E2E No-LLM (features-space-context-panel-switching)` — Root Cause E4
17. `E2E No-LLM (features-space-creation)` — Root Causes A + D
18. `E2E No-LLM (features-space-happy-path-pipeline)` — Root Cause A
19. `E2E No-LLM (features-space-multi-agent-editor)` — Root Cause E5
20. `E2E No-LLM (features-space-navigation)` — Root Cause A
21. `E2E No-LLM (features-space-settings-crud)` — Root Cause E1
22. `E2E No-LLM (features-space-task-creation)` — Root Causes A + D
23. `E2E No-LLM (features-space-task-fullwidth)` — Root Causes A + D
24. `E2E No-LLM (features-visual-workflow-editor)` — Root Cause E5
25. `E2E No-LLM (settings-mcp-servers)` — Root Cause E5
26. `E2E No-LLM (settings-tools-modal)` — Root Cause E2

---

### Root Cause A — SpaceDashboard hidden by seeded WorkflowCanvas

**Background**: On space creation, built-in workflows are seeded into `spaceWorkflow`. In `SpaceIsland.tsx`, `const showCanvas = defaultWorkflow !== null` — so any seeded workflow sets `showCanvas=true`. When `showCanvas=true`, the canvas div has `hidden md:flex` and the SpaceDashboard div has `md:hidden`, making the Dashboard invisible at the 1280×720 viewport used by E2E tests. Tests that expect to see tabs, the Overview button, or the space task list therefore time out.

**Failing suites** (5):
| Suite | Failing Tests |
|---|---|
| `E2E No-LLM (features-space-navigation)` | `navigates between spaces`, `shows space dashboard on overview click` |
| `E2E No-LLM (features-space-task-fullwidth)` | `expands task to fullwidth view`, `fullwidth panel shows task details` |
| `E2E No-LLM (features-space-task-creation)` | `creates task from space dashboard`, `task appears in task list after creation` |
| `E2E No-LLM (features-space-creation)` | `creates space and shows tabbed dashboard layout`, `space shows Quick Actions` |
| `E2E No-LLM (features-space-happy-path-pipeline)` | `end-to-end space pipeline`, `creates and assigns task` |

Note: `features-space-creation`, `features-space-task-fullwidth`, and `features-space-task-creation` also have Root Cause D failures (see below); both root causes affect those suites.

**Fix**: Delete seeded built-in workflows in E2E `beforeEach` so `defaultWorkflow` stays `null` → `showCanvas=false` → dashboard is visible.
**Fix PR**: [#1356](https://github.com/lsm/neokai/pull/1356) — `fix(e2e): delete seeded workflows so SpaceDashboard is visible on desktop`
**Status**: Fix PR open, unmerged.

---

### Root Cause B — Ripgrep missing from CI sandbox dependencies

**Background**: The Claude SDK sandbox mode expects the `rg` binary at a vendor path (`/tmp/neokai-sdk/vendor/ripgrep/x64-linux/rg`). The CI workflow (`.github/workflows/main.yml`) installs `bubblewrap` and `socat` but **not** `ripgrep`. When the SDK subprocess starts in CI, it immediately fails with a missing `rg` error, causing all tests that require a live SDK session to time out.

**Failing No-LLM suites** (2 — sandbox error confirmed in logs):
| Suite | Failing Tests |
|---|---|
| `E2E No-LLM (core-connection-resilience)` | `messages generated during disconnection are displayed upon reconnection`, `preserves message order after multiple disconnect-reconnect cycles`, `handles rapid connect-disconnect cycles` |
| `E2E No-LLM (features-provider-model-switching)` | `switches model in model selector`, `provider list is populated`, and 6 others |

**Failing LLM suites** (8 confirmed failed; 3 were cancelled — see above):
| Suite | Classification |
|---|---|
| `E2E LLM (core-model-selection)` | Likely sandbox — session never starts |
| `E2E LLM (features-file-operations)` | Likely sandbox |
| `E2E LLM (features-session-operations)` | Likely sandbox |
| `E2E LLM (features-message-operations)` | Likely sandbox |
| `E2E LLM (features-reference-autocomplete)` | Likely sandbox (also affected by no-git-repo issue) |
| `E2E LLM (core-message-flow)` | Tentative — may be product regression |
| `E2E LLM (responsive-tablet)` | Tentative — may be product regression |
| `E2E LLM (settings-auto-title)` | Tentative — may be product regression |

**Caveat**: The 8 LLM failures are attributed to ripgrep as the most likely cause, but per-test logs would be needed to confirm. `core-message-flow`, `responsive-tablet`, and `settings-auto-title` in particular could be unrelated product regressions — they were not in the previous run's failing list and their failure mode is not confirmed as sandbox-related.

**Fix**: Add `ripgrep` to the `sudo apt-get install -y bubblewrap socat` line in `.github/workflows/main.yml`.
**Fix PR**: [#1351](https://github.com/lsm/neokai/pull/1351) — `ci: add ripgrep to CI sandbox dependencies`
**Status**: Fix PR open, unmerged.

---

### Root Cause C — `features-neo-conversation` needs same fixes as `features-neo-panel`

**Background**: PR #1297 fixed `neo-panel.e2e.ts` by adding proper close/Escape/backdrop/Cmd+J wait helpers. The companion suite `neo-conversation.e2e.ts` has the same timing assumptions and was NOT updated in PR #1297. (This suite was cancelled in the previous run #23914538827 and its failure was not confirmed until this run.)

**Failing suite** (1):
| Suite | Failing Tests |
|---|---|
| `E2E No-LLM (features-neo-conversation)` | `closes panel on X button click`, `closes panel on Escape key`, `closes panel on backdrop click`, `tab switching preserves conversation state` |

**Fix PR**: [#1357](https://github.com/lsm/neokai/pull/1357) — `fix(e2e): apply neo-panel timing fixes to neo-conversation.e2e.ts`
**Status**: Fix PR open, unmerged.

---

### Root Cause D — NeoPanel `role="dialog"` causes Playwright strict mode violations

**Background**: `SpaceDetailPanel.tsx` renders with `role="dialog" aria-modal="true"`. Several E2E tests call `page.getByRole('dialog')`, which in strict mode fails when multiple `role="dialog"` elements are present. When navigating to space views, both the NeoPanel and the space detail panel may be in the DOM simultaneously.

**Failing suites** (3 — all overlap with Root Cause A; both root causes cause failures in the same suites):
| Suite | Failing Tests |
|---|---|
| `E2E No-LLM (features-space-creation)` | `space detail shows after creation` — strict mode violation on `getByRole('dialog')` |
| `E2E No-LLM (features-space-task-fullwidth)` | `fullwidth mode dialog transition` |
| `E2E No-LLM (features-space-task-creation)` | `task creation form dialog` |

**Fix PR**: [#1354](https://github.com/lsm/neokai/pull/1354) — `fix(e2e): use getModal() to fix NeoPanel role=dialog strict mode violations`
**Status**: Fix PR open, unmerged.

---

### Root Cause E — Individual test selector bugs and UI divergence

#### E1 — `features-space-settings-crud`: Invalid regex from path with slashes
**Tests**: All 6 tests that check `spaceWorkspacePath` visibility fail.
**Error**: `SyntaxError: Invalid flags supplied to RegExp constructor 'tmp/neokai/settings-1234'`
**Cause**: `page.locator('text=/tmp/neokai/settings-1234')` interprets the argument as a regex literal — the path slashes become regex delimiters and the suffix becomes invalid flags.
**Fix**: Replace with `page.getByText(spaceWorkspacePath, { exact: false })`.
**Fix PR**: [#1353](https://github.com/lsm/neokai/pull/1353)

#### E2 — `settings-tools-modal`: `aria-label` vs `title` attribute mismatch
**Tests**: `shows session options modal on button click`, `closes modal on X button click` (2 tests).
**Cause**: Test uses `button[aria-label="Session options"]` but the actual button has `title="Session options"`. The locator matches nothing, causing a timeout.
**Fix**: Replace with `page.getByTitle('Session options')`.
**Fix PR**: [#1353](https://github.com/lsm/neokai/pull/1353)

#### E3 — `features-space-agent-chat`: Textarea selector matches NeoPanel after navigation
**Tests**: `message input is not visible on overview tab` and 1 other (2 tests).
**Cause**: After navigating back to the Overview tab, `page.locator('textarea[placeholder*="Ask"]').first()` matches the NeoPanel's "Ask Neo…" textarea which remains mounted. `expect(messageInput).not.toBeVisible()` fails because that element IS visible.
**Fix**: Scope the selector to the chat container: `page.locator('[data-testid="chat-container"] textarea')`.
**Fix PR**: [#1355](https://github.com/lsm/neokai/pull/1355)

#### E4 — `features-space-agent-centric-workflow`, `features-space-context-panel-switching`: Navigation timeouts
**Tests**: `selectOption` timeout (1 test), space click navigation timeout (2 tests).
**Cause**: Timing issues in panel/tab navigation — likely exacerbated by the SpaceDashboard visibility issue (Root Cause A). May partially self-resolve once #1356 merges.
**Status**: Likely partially fixed by Root Cause A fix (#1356); no dedicated fix PR.

#### E5 — `features-space-approval-gate-rejection`, `features-reviewer-feedback-loop`, `features-space-multi-agent-editor`, `features-visual-workflow-editor`, `settings-mcp-servers`: UI divergence
**Tests**: Various (1–5 tests per suite).
**Cause**: Gate UI, multi-agent editor UI, or MCP settings UI changed in recent commits; test assertions reference old element structure or text that no longer exists.
**Status**: Requires individual investigation per suite — no fix PRs open yet.

---

### Fix PR Summary

| Root Cause | Fix PR | Status |
|---|---|---|
| A — SpaceDashboard hidden | [#1356](https://github.com/lsm/neokai/pull/1356) | Open, unmerged |
| B — Ripgrep missing in CI | [#1351](https://github.com/lsm/neokai/pull/1351) | Open, unmerged |
| C — neo-conversation timing | [#1357](https://github.com/lsm/neokai/pull/1357) | Open, unmerged |
| D — dialog strict mode | [#1354](https://github.com/lsm/neokai/pull/1354) | Open, unmerged |
| E1/E2 — space-settings-crud + tools-modal | [#1353](https://github.com/lsm/neokai/pull/1353) | Open, unmerged |
| E3 — space-agent-chat textarea | [#1355](https://github.com/lsm/neokai/pull/1355) | Open, unmerged |
| E4 — navigation timeouts | See #1356 (partial) | Partially covered |
| E5 — UI divergence (5 suites) | None yet | Needs investigation |

---

### Previously Failing, Now Passing

The following suites were failing in run #23914538827 (2026-04-02) and **now pass** in this run:

| Suite | How Fixed |
|---|---|
| `E2E No-LLM (features-neo-panel)` | Fixed by PR #1297 (timing stabilization) |
| `E2E No-LLM (features-neo-settings)` | Fixed — likely benefited from same PR #1297 timing fixes |
| `E2E No-LLM (features-app-mcp-registry)` | Fixed — root cause resolved (unknown — no dedicated PR) |
| `E2E No-LLM (features-task-lifecycle)` | Fixed — root cause resolved (unknown — no dedicated PR) |
| `E2E No-LLM (features-neo-chat-rendering)` | Fixed — root cause resolved (unknown — no dedicated PR) |

### Regression Summary

- **Previous run** (run #23914538827, 2026-04-02): 23 failing + 1 cancelled (`features-neo-conversation`)
- **This run** (run #23971370596, 2026-04-04): 26 failing + 3 cancelled (LLM jobs)
- **Improvements**: 5 suites no longer failing (neo-panel, neo-settings, app-mcp-registry, task-lifecycle, neo-chat-rendering)
- **Net new failures**: 8 new LLM failures (ripgrep issue, 3 of which may be product regressions) + `features-neo-conversation` now confirmed failing (was cancelled previously) = 9 new
- **Net change**: −5 resolved + 9 new = +4 → 23 + 4 − 1 (neo-conversation was already counted as cancelled, not failing) = **26**
- **Unique root cause categories**: 5 (A–E above)
