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

**22 failing E2E jobs** across No-LLM and LLM matrices. All failures are **pre-existing** — identical 22 jobs also failed in run #23887664826 (commit `c75b0e1d1`, earlier the same day).

#### Root Cause Analysis — 7 Distinct Failure Categories

---

##### Category 1: Neo Panel Dialog Blocks Escape Key / Dialog Close (affects 8 suites)

**Pattern**: Tests try to dismiss a dialog (typically the Neo AI panel `data-testid="neo-panel"`) by pressing Escape, but the panel stays visible. Tests use a helper like `createSessionViaNewSessionButton` that calls `page.keyboard.press('Escape')` then `expect(anyDialog).toBeHidden()`, but the Neo panel doesn't close.

**Failure signature**:
```
Expect "toBeHidden" with timeout 3000ms
locator('[role="dialog"]:visible') resolved to <div role="dialog" ... data-testid="neo-panel" ... class="... -translate-x-full">...</div>
```

**Affected suites** (8 jobs):
| Suite | Failed Tests | Note |
|---|---|---|
| `features-provider-model-switching` | 8/8 | All tests fail at `createSessionViaNewSessionButton` |
| `settings-tools-modal` | 3/3 | Same — Neo panel blocks Escape |
| `features-neo-panel` | 2/2 | Neo panel close behavior broken |
| `features-space-creation` | 3/3 | Dialog close fails — Neo panel persists |
| `features-mcp-servers` | 3/3 | Session options menu blocked by Neo panel |
| `features-space-approval-gate-rejection` | 4/4 | Gate UI not visible — setup fails due to Neo panel |
| `features-neo-settings` | 1/1 | Settings navigation broken |
| `features-task-lifecycle` | 1/1 | Archive dialog can't open (strict mode — 2 dialogs) |

**Root cause**: `product-bug` — The Neo AI panel (`data-testid="neo-panel"`) intercepts or ignores Escape key events. Tests expect pressing Escape to close it via `locator('[role="dialog"]:visible').toBeHidden()`, but the panel remains visible (it has `role="dialog"` and `aria-modal="true"`). The `createSessionViaNewSessionButton` helper in `provider-model-switching.e2e.ts` and similar shared helpers try to dismiss any open dialog before creating a session, but this fails because the Neo panel doesn't respond to Escape.

**Fix needed**: Either (a) fix the Neo panel to close on Escape, or (b) update test helpers to explicitly close the Neo panel before proceeding (e.g., click outside or call a dismiss function).

---

##### Category 2: Ambiguous Locators — Strict Mode Violations (affects 4 suites)

**Pattern**: Locators match multiple elements in Playwright strict mode, causing tests to fail.

**Failure signatures**:

1. `neo-settings`: `locator('h3:has-text("Neo Agent")').locator('..').locator('text=Clear Session')` resolved to **2 elements** — strict mode violation.
2. `space-agent-chat`: `getByRole('button', { name: 'Dashboard', exact: true })` resolved to **2 elements** — appears twice in the DOM.
3. `task-lifecycle`: `locator('[role="dialog"]')` resolved to **2 elements** — Neo panel dialog + archive dialog both match.

**Affected suites** (4 jobs):
| Suite | Failed Tests | Error |
|---|---|---|
| `features-neo-settings` | 1 | `h3:has-text("Neo Agent")` locator → 2 elements |
| `features-space-agent-chat` | 2 | `Dashboard` button → 2 elements; textarea still visible |
| `features-task-lifecycle` | 1 | `[role="dialog"]` → 2 elements (Neo panel + archive dialog) |

**Root cause**: `test-bug` — Locators are not specific enough. UI changes (likely adding the Neo panel or duplicate navigation elements) caused existing locators to resolve to multiple elements.

**Fix needed**: Make locators more specific:
- Use `getByRole('button', { name: 'Dashboard', exact: true }).nth(0)` or scope to a container
- Use `getByTestId('archive-dialog')` or scope `[role="dialog"]` to a specific parent
- Use `getByText('Clear Session').first()` or narrow the parent scope

