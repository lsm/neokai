# Milestone 3 — Daemon Cleanup & Frontend Tasks/Goals Migration

**Agent:** coder
**Depends on:** Milestone 2

## Overview

This milestone has two phases:
1. Remove the one redundant `emitTaskUpdate` from `task.fail` (validates the LiveQuery pipeline works)
2. Atomically remove daemon-side goal broadcasts AND replace frontend event listeners with LiveQuery

The atomic approach for goals prevents any regression window where goal updates go undelivered.

---

## Task 3.1 — Remove `emitTaskUpdate` from `task.fail` RPC handler

**Agent:** coder

After Milestones 1–2, every task write triggers `notifyChange` → LiveQuery delta → `sendToClient`.
The `emitTaskUpdate()` in `task.fail` is now redundant.

- [ ] Remove the `emitTaskUpdate()` call from `task.fail` handler in `task-handlers.ts`
  (search for `emitTaskUpdate` inside the `task.fail` handler block)
- [ ] Verify `task.create` does NOT call `emitTaskUpdate()` — no change needed there
- [ ] **Keep `emitRoomOverview()` calls** — `room.overview` is the only path for room/session
  metadata; removing it would break the frontend
- [ ] Integration test: RPC `task.fail` no longer produces handler-layer `room.task.update` event
- [ ] Test: `room.overview` still fires from `task-handlers.ts` after task writes
- [ ] Test: `liveQuery.delta` reaches a subscribed client after `task.fail` writes
- [ ] Test: `goal.created`, `goal.updated`, `goal.progressUpdated` still fire from `goal-handlers.ts`

**Why only `task.fail`:** The remaining seven `emitTaskUpdate` calls (`task.cancel` ×2,
`task.archive`, `task.setStatus` ×3, `task.sendHumanMessage`) are preserved because the frontend still
relies on `room.task.update` via `hub.onEvent` until Task 3.3 replaces it. Removing all handler
emits now would make task mutations invisible to the UI.

**Acceptance criteria:**
- `emitTaskUpdate()` removed from `task.fail` only; no other task-handler emit sites changed
- `room.overview` continues to be emitted
- Goal-handler emits unchanged
- Runtime/tool-layer `room.task.update` emits untouched; scheduling continues to work

---

## Task 3.2 — Remove daemon-side goal broadcasts from `goal-handlers.ts`

**Agent:** coder

Remove goal event emits that are superseded by LiveQuery delta delivery. This is merged atomically
with Task 3.3 (same PR) to avoid a regression window.

- [ ] Remove all **eight** `emitGoalUpdated()` call sites (search for `emitGoalUpdated(` in the file):
  1. `goal.update` handler
  2. `goal.needsHuman` handler
  3. `goal.reactivate` handler
  4. `goal.linkTask` handler (also remove paired `emitGoalProgressUpdated`)
  5. `goal.delete` handler
  6. `goal.setSchedule` handler
  7. `goal.pauseSchedule` handler
  8. `goal.resumeSchedule` handler
- [ ] Remove all remaining `emitGoalProgressUpdated` calls
- [ ] Verify `goal.completed` is never actually emitted (defined in `daemon-hub.ts` but unused)
- [ ] **Keep `goal.created` emits** — `room-runtime-service.ts` subscribes to `goal.created` on
  `daemonHub` to trigger scheduling. Removing would break goal-creation scheduling.

**Acceptance criteria:**
- All eight `emitGoalUpdated` call sites removed
- `goal.created` emit preserved
- Goal updates now delivered exclusively via LiveQuery delta

---

## Task 3.3 — Replace frontend task/goal event listeners with LiveQuery subscriptions

**Agent:** coder

Replace the one-shot RPC + manual event listener pattern in `room-store.ts` with LiveQuery.

**Remove these event listeners/writes from `room-store.ts`:**
- [ ] Remove `hub.onEvent('room.task.update', ...)` listener
- [ ] Remove goal event listeners (search for `hub.onEvent('goal.`):
  `goal.created`, `goal.updated`, `goal.completed`
- [ ] Remove `this.tasks.value` assignment from `hub.onEvent('room.overview', ...)` callback
  (keep the listener itself for `room.value` and `sessions.value`)
- [ ] Remove `this.tasks.value` population from `fetchInitialState`
  (keep the `room.get` RPC call for `room.value` and `sessions.value`)
- [ ] Remove optimistic `this.tasks.value = [...this.tasks.value, task]` append after `task.create`
  RPC response (search for this pattern in `room-store.ts`)
- [ ] Remove `this.goals.value = response.goals ?? []` from `fetchGoals()`; simplify or remove
  `fetchGoals()` call-sites in `createGoal`, `updateGoal`, `deleteGoal`, `linkTaskToGoal`

**Add LiveQuery subscription management to `room-store.ts`:**
- [ ] Add `subscribeRoom(roomId)` method:
  call `liveQuery.subscribe` with `tasks.byRoom` and `goals.byRoom`
- [ ] Add `unsubscribeRoom(roomId)` method:
  call `liveQuery.unsubscribe` for both subscriptions
- [ ] Handle `liveQuery.snapshot`: replace `this.tasks.value` / `this.goals.value` entirely
  (with stale-subscriptionId guard)
- [ ] Handle `liveQuery.delta`: apply `added`/`removed`/`updated` arrays
  (with stale-subscriptionId guard)
- [ ] **Task-state ownership:** LiveQuery is the sole data writer to `tasks.value` and `goals.value`
  (lifecycle resets to `[]` on room deselect are permitted)

