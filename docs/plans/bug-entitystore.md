# Plan: Unified State Management — Eliminate Dual-Channel Bug and Implement EntityStore Architecture

## Goal Summary

Fix a real-time state update bug where the task detail view does not update when the Runtime
autonomously transitions a task to `in_progress`. Then refactor the frontend state management to
eliminate the dual-channel pattern (LiveQuery + `room.task.update` events) by introducing a
generic `EntityStore<T>` class that makes LiveQuery the single authoritative update channel for
all entity types.

> **Scope note — Inbox Approve fix is explicitly out of scope.**
> The goal title references only the dual-channel bug and EntityStore architecture. There is no
> "Inbox Approve 修复" requirement in the goal description. If a separate Inbox Approve fix is
> needed it must be filed as a distinct goal.

## Root Cause

`useTaskViewData` fetches the task once on mount and then listens to `room.task.update` events
for subsequent updates. When the Runtime autonomously starts a task it calls
`taskManager.setTaskStatus()` which triggers `reactiveDb.notifyChange('tasks')` → LiveQuery
delta → `roomStore.tasks` signal updates. However `emitTaskUpdate()` is NOT called from the
runtime path, so `useTaskViewData`'s `room.task.update` listener never fires and the detail view
stays stale until a manual page refresh.

The fix (Phase 1) is surgical: make `useTaskViewData` derive the task from `roomStore.tasks`
instead of keeping its own independent copy fetched via `task.get`. This eliminates the
dependency on `room.task.update` events entirely for the task object.

The refactor (Phase 2) extracts the repeated snapshot/delta handling boilerplate from
`room-store.ts` into a reusable `EntityStore<T>` class so that future entities do not reproduce
the same pattern.

Phase 3 cleans up the now-redundant server-side `emitTaskUpdate` / `emitRoomOverview` calls.

## Approach

### Phase 1 — P0 Bug Fix (useTaskViewData reads from roomStore.tasks)

`useTaskViewData` currently fetches the task independently via `task.get` RPC and updates it
only through `room.task.update` events. The fix changes it to read `task` directly from the
already-live `roomStore.tasks` signal using a `computed` or `useComputed` derived signal keyed
by `taskId`. The group and session data are still fetched via RPC (unchanged). The
`room.task.update` listener for the task object is removed.

### Phase 2 — EntityStore<T> Implementation

Extract the repeated LiveQuery subscription pattern (snapshot handler, delta handler,
reconnect re-subscribe, unsubscribe on leave, stale-event guard) into a generic class:

```typescript
class EntityStore<T extends { id: string }> {
  readonly items = signal<Map<string, T>>(new Map());
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  applySnapshot(rows: T[]): void
  applyDelta(delta: LQDelta<T>): void
  getById(id: string): T | undefined
  toArray(): T[]
}
```

`RoomStore` replaces its `tasks = signal<TaskSummary[]>([])` and `goals = signal<RoomGoal[]>([])`
signals with `EntityStore` instances. The existing computed signals (`pendingTasks`, `activeTasks`,
etc.) are updated to call `toArray()` or read from the Map directly. The `subscribeRoom` method
delegates snapshot/delta events to the appropriate `EntityStore`.

### Phase 3 — Server-side Cleanup

Remove the now-unnecessary `emitTaskUpdate` helper and all its call sites from `task-handlers.ts`.
Remove `emitRoomOverview` from handlers where it fires only to propagate task data (the
`room.overview` event path still serves room + session data, so calls that are strictly needed
for session-list refresh can remain or be evaluated case-by-case).

---

## Tasks

---

### Task 1 — P0 Fix: useTaskViewData reads task from roomStore.tasks signal

**Agent type:** coder

**Description:**
Change `useTaskViewData` to derive the `task` object from `roomStore.tasks` instead of fetching
it independently via `task.get` and then listening to `room.task.update`. This makes the task
detail view automatically reactive to LiveQuery deltas that already update `roomStore.tasks`.

