# Space Workflow System -- End-to-End Delivery Plan

> **Design revalidation notice:** This plan was written against commit `81970139c` on `main`. Before executing any task, revalidate the file paths, function signatures, and architectural assumptions against the tip of `main` -- they may have drifted.

## Goal Summary

Answer the question: "What are ALL the pieces needed for a human to define a multi-agent workflow in Space, save it, run it on a real task, and watch it complete end-to-end?"

The Space workflow system already has substantial infrastructure. This plan focuses on the **gaps that prevent a user from successfully defining, running, and observing a workflow to completion** -- not on Room parity.

## What Already Works (Codebase Baseline)

The following are confirmed implemented and working:

| Layer | Component | Key File(s) |
|-------|-----------|-------------|
| **Definition** | Workflow type system (nodes, transitions, conditions, channels, rules, layout) | `packages/shared/src/types/space.ts` |
| **Definition** | Repository CRUD with JSON columns for agents/channels | `packages/daemon/src/storage/repositories/space-workflow-repository.ts` |
| **Definition** | Manager validation (unique name, agent refs, graph integrity, channel refs) | `packages/daemon/src/lib/space/managers/space-workflow-manager.ts` |
| **Definition** | 3 built-in templates (Coding 4-node, Research 2-node, Review-Only 1-node) | `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` |
| **Definition** | Visual drag-drop editor with canvas, serialization, layout | `packages/web/src/components/space/visual-editor/` |
| **Definition** | Export/import (`SpaceExportBundle`, agent + workflow portability) | `packages/daemon/src/lib/space/export-format.ts` |
| **Execution** | `WorkflowExecutor` -- graph nav, 4 condition types, iteration cap, retry | `packages/daemon/src/lib/space/runtime/workflow-executor.ts` |
| **Execution** | `SpaceRuntime` -- tick loop, executor rehydration, task spawning | `packages/daemon/src/lib/space/runtime/space-runtime.ts` |
| **Execution** | `TaskAgentManager` -- session hierarchy, spawn/rehydrate/cleanup | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` |
| **Execution** | 7 MCP tools: spawn_step_agent, check_step_status, advance_workflow, report_result, request_human_input, list_group_members, send_message | `packages/daemon/src/lib/space/tools/task-agent-tools.ts` |
| **Execution** | `ChannelResolver` -- per-step channel topology validation | `packages/daemon/src/lib/space/runtime/channel-resolver.ts` |
| **Execution** | `SessionNotificationSink` -- deferred event delivery to Space Agent | `packages/daemon/src/lib/space/runtime/session-notification-sink.ts` |
| **Persistence** | Tables: space_workflows, space_workflow_runs, space_tasks, space_session_groups, space_session_group_members | `packages/daemon/src/storage/schema/migrations.ts` |
| **Frontend** | SpaceStore with workflow/workflowRun signals, DaemonHub events | `packages/web/src/lib/space-store.ts` |
| **Frontend** | WorkflowEditor, WorkflowList, WorkflowNodeCard, WorkflowRulesEditor | `packages/web/src/components/space/` |
| **RPC** | spaceWorkflow.*, spaceWorkflowRun.*, spaceTask.*, spaceTaskMessage.* | `packages/daemon/src/lib/rpc-handlers/space-*-handlers.ts` |

## Identified Real Gaps

### Critical (blocks basic end-to-end execution)

1. **No "Run Workflow" UI trigger** -- `spaceWorkflowRun.start` RPC exists, `SpaceStore.startWorkflowRun()` exists, but no button or flow in the frontend to start a workflow run.
2. **No workflow run detail view** -- `workflowRuns` signal exists in SpaceStore but no component to display a run's current step, status, tasks, or history.
3. **No task detail/conversation view** -- SpaceTaskPane shows a task list but no detail panel with agent output, logs, or error messages.
4. **Tick loop not persistent across daemon restarts** -- Uses `setInterval`; workflows stall if SpaceRuntimeService fails to recreate all runtimes after restart.
5. **No dead loop detection beyond `maxIterations`** -- Cycles without `isCyclic` flag or repeated gate failures cause repeated `needs_attention` notification loops.
6. **Rate/usage limit errors not handled at workflow level** -- Step agent errors mark group member as `failed` but no automatic retry or `rate_limited` status at run level.

### High (blocks reliable real-world usage)

7. **No workflow run history inspection** -- Data exists in DB but no UI for reviewing past runs.
8. **Human gate approval not in frontend** -- `human` condition type exists, `request_human_input` tool exists, but no UI surface to approve gates or answer questions.
9. **No workflow pause/resume** -- Only cancel exists; no pause-and-inspect capability.
10. **Task Agent re-orientation after restart is fragile** -- Depends on model correctly interpreting re-orientation message.

### Medium (blocks advanced usage)

11. **No workflow versioning** -- Editing a definition while a run is active can break the run.
12. **No cron scheduling** -- Workflows can only be started manually.
13. **No goal/mission integration** -- `goalId` field exists but is write-only; no bidirectional link.
14. **No dynamic reconfiguration** -- Cannot modify running workflows.

## Milestones

| # | Milestone | Goal | Tasks |
|---|-----------|------|-------|
| 1 | **Workflow Execution MVP** | User can define, save, and run a workflow to completion from the UI | 6 |
| 2 | **Workflow Reliability** | Workflows survive errors, restarts, and edge cases | 5 |
| 3 | **Workflow Monitoring and Debugging** | Users can see what workflows are doing in real time | 5 |
| 4 | **Human-in-the-Loop** | Humans can approve gates and interact with running workflows | 4 |
| 5 | **Advanced Workflow Features** | Versioning, scheduling, goal integration, templates | 5 |

**Total: 25 tasks across 5 milestones. Estimated 22 coder sessions + 3 general/design sessions.**

## Cross-Milestone Dependencies

```
M1 (MVP)
  +--> M2 (Reliability)  -- can start after MVP is working
  +--> M3 (Monitoring)   -- can start after MVP is working (in parallel with M2)
        +--> M4 (Human-in-the-Loop) -- needs monitoring to be useful
