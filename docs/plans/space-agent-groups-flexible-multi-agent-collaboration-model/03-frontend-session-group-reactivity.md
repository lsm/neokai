# Milestone 3: Frontend Session Group Reactivity

## Goal

Add session group awareness to the frontend so users can see which agents are actively working on a task in real time.

## Scope

- Add `sessionGroups` signal to `SpaceStore`
- Subscribe to `space.sessionGroup.*` events
- Add RPC handler for initial fetch of session groups
- Display active agents in `SpaceTaskPane`
- Unit tests for store updates and web component tests

---

### Task 3.1: Add Session Group RPC Handler and SpaceStore Signal

**Description:** Add a `space.sessionGroup.list` RPC handler on the daemon side, and add a `sessionGroups` signal to `SpaceStore` that fetches initial state and subscribes to real-time updates.

**Subtasks:**
1. Create RPC handler `space.sessionGroup.list` in daemon that returns all groups for a space (using `SpaceSessionGroupRepository.getGroupsBySpace()`)
2. Add `sessionGroups: signal<SpaceSessionGroup[]>` to `SpaceStore`
3. Add computed signal `sessionGroupsByTask` that maps `taskId -> SpaceSessionGroup[]` for easy lookup
4. In `startSubscriptions()`, subscribe to `space.sessionGroup.created`, `space.sessionGroup.memberAdded`, `space.sessionGroup.memberUpdated` events
5. On `created`: append the new group to `sessionGroups`
6. On `memberAdded`: find the group and update its `members` array
7. On `memberUpdated`: find the group and member, update the member's status
8. In `fetchInitialState()`, call `space.sessionGroup.list` and populate the signal
9. In `stopSubscriptions()`, clean up the event handlers
10. Import `SpaceSessionGroup` and `SpaceSessionGroupMember` types in `SpaceStore`

**Acceptance Criteria:**
- `sessionGroups` signal is populated on space selection
- Real-time updates flow through events and update the signal
- `sessionGroupsByTask` computed provides O(1) lookup per task
- No regressions in existing space store behavior

**Dependencies:** Task 2.3 (events must be emitted)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Display Active Agents in SpaceTaskPane

**Description:** Update `SpaceTaskPane.tsx` to show which agents are currently working on a task, using the session group data.

**Subtasks:**
1. In `SpaceTaskPane`, read `sessionGroupsByTask` from `spaceStore` for the current task
2. If a group exists for the task, render a "Working Agents" section showing each member's role, agent name (looked up from `agents` signal by `agentId`), and status badge (active/completed/failed)
3. Use appropriate status colors: active = blue/green pulse indicator, completed = green check, failed = red X
4. Show the group name and creation time
5. Handle edge case: no group yet (task is pending or standalone) -- show nothing or "No agents assigned"
6. Handle edge case: multiple groups per task (sequential workflow steps) -- show the most recent or all

**Acceptance Criteria:**
- Active agents are visible in the task pane when a task is in progress
- Status badges update in real time as agents complete or fail
- The display is clean and does not clutter the existing task pane layout
- No regressions in existing SpaceTaskPane functionality

**Dependencies:** Task 3.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.3: Frontend Unit Tests for Session Group Signals

**Description:** Write unit tests for the SpaceStore session group signal behavior and web component tests for the SpaceTaskPane agent display.

**Subtasks:**
1. Add tests in `packages/web/src/lib/space-store.test.ts` (or create if not exists) for:
   - `sessionGroups` signal updates on event receipt
   - `sessionGroupsByTask` computed correctness
   - Cleanup on space deselection
2. Add component tests for SpaceTaskPane agent display:
   - Renders agent list when group exists
   - Shows correct status badges
   - Handles empty state (no group)
   - Updates on member status change

**Acceptance Criteria:**
- All tests pass with `cd packages/web && bunx vitest run`
- Tests cover the signal update logic and component rendering
- Tests follow existing vitest patterns in the web package

**Dependencies:** Task 3.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