**Subtasks (ordered implementation steps):**
1. **Fix the `roomStore.tasks` type annotation.** Inspect `TASKS_BY_ROOM_SQL` in
   `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` — it selects all `NeoTask`
   fields (`description`, `result`, `inputDraft`, `createdAt`, `startedAt`, `completedAt`,
   `taskType`, `assignedAgent`, `createdByTaskId`, `archivedAt`, `activeSession`, `prUrl`,
   `prNumber`, `prCreatedAt`, `shortId`). The signal is currently typed `signal<TaskSummary[]>`
   which is narrower than the actual payload. Change it to `signal<NeoTask[]>` in
   `packages/web/src/lib/room-store.ts`. This makes the type accurate and eliminates any need
   for unsafe casts downstream.
2. In `packages/web/src/hooks/useTaskViewData.ts`, import `useComputed` from `@preact/signals`
   and `roomStore` (already imported).
3. Replace the `useState<NeoTask | null>` for `task` and the `task.get` RPC call inside `load()`
   with a `useComputed` hook that derives `task` from `roomStore.tasks`:
   ```typescript
   // Inside the hook body — useComputed creates a stable computed with automatic cleanup:
   const task = useComputed(() =>
     roomStore.tasks.value.find((t) => t.id === taskId) ?? null
   );
   ```
   Use `task.value` to read the current task in the hook body and in the return value.
   Note: do NOT use bare `computed()` inside a hook — it creates a new computed signal on every
   render without cleanup. Always use `useComputed` from `@preact/signals` inside hook bodies.
4. Remove the `setTask` state setter and its usage in `load()`.
5. Remove the `room.task.update` event listener (`unsubTaskUpdate`) from the `useEffect`. Keep
   the `session.updated` listener (it handles model label updates, not task state).
6. Simplify `load()` to only fetch the group (`fetchGroup()`) — no longer needs `task.get`.
   Keep the `isLoading` state but scope it to the group fetch.
7. Re-evaluate `isLoading`: the task data is now immediately available from the store; loading
   only applies to the group/session fetch. Update the hook's loading semantics accordingly.
8. Update `useTaskViewData.test.ts`:
   - Remove test cases that assert `room.task.update` drives task state.
   - Add test cases asserting the task is derived from `roomStore.tasks.value`.
   - Mock `roomStore.tasks` as a signal with `{ value: [mockTask] }` where `mockTask`
     is typed as `NeoTask`.

**Acceptance criteria:**
- When Runtime autonomously starts a task (`pending` → `in_progress`), the task detail page
  reflects the new status without a page refresh.
- Task list and task detail views always show consistent status.
- `roomStore.tasks` is typed `signal<NeoTask[]>` (not `TaskSummary[]`).
- `room.task.update` is no longer subscribed to in `useTaskViewData`.
- No `as NeoTask[]` or similar unsafe casts exist in the hook.
- All existing unit tests in `useTaskViewData.test.ts` pass (updated as needed).
- TypeScript build is clean (`bun run typecheck`).

**Dependencies:** none

**Branch / PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2 — Implement EntityStore<T> generic class

**Agent type:** coder

**Description:**
Create `packages/web/src/lib/entity-store.ts` implementing the `EntityStore<T>` generic class
that encapsulates the snapshot/delta application logic currently duplicated for tasks, goals,
and skills in `room-store.ts`. This is a pure addition — it does not modify any existing files.

**Subtasks (ordered implementation steps):**
1. Create `packages/web/src/lib/entity-store.ts`.
2. Implement `EntityStore<T extends { id: string }>` with:
   - `readonly items = signal<Map<string, T>>(new Map())` — keyed by entity ID.
   - `readonly loading = signal(false)`.
   - `readonly error = signal<string | null>(null)`.
   - `applySnapshot(rows: T[]): void` — replaces the entire Map, sets `loading = false`.
   - `applyDelta(delta: { added?: T[]; removed?: T[]; updated?: T[] }): void` — applies
     incremental changes to the Map (delete removed IDs, set updated and added).
   - `getById(id: string): T | undefined` — convenience accessor.
   - `toArray(): T[]` — returns `Array.from(this.items.value.values())` for computed signals
     that need ordered iteration.
   - `clear(): void` — empties the store (called on room switch).
