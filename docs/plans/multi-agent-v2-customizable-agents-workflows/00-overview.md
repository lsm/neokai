# Multi-Agent V2: Customizable Agents & Workflows — Spaces

## Goal

Build a new **Spaces** system — a fully parallel, isolated multi-agent workflow container. Spaces allow users to create custom agents with configurable names, models, providers, tools, and system prompts. These agents can be composed into custom workflows that define agent interactions, runtime gates, and rules. A pure data layer underpins everything, enabling future sharing and marketplace capabilities.

## Isolation Principle

**No existing code is modified.** Spaces are an entirely new parallel system that coexists with the existing Rooms implementation:

- **New DB tables**: `spaces`, `space_agents`, `space_workflows`, `space_workflow_steps`, `space_tasks`, `space_goals`, `space_session_groups`, `space_session_group_members` — no modifications to any existing table (no ALTER TABLE on `tasks`, `goals`, `rooms`, etc.)
- **New API routes**: `space.*`, `spaceAgent.*`, `spaceWorkflow.*`, `spaceExport.*`, `spaceImport.*` — no touching existing RPC handlers
- **New frontend pages/components**: `/space/:spaceId` routes, new islands, new stores — no modifying existing UI components. All Space UI lives under `packages/web/src/components/space/`
- **New navigation entry point**: "Spaces" section in sidebar alongside existing "Rooms"
- **New runtime**: `SpaceRuntime` in `packages/daemon/src/lib/space/runtime/` — workflow-first orchestration engine, no modifications to `RoomRuntime`
- **New types**: All Space types in `packages/shared/src/types/space.ts` — no modifications to `packages/shared/src/types/neo.ts`
- **New managers/repos**: All under `packages/daemon/src/lib/space/` and `packages/daemon/src/storage/repositories/space-*` — no modifications to existing managers or repositories

Existing code (rooms, agents, sessions, components, routes, tables) can be **imported** (e.g., reusing `AgentSessionInit` interfaces, `Bun.spawn` patterns) but never **modified**.

## High-Level Approach

1. **Space Foundation** — new `spaces` table and full supporting infrastructure (tasks, goals, session groups, agents, workflows) all created in a **single migration** since there are no existing tables to worry about. `space_tasks` has `custom_agent_id`, `workflow_id`, `workflow_step_id` columns built in from the start. `space_goals` has `workflow_id` built in. Spaces require a **workspace path** at creation time.

2. **Custom Agent Definitions** — a `space_agents` table so users can define agents with arbitrary names, models, tools, and system prompts. Each agent belongs to a Space. Managed by `SpaceAgentManager`.

3. **Custom Workflows** — `space_workflows` and `space_workflow_steps` tables (created in the M1 migration) with `SpaceWorkflowRepository` and `SpaceWorkflowManager` in `packages/daemon/src/lib/space/`. Workflows define sequences of agent steps, runtime gates, and rules. All types in `space.ts`.

4. **SpaceRuntime** — a new workflow-first orchestration engine in `packages/daemon/src/lib/space/runtime/`. Unlike `RoomRuntime` which has a hardcoded planner-coder-leader flow, `SpaceRuntime` is designed from the ground up for workflow-driven orchestration via `WorkflowExecutor`. Managed by `SpaceRuntimeService`.

5. **Frontend** — a fresh, minimalist UI using the 3-column layout pattern. Creative design that feels focused and purposeful, not a copy of the existing Room UI. All components under `packages/web/src/components/space/`.

6. **Data Layer & Sharing Foundation** — export/import format for agents and workflows via `spaceExport.*`/`spaceImport.*` RPC routes. Export format uses `spaceId` context. All types in `space.ts`, handlers in `space-export-import-handlers.ts`, UI in `packages/web/src/components/space/`.

## Key Architectural Decisions

### 1. AgentType Preservation (no type widening)

The existing `AgentType = 'coder' | 'general'` union is **kept as-is**. Custom agents are referenced exclusively via the `customAgentId?: string` field on `SpaceTask`. Resolution logic: if `customAgentId` is set, resolve from `SpaceAgentManager`; otherwise, use the existing `assignedAgent` (`AgentType`) path. This preserves type safety in all existing code.

### 2. WorkflowExecutor Operates at the Goal Level

The `WorkflowExecutor` orchestrates **goal-level** workflow progression within Spaces:
- A `SpaceGoal` has an associated workflow (e.g., Step 1: Planner, Step 2: Coder, Step 3: Security Reviewer)
- Each workflow step produces one or more `SpaceTask` records. When a step completes, the executor evaluates the exit gate and advances to the next step.
- **The Leader role is preserved per group.** Every Worker group still gets a Leader session for review. Custom agents with `role: 'reviewer'` are specialized Workers whose output is reviewed by the Leader.
- The `WorkflowExecutor` hooks into the **goal completion** path within `SpaceRuntime`: when a task completes (Leader approves), the executor checks if the current step is done and whether to advance.

### 3. Gate Security Model

