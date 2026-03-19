# Milestone 06 — Room and Lobby

## Milestone Goal

Apply the complete design system to the higher-level page views: the Lobby homepage, Room dashboard, Room tab navigation, and the GoalsEditor. These are the surfaces users see when not in an active chat session. They should reflect the Mono no aware principle — functional, composed, and complete without being overloaded.

## Milestone Scope

- Lobby homepage: Recent Sessions grid and Room Grid visual refresh
- Room tab navigation: Replace raw `<button>` tab bar with a proper `TabBar` component
- Room dashboard (`RoomDashboard.tsx`): Card-based layout with clear hierarchy
- `GoalsEditor.tsx`: Mission list and metric progress bar polish
- Error/loading states: Consistent empty states using the design system

---

## Task 6.1 — Lobby Homepage Visual Refresh

**Agent type:** coder

**Description:**
The `Lobby.tsx` homepage has two content areas: "Recent Sessions" and "Rooms". The Recent Sessions grid uses `bg-dark-800 hover:bg-dark-750` cards — but `dark-750` is not in the design system. Room Grid cards (in `RoomGrid.tsx`) have a separate style. This task unifies the card style and improves the lobby header and empty states.

**Subtasks (in order):**
1. Read `packages/web/src/islands/Lobby.tsx` and `packages/web/src/components/lobby/RoomGrid.tsx`.
2. Fix `hover:bg-dark-750` in Recent Sessions cards: replace with `hover:bg-dark-700` (the defined step).
3. Unify card style across both Recent Sessions and Room Grid:
   - Card background: `bg-dark-800 border border-dark-700 rounded-xl hover:border-dark-600 transition-colors duration-150`
   - Remove any `hover:bg-dark-750` or `bg-dark-850` from card components.
4. In the Lobby header, replace the two-button group (New Session + Create Room) with a single primary action button "New Session" and a smaller text link "or Create Room" to reduce cognitive load. On mobile, keep icon buttons.
5. Add section labels using the token typography: `text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3` for "Recent Sessions" and "Rooms" headings.
6. Read `packages/web/src/components/lobby/GlobalStatus.tsx` (if it exists). If it shows running agent counts, ensure the status indicators use the `tokens.color.status.success` green dot with `animate-pulse-slow` for actively running agents.
7. Empty state for Rooms (when `rooms.length === 0`): display a centered box with a building icon, "No rooms yet", and a "Create your first room" button. Style: `flex flex-col items-center justify-center py-16 text-center`.
8. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- No `dark-750` color references remain
- Cards use `rounded-xl bg-dark-800 border-dark-700`
- Lobby header has single primary CTA
- Section headings use small-caps label style
- Empty state for Rooms renders correctly

**Depends on:** Milestone 02, Milestone 03

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6.2 — Room Tab Navigation Refactor

**Agent type:** coder

**Description:**
The Room page (`Room.tsx`) currently uses a manual tab bar implemented with five raw `<button>` elements inside a `flex border-b` wrapper. Each button applies conditional classes for active/inactive state. This is fragile, non-reusable, and violates the component library principle. This task extracts a proper `TabBar` component and replaces the Room tab implementation.

**Subtasks (in order):**
1. Create `packages/web/src/components/ui/TabBar.tsx`:
   - Interface:
     ```ts
     interface Tab { id: string; label: string; }
     interface TabBarProps { tabs: Tab[]; activeTab: string; onChange: (id: string) => void; }
     ```
   - Visual design: `flex border-b border-dark-700 bg-dark-900`
   - Each tab button: `px-4 py-2 text-sm font-medium transition-colors`
   - Active: `text-indigo-400 border-b-2 border-indigo-500` (indigo, not blue)
   - Inactive: `text-gray-400 hover:text-gray-200 border-b-2 border-transparent`
   - Use `transition-colors duration-150` on the text color change.
2. Export `TabBar` from `packages/web/src/components/ui/index.ts`.
3. In `Room.tsx`:
   - Replace the manual button/tab bar with `<TabBar tabs={...} activeTab={activeTab} onChange={handleTabChange} />`.
   - Define the tabs array: `[{ id: 'overview', label: 'Overview' }, { id: 'context', label: 'Context' }, { id: 'agents', label: 'Agents' }, { id: 'goals', label: 'Missions' }, { id: 'settings', label: 'Settings' }]`.
4. Ensure the `TabBar` component is accessible: add `role="tablist"` to the wrapper and `role="tab"` + `aria-selected` to each button.
5. Write a unit test for `TabBar` in `packages/web/src/components/ui/__tests__/TabBar.test.tsx`.
6. Run `bun run typecheck`, `bun run lint`, and `bunx vitest run src/components/ui/__tests__/TabBar.test.tsx`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- TabBar unit test passes
- Room page uses `TabBar` component
- Active tab shows indigo accent underline (not blue)
- ARIA roles present for accessibility

**Depends on:** Task 6.1, Milestone 02

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6.3 — Room Dashboard Card Layout

**Agent type:** coder

**Description:**
`RoomDashboard.tsx` renders the Room overview tab. It shows session list, task list, and agent status for the room. The current implementation likely uses a flat list or basic grid. This task ensures the overview uses a clear card-based layout consistent with the design system.

