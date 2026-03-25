# M1: Workflow Execution MVP

> **Design revalidation notice:** Before implementing any task, revalidate file paths, function signatures, and integration points against the current codebase.

**Milestone goal:** After this milestone, a human can define a workflow in the visual editor, save it, click a button to run it, see its progress in real time, and observe it reaching a terminal step (completed or failed). A simple linear workflow (e.g., Research: Plan -> Execute) should complete end-to-end.

**Scope:** Frontend run trigger, workflow run detail view, task detail view, basic validation improvements, and an end-to-end integration test that proves the system works.

---

## Task 1.1: "Run Workflow" UI Trigger

**Priority:** P0 (highest -- unlocks all subsequent testing)
**Agent type:** coder
**Depends on:** nothing

### Description

Add a "Run" button to the workflow editor/list that allows users to start a workflow run from the UI. This is the single most important UI gap -- without it, no workflow can be tested end-to-end from the browser.

### Subtasks

1. Add a `startRun` action to `SpaceStore` that calls `SpaceStore.startWorkflowRun()` (method already exists at line ~946) and handles the response.
2. Add a "Run Workflow" button to `WorkflowEditor.tsx` (or `WorkflowList.tsx` for the list view). The button should:
   - Open a simple dialog asking for run title (pre-filled from workflow name) and optional description.
   - Call `spaceStore.startWorkflowRun({ title, description, workflowId })`.
   - On success, navigate to the new workflow run detail view (Task 1.2).
   - On error, display the error message inline.
3. Wire up the `space.workflowRun.created` DaemonHub event (already subscribed in SpaceStore at line ~499) to auto-update the `workflowRuns` signal.
4. Add a "Start Run" button to the `CanvasToolbar.tsx` for quick access from the visual editor.

### Files to modify/create

- `packages/web/src/components/space/WorkflowEditor.tsx` -- Add Run button
- `packages/web/src/components/space/WorkflowList.tsx` -- Add Run button per workflow
- `packages/web/src/components/space/visual-editor/CanvasToolbar.tsx` -- Add Run button
- `packages/web/src/lib/space-store.ts` -- Ensure `startWorkflowRun` is wired correctly

### Implementation approach

The RPC handler `spaceWorkflowRun.start` already exists and works. The SpaceStore method exists. The event subscription exists. This task is purely frontend wiring -- connect the existing pieces.

### Edge cases

- Workflow has no nodes -- RPC returns error, display it.
- Space has no agents -- RPC returns error (agent validation in `seedBuiltInWorkflows`).
- Multiple clicks -- debounce or disable button while request is in-flight.

### Testing

- Unit test: `SpaceStore.startWorkflowRun()` calls correct RPC.
- Component test: Run button renders, click triggers dialog, submit calls startWorkflowRun.
- Manual E2E: Create a Research workflow, click Run, verify workflow run is created.

### Acceptance criteria

- [ ] "Run" button visible on WorkflowEditor and WorkflowList
- [ ] Clicking Run opens a title dialog
- [ ] Submitting the dialog creates a workflow run via RPC
- [ ] On success, the `workflowRuns` signal updates with the new run
- [ ] Error messages display inline when RPC fails
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 1.2: Workflow Run Detail View

**Priority:** P0
**Agent type:** coder
**Depends on:** Task 1.1 (need the run trigger to create runs for testing)

### Description

Create a `WorkflowRunView` component that shows the status, progress, and step list for a workflow run. This is the primary dashboard for monitoring a running workflow.

### Subtasks

1. Create `packages/web/src/components/space/WorkflowRunView.tsx` with:
   - Run status badge (in_progress / completed / cancelled / needs_attention)
   - Current step indicator (which node is active)
   - Step timeline showing all workflow nodes with their execution status (pending / active / completed / skipped)
   - Task list for the current step (using existing `spaceTasks` signal grouped by `workflowRunId`)
   - Cancel Run button (calls `spaceWorkflowRun.cancel` RPC)
2. Add routing so navigating to `/space/:spaceId/run/:runId` renders this view.
3. Add a link from the run list in `SpaceDashboard.tsx` to individual run detail views.
4. Subscribe to `space.workflowRun.updated` events (already subscribed at SpaceStore line ~509) to auto-refresh the view.

### Files to modify/create

- `packages/web/src/components/space/WorkflowRunView.tsx` -- NEW
- `packages/web/src/components/space/SpaceDashboard.tsx` -- Add run list links
- `packages/web/src/components/space/SpaceNavPanel.tsx` -- Add run view nav (if applicable)
- `packages/web/src/lib/space-store.ts` -- Add `activeRunId` signal for navigation

### Implementation approach

