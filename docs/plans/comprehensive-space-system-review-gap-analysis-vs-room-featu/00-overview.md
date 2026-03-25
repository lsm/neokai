# Space Workflow System -- End-to-End Delivery Plan

> **Design revalidation notice:** This plan was written against commit `81970139c` on `main`. Before executing any task, revalidate the file paths, function signatures, and architectural assumptions against the tip of `main` -- they may have drifted.

## Goal Summary

Answer the question: "What are ALL the pieces needed for a human to define a multi-agent workflow in Space, save it, run it on a real task, and watch it complete end-to-end?"

The Space workflow system already has substantial infrastructure. This plan focuses on the **gaps that prevent a user from successfully defining, running, and observing a workflow to completion** -- not on Room parity.

A critical prerequisite (Task 0) evaluates whether the existing 4 condition types are sufficient for the user vision of flexible, user-defined workflows. All subsequent tasks depend on this assessment.

## What Already Works (Codebase Baseline)

The following are confirmed implemented and working:

| Layer | Component | Key File(s) |
|-------|-----------|-------------|
| **Definition** | Workflow type system (nodes, transitions, conditions, channels, rules, layout) | `packages/shared/src/types/space.ts` |
| **Definition** | Repository CRUD with JSON columns for agents/channels | `packages/daemon/src/storage/repositories/space-workflow-repository.ts` |
| **Definition** | Manager validation (unique name, agent refs, graph integrity, channel refs) | `packages/daemon/src/lib/space/managers/space-workflow-manager.ts` |
| **Definition** | 3 built-in templates (Coding 4-node, Research 2-node, Review-Only 1-node) | `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` |
| **Definition** | Visual drag-drop editor with canvas, serialization, layout, node/edge CRUD | `packages/web/src/components/space/visual-editor/` |
| **Definition** | Export/import (`SpaceExportBundle`, agent + workflow portability) | `packages/daemon/src/lib/space/export-format.ts` |
| **Execution** | `WorkflowExecutor` -- graph nav, 4 condition types, iteration cap, retry | `packages/daemon/src/lib/space/runtime/workflow-executor.ts` |
| **Execution** | `SpaceRuntime` -- tick loop, executor rehydration, task spawning | `packages/daemon/src/lib/space/runtime/space-runtime.ts` |
| **Execution** | `TaskAgentManager` -- session hierarchy, spawn/rehydrate/cleanup | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` |
| **Execution** | 7 MCP tools: spawn_step_agent, check_step_status, advance_workflow, report_result, request_human_input, list_group_members, send_message | `packages/daemon/src/lib/space/tools/task-agent-tools.ts` |
| **Execution** | `ChannelResolver` -- per-step channel topology validation | `packages/daemon/src/lib/space/runtime/channel-resolver.ts` |
| **Execution** | `SessionNotificationSink` -- deferred event delivery to Space Agent | `packages/daemon/src/lib/space/runtime/session-notification-sink.ts` |
| **Persistence** | Tables: space_workflows, space_workflow_runs, space_tasks, space_session_groups, space_session_group_members | `packages/daemon/src/storage/schema/migrations.ts` |
| **Frontend** | SpaceStore with workflow/workflowRun signals, DaemonHub events | `packages/web/src/lib/space-store.ts` |
| **Frontend** | WorkflowEditor, WorkflowList, WorkflowNodeCard, WorkflowRulesEditor, VisualWorkflowEditor | `packages/web/src/components/space/` |
| **RPC** | spaceWorkflow.*, spaceWorkflowRun.*, spaceTask.*, spaceTaskMessage.* | `packages/daemon/src/lib/rpc-handlers/space-*-handlers.ts` |

### What the Visual Editor Already Supports

The `VisualWorkflowEditor` (`packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx`) already provides:

- **Create workflows from scratch** -- empty canvas with add/remove nodes
- **Drag-drop nodes** with auto-layout and manual positioning
- **Edge creation** via port drag between nodes
- **Edge condition configuration** via `EdgeConfigPanel` (set type: always/human/condition/task_result, expression, description)
- **Node configuration** via `NodeConfigPanel` (agent assignment, multi-agent `agents[]`, instructions, channels)
- **Start node designation**
- **Tags and rules** via `WorkflowRulesEditor`
- **Serialization/deserialization** round-trip with layout persistence
- **Template-based creation** via `TEMPLATES` in `WorkflowEditor.tsx`

The visual editor is fully functional for creating user-defined workflow topologies. Users can already create sequential chains, fan-out patterns (multi-agent nodes), conditional branching (multiple transitions with different conditions), and cyclic workflows. This plan does NOT need tasks for basic workflow definition UI.

### Known Editor Limitations (acknowledged, not in scope for this plan)

- No sub-workflow composition (workflows calling other workflows)
- No visual rendering of workflow run state overlaid on the editor canvas
- No drag-and-drop from a template gallery directly into the editor
- No undo/redo for canvas operations

## Identified Real Gaps

### Critical (blocks basic end-to-end execution)

1. **No assessment of workflow model expressiveness** -- The 4 condition types (`always`, `human`, `condition`, `task_result`) may be insufficient for common patterns (AND gates, quorum gates, time-based gates, error routing). Without this assessment, we risk building execution infrastructure around an insufficient definition model. (Task 0)
2. **No "Run Workflow" UI trigger** -- `spaceWorkflowRun.start` RPC exists, `SpaceStore.startWorkflowRun()` exists, but no button or flow in the frontend to start a workflow run.
3. **No workflow run detail view** -- `workflowRuns` signal exists in SpaceStore but no component to display a run's current step, status, tasks, or history.
4. **No task detail/conversation view** -- SpaceTaskPane shows a task list but no detail panel with agent output, logs, or error messages.
5. **Missing task status transitions** -- `VALID_SPACE_TASK_TRANSITIONS` in `space-task-manager.ts:26` does NOT include `in_progress -> rate_limited` or `in_progress -> usage_limited`. Attempting to set these statuses will throw.
6. **Tick loop not persistent across daemon restarts** -- Uses `setInterval`; workflows stall if SpaceRuntimeService fails to recreate all runtimes after restart.
7. **Rate/usage limit errors not handled at workflow level** -- Step agent errors mark group member as `failed` but no automatic retry or `rate_limited` status at run level.

### High (blocks reliable real-world usage)

8. **No dead loop detection beyond `maxIterations`** -- Cycles without `isCyclic` flag or repeated gate failures cause repeated `needs_attention` notification loops.
9. **Human gate approval not in frontend** -- `human` condition type exists, `request_human_input` tool exists, but no UI surface to approve gates or answer questions.
10. **No workflow pause/resume** -- Only cancel exists; no pause-and-inspect capability.

### Medium (blocks advanced usage)

11. **No workflow versioning** -- Editing a definition while a run is active can break the run.
12. **No dynamic reconfiguration** -- Cannot modify running workflows.
13. **No template gallery** -- Users can create from built-in templates but cannot browse or share custom templates.

## Pre-Milestone: Task 0 (Design Assessment)

Task 0 is a prerequisite design task that must be completed before M1 implementation begins. It evaluates whether the current workflow model supports the user vision and proposes additions if gaps are found.

## Milestones

| # | Milestone | Goal | Tasks |
|---|-----------|------|-------|
| 0 | **Workflow Model Assessment** | Evaluate condition types vs. user patterns; propose additions if needed | 1 |
| 1 | **Workflow Execution MVP** | User can define, save, and run a user-defined workflow to completion from the UI | 6 |
| 2 | **Workflow Reliability** | Workflows survive errors, restarts, and edge cases | 5 |
| 3 | **Workflow Monitoring and Debugging** | Users can see what workflows are doing in real time | 3 |
| 4 | **Human-in-the-Loop** | Humans can approve gates and interact with running workflows | 3 |
| 5 | **Advanced Workflow Features** | Versioning, templates, dynamic reconfiguration | 3 |

**Total: 21 tasks across 6 milestones (1 design + 5 implementation). Estimated 18 coder sessions + 3 general/design sessions.**

Tasks moved to the appendix (not workflow-execution prerequisites):
- Task 3.2 (Conversation Inspector) -- nice-to-have debugging feature
- Task 3.3 (Run History View) -- nice-to-have monitoring feature
- Task 4.4 (Space Agent Orchestration) -- Room-like leader coordination pattern
- Task 5.2 (Cron Scheduling) -- Room cron-utils port
- Task 5.3 (Goal/Mission Integration) -- Room GoalManager bridge

## Cross-Milestone Dependencies

```
Task 0 (Design Assessment) -- must complete before any implementation
  |
  v