3. Export `EntityStore` from `entity-store.ts`.
4. Write unit tests in `packages/web/src/lib/__tests__/entity-store.test.ts` covering:
   - `applySnapshot` populates items correctly.
   - `applyDelta` with `added` inserts items.
   - `applyDelta` with `removed` deletes items.
   - `applyDelta` with `updated` merges items.
   - `clear` empties items.
   - `getById` returns the correct item or undefined.
   - `toArray` returns all values.
   - Signal reactivity: a computed that reads `items.value` re-evaluates after `applyDelta`.

**Acceptance criteria:**
- `packages/web/src/lib/entity-store.ts` exists and exports `EntityStore<T>`.
- All unit tests pass (`cd packages/web && bunx vitest run src/lib/__tests__/entity-store.test.ts`).
- TypeScript build is clean.

**Dependencies:** Task 1 (establish feature branch baseline)

**Branch / PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3 — Migrate RoomStore tasks and goals to EntityStore

**Agent type:** coder

**Description:**
Replace the `tasks = signal<TaskSummary[]>([])` and `goals = signal<RoomGoal[]>([])` raw
signals in `RoomStore` with `EntityStore` instances, and update `subscribeRoom` to delegate
snapshot/delta application to the stores. Update all computed signals and consumers to use
the new API.

**Subtasks (ordered implementation steps):**
1. In `packages/web/src/lib/room-store.ts`:
   a. Import `EntityStore` from `./entity-store`.
   b. Replace `readonly tasks = signal<TaskSummary[]>([])` with
      `readonly taskStore = new EntityStore<TaskSummary>()`.
   c. Replace `readonly goals = signal<RoomGoal[]>([])` with
      `readonly goalStore = new EntityStore<RoomGoal>()`.
   d. Keep `tasks` and `goals` as `computed` pass-through getters so existing consumers
      outside `room-store.ts` continue to work without changes:
      ```typescript
      readonly tasks = computed(() => this.taskStore.toArray());
      readonly goals = computed(() => this.goalStore.toArray());
      ```
      This is a non-breaking migration — all existing computed signals (`pendingTasks`,
      `activeTasks`, `tasksByGoalId`, etc.) continue to read from `.tasks.value`.
   e. In `subscribeRoom`: replace the inline snapshot/delta handlers for tasks with calls to
      `this.taskStore.applySnapshot(event.rows as TaskSummary[])` and
      `this.taskStore.applyDelta(event)`. Remove the toast side-effect from the delta handler
      only if it's cleanly separable; otherwise keep it as a wrapper around `applyDelta`.
   f. In `subscribeRoom`: same migration for goals — replace inline handlers with
      `this.goalStore.applySnapshot` / `this.goalStore.applyDelta`.
   g. In `doSelect` (room switch): replace `this.tasks.value = []` / `this.goals.value = []`
      with `this.taskStore.clear()` / `this.goalStore.clear()`.
   h. Replace `this.goalsLoading.value` assignments with `this.goalStore.loading.value` (or
      keep the separate signal if the loading semantics differ — evaluate case by case).
2. Update `tasksByGoalId` and `goalByTaskId` computed signals to read from
   `this.tasks.value` (unchanged — they already read from the computed getter).
3. Verify that `useTaskViewData` (Task 1) still works: it reads from `roomStore.tasks.value`
   which now comes from the `EntityStore`-backed computed signal.
4. Update `room-store-tasks-live-query.test.ts` and `room-store-review.test.ts` if they
   reference the internal `tasks`/`goals` signal shape — ensure they still pass.

**Acceptance criteria:**
- `roomStore.tasks.value` and `roomStore.goals.value` return arrays as before (no consumer
  breakage).
- `subscribeRoom` delegates snapshot/delta to `EntityStore` methods.
- All existing room-store tests pass.
- TypeScript build is clean.
- The toast side-effect on task status transitions (review / rate_limited / usage_limited)
  is preserved.

**Dependencies:** Task 2