The data is already available: `workflowRuns` signal has run objects with `currentNodeId` and `status`. The `tasksByWorkflowRunId` computed groups tasks by run. The workflow definition (with node names and transitions) is in the `workflows` signal. Cross-reference `run.currentNodeId` against `workflow.nodes` to build the step timeline.

### Edge cases

- Run references a deleted workflow -- show "Workflow definition not found" message.
- Run is in `needs_attention` -- show a prominent banner with the reason.
- Run has been cancelled -- show final state, disable Cancel button.

### Testing

- Component test: Renders run status, step timeline, task list.
- Component test: Cancel button calls RPC and updates signal.
- Component test: needs_attention banner renders with reason.

### Acceptance criteria

- [ ] WorkflowRunView renders for a valid run ID
- [ ] Run status badge shows correct status
- [ ] Step timeline highlights current step
- [ ] Task list shows tasks for the current step
- [ ] Cancel button works and updates the view
- [ ] View auto-updates when `space.workflowRun.updated` event fires
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 1.3: Task Detail View (Agent Output)

**Priority:** P0
**Agent type:** coder
**Depends on:** Task 1.2 (task detail is accessed from the run view)

### Description

Create a `TaskDetailView` component that shows what a specific task's agent is doing -- its conversation output, current status, and error messages. Without this, users cannot see whether their workflow steps are executing correctly.

### Subtasks

1. Create `packages/web/src/components/space/TaskDetailView.tsx` with:
   - Task status and metadata (title, agent, startedAt, completedAt, result, error)
   - Conversation view showing messages from the task's agent session (using `session.messages` or similar RPC)
   - Expandable error section when `task.error` is set
   - Link to the agent's session (if session ID is available via `task.taskAgentSessionId`)
2. Add a click handler on task items in the WorkflowRunView (Task 1.2) to open TaskDetailView.
3. Add `message.list` or equivalent RPC call to fetch session messages for a given session ID. If no such RPC exists, use `session.get` + existing message subscription.

### Files to modify/create

- `packages/web/src/components/space/TaskDetailView.tsx` -- NEW
- `packages/web/src/components/space/WorkflowRunView.tsx` -- Add task click handler
- `packages/web/src/lib/space-store.ts` -- Add session message fetching if needed

### Implementation approach

