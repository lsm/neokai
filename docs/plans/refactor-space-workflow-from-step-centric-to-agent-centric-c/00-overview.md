# Refactor Space Workflow from Step-Centric to Agent-Centric Collaboration Model

## Goal Summary

Transform the Space workflow system from a sequential step/pipeline model (directed graph of nodes with `advance()` as the central nervous system) to an agent-centric collaboration model (collaboration graph of agents with gated communication channels). Agents become the primary execution units that self-direct, with gates moving from `WorkflowTransition` to `WorkflowChannel`, and completion detected by all-agents-done rather than terminal-node detection.

## Current Architecture (Step-Centric)

The current system treats workflows as directed graphs of sequential steps:

- **`WorkflowNode`** -- a step in the graph, assigned one or more agents
- **`WorkflowTransition`** -- directed edges between steps with optional `WorkflowCondition` guards (always, human, condition, task_result)
- **`SpaceWorkflowRun`** -- tracks execution with a single `currentNodeId` (one active step at a time)
- **`WorkflowExecutor.advance()`** -- the central nervous system: evaluates transitions from the current step, follows the first matching transition, creates pending tasks for the target step
- **`SpaceRuntime.executeTick()`** -- polls for completed step tasks, calls `advance()` to move forward
- **`TaskAgentManager`** -- manages Task Agent sessions (orchestrator per task) that use MCP tools (`spawn_step_agent`, `check_step_status`, `advance_workflow`, `report_result`) to drive workflows
- **`WorkflowChannel`** -- currently node-scoped messaging topology for inter-agent communication within a step (no gates, just topology)
- **`ChannelResolver`** -- validates `canSend(fromRole, toRole)` based on declared topology

Key files:
- `packages/shared/src/types/space.ts` -- all workflow types (WorkflowNode, WorkflowTransition, WorkflowCondition, WorkflowChannel, etc.)
- `packages/shared/src/types/space-utils.ts` -- ResolvedChannel, resolveNodeAgents, resolveNodeChannels, validateNodeChannels
- `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- WorkflowExecutor with advance(), condition evaluation
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- SpaceRuntime tick loop, task processing
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- Task Agent lifecycle, sub-session management
- `packages/daemon/src/lib/space/agents/task-agent.ts` -- Task Agent system prompt builder
- `packages/daemon/src/lib/space/tools/task-agent-tools.ts` -- 7 MCP tools for Task Agent
- `packages/daemon/src/lib/space/tools/step-agent-tools.ts` -- peer communication tools (list_peers, send_message)
- `packages/daemon/src/lib/space/runtime/channel-resolver.ts` -- channel topology validation
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` -- 3 built-in workflow templates
- DB tables: `space_workflows`, `space_workflow_nodes`, `space_workflow_transitions`, `space_workflow_runs`, `space_tasks`, `space_session_groups`, `space_session_group_members`

## Target Architecture (Agent-Centric Collaboration)

The target system treats workflows as collaboration graphs of agents:

1. **Workflow = collaboration graph of agents with gated communication channels**
   - Nodes become "agent pools" -- groups of agents that collaborate
   - Transitions become "gated channels" between agent pools
   - Channels carry gates (condition policies) that enforce when messages can flow

2. **Agents are primary execution units**
   - Each agent has its own session and decides what to do based on intelligence
   - The system provides guardrails (rules = behavioral prompts) and enforcement (gates = policy checks)
   - Multiple agents can fill the same role (e.g., 3 coders working in parallel)

3. **Gates move from WorkflowTransition to WorkflowChannel**
   - Channel-level gates with policy evaluation (condition checks before message delivery)
   - Gates enforce policies like "coder can't send to reviewer until PR exists and CI passes"

4. **advance() is dramatically reduced or eliminated**
   - Agents drive themselves by sending messages through gated channels
   - The executor becomes a channel-routing + gate-enforcement layer
   - Completion is detected when all agents report done

5. **Task Agent role changes**
   - Less "advance the pipeline", more "manage the collaboration"
   - Coordinates agents, monitors gates, handles human escalation