M1 (MVP)
  +--> M2 (Reliability)  -- can start after MVP is working
  +--> M3 (Monitoring)   -- can start after MVP is working (in parallel with M2)
        +--> M4 (Human-in-the-Loop) -- needs monitoring events
M2 +--> M5 (Advanced)     -- needs reliability to be stable
```

## Key Sequencing Decisions

1. **Task 0 (Model Assessment) gates everything** -- without confirming the condition type model is sufficient, we risk building execution infrastructure around the wrong abstractions.
2. **Task 1.1 (Run trigger) is the most important implementation task** -- without it, nothing can be tested end-to-end.
3. **Task 1.2 (Run detail view) before Task 1.3 (Task detail view)** -- users need to see run progress first.
4. **Dead loop detection (Task 2.1) before rate limit handling (Task 2.2)** -- dead loops are more common and damaging.
5. **Transition map fix must precede Task 2.2** -- `in_progress -> rate_limited` transition must be added before the rate limit handler can set that status.
6. **Real-time events (Task 3.1) before step timeline (Task 3.2)** -- timeline depends on live event streaming.

## Architecture Diagram

```
Human (browser)
  |
  v
Space UI (Preact + Signals)
  |-- VisualWorkflowEditor  (define workflows -- WORKS)
  |-- [NEW] WorkflowRunView (monitor execution -- Task 1.2)
  |-- [NEW] TaskDetailView   (inspect agent output -- Task 1.3)
  |-- [NEW] HumanGateDialog  (approve gates -- Task 4.1)
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

- [`00a-workflow-model-assessment.md`](00a-workflow-model-assessment.md) -- Task 0: Design assessment of workflow condition types
- [`01-workflow-execution-mvp.md`](01-workflow-execution-mvp.md) -- M1: Run trigger + views + basic e2e + user-defined topology
- [`02-workflow-reliability.md`](02-workflow-reliability.md) -- M2: Dead loops, persistence, rate limits, error handling
- [`03-workflow-monitoring-debugging.md`](03-workflow-monitoring-debugging.md) -- M3: Real-time events, step timeline, run debugging
- [`04-human-in-the-loop.md`](04-human-in-the-loop.md) -- M4: Gate approval, message routing, pause/resume
- [`05-advanced-workflow-features.md`](05-advanced-workflow-features.md) -- M5: Versioning, templates, dynamic reconfiguration
- [`06-room-parity-reference.md`](06-room-parity-reference.md) -- Appendix: Room parity reference + deferred tasks
