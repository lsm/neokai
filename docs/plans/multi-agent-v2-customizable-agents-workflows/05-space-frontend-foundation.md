# Milestone 5: Space Frontend Foundation

## Goal

Build the frontend foundation for Spaces: navigation entry point, URL routing, state management, Space creation UX with workspace path picker, and the minimalist 3-column layout. This creates the shell that all Space UI features plug into.

## Design Principles

- **Minimalist**: Clean, uncluttered, purposeful. Every element earns its place.
- **3-column layout**: Follows the existing room pattern (nav | work area | detail) but with fresh, focused design.
- **Creative**: Not a copy of the Room UI. Fresh visual language, focused interaction model.
- **Workspace-first**: Space creation prominently features workspace path selection as a required field.

## Scope

- New navigation entry point ("Spaces" in sidebar)
- URL routing: `/space/:spaceId`, `/space/:spaceId/session/:sessionId`, `/space/:spaceId/task/:taskId`
- `SpaceStore` for reactive state management
- Space creation dialog with workspace path picker
- 3-column layout shell
- Space dashboard/overview
- Unit tests

---

### Task 5.1: Navigation, Routing, and Signals

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.4

**Description:**

Add the navigation entry point for Spaces, URL routing, and core signals. All new files — no modifications to existing navigation or routing code.

**Subtasks:**

1. Add URL patterns to `packages/web/src/lib/router.ts`:
   - `/space/:spaceId` — Space overview
   - `/space/:spaceId/session/:sessionId` — Session within Space layout
   - `/space/:spaceId/task/:taskId` — Task detail within Space
   - Add `navigateToSpace(spaceId)`, `navigateToSpaceSession(spaceId, sessionId)`, `navigateToSpaceTask(spaceId, taskId)` functions
   - **Keep existing routes unchanged** — add new routes alongside

2. Add signals to `packages/web/src/lib/signals.ts`:
   - `currentSpaceIdSignal` — active space (null by default)
   - `currentSpaceSessionIdSignal` — session viewed within space
   - `currentSpaceTaskIdSignal` — task detail within space
   - **Keep existing signals unchanged** — add new signals alongside

3. Add "Spaces" navigation entry in the sidebar:
   - **Required modifications to existing files** (minimal, additive only):
     - `packages/web/src/lib/signals.ts`: Extend `NavSection` union type to include `'spaces'` (e.g., `type NavSection = 'rooms' | 'spaces' | ...`)
     - `packages/web/src/lib/nav-config.tsx`: Add a `'spaces'` entry to `MAIN_NAV_ITEMS` array
     - `packages/web/src/islands/ContextPanel.tsx`: Add a case for `'spaces'` section that renders the new `SpaceContextPanel` component (the panel itself is a new component under `components/space/`)
   - These are the **only** existing file modifications in the entire plan. They are small, additive changes (extending a union, adding an array entry, adding a switch case).
   - Create new `packages/web/src/components/space/SpaceContextPanel.tsx` — list of spaces with active/archived filter, "Create Space" button

4. Update `packages/web/src/islands/MainContent.tsx` routing logic:
   - Add condition: if `currentSpaceIdSignal` → render `SpaceIsland` component
   - This should take priority alongside (not replace) the existing `roomId` check
   - **Minimal modification**: add a single condition check, keep all existing logic unchanged

5. Write unit tests:
   - URL parsing for space routes
   - Navigation functions update signals correctly
   - Routing dispatches to Space component

**Acceptance criteria:**
- "Spaces" appears in sidebar navigation
- URL routing works for all space paths
- Signals track active space/session/task
- Existing navigation and routing minimally affected (only `NavSection` union, `MAIN_NAV_ITEMS` array, `ContextPanel` switch case, `MainContent` routing condition)
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5.2: SpaceStore — Reactive State Management

**Agent:** coder
**Priority:** high
**Depends on:** Task 5.1

**Description:**

Create `SpaceStore` for managing all Space-related reactive state. Follows the existing `RoomStore` pattern (signals, subscriptions, computed values) but is a completely new module.

**Subtasks:**

1. Create `packages/web/src/lib/space-store.ts`:
   - Core signals:
     - `space: Signal<Space | null>` — current space
     - `tasks: Signal<SpaceTask[]>` — tasks in current space
     - `workflowRuns: Signal<SpaceWorkflowRun[]>` — active and recent workflow runs
     - `agents: Signal<SpaceAgent[]>` — custom agents
     - `workflows: Signal<SpaceWorkflow[]>` — workflow definitions
     - `runtimeState: Signal<SpaceRuntimeState | null>` — runtime status
     - `loading: Signal<boolean>`, `error: Signal<string | null>`

   - Computed signals:
     - `activeTasks` — tasks filtered by active status
     - `activeRuns` — workflow runs filtered by in-progress status
     - `defaultWorkflow` — the space's default workflow
     - `tasksByRun` — tasks grouped by workflow run ID

   - Methods:
     - `selectSpace(spaceId: string)` — fetch space data, subscribe to events
     - `clearSpace()` — unsubscribe, reset signals
     - CRUD wrappers: `createTask()`, `startWorkflowRun()`, `archiveSpace()`, etc.

