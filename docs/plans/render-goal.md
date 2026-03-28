# Plan: Render Goal

## Goal Summary

Surface the active mission/goal context prominently in the NeoKai chat UI. Users working inside a
room's agent conversation currently have no visible reminder of what mission is being worked on.
This plan adds four focused improvements:

1. **MissionBanner** — a persistent banner above the message list in `ChatContainer` that shows the
   active goal(s) when a room session is active.
2. **`needs_human` goals in `RoomContextPanel`** — extend the sidebar Missions section to show
   goals awaiting human review (currently invisible).
3. **`MetricSparkline` SVG component** — hand-rolled SVG trend line for metric history displayed
   inside `GoalsEditor` goal cards.
4. **`goal.getMetricHistory` frontend RPC + sparkline integration** — wire the existing backend
   `getMetricHistory` into a new `roomStore.getMetricHistory()` method and connect it to the
   sparkline inside `GoalsEditor`.

All tasks produce focused, reviewable PRs. No new dependencies are introduced.

---

## Approach

- `roomStore.activeGoals` (computed signal, `status === 'active'`) is already available. The
  `MissionBanner` reads from it directly — no new RPC needed.
- `RoomContextPanel` already has `goalStatusColors` for `needs_human`; only the filter driving the
  rendered list needs expanding.
- The daemon's `goal.getMetrics` RPC already exists and returns structured metric state. A separate
  `goal.getMetricHistory` RPC handler (daemon side) already exposes time-series data via
  `GoalManager.getMetricHistory()`. The frontend needs only a thin `roomStore` method and an RPC
  call wiring.
- The `MetricSparkline` is a pure SVG component (~50 lines) — zero external charting libraries.

---

## Tasks

---

### Task 1: MissionBanner component in ChatContainer

**Agent type:** coder

**Description:**
Create a new `MissionBanner` component and render it inside `ChatContainer` between the
`ChatHeader` and the messages area, visible only when the session belongs to a room that has one or
more active goals. The banner must be non-intrusive: compact (single line or two lines max),
collapsible/dismissible per-session, and must not block the rewind mode banner which occupies the
same vertical region.

**Subtasks (ordered):**

