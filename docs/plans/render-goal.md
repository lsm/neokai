# Plan: Render Goal

## Goal Summary

Display the room's active mission(s) in the UI so users can always see the current goal title, type,
autonomy level, and status without navigating to the Missions tab. The feature has two surfaces:

1. A **Mission Summary banner** in `RoomDashboard` (the Overview tab) — shows all active goals with
   their key metadata and a "View Missions" shortcut link.
2. Enhanced **sidebar goal rows** in `RoomContextPanel` — add type and autonomy-level badges next to
   each goal's title/status dot.

Both surfaces reuse the same badge sub-components, which are extracted from `GoalsEditor.tsx` into a
new shared file `MissionBadges.tsx` to avoid code duplication and satisfy the Knip dead-export check.

## Approach

- Extract `StatusIndicator`, `MissionTypeBadge`, and `AutonomyBadge` from `GoalsEditor.tsx` into
  `packages/web/src/components/room/MissionBadges.tsx` and re-export them through
  `packages/web/src/components/room/index.ts`.
- Update `GoalsEditor.tsx` to import from `MissionBadges.tsx` (no behavioral change).
- Add a `MissionSummary` sub-component inside `RoomDashboard.tsx` that reads
  `roomStore.activeGoals.value` and renders a compact card for each active goal.
- Enhance the sidebar goal rows in `RoomContextPanel.tsx` to show the mission type badge and
  autonomy indicator inline.

All changes are purely additive UI work; no backend changes are needed.

---

## Tasks

### Task 1 — Extract shared mission badge components

**Description:**
Move the three badge sub-components out of `GoalsEditor.tsx` and into a new dedicated file so they
can be consumed by both the dashboard and the sidebar without duplicating code.

**Subtasks (ordered):**

1. Create `packages/web/src/components/room/MissionBadges.tsx`.
   Export `StatusIndicator`, `MissionTypeBadge`, and `AutonomyBadge` as named exports. Copy the
   existing implementations verbatim from `GoalsEditor.tsx` (lines ~136–208), keeping the `cn`
   import from `../../lib/utils` and the Preact automatic JSX runtime.
2. In `GoalsEditor.tsx`, replace the three inline component definitions with imports from
   `./MissionBadges`. Verify no behavioral changes.
3. Add the three exports to `packages/web/src/components/room/index.ts` with `@public` comments,
   so Knip treats them as live exports.
4. Run `bun run typecheck` and `bun run lint` to confirm no type errors or lint violations.

**Acceptance criteria:**
- `MissionBadges.tsx` exists and exports `StatusIndicator`, `MissionTypeBadge`, `AutonomyBadge`.
- `GoalsEditor.tsx` no longer defines those components inline; it imports them.
- `index.ts` re-exports all three.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** none

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2 — Add Mission Summary panel to RoomDashboard (Overview tab)

**Description:**
Insert a "Missions" section at the top of the Overview tab dashboard so users immediately see active
goals when they open a room.

**Subtasks (ordered):**

1. In `RoomDashboard.tsx`, import `StatusIndicator`, `MissionTypeBadge`, `AutonomyBadge` from
   `./MissionBadges` (created in Task 1).
2. Read `roomStore.activeGoals.value` at the top of the `RoomDashboard` function body.
3. Add a `MissionSummary` sub-component (local to the file) that receives `goals: RoomGoal[]` and
   renders:
   - A section heading "Active Missions" with a "View all" button that sets
     `currentRoomTabSignal.value = 'goals'`.
   - One compact card per goal showing: title (truncated, full text in `title` attribute),
     `StatusIndicator`, `MissionTypeBadge` (when `goal.missionType` is present), and `AutonomyBadge`
     (when `goal.autonomyLevel` is present).
   - A progress bar using `goal.progress` (0–100) when `goal.progress > 0`.
   - An empty state message "No active missions" when `goals.length === 0`.
4. Place the `<MissionSummary>` component above the Runtime state card, at the very top of the
   dashboard's `<div class="p-4 space-y-6">`.
5. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- The Overview tab shows an "Active Missions" section.
- Each active goal displays title, status indicator, mission type badge (when set), and autonomy
  badge (when set).
- Progress bar renders when `goal.progress > 0`.
- "View all" / "No active missions" empty state work correctly.
- No console errors; typecheck and lint pass.

**Dependencies:** Task 1

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3 — Enhance sidebar goal rows with type and autonomy badges

**Description:**
The sidebar `RoomContextPanel` already lists active goals but only shows the title and a color dot.
Enhance each goal row to also show the mission type and autonomy level, making the sidebar
information-dense without becoming cluttered.

**Subtasks (ordered):**

1. In `RoomContextPanel.tsx`, import `MissionTypeBadge` and `AutonomyBadge` from
   `../components/room/MissionBadges`.
2. Inside the `activeGoals.map(...)` block (around line 313), update the goal `<button>` row to
   add `MissionTypeBadge` and `AutonomyBadge` after the goal title span, wrapped in a
   `flex items-center gap-1` container. Show `MissionTypeBadge` only when `goal.missionType` is
   defined; show `AutonomyBadge` only when `goal.autonomyLevel` is defined.
   Keep the existing expand/collapse arrow and status dot unchanged.
3. Constrain badge font size to `text-[10px]` or use the existing badge styles (already `text-xs`)
   so rows remain compact at the sidebar's typical ~200 px width.
4. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- Each active goal row in the sidebar shows the mission type badge (when set) and autonomy badge
  (when set) alongside the existing title and status dot.
- Expand/collapse behavior is unchanged.
- Sidebar layout does not overflow or wrap awkwardly on narrow viewports.
- Typecheck and lint pass.

**Dependencies:** Task 1

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4 — Vitest unit tests for MissionBadges and MissionSummary

**Description:**
Add lightweight unit tests to cover the new shared badge components and the dashboard's mission
summary rendering.

**Subtasks (ordered):**

1. Create `packages/web/src/components/room/MissionBadges.test.tsx`.
   Test that `StatusIndicator`, `MissionTypeBadge`, and `AutonomyBadge` render expected text/class
   content for each valid input variant using `@testing-library/preact` (or the project's existing
   Vitest+jsdom setup).
2. Create `packages/web/src/components/room/RoomDashboard.test.tsx` (or extend if it already
   exists). Mock `roomStore.activeGoals` signal to return a list of fake goals and assert:
   - "Active Missions" heading is present.
   - Goal title text is rendered.
   - Empty state "No active missions" renders when the list is empty.
3. Run `make test-web` to confirm all web tests pass.

**Acceptance criteria:**
- Both test files exist and all tests pass under `make test-web`.
- Coverage includes all three badge variants and empty/non-empty mission summary states.

**Dependencies:** Task 1, Task 2

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
