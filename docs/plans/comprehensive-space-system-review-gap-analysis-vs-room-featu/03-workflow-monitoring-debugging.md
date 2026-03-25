# M3: Workflow Monitoring and Debugging

> **Design revalidation notice:** Before implementing any task, revalidate file paths, function signatures, and integration points against the current codebase.

**Milestone goal:** After this milestone, users can see real-time updates for workflow runs via DaemonHub events, view a step execution timeline overlaid on the workflow graph, and access debug-level information for troubleshooting.

**Scope:** Real-time DaemonHub events for task/run state, step execution timeline, and run-level debugging information.

**Note:** Task 3.2 (Conversation Inspector) and Task 3.3 (Run History View) have been moved to the appendix as they are monitoring niceties, not prerequisites for workflow execution or reliability.

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

## Task 3.2: Step Execution Timeline in WorkflowRunView

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

## Task 3.3: Run-Level Debugging Information

**Priority:** P2
**Agent type:** coder
**Depends on:** Task 3.1 (real-time events), Task 3.2 (timeline)

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

### Design Note (P2 from review)

The review suggested evaluating whether DaemonHub events (already pub/sub, already consumed by the frontend) can be used for the debug view instead of creating a parallel persistence mechanism. Consider this: DaemonHub events are ephemeral (in-memory, lost on restart). For debugging, we need persistent events that survive daemon restarts and can be reviewed after the fact. Therefore, a `workflow_run_events` DB table is still warranted for the "Run Log" feature. However, the real-time timeline (Task 3.2) should use DaemonHub events for live updates.

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