Shell-executing gates (`quality_check`, `custom`) pose security risks:
- **Command allowlisting**: `quality_check` gates only accept predefined commands from a configurable allowlist
- **Custom gate restrictions**: scripts must be within the workspace directory (no `..`, no absolute paths outside workspace)
- **Execution timeout**: Default 60s, max 300s, enforced via `Bun.spawn`
- **Authorization**: Only space owners can define `custom` gates with shell commands

### 4. Single Migration Strategy

All schema changes are in a **single migration** since everything is new:
- Creates all Space-related tables: `spaces`, `space_agents`, `space_workflows`, `space_workflow_steps`, `space_tasks`, `space_goals`, `space_session_groups`, `space_session_group_members`
- `space_tasks` has `custom_agent_id`, `workflow_id`, `workflow_step_id` columns built in from the start
- `space_goals` has `workflow_id` built in from the start
- **No ALTER TABLE** on any existing table

### 5. Agent Referencing Convention

Unified naming for agent references:
- `agentRef: string` + `agentRefType: 'builtin' | 'custom'` — used on `WorkflowStep` for workflow definitions
- `customAgentId?: string` on `SpaceTask` — task-level custom agent assignment
- `assignedAgent: AgentType` on `SpaceTask` — built-in agent assignment
- The `agentRef`/`agentRefType` pair is the canonical way to reference agents in workflow definitions. `customAgentId` is the runtime assignment mechanism.

### 6. Space Creation Requires Workspace Path

Spaces require a **workspace path** at creation time — the directory where agents operate. Validation:
- Path must exist on disk (via `fs.access`)
- Path must be unique across active spaces (prevent agent conflicts from two spaces sharing a directory)
- Path should be a git repository (warning if not, since agents need git workflow)
- Symlinks resolved to real path before uniqueness check

## Milestones

1. **Space Core Data Model & Infrastructure** — All Space types in `space.ts`, single DB migration (all tables), repositories, managers, RPC handlers for Space container + tasks + goals + session groups.
2. **Custom Agent Data & Runtime** — Agent types in `space.ts`, `SpaceAgentRepository`, `SpaceAgentManager`, agent RPC handlers, `createCustomAgentInit()` factory, agent resolution helper.
3. **Workflow Data Model** — Workflow/step/gate/rule types in `space.ts`, `SpaceWorkflowRepository` and `SpaceWorkflowManager` in `packages/daemon/src/lib/space/`, workflow RPC handlers (`spaceWorkflow.*`), built-in templates in `packages/daemon/src/lib/space/workflows/`.
4. **Workflow Runtime Engine** — `WorkflowExecutor` in `packages/daemon/src/lib/space/runtime/`, `SpaceRuntime` orchestration engine, `SpaceRuntimeService`, gate evaluation with security enforcement, step advancement, rule injection.
5. **Space Frontend Foundation** — Navigation entry point, URL routing, `SpaceStore`, Space creation UX with workspace path picker, minimalist 3-column layout shell (right pane shows placeholder states until M4 makes it functional).
6. **Frontend: Agent & Workflow UI** — Agent creation/editing, visual workflow builder, rules editor — all under `packages/web/src/components/space/`.
7. **Workflow Selection & Intelligence** — `SpaceGoalManager` workflow assignment, auto-selection logic in `packages/daemon/src/lib/space/runtime/`, Space agent tools in `packages/daemon/src/lib/space/tools/`, prompt enhancement.
8. **Export/Import & Sharing Foundation** — Export format types in `space.ts`, `spaceExport.*`/`spaceImport.*` RPC handlers in `space-export-import-handlers.ts`, frontend UI under `packages/web/src/components/space/`.

## Cross-Milestone Dependencies and Sequencing

- **M1 must complete before M2, M3, M4, M5**: everything depends on the core data model
- **M2 and M3 can proceed in parallel** once M1 is done (agents and workflows are independent data models)
- **M4 depends on both M2 and M3**: SpaceRuntime needs agent resolution and workflow definitions
- **M5 depends on M1**: frontend needs core RPC endpoints (right pane shows placeholder/empty states until M4 provides a running runtime)
- **M6 depends on M2, M3, and M5**: UI needs agent/workflow RPCs and the Space frontend shell
- **M7 depends on M4**: selection needs the runtime engine
- **M8 depends on M2 and M3**: export/import needs both data models

```
M1 (Space Core) ──┬──→ M2 (Agent Data & Runtime) ──┬──→ M4 (SpaceRuntime Engine) → M7 (Selection)
                   │                                 │
                   ├──→ M3 (Workflow Data) ──────────┘
                   │         │
                   │         ├──→ M8 (Export/Import)
                   │
                   ├──→ M5 (Frontend Foundation) ──→ M6 (Agent & Workflow UI)
                   │
                   └──→ (M2, M3, M5 can run in parallel)
```

Note: M5 builds a functional shell with placeholder states for the right pane (task conversations). The right pane becomes fully functional after M4 (SpaceRuntime) is implemented.

## Total Estimated Task Count

26 tasks across 8 milestones.
