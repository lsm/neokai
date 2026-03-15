# Multi-Agent V2: Customizable Agents & Workflows

## Goal

Enable full user customization of multi-agent behavior in NeoKai rooms. Users should be able to create custom agents with configurable names, models, providers, tools, and system prompts. These agents can be composed into custom workflows that define agent interactions, runtime gates, and rules. A pure data layer underpins everything, enabling future sharing and marketplace capabilities.

## High-Level Approach

The current system has four hardcoded agent roles (Planner, Coder, General, Leader) stored via `room.config.agentModels` and `room.config.agentSubagents`. Workflows are implicit in the `RoomRuntime` tick loop: goal -> planning group -> task execution group -> review cycle.

This plan introduces:

1. **Custom Agent Definitions** -- a new `custom_agents` table and corresponding types so users can define agents with arbitrary names, models, tools, and system prompts. Each agent belongs to a room.

2. **Custom Workflows** -- a new `workflows` table that defines sequences of agent steps, runtime gates between steps, and rules. Workflows belong to a room and can be selected by the room agent based on task/goal context.

3. **Runtime Integration** -- the `RoomRuntime` and `TaskGroupManager` learn to resolve agent definitions from the data layer instead of only using hardcoded factories. Lifecycle hooks become configurable per-workflow step.

4. **Frontend UI** -- agent creation/editing forms, workflow builder, and workflow selection in the room dashboard. Built on top of existing `RoomAgents.tsx` patterns.

5. **Data Layer & Sharing Foundation** -- export/import format for agents and workflows, preparing for future marketplace.

## Key Architectural Decisions

### 1. AgentType Preservation (no type widening)

The existing `AgentType = 'coder' | 'general'` union is **kept as-is**. Custom agents are referenced exclusively via the `customAgentId?: string` field on `NeoTask`. This preserves type safety across all existing switch/if-else checks on `AgentType` in `room-runtime.ts`, `task-group-manager.ts`, and `lifecycle-hooks.ts`. Resolution logic: if `customAgentId` is set, resolve from `CustomAgentManager`; otherwise, use the existing `assignedAgent` (`AgentType`) path.

### 2. WorkflowExecutor Operates at the Goal Level

The `WorkflowExecutor` orchestrates **goal-level** workflow progression, not individual task progression. In the current architecture:
- A goal spawns multiple tasks (e.g., a planning task, then coding tasks)
- Each task gets its own Worker + Leader group pair
- The Leader reviews Worker output via `submit_for_review` -> `complete_task` / `send_to_worker`

With custom workflows:
- A workflow defines the step sequence for a **goal** (e.g., Step 1: Planner, Step 2: Coder, Step 3: Security Reviewer)
- Each workflow step produces one or more tasks. When a step completes (all its tasks done), the executor evaluates the exit gate and advances to the next step.
- **The Leader role is preserved per group.** Every Worker group still gets a Leader session for review. Custom agents with `role: 'reviewer'` do NOT replace the Leader — they are specialized Workers (e.g., a security review agent produces a review report, which the Leader then approves/rejects).
- The `onWorkerTerminalState` -> Leader routing -> `complete_task`/`send_to_worker` cycle remains unchanged within each group.
- The `WorkflowExecutor` hooks into the **goal completion** path: when a task completes (Leader approves), the executor checks if the current workflow step is done and whether to advance to the next step (spawning new tasks for the next agent).

### 3. Gate Security Model

Shell-executing gates (`quality_check`, `custom`) pose security risks. The plan mandates:
- **Command allowlisting**: `quality_check` gates only accept predefined commands (`bun run check`, `bun test`, etc.) from a configurable allowlist
- **Custom gate restrictions**: `custom` gates are restricted to scripts within the workspace directory and must pass basic path validation (no `..`, no absolute paths outside workspace)
- **Execution timeout**: All gate commands have a configurable timeout (default: 60s, max: 300s) enforced via `Bun.spawn` timeout
- **Authorization**: Only room owners can define `custom` gates with shell commands

### 4. Consolidated Migration Strategy