2. Promise-chain lock for atomic space switching (prevent race conditions when rapidly switching spaces — same pattern as `RoomStore`)

3. Event subscriptions:
   - Subscribe to `space.task.created`, `space.task.updated`, `space.workflowRun.created`, `space.workflowRun.updated`, `spaceAgent.created/updated/deleted`, `spaceWorkflow.created/updated/deleted`
   - Auto-cleanup on space switch

4. Write unit tests:
   - Space selection fetches data and subscribes
   - Space switching cleans up previous subscriptions
   - Computed signals derive correctly
   - CRUD methods call correct RPC endpoints

**Acceptance criteria:**
- `SpaceStore` provides complete reactive state for Space UI
- Event subscriptions enable real-time updates
- Promise-chain lock prevents race conditions
- Computed signals derive useful views of the data (tasks by run, active runs, etc.)
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5.3: Space Creation UX and 3-Column Layout

**Agent:** coder
**Priority:** high
**Depends on:** Task 5.2

**Description:**

Build the Space creation dialog (with required workspace path) and the main 3-column layout shell. The design should feel fresh, minimalist, and focused.

**Subtasks:**

1. Create `packages/web/src/components/space/SpaceCreateDialog.tsx`:
   - **Workspace path is the hero field** — prominently featured, required
   - Fields:
     - **Workspace Path**: directory picker or text input with validation (path must exist). Consider a "Browse" button that opens a native file dialog or a path autocomplete.
     - **Name**: text input (auto-suggest from directory name)
     - **Description**: optional textarea
     - **Default Model**: model picker (reuse model selection patterns)
   - "Create" button validates workspace path exists (client-side check + server-side validation on `space.create`)
   - Clean, minimal dialog design — no unnecessary fields

2. Create `packages/web/src/islands/Space.tsx` — the main Space component:
   - **3-column layout**:
     - **Left column (narrow)**: Space navigation panel — workflow runs list, standalone tasks, quick-access sections (Agents, Workflows, Settings), space status indicator
     - **Middle column (wide)**: Primary work area — workflow run detail, task list, dashboard, or editor views depending on what's selected
     - **Right column (wide)**: Detail pane — active task conversation, session view, or contextual information
   - The right column shows task conversations (using the `TaskConversationRenderer` pattern but styled fresh) when a task is selected
   - Responsive: on narrow screens, columns collapse (right → overlay, left → toggleable)

3. Create `packages/web/src/components/space/SpaceDashboard.tsx`:
   - Default middle-column view when no specific item is selected
   - Shows: space name, workspace path, workflow run progress, recent activity
   - Quick actions: "Start Workflow Run", "Create Task", "Configure Agents", "Edit Workflows"
   - Minimalist design: cards with clear hierarchy, subtle color accents

4. Create `packages/web/src/components/space/SpaceNavPanel.tsx`:
   - Left column navigation:
     - Workflow Runs section (expandable list with status indicators, step progress like "Step 2/3")
     - Standalone Tasks section (tasks not part of a workflow run)
     - "Agents" link → opens agent management in middle column
     - "Workflows" link → opens workflow management in middle column
     - "Settings" link → opens space settings
   - Active item highlighted
   - Compact, scannable design

5. Create `packages/web/src/components/space/SpaceTaskPane.tsx`:
   - Right column task detail view
   - Shows task header (title, status, workflow step indicator like "Step 2/3: Review")
   - Task conversation (Worker + Leader messages)
   - Human input area for sending messages
   - Minimalist: focus on the conversation, metadata tucked away

6. Write unit tests:
   - SpaceCreateDialog validates workspace path
   - 3-column layout renders correctly
   - SpaceDashboard shows correct data
   - Navigation panel highlights active item
   - Task pane shows workflow step indicator

7. Write e2e tests:
   - Create a new Space via the dialog
   - Verify workspace path is required
   - Navigate to Space and verify 3-column layout renders
   - Navigate between workflow runs and verify task pane updates

**Acceptance criteria:**
- Space creation requires workspace path and validates it
- 3-column layout renders correctly with left nav, middle work area, right detail
- Dashboard provides clear overview of space status (workflow runs, tasks)
- Navigation panel shows workflow runs and standalone tasks
- Task pane shows workflow step progression
- Design is minimalist and feels fresh (not a copy of Room UI)
- E2E tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