The `SpaceTask` type includes `taskAgentSessionId` (the step agent's session ID). Use existing session message infrastructure to fetch and display messages. The frontend already handles session messages in `ChatContainer.tsx` -- reuse or adapt that pattern.

### Edge cases

- Task has no `taskAgentSessionId` -- show "No session created yet" message.
- Session has no messages yet (agent just spawned) -- show "Waiting for agent..." indicator.
- Agent session ended with error -- show error prominently with retry hint.

### Testing

- Component test: Renders task metadata (title, status, timestamps).
- Component test: Shows error section when task.error is set.
- Component test: Shows "No session" placeholder when taskAgentSessionId is null.

### Acceptance criteria

- [ ] TaskDetailView renders for a valid task ID
- [ ] Task metadata (title, status, timestamps, result, error) displays correctly
- [ ] Agent conversation messages are visible (when session exists)
- [ ] Error state shows clearly with actionable context
- [ ] "No session" placeholder shows for pending tasks
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 1.4: Workflow Validation Hardening

**Priority:** P1
**Agent type:** coder
**Depends on:** nothing

### Description

Strengthen the `SpaceWorkflowManager` validation to catch more user-defined workflow errors before they cause runtime failures. The current validation (in `space-workflow-manager.ts`) checks: unique names, agent refs, node IDs, transition endpoints, channel refs. Add validation for common workflow design mistakes.

### Subtasks

1. Add a "reachability check" to `validateTransitions()`: verify that every node is reachable from the start node (BFS/DFS from startNodeId). Warn (not error) for unreachable nodes.
2. Add a "dead-end check": verify that the graph has at least one terminal node (no outgoing transitions). Warn if the graph has no terminal node (all nodes have outgoing transitions).
3. Add validation that `startNodeId` is not null/empty when the workflow has transitions.
4. Add validation that `task_result` conditions only appear on transitions leaving nodes that have agents (not on transitions from nodes with no tasks).
5. Add a `validateWorkflowForRun()` method that performs runtime-specific checks (e.g., all nodes have resolvable agents, the workflow has not been deleted).

### Files to modify

- `packages/daemon/src/lib/space/managers/space-workflow-manager.ts` -- Add validation methods
- `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` -- Call validateWorkflowForRun() before start

### Implementation approach

Add new private validation methods to `SpaceWorkflowManager`. Keep the existing validation methods intact. New checks should produce warnings (log.warn) rather than errors for backward compatibility -- some built-in workflows may not satisfy all new rules.

### Edge cases

- Self-loop transitions (from == to without isCyclic) -- warn, may be intentional.
- Multiple start nodes -- warn, only one is used.
- Empty conditions on cyclic transitions -- warn, user may not understand iteration counting.

### Testing

- Unit test: Unreachable node detection (graph with disconnected component).
- Unit test: No terminal node detection.
- Unit test: startNodeId null/empty with transitions.
- Unit test: Backward compatibility -- existing built-in workflows still pass validation.

### Acceptance criteria

- [ ] Reachability check logs warnings for unreachable nodes
- [ ] Dead-end check logs warnings for graphs with no terminal node
- [ ] Existing built-in workflows still pass all validation
- [ ] `spaceWorkflowRun.start` calls `validateWorkflowForRun()` before creating the run
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 1.5: End-to-End Workflow Execution Integration Test

**Priority:** P1
**Agent type:** coder
**Depends on:** Tasks 1.1, 1.2, 1.3, 1.4

### Description

Write a comprehensive integration test that proves a simple workflow can be defined, saved, run, and observed completing end-to-end. This test uses the Research workflow (2-node: Plan -> Execute) as the target since it has no human gates and always-condition transitions, making it fully autonomous.

### Subtasks

1. Create `packages/daemon/tests/integration/space-workflow-e2e.test.ts`:
   - Setup: Create a Space with default agents and Research workflow.
   - Act: Call `spaceWorkflowRun.start` with the Research workflow.
   - Assert: Workflow run transitions through both steps and reaches `completed` status.
   - Assert: Two SpaceTask records exist (one per step), both `completed`.
   - Assert: `iterationCount` is 0 (no cycles).
2. Add a second test case for the Coding workflow (4-node with human gate):
   - Assert: Workflow run reaches `needs_attention` at the human gate.
   - Assert: After setting `humanApproved: true` and resetting status, the run resumes.
3. Add a third test case for cycle detection:
   - Assert: Workflow run with `maxIterations: 1` correctly escalates to `needs_attention` after one cycle.
4. Mock the agent session creation (sub-sessions) to immediately complete, so the test does not require real API calls.

### Files to create

- `packages/daemon/tests/integration/space-workflow-e2e.test.ts` -- NEW
- May need a test helper: `packages/daemon/tests/integration/helpers/space-workflow-test-util.ts` -- NEW (optional)

### Implementation approach

Use the existing test patterns from `packages/daemon/tests/online/` and `packages/daemon/tests/unit/`. Mock `TaskAgentManager.spawnTaskAgent()` to immediately complete tasks (simulate agent finishing work). Focus on testing the WorkflowExecutor + SpaceRuntime integration, not the actual agent execution.

### Edge cases

- Test timeout if executor does not advance -- assert run status within N ticks.
- Task status transition race conditions -- use polling with timeout.

### Testing

- This IS the test.
- Run via: `cd packages/daemon && bun test tests/integration/space-workflow-e2e.test.ts`

### Acceptance criteria

- [ ] Research workflow completes end-to-end in test
- [ ] Coding workflow correctly blocks at human gate
- [ ] Cycle detection correctly escalates after maxIterations
- [ ] Test runs in CI without real API credentials
- [ ] All assertions pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 1.6: Space Dashboard Run List Enhancement

**Priority:** P1
**Agent type:** coder
**Depends on:** Task 1.1

### Description

Enhance the Space Dashboard to show a list of workflow runs with their status, making it easy for users to navigate from the dashboard to the run detail view.

### Subtasks

1. Add a "Workflow Runs" section to `SpaceDashboard.tsx` showing:
   - List of recent workflow runs from the `workflowRuns` signal
   - Run title, status badge, created time, and current step name
   - Click navigates to the `WorkflowRunView` (Task 1.2)
   - Empty state when no runs exist
2. Add a "Create New Run" button that opens the workflow selection dialog (if Task 1.1's dialog allows workflow selection).
3. Filter by status (All / Active / Completed / Failed) as a simple tab bar.

### Files to modify

- `packages/web/src/components/space/SpaceDashboard.tsx` -- Add runs section
- `packages/web/src/lib/space-store.ts` -- Add computed signals for filtered runs if needed

### Implementation approach

The `workflowRuns` signal in SpaceStore already contains all runs. Cross-reference with the `workflows` signal to get workflow names. Cross-reference with `tasksByWorkflowRunId` to get current step name from the workflow definition.

### Edge cases

- Many runs (100+) -- add pagination or limit to 20 most recent.
- Runs referencing deleted workflows -- show workflow ID instead of name.

### Testing

- Component test: Renders run list with correct status badges.
- Component test: Click navigates to run detail.
- Component test: Empty state renders correctly.
- Component test: Filter tabs work.

### Acceptance criteria

- [ ] Dashboard shows workflow runs list
- [ ] Each run shows title, status, created time
- [ ] Click navigates to WorkflowRunView
- [ ] Filter tabs work
- [ ] Empty state renders when no runs
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