All schema changes are organized into exactly **two migrations** to avoid ordering conflicts:
- **Migration A** (Milestones 1 + 2): Creates `custom_agents` table and adds `custom_agent_id` column to `tasks`
- **Migration B** (Milestones 3 + 4 + 7): Creates `workflows` and `workflow_steps` tables, adds `workflow_id`/`current_workflow_step_id` to `tasks`, adds `workflow_id` to `goals`

Each migration gets the next sequential number in `packages/daemon/src/storage/schema/migrations.ts`. All tasks that reference "add migration" point to the relevant consolidated migration.

### 5. Agent Referencing Convention

Unified naming for agent references:
- `agentRef: string` + `agentRefType: 'builtin' | 'custom'` — used on `WorkflowStep` for workflow definitions
- `customAgentId?: string` on `NeoTask` — used for task-level custom agent assignment (when set, overrides `assignedAgent`)
- `assignedAgent: AgentType` on `NeoTask` — unchanged, used for built-in agent assignment

The `agentRef`/`agentRefType` pair is the canonical way to reference agents in workflow definitions. The `customAgentId` on `NeoTask` is the runtime assignment mechanism. These are intentionally separate: workflow steps define *which agent type* runs, and task assignment is the *runtime resolution* of that definition.

## Milestones

1. **Custom Agent Data Model** -- Define shared types, DB schema (consolidated migration A), repository, CRUD RPC handlers, and DaemonEventMap registration for custom agent definitions stored per-room.
2. **Custom Agent Runtime Integration** -- Wire custom agent definitions into `TaskGroupManager` and `RoomRuntime` so custom agents can execute tasks alongside built-in agents. Add referential integrity protection for custom agents.
3. **Workflow Data Model** -- Define shared types, DB schema (consolidated migration B), repository, CRUD RPC handlers, and DaemonEventMap registration for workflow definitions with agent steps, gates, and rules.
4. **Workflow Runtime Engine** -- Build a goal-level workflow executor that orchestrates step sequences while preserving the existing Leader/Worker group model. Includes gate security enforcement.
5. **Frontend: Agent Creation UI** -- Build the UI for creating, editing, and managing custom agents within a room. Includes shared state design for `room-store.ts`.
6. **Frontend: Workflow Builder UI** -- Build the visual workflow builder for composing agents into steps with gates and rules. Includes shared state design for `room-store.ts`.
7. **Workflow Selection & Intelligence** -- Enable room agent/goal to auto-select workflows based on task context, plus manual override. Auto-selection is an MVP heuristic with a clear path to future refinement.
8. **Data Layer: Export/Import & Sharing Foundation** -- Implement export/import of agent definitions and workflows as JSON, with version migration strategy, laying groundwork for sharing.

## Cross-Milestone Dependencies and Sequencing

- **Milestone 1 must complete before 2**: runtime integration needs the data model.
- **Milestone 3 must complete before 4**: workflow runtime needs the workflow data model.
- **Milestone 1 must complete before 5**: frontend agent UI needs CRUD RPCs and types.
- **Milestone 3 must complete before 6**: workflow builder needs the data model and RPC handlers. (M6 does **not** depend on M4 — the builder is a pure data UI.)
- **Milestones 2 and 4 must complete before 7**: auto-selection needs both custom agents and workflow runtime.
- **Milestones 1 and 3 must complete before 8**: export/import needs both data models.
- **Milestones 2 and 5 can proceed in parallel** once Milestone 1 is done.
- **Milestones 4 and 6 can proceed in parallel** once Milestone 3 is done.

```
M1 (Agent Data) --> M2 (Agent Runtime)  --+
     |                                     +--> M7 (Selection Intelligence) --> M8 (Export/Import)
     +--> M5 (Agent UI)                   |
                                          |
M3 (Workflow Data) --> M4 (Workflow Runtime) --+
     |                                         |
     +--> M6 (Workflow Builder UI)             |
                    |                          |
                    +--------------------------+
```

Note: M6 depends only on M3 (data model + RPC), not M4 (runtime). The workflow builder is a data management UI that creates/edits workflow definitions; it does not need the runtime engine.

## Total Estimated Task Count

28 tasks across 8 milestones.
