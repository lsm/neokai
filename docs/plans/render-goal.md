# Plan: Render Goal (Active Mission in Chat Interface)

## Summary

Display the active mission (room goal) in the NeoKai chat interface so users can see what the current goal/mission is while chatting. The goal should appear as a collapsible banner below the `ChatHeader` in `ChatContainer`, visible whenever the chat session belongs to a room that has one or more active goals.

## Approach

All the required data is already available reactively. `roomStore.activeGoals` is a `computed()` signal populated when a room is selected. `ChatContainer` already derives `roomId` from `session?.context?.roomId`. The work is:

1. Build a small read-only `ActiveMissionBanner` component.
2. Import `roomStore` into `ChatContainer`, derive the active goal(s) for the current room, and render the banner between the header and the messages list.
3. Add a `data-testid` for the banner so it can be targeted in tests.

No new RPC handlers, no new store methods, and no backend changes are needed.

---

## Tasks

### Task 1: Build `ActiveMissionBanner` component

**Agent type**: coder

**Description**

Create a new read-only display component `packages/web/src/components/ActiveMissionBanner.tsx` that renders the active mission title and, optionally, the description. The banner should:

- Accept a list of `RoomGoal[]` as a prop (so the parent controls which goals to pass).
- Render nothing when the list is empty.
- Show the first active goal prominently (title + truncated description if present).
- If more than one active goal exists, show a secondary line like "+N more missions".
- Include a link/button that navigates to the Missions tab (`currentRoomTabSignal.value = 'goals'`) so the user can see the full list.
- Be collapsible: a small chevron toggles the description line open/closed. State is local (`useState`).
- Use the existing design tokens (`borderColors`, Tailwind dark palette) consistent with `ChatHeader`.

**Subtasks**

1. Create `packages/web/src/components/ActiveMissionBanner.tsx`.
2. Define `ActiveMissionBannerProps`: `goals: RoomGoal[]` (required). No optional styling overrides needed.
3. Return `null` when `goals.length === 0`.
4. Render a styled bar (e.g., `bg-dark-850/50 border-b border-{borderColor}`) with:
   - A small target/flag icon on the left.
   - The primary goal title as bold text, truncated with `title` tooltip.
   - A truncated description line (collapsed by default, toggled by a chevron).
   - If `goals.length > 1`, render `+{goals.length - 1} more` as a muted pill.
   - A "View missions" text button that sets `currentRoomTabSignal.value = 'goals'`.
5. Add `data-testid="active-mission-banner"` to the outer container.
6. Add `data-testid="active-mission-title"` to the title span.

**Acceptance criteria**

- Component renders nothing when passed an empty array.
- Component renders the first goal's title when passed one active goal.
- "+N more" text appears when more than one goal is passed.
- Clicking "View missions" sets `currentRoomTabSignal.value = 'goals'`.
- The description is hidden by default and toggled by the chevron.
- No TypeScript errors (`bun run typecheck` passes).
- No lint errors (`bun run lint` passes).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies**: none

---

### Task 2: Integrate `ActiveMissionBanner` into `ChatContainer`

**Agent type**: coder

**Description**

Modify `packages/web/src/islands/ChatContainer.tsx` to import `roomStore` and render `ActiveMissionBanner` between the `ChatHeader` and the messages area. The banner should only appear when the session belongs to a room (i.e., `roomContext` is defined) and that room has at least one active goal.

**Subtasks**

1. Add `import { roomStore } from '../lib/room-store.ts';` to `ChatContainer.tsx`.
2. Add `import { ActiveMissionBanner } from '../components/ActiveMissionBanner.tsx';` to `ChatContainer.tsx`.
3. Derive `activeGoals` using `useComputed` (component-local, garbage-collectable):
   ```ts
   const activeGoals = useComputed(() => {
     const roomId = session?.context?.roomId;
     if (!roomId || roomStore.roomId.value !== roomId) return [];
     return roomStore.activeGoals.value;
   });
   ```
   Note: `roomStore.roomId.value !== roomId` guards against stale data when the store is pointing to a different room (e.g., a standalone session view outside a room).
4. In the JSX return, insert `<ActiveMissionBanner goals={activeGoals.value} />` immediately after the `<ChatHeader ... />` element and before the messages `<div class="flex-1 relative min-h-0">`.
5. Ensure no TypeScript or lint errors are introduced.

**Acceptance criteria**

- Banner does not appear in standalone (non-room) sessions.
- Banner does not appear in room sessions with no active goals.
- Banner appears in room sessions with one or more active goals.
- The `activeGoals` computation does not cause unnecessary re-renders (uses `useComputed`, not `useMemo`, for signal-based derivation).
- `bun run typecheck` passes.
- `bun run lint` passes.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies**: Task 1

---

### Task 3: Unit tests for `ActiveMissionBanner`

**Agent type**: coder

**Description**

Add Vitest unit tests for the `ActiveMissionBanner` component in `packages/web/src/components/ActiveMissionBanner.test.tsx`.

**Subtasks**

1. Create `packages/web/src/components/ActiveMissionBanner.test.tsx`.
2. Mock `currentRoomTabSignal` from `../lib/signals` so navigation side-effects are testable without a full app.
3. Write test cases:
   - Renders nothing when passed an empty array.
   - Renders the goal title when passed one active goal.
   - Renders "+1 more" when passed two active goals.
   - Clicking "View missions" sets `currentRoomTabSignal.value` to `'goals'`.
   - Description is hidden by default.
   - Clicking the chevron toggles description visibility.
4. Run `make test-web` and confirm all tests pass.

**Acceptance criteria**

- All 6 test cases pass under `make test-web`.
- No TypeScript errors in the test file.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies**: Task 1

---

## Notes

- The `roomStore.roomId` guard in Task 2 ensures the banner does not show stale goal data if `ChatContainer` is rendered for a session that belongs to a different room than the one currently selected in `roomStore`. In practice, within `Room.tsx` the room is always selected before the chat is opened, so `roomStore.roomId.value === roomId` is expected to be true whenever the banner would be visible.
- If the product decision is to show the banner only for the room agent chat (`room:chat:{roomId}` session IDs) and not for worker sessions inside a room, add a check `sessionId.startsWith('room:chat:')` alongside the `roomContext` guard in `ChatContainer`. This is a product scoping decision to be made by the implementing agent.
- Do not re-use `GoalsEditor` for this feature; it is a full CRUD UI and not appropriate as a read-only display.