**Branch / PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4 — (Optional) Migrate roomSkills to EntityStore

**Agent type:** coder

**Description:**
Apply the same `EntityStore` migration to `roomSkills` in `RoomStore`, following the same
pattern as Task 3. This is lower priority (skills updates are infrequent and the dual-channel
bug does not affect skills) but completes the architectural unification.

**Subtasks (ordered implementation steps):**
1. Replace `readonly roomSkills = signal<EffectiveRoomSkill[]>([])` with
   `readonly skillStore = new EntityStore<EffectiveRoomSkill>()`.
2. Add `readonly roomSkills = computed(() => this.skillStore.toArray())` pass-through getter.
3. In `subscribeRoom`: delegate skills snapshot/delta to `this.skillStore.applySnapshot` /
   `this.skillStore.applyDelta`.
4. In `doSelect`: call `this.skillStore.clear()`.
5. Run all room-store tests to verify no regressions.

**Acceptance criteria:**
- `roomStore.roomSkills.value` continues to return the correct array.
- `subscribeRoom`'s skills block is simplified to `EntityStore` calls.
- All existing tests pass.
- TypeScript build is clean.

**Dependencies:** Task 3

**Branch / PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5 — Server-side cleanup: remove emitTaskUpdate and redundant emitRoomOverview

**Agent type:** coder

**Description:**
Now that `useTaskViewData` no longer listens to `room.task.update` and `roomStore.tasks` is
driven exclusively by LiveQuery, the `emitTaskUpdate` helper and its call sites in
`task-handlers.ts` are redundant. Remove them. Also remove `emitRoomOverview` calls that
were only needed to propagate task list state (the room overview is still used for room
metadata + session list, so retain calls that serve those purposes).

**Subtasks (ordered implementation steps):**
1. In `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`:

   **a. Remove `emitTaskUpdate` entirely** — delete the helper function (lines ~67–80) and every
   call site listed below. All these handlers mutate tasks via `taskManager` which triggers
   `reactiveDb.notifyChange('tasks')` → LiveQuery → `roomStore.tasks` signal. The dedicated
   event is therefore redundant.

   | Handler | Lines (approx) | Action |
   |---------|----------------|--------|
   | `task.cancel` — with runtime path | ~265 | Remove `emitTaskUpdate` |
   | `task.cancel` — no-runtime path | ~274 | Remove `emitTaskUpdate` |
   | `task.archive` — direct archive | ~363 | Remove `emitTaskUpdate` |
   | `task.setStatus` — archive branch | ~426 | Remove `emitTaskUpdate` |
   | `task.setStatus` — cancel with runtime | ~452 | Remove `emitTaskUpdate` |
   | `task.setStatus` — apply status change | ~510 | Remove `emitTaskUpdate` |
   | `task.sendHumanMessage` — after routing | ~1121 | Remove `emitTaskUpdate` |

   **b. Enumerate and decide each `emitRoomOverview` call site.** The `room.overview` event
   carries `room`, `sessions`, and task arrays. Since task arrays are now delivered exclusively
   via LiveQuery, the only valid reason to keep an `emitRoomOverview` call is if the handler
   also changes the **session list** or **room metadata** (which the session/room LiveQuery may
   not yet propagate promptly).

   | Handler | Lines (approx) | Verdict | Rationale |
   |---------|----------------|---------|-----------|
   | `task.create` | ~125 | **REMOVE** | New task does not create a session; LiveQuery covers it |
   | `task.fail` | ~225 | **REMOVE** | Fails a task only; no session/room change |
   | `task.cancel` — with runtime | ~266 | **KEEP temporarily** | Runtime may terminate a session group; session list changes |
   | `task.cancel` — no-runtime | ~275 | **REMOVE** | No session involved |
   | `task.archive` | ~364 | **REMOVE** | No session change |
   | `task.setStatus` — archive branch | ~427 | **REMOVE** | No session change |
   | `task.setStatus` — cancel with runtime | ~453 | **KEEP temporarily** | Runtime cancels active session group |
   | `task.setStatus` — apply status | ~511 | **REMOVE** | Pure status change; LiveQuery covers task data |
   | `session_group.stop` | ~1155 | **KEEP temporarily** | Force-stops a session; session list changes |

   "Keep temporarily" calls should add a `// TODO: remove once session LiveQuery covers list` comment.

   **c.** Remove the `emitRoomOverview` helper definition only if all call sites are removed;
   otherwise leave it in place with remaining callers.