## Key Architectural Decisions

1. **Backward compatibility**: Existing workflows must continue to work. The refactoring should be additive -- the new channel-gate model coexists with the step-transition model during migration.

2. **Incremental migration**: The change is too large for a single PR. The plan uses 9 milestones, each independently deployable.

3. **Channel gates are optional**: Not all channels need gates. Unconditional channels work like current `always` transitions.

4. **Agent completion signaling**: Agents explicitly report done (via tool call), replacing the implicit "all tasks completed on step = advance" model. A timeout-based liveness guard auto-completes stuck agents (alive but forgot to call `report_done`).

5. **Gate evaluation reuses existing infrastructure**: The `WorkflowCondition` type and `evaluateCondition()` logic move to channels rather than being rewritten.

6. **Dual-model conflict resolution**: When a workflow has both transitions AND cross-node channels, cross-node channels take precedence. `advance()` becomes a no-op for such workflows. This prevents race conditions between the two models. See Task 2.6 for full specification.

7. **Lazy target-node activation**: When a cross-node channel fires but the target node has no active agents, the router lazily creates tasks/sessions for that node on demand. No pre-spawning or Task Agent orchestration needed.

8. **Structured cross-node targets only**: Cross-node `send_message` uses `{ role, node }` object syntax (no `role@node` string parsing) to avoid ambiguity.

9. **Migration numbers are dynamic**: DB migration numbers are not hardcoded in the plan (they drift over time). Implementation must use the next available migration number at implementation time.

## Milestones

1. **Channel Gate Types** -- Add gate/condition support to `WorkflowChannel`, create `ChannelGateEvaluator`, unit tests (4 tasks)
2. **Cross-Node Channel Infrastructure** -- Extend channels to span nodes, DB migration, resolution, dual-model conflict resolution (6 tasks)
3. **Agent Completion Signaling** -- New `report_done` tool, liveness guard with timeout, completion state tracking (6 tasks)
4. **Agent-Driven Advancement** -- Channel routing layer, lazy target-node activation, gated cross-node messaging (6 tasks)
5. **Completion Model Migration** -- All-agents-done detector, update SpaceRuntime tick, status lifecycle (4 tasks)
6. **Task Agent Refactoring** -- Collaboration manager prompt, `report_workflow_done`, deprecate `advance_workflow` (5 tasks)
7. **Built-in Workflow Migration** -- Migrate 3 built-in workflows to agent-centric model, backend tests (2 tasks)
8. **UI Updates** -- Visual editor for cross-node channels, gate config UI, agent completion state, web/e2e tests (4 tasks)
9. **Deprecation & Cleanup** -- Deprecation warnings, migration scripts, cleanup `advance()`, comprehensive tests (5 tasks)

## Cross-Milestone Dependencies

- Milestone 1 is standalone (types + evaluator)
- Milestone 2 depends on Milestone 1 (cross-node channels need gate support)
- Milestone 3 is largely standalone (completion signaling)
- Milestone 4 depends on Milestones 1 and 2 (needs gated cross-node channels)
- Milestone 5 depends on Milestones 3 and 4 (needs completion detection + agent-driven advancement)
- Milestone 6 depends on Milestone 5 (needs the new advancement model before refactoring Task Agent)
- Milestone 7 depends on Milestone 6 (needs new model before updating built-in workflows)
- Milestone 8 depends on Milestones 2, 3, 7 (needs cross-node types + completion state + backend migration)
- Milestone 9 depends on Milestones 6 and 7 (final cleanup after all migrations)

Key sequencing decisions:
- **Milestones 1 and 3 can be developed in parallel** (no dependencies between them)
- **Milestones 7 and 8 can be developed in parallel** (backend migration vs UI updates are independent workstreams)
- Milestone 2 can start after Milestone 1
- Milestones 4-6 are sequential
- Milestone 9 is the final milestone

## Total Estimated Task Count

42 tasks across 9 milestones (excluding Task 1.5 which is folded into acceptance criteria).
