# Milestone 3: Conditional LiveQuery Subscriptions

## Goal

Make goals and skills LiveQuery subscriptions conditional on the active tab, so data is only fetched and kept in sync when the user is actually viewing it. Tasks LiveQuery remains always-on (needed by overview dashboard, tasks tab, and goals editor).

## Pre-Implementation: Goals Data Consumer Audit

**Before implementing conditional subscriptions, the implementer must audit all consumers of goals data across the room UI.** Specifically:

1. Search for all reads of `goalStore` / `roomStore.goalStore` / `goals.value` across `packages/web/src/`.
2. Identify any component that reads goals data and renders **outside** the goals tab.
3. Known consumers to check:
   - `RoomDashboard.tsx` — currently shows a "Create a mission to get started" prompt. Verify whether it reads goals data to conditionally show this, or whether it's a static prompt.
   - `TaskHeader.tsx` — has a goal badge click handler. Check if it reads goal data to render badges, or just navigates.
   - `RoomContextPanel.tsx` — may show goal summaries or counts.
4. **If any non-goals-tab component reads goals data for rendering:** either (a) keep goals always-on (remove it from conditional subscriptions), or (b) extract the specific data need into a lightweight separate query.
5. **If the audit confirms goals data is only consumed on the goals tab:** proceed with conditional subscription as planned.

This audit is a **prerequisite** for Task 6 and must be documented in the PR description.

## Scope

Primary files: `packages/web/src/lib/room-store.ts`, `packages/web/src/hooks/useRoomLiveQuery.ts`, and their test files.

---

### Task 5: Split room-store subscribeRoom into per-query methods

**Description:** Refactor the monolithic `subscribeRoom` method into separate per-query subscription methods so that goals and skills subscriptions can be managed independently of the always-on tasks subscription.

**Subtasks:**

1. Add three new methods to the room store class:
   - `subscribeRoomTasks(roomId: string): Promise<void>` -- subscribes to `tasks.byRoom` LiveQuery only
   - `subscribeRoomGoals(roomId: string): Promise<void>` -- subscribes to `goals.byRoom` LiveQuery only
   - `subscribeRoomSkills(roomId: string): Promise<void>` -- subscribes to `skills.byRoom` LiveQuery only

   Each method should follow the same pattern as the current `subscribeRoom` but for a single query:
   - Guard against double-subscription using a per-query key (e.g., `tasks-${roomId}`, `goals-${roomId}`, `skills-${roomId}`) in `liveQueryActive`
   - Register snapshot and delta event handlers before sending the subscribe request
   - Handle reconnect (re-subscribe on `onConnection('connected')`)
   - Track cleanup functions in `liveQueryCleanups` keyed by the per-query key
   - Maintain the stale-event guard pattern with `activeSubscriptionIds`

2. Add three corresponding unsubscribe methods:
   - `unsubscribeRoomTasks(roomId: string): void`
   - `unsubscribeRoomGoals(roomId: string): void`
   - `unsubscribeRoomSkills(roomId: string): void`

   Each clears its per-query key from `liveQueryActive`, `activeSubscriptionIds`, and runs its cleanup functions from `liveQueryCleanups`.

3. Rewrite the existing `subscribeRoom(roomId)` to call all three new methods (preserving backward compatibility for any callers). Similarly, `unsubscribeRoom(roomId)` should call all three unsubscribe methods.

4. Preserve the existing `goalStore.loading` management: set `goalStore.loading.value = true` at the start of `subscribeRoomGoals`, clear it on snapshot arrival or error.

5. Add unit tests for the new per-query methods in `packages/web/src/hooks/__tests__/useRoomLiveQuery.test.ts` or a new test file `packages/web/src/lib/__tests__/room-store-livequery.test.ts`:
   - Verify that subscribing to goals only sends the `goals.byRoom` LiveQuery subscribe request
   - Verify that unsubscribing from goals does not affect the tasks subscription
   - Verify that the stale-event guard works per-query (unsubscribe goals, then simulate a stale goals snapshot -- should be discarded)

**Acceptance Criteria:**

- `subscribeRoomTasks`, `subscribeRoomGoals`, `subscribeRoomSkills` can be called independently
- Unsubscribing one query does not affect the others
- The existing `subscribeRoom`/`unsubscribeRoom` still work as before (calls all three)
- No regressions in existing room-store tests
- `cd packages/web && bunx vitest run` passes