M2 +--> M5 (Advanced)     -- needs reliability to be stable
M4 +--> M5 (Advanced)
```

## Key Sequencing Decisions

1. **Task 1.1 (Run trigger) is THE most important task** -- without it, nothing can be tested end-to-end.
2. **Task 1.2 (Run detail view) before Task 1.3 (Task detail view)** -- users need to see run progress first.
3. **Dead loop detection (Task 2.1) before rate limit handling (Task 2.2)** -- dead loops are more common and damaging.
4. **Notification events (Task 3.1) before run history (Task 3.3)** -- real-time is more valuable for debugging.

## Architecture Diagram

```
Human (browser)
  |
  v
Space UI (Preact + Signals)
  |-- VisualWorkflowEditor  (define workflows -- WORKS)
  |-- [NEW] WorkflowRunView (monitor execution -- Task 1.2)
  |-- [NEW] TaskDetailView   (inspect agent output -- Task 1.3)
  |-- [NEW] HumanGateDialog  (approve gates -- Task 4.2)
  |
  v  (MessageHub RPC + pub/sub)
Daemon
  |
  |-- SpaceRuntimeService  (lifecycle management)
  |     |-- SpaceRuntime     (tick loop, executor management)
  |     |     |-- WorkflowExecutor   (graph navigation)
  |     |     |-- NotificationSink   (event delivery)
  |     |-- TaskAgentManager  (Task Agent + sub-sessions)
  |     |-- ChannelResolver   (messaging permissions)
  |
  |-- DaemonHub  (event bus)
  |-- MessageHub  (WebSocket RPC)
```

## Milestone Files

- [`01-workflow-execution-mvp.md`](01-workflow-execution-mvp.md) -- M1: Run trigger + views + basic e2e
- [`02-workflow-reliability.md`](02-workflow-reliability.md) -- M2: Dead loops, persistence, rate limits, error handling
- [`03-workflow-monitoring-debugging.md`](03-workflow-monitoring-debugging.md) -- M3: Real-time events, run history, task inspection
- [`04-human-in-the-loop.md`](04-human-in-the-loop.md) -- M4: Gate approval, message routing, pause/resume
- [`05-advanced-workflow-features.md`](05-advanced-workflow-features.md) -- M5: Versioning, cron, goals, templates
- [`06-room-parity-reference.md`](06-room-parity-reference.md) -- Appendix: Room parity brief reference