**Acceptance criteria:**
- LiveQuery snapshot/delta are the sole data writers to task and goal signals
- No other code path overwrites task or goal signals after migration
- Goal progress updates now surface in UI (were previously silently dropped)

---

## Task 3.4 — Implement review-status toast in LiveQuery delta handler

**Agent:** coder

The old `room.task.update` handler showed a toast when a task transitioned to `review`. This must
be reimplemented in the delta handler.

- [ ] In the `liveQuery.delta` `updated` array processing, detect tasks transitioning to `review`:
  ```ts
  // Only show toast if task was already known AND previous status was not 'review'
  if (updatedTask.status === 'review' && existingTask && existingTask.status !== 'review') {
    toast.info(`Task ready for review: ${updatedTask.title}`);
  }
  ```
- [ ] **Hydration guard:** Do NOT fire toasts during initial snapshot or reconnect resync
- [ ] Rewrite all five existing toast test cases in `room-store-review.test.ts` to drive the
  `liveQuery.snapshot`/`liveQuery.delta` path (retain test coverage, change mechanism)

**Acceptance criteria:**
- Toast fires on task → review transition via LiveQuery delta
- Toast suppressed during snapshot hydration and reconnect resync
- All five existing toast test cases passing with new mechanism

---

## Task 3.5 — Create `useRoomLiveQuery` hook and integrate with `Room.tsx`

**Agent:** coder

- [ ] Create `packages/web/src/hooks/useRoomLiveQuery.ts` as a lifecycle adapter hook:
  - On mount: call `roomStore.subscribeRoom(roomId)`
  - On `roomId` change: call `roomStore.unsubscribeRoom(oldRoomId)` then
    `roomStore.subscribeRoom(newRoomId)`
  - On unmount: call `roomStore.unsubscribeRoom(roomId)`
- [ ] Mount `useRoomLiveQuery` inside `Room.tsx` (or a direct unconditionally-rendered child)
- [ ] `roomStore.select()` must NOT call `liveQuery.subscribe` internally (hook's responsibility)
- [ ] No double-subscription: hook calls store methods; store owns handles
- [ ] Vitest tests for the hook lifecycle

**Acceptance criteria:**
- Hook manages subscription lifecycle correctly
- No double-subscription on room selection
- Clean unsubscribe on unmount

---

## Task 3.6 — Implement reconnect and stale-event guards

**Agent:** coder

- [ ] **Reconnect re-subscribe:** After WebSocket reconnect (general `connected` state transition
  via `hub.onConnection`), re-issue `liveQuery.subscribe` for the active room
  - Do NOT call `liveQuery.unsubscribe` before re-subscribing (old handles disposed server-side)
- [ ] **Room switch unsubscribe:** Call `liveQuery.unsubscribe` on old room when switching rooms
  while connected
- [ ] **Stale-event guard:** Track current active `subscriptionId` per query; discard any
  snapshot or delta whose `subscriptionId` doesn't match (guards against rapid room switching)
- [ ] **Connection flap safety:** Server-side `subscriptionId` collision semantics (silent replace)
  make rapid reconnects safe; client-side stale guard handles race conditions

**Acceptance criteria:**
- After reconnect, subscriptions re-established and snapshot resyncs state
- After room switch, task list reflects only the new room's tasks within one render cycle
- Stale snapshots and deltas from prior rooms are discarded

---

## Task 3.7 — E2E tests for LiveQuery task/goal updates

**Agent:** coder

- [ ] E2E test: task created by agent appears in room UI without page reload
- [ ] E2E test: switching rooms shows only the new room's tasks within one render cycle
- [ ] Goal deletion surfaces in UI via LiveQuery `removed` array

**Acceptance criteria:**
- All E2E tests pass
- All Vitest tests pass

---

## Post-milestone note: known dead code after Milestone 3

### Remaining `emitTaskUpdate` calls in `task-handlers.ts`

After Task 3.3 removes the frontend `room.task.update` listener, the seven remaining
`emitTaskUpdate()` calls in `task-handlers.ts` (`task.cancel` ×2, `task.archive`,
`task.setStatus` ×3, `task.sendHumanMessage`) become dead code from the frontend's perspective.
They are **intentionally retained** because `room-runtime-service.ts` subscribes to
`room.task.update` on `daemonHub` to drive `scheduleTick()`. A follow-up task can audit and remove
these after confirming runtime-layer coverage is complete.

### `goal.progressUpdated` daemon-side emissions

After Milestone 3, `goal.progressUpdated` is emitted from `room-runtime.ts` (~3 sites) and
`room-agent-tools.ts` (~1 site) via `daemonHub`, but no frontend consumer exists (there was never
a `goal.progressUpdated` listener in `room-store.ts`; progress updates now surface via the
`goals.byRoom` LiveQuery since `progress` is a stored column). These emissions are **intentionally
out of scope** for this plan — they flow through `daemonHub` harmlessly and may serve future
internal subscribers. A follow-up task can remove them if no internal consumer is added.

### `state-manager.ts` event bridge entries

`packages/daemon/src/lib/state-manager.ts` has bridge listeners for `goal.updated`,
`goal.progressUpdated`, and `goal.completed` that forward these events to `messageHub`. After
Milestones 3–4 remove all frontend consumers for these events, these bridge entries become dead
code. They are **intentionally out of scope** for the same reason — harmless overhead in a
single-user deployment. A follow-up cleanup pass can remove them alongside the `emitTaskUpdate`
audit above.
