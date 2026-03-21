# Task Agent -- Session Orchestrator for Space Tasks

## Goal

Implement the Task Agent as a long-lived conversational session that serves as the single entry point for each Space task. The Task Agent receives task assignments, runs workflows by spawning sub-sessions for each step's agent, manages the task lifecycle, and acts as the conversation facade for human and Space Agent interactions.

## High-Level Approach

The implementation follows a bottom-up strategy: first define the data model extensions and types, then build the core Task Agent session and its MCP tools, then integrate with SpaceRuntime's tick loop, and finally wire up communication between Space Agent and Task Agent.

The Task Agent is a new session type (`space_task_agent`) that:
- Is created one-per-task when a SpaceTask transitions to `in_progress`
- Has MCP tools for workflow orchestration (`spawn_step_agent`, `check_step_status`, `advance_workflow`, `report_result`, `request_human_input`)
- Uses `resolveAgentInit()` / `createCustomAgentInit()` from `custom-agent.ts` to spawn sub-sessions for each workflow step
- Is the only agent visible to human users for a given task -- sub-sessions are internal
- Reports results back to the SpaceTask record and notifies the Space Agent

Key architectural decision: The Task Agent replaces SpaceRuntime's direct `advance()` calls for workflow-driven tasks. SpaceRuntime's tick loop detects pending tasks and spawns Task Agent sessions, then Task Agent takes over the full workflow lifecycle internally.

**Scope note:** This plan is purely backend-focused. Frontend UI for displaying Task Agent conversations, step progress, and `request_human_input` prompts is intentionally out of scope — Task Agent conversations use the existing chat UI via standard session routing. A separate plan will address any Task Agent-specific UI enhancements if needed.

## Milestones

1. **Types and Data Model** -- Add `space_task_agent` session type, extend SpaceTask with `taskAgentSessionId` field, define Task Agent MCP tool schemas
2. **Task Agent System Prompt and Session Init** -- Build system prompt, session init factory, and task message builder for Task Agent sessions
3. **Task Agent MCP Tools** -- Implement the 5 MCP tools (`spawn_step_agent`, `check_step_status`, `advance_workflow`, `report_result`, `request_human_input`) as an MCP server
4. **Task Agent Session Manager** -- Create `TaskAgentManager` that handles spawning Task Agent sessions, managing sub-sessions, and tracking task-to-session mappings
5. **SpaceRuntime Integration** -- Modify SpaceRuntime tick loop to spawn Task Agent sessions for pending tasks and delegate workflow advancement to the Task Agent
6. **Space Agent Communication** -- Add `send_message_to_task` tool to Space Agent tools and wire up bidirectional messaging between Space Agent and Task Agent

## Parallel Execution Strategy

Tasks are organized into waves that maximize parallel execution:

### Wave 1 (no dependencies — fully parallel)
- **Task 1.1**: Add `space_task_agent` session type and extend SpaceTask type
- **Task 1.3**: Define Task Agent MCP tool schemas

### Wave 2 (depends on Wave 1 — fully parallel)
- **Task 1.2**: Update SpaceTask DB schema and repository (needs 1.1)
- **Task 2.1**: Build Task Agent system prompt (needs 1.1)
- **Task 3.1**: Implement Task Agent tool handlers (needs 1.3 only — uses callback patterns, no dependency on session init)

### Wave 3 (depends on Wave 2 — fully parallel)
- **Task 2.2**: Create Task Agent session init factory (needs 2.1)
- **Task 3.2**: Create Task Agent MCP server factory (needs 3.1)

### Wave 4 (convergence point)
- **Task 4.1**: Implement TaskAgentManager core (needs 2.2 + 3.2)

### Wave 5 (depends on 4.1 — fully parallel)
- **Task 4.2**: Add human message routing to Task Agent (needs 4.1)
- **Task 4.3**: Wire TaskAgentManager into DaemonApp (needs 4.1)
- **Task 5.1**: Add Task Agent spawning to SpaceRuntime tick loop (needs 4.1)
- **Task 6.1**: Add `send_message_to_task` tool to Space Agent (needs 4.1)

### Wave 6 (depends on Wave 5 — fully parallel)
- **Task 5.2**: Update SpaceRuntimeService to pass TaskAgentManager (needs 5.1 + 4.3)
- **Task 5.3**: Task Agent session rehydration on restart (needs 5.1)
- **Task 6.2**: Add task completion notification to Space Agent (needs 3.1 + 6.1)

### Wave 7 (final integration)
- **Task 6.3**: End-to-end online test (needs all previous tasks)

## Dependency Graph

```
1.1 ──┬── 1.2
      ├── 2.1 ── 2.2 ──┐
      │                 ├── 4.1 ──┬── 4.2
1.3 ──┴── 3.1 ── 3.2 ──┘         ├── 4.3 ──┬── 5.2
                                  ├── 5.1 ──┼── 5.3
                                  └── 6.1 ──┴── 6.2
                                                 └── 6.3
```

## Estimated Task Count

~18 tasks across 6 milestones, organized into 7 execution waves with maximum parallelism (up to 4 tasks running concurrently in Waves 2 and 5).