2. Verify that the daemon still compiles: `cd packages/daemon && bun build main.ts --target bun`.
3. Check for any existing daemon unit tests that assert `room.task.update` is emitted — remove
   those assertions (the event is no longer emitted from task-handlers).
4. Run `bun run lint` and fix any unused-variable warnings from the removed helpers.

**Acceptance criteria:**
- `emitTaskUpdate` is fully removed from `task-handlers.ts`.
- `emitRoomOverview` call sites that were only needed for task propagation are removed.
- TypeScript and lint checks are clean.
- No daemon unit tests assert `room.task.update` emission (update or remove such assertions).
- Existing E2E tests continue to pass (task status changes are reflected in the UI via
  LiveQuery without the removed events).

**Dependencies:** Task 1, Task 3 (consumers must be migrated before removing the emitter)

**Branch / PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6 — Integration verification and test coverage

**Agent type:** coder

**Description:**
Add a focused integration test that verifies the end-to-end fix: when `notifyChange('tasks')`
fires (simulating the Runtime path), `roomStore.tasks` updates and `useTaskViewData` returns
the new task state — without any `room.task.update` event being emitted.

**Subtasks (ordered implementation steps):**
1. In `packages/web/src/lib/__tests__/room-store-tasks-live-query.test.ts`, add a test:
   "task derived from LiveQuery reflects status change without room.task.update event":
   - Set up `roomStore` with a subscribed room and a snapshot containing a `pending` task.
   - Fire a `liveQuery.delta` event updating the task to `in_progress`.
   - Assert `roomStore.tasks.value` contains the updated task.
   - Assert no `room.task.update` handler is needed (i.e., no such event was fired in the
     test, yet the task state is correct).
2. In `packages/web/src/hooks/__tests__/useTaskViewData.test.ts`, add a test:
   "task updates reactively when roomStore.tasks signal changes":
   - Initialize the hook with `roomStore.tasks.value` containing a task with status `pending`.
   - Update `roomStore.tasks.value` to reflect status `in_progress`.
   - Assert the hook returns the updated task status without a `room.task.update` event.
3. Run the full web test suite to confirm no regressions:
   `cd packages/web && bunx vitest run`.

**Acceptance criteria:**
- New tests pass and document the fixed behavior.
- Full web test suite passes with no regressions.
- TypeScript build is clean.

**Dependencies:** Task 1, Task 3

**Branch / PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Acceptance Criteria (System-Level)

- [ ] Task autonomously started by Runtime (`pending` → `in_progress`) is reflected in the
      task detail page in real time without a page refresh.
- [ ] Task list and task detail always show the same status.
- [ ] After WebSocket reconnect, task state is correctly restored via LiveQuery re-subscribe.
- [ ] All existing E2E tests pass.
- [ ] All existing web unit tests pass.
- [ ] TypeScript build and lint are clean across all packages.

## Key Files

- `packages/web/src/hooks/useTaskViewData.ts` — primary fix target (Task 1)
- `packages/web/src/hooks/__tests__/useTaskViewData.test.ts` — test update (Tasks 1, 6)
- `packages/web/src/lib/entity-store.ts` — new file (Task 2)
- `packages/web/src/lib/__tests__/entity-store.test.ts` — new test file (Task 2)
- `packages/web/src/lib/room-store.ts` — EntityStore migration (Tasks 3, 4)
- `packages/web/src/lib/__tests__/room-store-tasks-live-query.test.ts` — test update (Tasks 3, 6)
- `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` — server cleanup (Task 5)
- `packages/daemon/src/lib/room/managers/task-manager.ts` — reference only (no changes needed)
- `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` — reference only (no changes needed)