1. Create `packages/web/src/components/MissionBanner.tsx`.
   - Accept props: `goals: RoomGoal[]` (the active goals to display), `onNavigate?: () => void`
     (called when the user clicks the banner to jump to the Missions tab).
   - Render nothing if `goals` is empty.
   - When `goals.length === 1`: show the goal title, mission-type badge (`missionType` if not
     `one_shot`), status dot (green), and a small right-arrow chevron to navigate.
   - When `goals.length > 1`: show a compact summary line `N active missions` with the same
     chevron.
   - Use a sticky/pinned strip styled with `bg-dark-850/60 border-b border-dark-700 px-4 py-2`
     (matching the project's dark palette). No backdrop-blur required.
   - Include a dismiss button (×) that hides the banner for the lifetime of the component mount
     (local `useSignal<boolean>` — no persistence needed).

2. In `packages/web/src/islands/ChatContainer.tsx`:
   - Import `roomStore` from `../lib/room-store` and read `roomStore.activeGoals.value` inside a
     `useSignalEffect` (or directly via `.value` since `ChatContainer` is already a Preact
     component).
   - Determine if this is a room session: `sessionId.startsWith('room:chat:')`. The banner should
     only appear for room-context sessions.
   - Extract the `roomId` from `sessionId` (`sessionId.replace('room:chat:', '')`) to scope the
     lookup — `roomStore` already tracks the currently selected room.
   - Render `<MissionBanner>` immediately after `<ChatHeader>` and before the `{/* Messages */}`
     block, passing `goals={roomStore.activeGoals.value}`.
   - Provide `onNavigate` that sets `navSectionSignal.value = 'missions'` (or navigates to the
     Goals tab in Room.tsx — confirm the correct signal/mechanism by reading `Room.tsx` active-tab
     logic).

3. Write a Vitest unit test in `packages/web/src/components/MissionBanner.test.tsx`:
   - No goals → renders null (nothing in DOM).
   - One active goal → renders title and status dot.
   - Multiple goals → renders summary count.
   - Dismiss button → hides the banner.

**Acceptance criteria:**
- When a room agent session (`room:chat:<roomId>`) has `activeGoals.length > 0`, a banner appears
  below the chat header showing the mission context.
- Dismissing the banner hides it for that component mount.
- When `activeGoals` is empty the DOM contains no banner element.
- All Vitest tests pass (`make test-web`).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** none

---

### Task 2: Show `needs_human` goals in RoomContextPanel

**Agent type:** coder

**Description:**
`RoomContextPanel` currently renders only `roomStore.activeGoals` (status `=== 'active'`). Goals
in `needs_human` status are invisible in the sidebar, even though they represent missions
specifically waiting for human action. Extend the displayed set to include `needs_human` goals,
grouped visually below the active goals.

**Subtasks (ordered):**

1. In `packages/web/src/lib/room-store.ts`, add a computed signal:
   ```
   readonly needsHumanGoals = computed(() =>
     this.goals.value.filter((g) => g.status === 'needs_human')
   );
   ```

2. In `packages/web/src/islands/RoomContextPanel.tsx`:
   - Read `roomStore.needsHumanGoals.value` alongside `activeGoals`.
   - Update the `CollapsibleSection` `count` prop to
     `activeGoals.length + needsHumanGoals.length`.
   - After the `activeGoals.map(...)` block, render `needsHumanGoals` entries. Apply a visual
     separator (a small `text-[10px] text-yellow-500/70 px-3 pt-1` label "Needs Review") before
     this group if both groups are non-empty.
   - Each `needs_human` goal entry retains the existing expand/collapse toggle + linked tasks
     pattern already used for active goals. Reuse the same JSX structure with the
     `goalStatusColors.needs_human` (`text-yellow-400`) status dot.

3. Add a test for this behavior in `packages/web/src/islands/__tests__/` (or co-locate with
   existing test files for `RoomContextPanel` if any exist — check first):
   - A `needs_human` goal appears in the panel with a yellow dot.
   - Active goals and `needs_human` goals are both visible at the same time.

**Acceptance criteria:**
- Goals with `status === 'needs_human'` are visible in the sidebar Missions section with a yellow
  status dot.
- Active goals are still listed first; `needs_human` goals appear below with a "Needs Review"
  label separating them when both groups are present.
- The section count badge reflects the total of both groups.
- All Vitest tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** none

---

### Task 3: MetricSparkline SVG component

**Agent type:** coder

**Description:**
Create a pure SVG sparkline component for displaying metric history trends (e.g. coverage over
time). No external charting library. The component is self-contained and will be used by
`GoalsEditor` in Task 4.

**Subtasks (ordered):**

1. Create `packages/web/src/components/MetricSparkline.tsx`.
   - Props:
     ```ts
     interface MetricSparklineProps {
       /** Data points in chronological order */
       data: { value: number; recordedAt: number }[];
       /** Target value for the metric (draws a dashed reference line) */
       target?: number;
       /** Direction: 'increase' = higher is better, 'decrease' = lower is better */
       direction?: 'increase' | 'decrease';
       /** Width of the SVG canvas in pixels (default 120) */
       width?: number;
       /** Height of the SVG canvas in pixels (default 32) */
       height?: number;
       /** CSS class applied to the wrapping <svg> element */
       class?: string;
     }
     ```
   - Render nothing (return null) if `data.length < 2`.
   - Normalise `value` to the SVG coordinate space:
     - `minVal = Math.min(...data.map(d => d.value))`
     - `maxVal = Math.max(...data.map(d => d.value))`
     - If `target` is provided, extend the range to include it.
     - Map each point to `(x, y)` coordinates with padding of 2px top/bottom.
   - Draw a single `<polyline>` for the data trend in `stroke="currentColor"` at `opacity-70`.
   - If `target` is provided, draw a horizontal `<line>` at the normalised target y-coordinate
     with `stroke-dasharray="3 2"` in `stroke="currentColor"` at `opacity-30`.
   - Color hint via CSS class prop (caller sets `text-green-400` or `text-yellow-400` on the
     wrapper `<svg>` to drive `currentColor`).
   - The final point should have a small filled `<circle r="2">` to indicate the latest value.

2. Write a Vitest unit test in `packages/web/src/components/MetricSparkline.test.tsx`:
   - `data.length < 2` renders null.
   - `data.length >= 2` renders a `<polyline>` with correct number of coordinate pairs.
   - When `target` is provided, a `<line>` element is present.

**Acceptance criteria:**
- `MetricSparkline` renders valid SVG for data arrays of length >= 2.
- For length < 2, it renders nothing.
- A dashed target line appears when `target` prop is provided.
- No external chart library is added to `packages/web/package.json`.
- All Vitest tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** none

---

### Task 4: goal.getMetricHistory frontend RPC + sparkline integration in GoalsEditor

**Agent type:** coder

**Description:**
Wire up the existing backend `goal.getMetricHistory` capability to the frontend. Add a
`getMetricHistory` method to `roomStore`, extend `GoalsEditorProps` with an `onGetMetricHistory`
callback, and render `MetricSparkline` inside the expanded measurable goal card.

**Background on the backend:** The daemon already exposes
`GoalManager.getMetricHistory(goalId, metricName?, options?)` which reads from
`mission_metric_history`. However, no frontend-facing RPC handler (`messageHub.onRequest(...)`) is
currently registered for this — only `goal.getMetrics` exists. This task also adds the missing RPC
handler on the daemon side.

**Subtasks (ordered):**

1. **Daemon: add `goal.getMetricHistory` RPC handler** in
   `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts`:
   - Add a handler for `'goal.getMetricHistory'` that accepts
     `{ roomId: string; goalId: string; metricName?: string; limit?: number }`.
   - Calls `goalManager.getMetricHistory(goalId, metricName, { limit })`.
   - Returns `{ entries: MetricHistoryEntry[] }`.
   - Add the handler name to the file's JSDoc list at the top (lines 1–20 pattern).

2. **Daemon: add a unit test** for the new RPC handler in
   `packages/daemon/tests/unit/rpc-handlers/goal-handlers.test.ts` following the existing
   `goal.getMetrics` test pattern (lines 1506–1583):
   - Returns history entries for a valid `goalId`.
   - Returns empty array for a goal with no history.
   - Throws when `roomId` or `goalId` is missing.

3. **Frontend: add `getMetricHistory` to `roomStore`** in
   `packages/web/src/lib/room-store.ts`:
   ```ts
   async getMetricHistory(
     goalId: string,
     metricName?: string,
     limit = 30,
   ): Promise<MetricHistoryEntry[]> {
     const hub = connectionManager.getHubIfConnected();
     if (!hub) return [];
     const roomId = this.roomId.value;
     if (!roomId) return [];
     const result = await hub.request<{ entries: MetricHistoryEntry[] }>(
       'goal.getMetricHistory',
       { roomId, goalId, metricName, limit },
     );
     return result.entries;
   }
   ```
   - Import `MetricHistoryEntry` from `@neokai/shared` (already imported in the file via
     `packages/shared/src/types/neo.ts`).

4. **Frontend: extend `GoalsEditorProps`** in
   `packages/web/src/components/room/GoalsEditor.tsx`:
   - Add optional callback:
     ```ts
     onGetMetricHistory?: (goalId: string, metricName: string) => Promise<MetricHistoryEntry[]>;
     ```
   - Import `MetricHistoryEntry` from `@neokai/shared`.

5. **Frontend: render `MetricSparkline` inside GoalsEditor** for measurable goals:
   - In the expanded `GoalItem` card (the section that currently renders `MetricProgress` bars),
     after each metric's progress bar, lazy-load metric history via `onGetMetricHistory` (called
     inside `useEffect` on expand, keyed on `goalId + metricName`).
   - Store loaded history in a local `useSignal<Map<string, MetricHistoryEntry[]>>` keyed by
     `metricName`.
   - Render `<MetricSparkline data={history} target={metric.target} direction={metric.direction}
     class="text-blue-400" width={120} height={28} />` alongside each metric's progress bar.
   - Show nothing (no sparkline) while history is loading or when fewer than 2 data points exist.

6. **Frontend: wire `onGetMetricHistory` in `Room.tsx`**:
   - Pass `onGetMetricHistory={(goalId, metricName) => roomStore.getMetricHistory(goalId,
     metricName)}` to `<GoalsEditor>`.

**Acceptance criteria:**
- Expanding a measurable goal card that has recorded metric history shows a sparkline beside each
  metric's progress bar.
- No sparkline renders for goals with fewer than 2 history data points.
- The new `goal.getMetricHistory` daemon RPC handler passes its unit tests.
- All Vitest web tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Task 3 (MetricSparkline component must exist before it can be used here)