---

##### Category 3: Space Creation — UNIQUE Constraint / Already Exists (affects 5 suites)

**Pattern**: Tests create spaces via RPC, but get `UNIQUE constraint failed: spaces.workspace_path` or `A space already exists for workspace path` errors. Tests don't clean up spaces from previous test runs or retries.

**Failure signature**:
```
Error: page.evaluate: Error: UNIQUE constraint failed: spaces.workspace_path
Error: page.evaluate: Error: A space already exists for workspace path: /tmp/tmp.6KrjG8hFj0
```

**Affected suites** (5 jobs):
| Suite | Failed Tests | Error |
|---|---|---|
| `features-space-happy-path-pipeline` | 1 | UNIQUE constraint on space creation |
| `features-space-navigation` | 2 | Space already exists for workspace path |
| `features-space-settings-crud` | 6 | Cascade — space creation fails in retries |
| `features-space-task-creation` | 4 | Cascade — space creation fails |
| `features-space-context-panel-switching` | 2 | Space list or navigation fails |

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

##### Category 7: Reference Autocomplete — No .git in E2E Workspace (pre-existing, 1 suite)

**Pattern**: All reference-autocomplete tests fail because the E2E temp workspace (`/tmp/tmp.*`) is not a git repository. `WorktreeManager.findGitRoot()` returns null, preventing worktree creation for task isolation.

**Affected suite**:
| Suite | Failed Tests | Error |
|---|---|---|
| `features-reference-autocomplete` (LLM) | 30 | No `.git` in temp workspace — worktree creation fails |

**Root cause**: `env` — Pre-existing issue documented in 2026-03-22 and 2026-03-27 health check logs. E2E CI workspaces lack a `.git` directory.

**Status**: Unresolved pre-existing issue.

---

### Pre-existing Issues (from prior health checks)

| Issue | First Seen | Status |
|---|---|---|
| `features-reference-autocomplete` — no `.git` in E2E workspace | 2026-03-22 | **Unresolved** |
| `features-worktree-isolation` — session deletion race | 2026-03-22 | Not checked this run (excluded from No-LLM matrix) |
| `features-space-session-groups` — workspace path race | 2026-03-22 | Not checked this run (not in failed jobs) |

### New Issues (first seen this run)

| Issue | Category | Suites Affected |
|---|---|---|
| Neo panel doesn't close on Escape key | `product-bug` | 8 suites (provider-model-switching, settings-tools-modal, neo-panel, space-creation, mcp-servers, space-approval-gate-rejection, neo-settings, task-lifecycle) |
| Ambiguous locators (strict mode violations) | `test-bug` | 4 suites (neo-settings, space-agent-chat, task-lifecycle, space-context-panel-switching) |
| Space UNIQUE constraint on retry | `test-bug` | 5 suites (space-happy-path-pipeline, space-navigation, space-settings-crud, space-task-creation, space-context-panel-switching) |
| AI-dependent tests in No-LLM matrix | `test-bug` | 1 suite (neo-chat-rendering) |
| Visual workflow editor toggle broken | `product-bug` / `test-bug` | 1 suite (visual-workflow-editor) |
| Multi-agent editor node count mismatch | `product-bug` / `test-bug` | 1 suite (space-multi-agent-editor) |

### Priority Recommendations

1. **HIGH — Neo panel Escape key** (affects 8 suites): Fix the Neo panel to close on Escape, or update all test helpers that rely on Escape-to-dismiss.
2. **HIGH — Space cleanup in tests** (affects 5 suites): Add proper `afterEach`/`afterAll` space deletion to prevent UNIQUE constraint violations on retry.
3. **MEDIUM — Ambiguous locators** (affects 4 suites): Make locators more specific to avoid strict mode violations with Neo panel dialogs.
4. **LOW — Neo chat AI tests in No-LLM** (1 suite): Reclassify or mock AI responses.
5. **LOW — Visual editor / multi-agent editor** (2 suites): Investigate individually.