**Subtasks (in order):**
1. Read `packages/web/src/components/room/RoomDashboard.tsx`.
2. Ensure the dashboard uses a two-column grid on medium screens (`grid grid-cols-1 md:grid-cols-2 gap-4`).
3. Each section (Sessions, Tasks, Agents) should be a card: `bg-dark-800 border border-dark-700 rounded-xl p-4`.
4. Section headings within each card: `text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3`.
5. For the Sessions list, ensure each session item shows: session title (truncated), workspace path (truncated, text-gray-500 text-xs), and last-active time (right-aligned, text-gray-500 text-xs).
6. For the Tasks list, ensure each task shows: task status badge, task title (truncated).
   - Status badge styles: `px-1.5 py-0.5 rounded text-xs font-medium` with colors from `tokens.color.status`.
7. Empty state for each section: `py-8 text-center text-sm text-gray-500` with a relevant icon.
8. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Dashboard uses two-column grid on medium+ screens
- Each section is a card with `rounded-xl bg-dark-800`
- Section headings are small-caps labels
- Status badges use token colors
- Empty states are present for all sections

**Depends on:** Task 6.2

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6.4 — GoalsEditor and Mission UI Polish

**Agent type:** coder

**Description:**
`GoalsEditor.tsx` is the Mission list and creation form for rooms. It's a complex component with mission type selection (one-shot, measurable, recurring), autonomy level, metric progress bars, and execution history. The visual polish needed: reduce border color complexity, improve metric progress bars, and make the mission type selector more visually distinct.

**Subtasks (in order):**
1. Read `packages/web/src/components/room/GoalsEditor.tsx` (it is a large file — read in sections).
2. Mission type selector: replace the current radio-style inputs with pill-toggle buttons:
   - Container: `flex gap-2 p-1 bg-dark-800 rounded-lg`
   - Each option: `px-3 py-1.5 rounded-md text-sm font-medium transition-colors`
   - Active: `bg-indigo-600 text-white`
   - Inactive: `text-gray-400 hover:text-gray-200 hover:bg-dark-700`
3. Autonomy level selector: apply the same pill-toggle pattern.
4. Metric progress bars: replace any `bg-blue-*` with `bg-indigo-500`. Use `h-1.5 rounded-full` for the track and `h-1.5 rounded-full bg-indigo-500 transition-[width] duration-500` for the fill.
5. Mission card in the list: each mission should be a card `bg-dark-800 border border-dark-700 rounded-xl p-4` with:
   - Mission title in `text-base font-semibold text-gray-100`
   - Mission type badge (pill): one-shot = `bg-dark-700 text-gray-300`, measurable = `bg-teal-900/50 text-teal-300`, recurring = `bg-purple-900/50 text-purple-300`
   - Progress section (for measurable missions): a mini progress bar below the title
6. Execution history entries: use `flex items-center gap-3 py-2 border-t border-dark-700 text-sm` for each entry. Success = green dot, failure = red dot.
7. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Mission type and autonomy level use pill-toggle selectors
- Metric progress bars use indigo accent
- Mission cards use consistent `rounded-xl` card style
- Mission type badges have distinct color coding
- Execution history entries have status dots

**Depends on:** Task 6.3, Milestone 02

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6.5 — Error States, Loading States, and Final Consistency Pass

**Agent type:** coder

**Description:**
A final cross-cutting consistency pass: audit error and loading states across all pages (Lobby, Room, ChatContainer), ensure they use the design system, and verify no raw hex colors or non-token classes remain in key components.

**Subtasks (in order):**
1. Audit all occurrences of `bg-blue-*` in `packages/web/src/` (except in explicit test files or comments) and replace with `bg-indigo-*` where appropriate (message bubbles, active states, buttons).
2. Audit all occurrences of `border-blue-*` in key component files and replace with `border-indigo-*` where they represent the primary accent.
3. For loading states in `Lobby.tsx` and `Room.tsx` (the `loading && initialLoad` returns): replace the basic `Skeleton` usage with a proper skeleton layout that matches the actual page structure — for Lobby, a row of skeleton cards; for Room, a skeleton header + tab bar + content area.
4. For error states (`error && !room`): replace raw text error display with a styled error card: `bg-red-950/30 border border-red-800 rounded-xl p-6 text-center`.
5. Remove any remaining emoji from non-lobby UI components. The Lobby may retain its emoji for the empty state icons (building/chat bubble emojis are acceptable in empty states), but nav and action components should use SVGs.
6. Run `bun run lint`, `bun run typecheck`, and `make test-web` to run the full web test suite.
7. Verify the full app renders without visual regressions by doing a manual smoke test with `make dev WORKSPACE=.`.

**Acceptance criteria:**
- `bun run lint`, `bun run typecheck`, and `make test-web` all pass
- No `bg-blue-500` in active/accent UI contexts
- Loading states are skeleton layouts matching page structure
- Error states use styled error cards
- No emoji in nav/action components
- App renders correctly in dev mode

**Depends on:** Tasks 6.1 through 6.4, Milestones 01–05

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
