# M3: Workflow Monitoring and Debugging

> **Design revalidation notice:** Before implementing any task, revalidate file paths, function signatures, and integration points against the current codebase.

**Milestone goal:** After this milestone, users can see real-time updates for workflow runs, inspect task agent conversations, review past workflow run history, and debug issues by examining step execution logs.

**Scope:** Real-time DaemonHub events for task/run state, workflow run history UI, task agent conversation inspection, and step execution timeline.

---

## Task 3.1: Real-Time DaemonHub Events for Workflow Task State Changes

**Priority:** P0
**Agent type:** coder
**Depends on:** nothing

### Description

The SpaceRuntime emits notifications via `NotificationSink` (task_needs_attention, task_timeout, workflow_run_needs_attention, workflow_run_completed), but these go to the Space Agent session, not to the web frontend. Add DaemonHub events that the web frontend can subscribe to for real-time UI updates.

### Subtasks

1. Add DaemonHub events for task state transitions:
   - `space.task.statusChanged` -- emitted when a task status changes (payload: `{ taskId, spaceId, oldStatus, newStatus, timestamp }`)
   - `space.task.created` -- emitted when a new task is created (payload: `{ taskId, spaceId, task }`)
2. Add DaemonHub events for workflow run state transitions:
   - `space.workflowRun.statusChanged` -- emitted when a run status changes (payload: `{ runId, spaceId, oldStatus, newStatus, timestamp }`)
   - `space.workflowRun.stepAdvanced` -- emitted when a run advances to a new step (payload: `{ runId, spaceId, previousNodeId, currentNodeId, timestamp }`)
3. Emit these events from the appropriate locations in `SpaceRuntime` and `SpaceTaskManager`.
4. Subscribe to these events in `SpaceStore` to update signals reactively.

### Files to modify

- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Emit events on step advance, completion
- `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- Emit events on status change
- `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` -- Emit events on cancel
- `packages/web/src/lib/space-store.ts` -- Subscribe to events, update signals

### Implementation approach

The DaemonHub already emits `spaceSessionGroup.created` and `spaceSessionGroup.memberUpdated` events. Follow the same pattern for task and run events. The `DaemonHub.emit()` method already exists and is used extensively. SpaceStore already subscribes to `space.workflowRun.created/updated` -- extend with the new events.

### Edge cases

- Event emitted during daemon shutdown -- safe to lose, UI will re-sync on reconnect.
- Rapid status changes (e.g., pending -> in_progress -> completed in same tick) -- batch events or use the latest state from the signal.
- Multiple spaces active -- events include `spaceId` for correct routing.

### Testing

- Unit test: `space.task.statusChanged` emitted when task status transitions.
- Unit test: `space.workflowRun.stepAdvanced` emitted when run advances.
- Unit test: SpaceStore signal updates when receiving event.
- Component test: WorkflowRunView re-renders on step advance event.

### Acceptance criteria

- [ ] Task status changes emit DaemonHub events
- [ ] Workflow run step advances emit DaemonHub events
- [ ] SpaceStore subscribes and updates signals reactively
- [ ] UI updates in real-time without polling
- [ ] Events include correct spaceId and timestamps
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 3.2: Task Agent Conversation Inspector

**Priority:** P1
**Agent type:** coder
**Depends on:** Task 1.3 (TaskDetailView)

### Description

Enhance the `TaskDetailView` (from Task 1.3) to show the full conversation history of the task's agent session, including tool calls, tool results, and the agent's reasoning. This is essential for debugging workflow steps.

### Subtasks

1. Add a "Conversation" tab to `TaskDetailView` that fetches and displays messages from the task's session:
   - Use existing `message.list` RPC or `session.get` to fetch session messages.
   - Display messages in chronological order with role indicators (user / assistant / tool).
   - Render tool calls as collapsible blocks showing the tool name, input, and result.
2. Add a "Logs" tab showing session-level events (status changes, errors, rehydration).
3. Add auto-refresh: subscribe to `session.updated` DaemonHub events for the task's session to stream new messages as they arrive.
4. Add a "Sub-sessions" tab for multi-agent steps, showing all sub-sessions and their status (from the session group).

### Files to modify/create

- `packages/web/src/components/space/TaskDetailView.tsx` -- Enhance with conversation, logs, sub-sessions tabs
- `packages/web/src/lib/space-store.ts` -- Add session message fetching
- `packages/daemon/src/lib/rpc-handlers/` -- May need a `space.task.getMessages` RPC if none exists

### Implementation approach

The `ChatContainer.tsx` component already renders messages with tool calls. Adapt or extract the message rendering logic into a reusable component. The `taskAgentSessionId` field on `SpaceTask` provides the session ID.

### Edge cases

- Task has no session (pending) -- show "No session yet" placeholder.
- Very long conversations (1000+ messages) -- add virtual scrolling or pagination.
- Session deleted before view is opened -- show "Session no longer available" error.

### Testing

- Component test: Conversation tab renders messages.
- Component test: Tool calls are collapsible.
- Component test: Auto-refresh updates on new messages.
- Component test: Sub-sessions tab shows all group members.

### Acceptance criteria

- [ ] TaskDetailView shows full agent conversation
- [ ] Tool calls are rendered with input/result
- [ ] New messages stream in real-time via DaemonHub events
- [ ] Sub-sessions tab shows all group members for multi-agent steps
- [ ] Performance is acceptable for conversations with 100+ messages
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 3.3: Workflow Run History View

**Priority:** P1
**Agent type:** coder
**Depends on:** Task 1.2 (WorkflowRunView)

### Description

Create a history view showing all past workflow runs for a space, with the ability to inspect completed, cancelled, and failed runs. This is the "activity feed" for Space workflows.

### Subtasks

1. Add a "Run History" section to the `WorkflowRunView` (or a separate `WorkflowRunHistory.tsx`) that shows:
   - Chronological list of all workflow runs (paginated, 20 per page)
   - Run summary: title, status, workflow name, duration (createdAt -> completedAt), step count
   - Click expands to show the step execution timeline (which steps were executed, in what order, with timestamps)
   - Each step shows: step name, task count, status, duration
2. Add filtering by: workflow, status, date range.
3. Add a `spaceWorkflowRun.list` enhancement to support pagination and sorting (or do it client-side from the existing list).
4. Cross-reference `space_tasks` with `workflowRunId` to build the step timeline.

### Files to modify/create

- `packages/web/src/components/space/WorkflowRunHistory.tsx` -- NEW (or extend WorkflowRunView)
- `packages/web/src/lib/space-store.ts` -- Add filtered/sorted run signals

### Implementation approach

The `workflowRuns` signal in SpaceStore already has all runs. The `tasksByWorkflowRunId` computed groups tasks by run. Cross-reference `task.workflowNodeId` with `workflow.nodes` to build the step timeline. Duration is computed from `task.startedAt` and `task.completedAt`.

### Edge cases

- Run with 50+ steps (long cycle) -- paginate step timeline.
- Run referencing a deleted workflow -- show "Workflow deleted" but still display step names from task data.
- Run with no tasks (orphaned) -- show "No step data available."

### Testing

- Component test: History list renders all runs with correct metadata.
- Component test: Step timeline shows correct step order and durations.
- Component test: Filtering works (status, workflow, date).
- Component test: Pagination works.

### Acceptance criteria

- [ ] History view shows all past runs
- [ ] Each run shows status, duration, step count
- [ ] Step timeline is expandable and shows execution order
- [ ] Filtering by status and workflow works
- [ ] Runs referencing deleted workflows still display step names
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 3.4: Step Execution Timeline in WorkflowRunView

**Priority:** P1
**Agent type:** coder
**Depends on:** Task 1.2 (WorkflowRunView), Task 3.1 (real-time events)

### Description

Add a visual step execution timeline to the `WorkflowRunView` that shows the workflow graph with live status indicators for each node. This combines the workflow definition (nodes, transitions) with runtime state (which step is active, which are completed) to create a real-time execution map.

### Subtasks

1. Add a "Timeline" panel to `WorkflowRunView` that renders the workflow graph as a linear timeline:
   - Each node is a step card showing: name, agent, status indicator (pending/active/completed/skipped), duration
   - Transitions are shown as connectors between step cards
   - Active step has a pulsing indicator
   - Completed steps have a checkmark
   - Failed/skipped steps have an X or warning icon
2. Animate status transitions: when a step completes, the timeline scrolls to the next active step.
3. Show the iteration count for cyclic workflows (e.g., "Iteration 2/3").
4. For multi-agent parallel steps, show sub-task status within the step card.

### Files to modify

- `packages/web/src/components/space/WorkflowRunView.tsx` -- Add timeline panel
- `packages/web/src/components/space/visual-editor/WorkflowNode.tsx` -- Reuse or adapt node rendering

### Implementation approach

The workflow definition provides the full node list and transitions. The `currentNodeId` on the run tells which step is active. Cross-reference with `tasksByWorkflowRunId` to get per-step task statuses. The timeline is a simplified, linear view of the visual editor -- not the full canvas.

### Edge cases

- Workflow with 10+ nodes -- timeline should scroll or wrap.
- Parallel multi-agent steps -- show all sub-tasks within the step card.
- Cyclic workflow on iteration 3/3 -- show iteration counter prominently.

### Testing

- Component test: Timeline renders all workflow nodes in order.
- Component test: Active step has pulsing indicator.
- Component test: Completed steps show checkmark.
- Component test: Iteration counter displays correctly.
- Component test: Multi-agent steps show sub-task status.

### Acceptance criteria

- [ ] Step timeline renders workflow graph as linear cards
- [ ] Active step has visual indicator
- [ ] Completed/failed steps have appropriate icons
- [ ] Iteration counter shows for cyclic workflows
- [ ] Multi-agent steps show sub-task status
- [ ] Timeline auto-scrolls on step transition
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 3.5: Run-Level Debugging Information

**Priority:** P2
**Agent type:** coder
**Depends on:** Task 3.1 (real-time events), Task 3.4 (timeline)

### Description

Add a "Debug" section to the `WorkflowRunView` that shows technical details useful for debugging workflow execution issues: raw executor state, condition evaluation results, notification history, and tick timing.

### Subtasks

1. Add a collapsible "Debug" section to `WorkflowRunView`:
   - Show `run.config` (filtered to remove internal keys starting with `_`).
   - Show `run.iterationCount` / `run.maxIterations`.
   - Show last notification from the Space Agent (from the notification dedup set).
   - Show tick timing (time between `executeTick()` calls).
2. Add a "raw state" view that serializes the `WorkflowExecutor`'s current state (current node, outgoing transitions, last condition evaluation result).
3. Add a "Run Log" that shows a chronological list of events: step started, step completed, condition evaluated, gate blocked, etc. Store these in a new `workflow_run_events` table.

### Files to modify/create

- `packages/web/src/components/space/WorkflowRunView.tsx` -- Add debug section
- `packages/daemon/src/storage/schema/migrations.ts` -- Add `workflow_run_events` table
- `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- Log events to table
- `packages/daemon/src/storage/repositories/` -- New repository for run events

### Implementation approach

Create a lightweight `workflow_run_events` table with columns: `id`, `run_id`, `event_type`, `data` (JSON), `created_at`. The `WorkflowExecutor.advance()` method and `SpaceRuntime.processRunTick()` emit events to this table. The debug view fetches and displays them.

### Edge cases

- High-frequency events (e.g., tick every 5s) -- limit stored events to the last 1000 per run.
- Very long-running workflows (weeks) -- add TTL-based cleanup.

### Testing

- Unit test: Events are written to the table on advance.
- Unit test: Debug section fetches and displays events.
- Unit test: Event count is capped at 1000 per run.

### Acceptance criteria

- [ ] Debug section shows run config (filtered)
- [ ] Debug section shows iteration count
- [ ] Run log shows chronological events
- [ ] Events are stored in DB and survive restart
- [ ] Event count is capped to prevent unbounded growth
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
