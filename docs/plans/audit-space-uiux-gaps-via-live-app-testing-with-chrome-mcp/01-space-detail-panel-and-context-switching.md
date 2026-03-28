# Milestone 1: SpaceDetailPanel + ContextPanel Switching

## Goal

Build a space-specific ContextPanel (`SpaceDetailPanel`) that mirrors `RoomContextPanel`'s layout — stats strip, pinned items, collapsible sections — and wire the top-level `ContextPanel.tsx` to switch between SpaceContextPanel (spaces list, level 1) and SpaceDetailPanel (individual space, level 2) based on whether a space is selected.

## Design Reference

**RoomContextPanel pattern (to mirror):**
1. Task stats strip (`3 active · 1 review`)
2. Pinned items: Dashboard button (highlight when active), Room Agent button (highlight when active)
3. Divider
4. Scrollable sections: Missions (collapsible, with nested tasks), Tasks (with active/review/done tabs), Sessions (collapsible, default collapsed, with + button)

**SpaceDetailPanel should have:**
1. Task stats strip (active · review · needs_attention counts from `spaceStore.tasks`)
2. Pinned items: Dashboard button, Space Agent button
3. Divider
4. Scrollable sections: Workflow Runs (collapsible, with nested tasks per run), Tasks (orphan tasks with active/review/done tabs), Sessions (collapsible, default collapsed)

## Tasks

### Task 1.1: Build SpaceDetailPanel Component

**Description:** Create `SpaceDetailPanel` as the space-level ContextPanel, following the exact same structure as `RoomContextPanel`. This is the core of the two-layer design — it replaces the global spaces list with a space-specific navigation panel when inside a space.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/islands/RoomContextPanel.tsx` — primary pattern to follow
- `packages/web/src/components/room/CollapsibleSection.tsx` — reuse this component
- `packages/web/src/lib/space-store.ts` — data source (tasks, activeRuns, workflows)
- `packages/web/src/lib/signals.ts` — `currentSpaceSessionIdSignal`, `currentSpaceTaskIdSignal`

**Subtasks:**
1. Create `packages/web/src/islands/SpaceDetailPanel.tsx`
2. **Stats strip**: Compute active/review/done counts from `spaceStore.tasks.value` (same logic as RoomContextPanel lines 111-125)
3. **Pinned items**: Dashboard button (navigates to `/space/:id`, highlighted when no session/task selected) and Space Agent button (navigates to `/space/:id/agent`, highlighted when `currentSpaceSessionIdSignal.value === 'space:chat:{spaceId}'`). Use same button styling as RoomContextPanel (lines 219-267)
4. **Workflow Runs section**: Collapsible section showing `spaceStore.activeRuns.value`. Each run is expandable to show its tasks (filter `spaceStore.tasks.value` by `workflowRunId`). Run items show status dot + title. Task items show TaskStatusDot + title, clickable to navigate to `/space/:id/task/:taskId`
5. **Tasks section**: Orphan tasks (tasks without a `workflowRunId`) with active/review/done tab filter. Same pattern as RoomContextPanel's orphan tasks section (lines 392-429). Click navigates to `/space/:id/task/:taskId`
6. **Sessions section**: Collapsible, default collapsed. Shows: (1) the space agent session (`space:chat:{spaceId}`) — always listed, (2) task agent sessions linked via `SpaceTask.taskAgentSessionId`, (3) manually created sessions. Include a "+" button to create a new session (future use). Click navigates to `/space/:id/session/:sessionId`
7. **Empty states**: Each section needs an empty state: "No active runs" for Workflow Runs, "No tasks" for Tasks, "No sessions" for Sessions (matching RoomContextPanel's empty state patterns)
7. Accept props: `spaceId: string`, `onNavigate?: () => void` (for mobile drawer close)
8. Write unit test in `packages/web/src/islands/__tests__/SpaceDetailPanel.test.tsx` covering: stats strip counts, pinned item highlighting, workflow run expansion, task tab filtering, click navigation

**Acceptance criteria:**
- Component mirrors RoomContextPanel's visual structure
- Stats strip shows correct task counts
- Dashboard and Space Agent pinned items highlight correctly based on route
- Workflow runs are expandable with nested tasks
- Orphan tasks are filterable by active/review/done tabs
- All click handlers navigate to correct routes
- Unit tests pass

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 1.2: Wire ContextPanel Switching (Level 1 ↔ Level 2)

**Description:** Update `ContextPanel.tsx` to render `SpaceDetailPanel` when a space is selected (`currentSpaceIdSignal` is set) and `SpaceContextPanel` when no space is selected (browsing the spaces list). This mirrors how rooms switch between `RoomList` (no room) and `RoomContextPanel` (room selected).

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/islands/ContextPanel.tsx` — the file to modify
- Current behavior: spaces section always renders `SpaceContextPanel` regardless of whether a space is selected

**Subtasks:**
1. In `ContextPanel.tsx`, import `SpaceDetailPanel`
2. In the spaces section rendering (the section config around line 195-210), change the content logic:
   - When `currentSpaceIdSignal.value` is set → render `<SpaceDetailPanel spaceId={currentSpaceIdSignal.value} onNavigate={...} />`
   - When `currentSpaceIdSignal.value` is null → render `<SpaceContextPanel onSpaceSelect={...} onCreateSpace={...} />`
3. Update the section title: show space name when inside a space (from `spaceStore.space.value?.name`), show "Spaces" when at list level
4. Add a back button/breadcrumb in the ContextPanel header when inside a space to navigate back to the spaces list (`navigateToSpaces()`)
5. Remove the emoji from the spaces section config (`emptyIcon: '🚀'`) — replace with an SVG icon or remove
6. Write unit test verifying the switching behavior: renders SpaceContextPanel when no space selected, renders SpaceDetailPanel when space selected, back button navigates to spaces list
7. Add E2E test: navigate to spaces, click a space, verify ContextPanel shows SpaceDetailPanel with pinned items, click back, verify ContextPanel shows SpaceContextPanel

**Acceptance criteria:**
- ContextPanel switches between SpaceContextPanel and SpaceDetailPanel based on `currentSpaceIdSignal`
- Space name shown in section header when inside a space
- Back button navigates to spaces list
- Emoji removed from spaces section
- E2E test passes

**Dependencies:** Task 1.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Note:** The `navigateToSpaceAgent()` router function needed by SpaceDetailPanel's "Space Agent" button is in M2 Task 2.4. Task 1.1 should use it as an import — if Task 2.4 lands first, import directly; otherwise, use a placeholder `navigateToSpaceSession(spaceId, 'space:chat:' + spaceId)` which achieves the same navigation.