**Dependencies:** None (can be done in parallel with Milestone 2, but Milestone 2 must land first for the hook changes in Task 6)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6: Make useRoomLiveQuery tab-aware

**Description:** Update the `useRoomLiveQuery` hook to subscribe to tasks always, but subscribe to goals only when the active tab is `'goals'` and skills only when the active tab is `'agents'` or `'settings'`.

**Subtasks:**

1. Import `currentRoomActiveTabSignal` in `useRoomLiveQuery.ts`.

2. Change the hook to accept the active tab as a **parameter** (not read from signal inside the hook). This is important for Preact Signals reactivity: reading `currentRoomActiveTabSignal.value` inside a `useEffect` dependency array will NOT automatically re-run when the signal changes — Preact signals only trigger re-renders in component render functions or `useSignalEffect`. By passing `activeTab` as a prop from Room.tsx (which reads the signal in render context and thus re-renders on signal change), the `useEffect` dependency array correctly triggers on tab changes.

   Recommended signature change:
   ```ts
   export function useRoomLiveQuery(roomId: string, activeTab: string | null): void
   ```

   **Alternative approach:** Use `useSignalEffect` from `@preact/signals` instead of `useEffect` for the tab-dependent subscription effects. This would allow reading `currentRoomActiveTabSignal.value` directly inside the effect. However, the parameter approach is simpler and keeps the hook framework-agnostic.

3. In the hook body, manage three separate `useEffect` blocks:
   - **Tasks** (`[roomId]` dependency): always subscribe/unsubscribe via `roomStore.subscribeRoomTasks(roomId)` / `roomStore.unsubscribeRoomTasks(roomId)`.
   - **Goals** (`[roomId, activeTab]` dependency): subscribe via `roomStore.subscribeRoomGoals(roomId)` only when `activeTab === 'goals'`. Unsubscribe when tab changes away or on unmount.
   - **Skills** (`[roomId, activeTab]` dependency): subscribe via `roomStore.subscribeRoomSkills(roomId)` only when `activeTab === 'agents' || activeTab === 'settings'`. Unsubscribe when tab changes away or on unmount. **Scope note:** `RoomAgents` renders agent configurations (needs skills data), and `RoomSettings` contains `RoomSkillsSettings` as a sub-section. Both tabs need skills data, so subscribing on both `'agents'` and `'settings'` is correct. While settings has sub-sections that don't need skills, the simpler approach of subscribing for the entire settings tab is acceptable — the data payload is small.

4. Update the call site in Room.tsx to pass the active tab:
   ```ts
   useRoomLiveQuery(roomId, currentRoomActiveTabSignal.value ?? 'overview');
   ```

5. Handle edge cases:
   - When the user navigates directly to `/room/:id/goals`, the hook mounts with `activeTab === 'goals'` and subscribes to goals immediately.
   - When switching from goals to tasks tab, goals subscription is torn down, tasks continues.
   - When switching from tasks to goals, goals subscription starts fresh (snapshot will be pushed).
   - The goals LiveQuery snapshot handler already manages `goalStore.loading`, so switching tabs shows a brief loading state while the snapshot arrives.

6. Update `packages/web/src/hooks/__tests__/useRoomLiveQuery.test.ts`:
   - Test that mounting with `activeTab='overview'` only subscribes to tasks
   - Test that changing `activeTab` to `'goals'` triggers goals subscription
   - Test that changing `activeTab` away from `'goals'` triggers goals unsubscription
   - Test that tasks subscription persists across tab changes

**Acceptance Criteria:**

- On room entry (overview tab), only `tasks.byRoom` LiveQuery is subscribed
- Switching to goals tab triggers `goals.byRoom` subscription; switching away tears it down
- Switching to agents or settings tab triggers `skills.byRoom` subscription; switching away tears it down
- Tasks LiveQuery stays active regardless of tab
- No stale data: when goals tab is re-entered, a fresh snapshot is received
- `cd packages/web && bunx vitest run` passes

**Dependencies:** Task 5 (needs per-query subscribe/unsubscribe methods), Task 3 (Room.tsx must pass activeTab from signal)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
