# Milestone 5: Canvas Mode and Artifacts Panel

## Goal

Add canvas mode toggle from the task view and integrate the artifacts side panel showing changed files with diffs.

## Scope

Happy paths 8 (Canvas mode) and 9 (Artifacts side panel).

## Tasks

### Task 5.1: Add canvas mode toggle button to task view

**Description:** The `WorkflowCanvas` component exists but there is no button in the task view to switch to canvas mode. Add a toggle in the task pane header that switches between the thread view and canvas view for tasks with an active workflow run.

**Subtasks:**
1. Read `packages/web/src/components/space/WorkflowCanvas.tsx` for the canvas component interface and props.
2. Read `packages/web/src/components/space/SpaceTaskPane.tsx` for the current header layout.
3. Add a view mode state (`thread` | `canvas`) to `SpaceTaskPane`.
4. Add a toggle button (or segmented control) in the task pane header to switch between thread and canvas views. Only show for tasks with a `workflowRunId`.
5. When canvas mode is active, render `WorkflowCanvas` with the task's workflow run data instead of the unified thread.
6. Wire canvas node clicks to open the agent overlay chat (from Task 4.2).
7. Add Vitest tests: toggle button appears only for workflow tasks, clicking toggle switches view, canvas renders with correct run data.
8. Run tests to verify.

**Acceptance Criteria:**
- Tasks with workflow runs show a canvas/thread toggle.
- Canvas mode shows the workflow visualization with active node pulsing.
- Clicking a node in canvas opens the agent overlay chat.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 4.2

**Agent type:** coder

### Task 5.2: Add artifacts side panel to task view

**Description:** The `GateArtifactsView` component exists for gate-level artifacts but there is no task-level artifacts panel. Add an artifacts button to the task pane that opens a right-side panel showing all changed files across all gates/nodes with +/- line counts and click-to-diff.

**Subtasks:**
1. Read `packages/web/src/components/space/GateArtifactsView.tsx` for existing artifacts/diff rendering.
2. Read `packages/web/src/components/space/FileDiffView.tsx` for the diff viewer component.
3. Read the space store for how gate data and artifacts are fetched.
4. Create `packages/web/src/components/space/TaskArtifactsPanel.tsx` -- a slide-over panel from the right that aggregates artifacts from all completed gates in the task's workflow run.
5. Add an "Artifacts" button to the task pane header (only visible for workflow tasks).
6. Panel should list files with +/- line indicators, grouped by gate/node. Clicking a file opens the diff view.
7. Add Vitest tests: panel renders file list, line counts are displayed, click opens diff.
8. Run tests to verify.

**Acceptance Criteria:**
- Artifacts panel shows all changed files from the task's workflow run.
- Each file shows +/- line counts.
- Clicking a file opens a unified diff view.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 5.1

**Agent type:** coder

### Task 5.3: Verify WorkflowCanvas runtime mode rendering

**Description:** The `WorkflowCanvas` has both template and runtime modes. Verify runtime mode correctly shows: active node pulsing, completed nodes dimmed, pending nodes neutral, and agent labels on nodes.

**Subtasks:**
1. Read `packages/web/src/components/space/WorkflowCanvas.tsx` for runtime vs template mode logic.
2. Check existing tests in `packages/web/src/components/space/__tests__/WorkflowCanvas.test.tsx`.
3. Add Vitest tests for runtime mode: active nodes pulse, completed nodes show done styling, node agents are labeled, clicking a node fires the expected callback.
4. Run tests to verify.

**Acceptance Criteria:**
- Runtime canvas correctly visualizes workflow state with active/completed/pending styling.
- Vitest tests verify node rendering in each state.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 5.1

**Agent type:** coder
