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

## Milestones

1. **Types and Data Model** -- Add `space_task_agent` session type, extend SpaceTask with `taskAgentSessionId` field, define Task Agent MCP tool schemas
2. **Task Agent System Prompt and Session Init** -- Build system prompt, session init factory, and task message builder for Task Agent sessions
3. **Task Agent MCP Tools** -- Implement the 5 MCP tools (`spawn_step_agent`, `check_step_status`, `advance_workflow`, `report_result`, `request_human_input`) as an MCP server
4. **Task Agent Session Manager** -- Create `TaskAgentManager` that handles spawning Task Agent sessions, managing sub-sessions, and tracking task-to-session mappings
5. **SpaceRuntime Integration** -- Modify SpaceRuntime tick loop to spawn Task Agent sessions for pending tasks and delegate workflow advancement to the Task Agent
6. **Space Agent Communication** -- Add `send_message_to_task` tool to Space Agent tools and wire up bidirectional messaging between Space Agent and Task Agent

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (types must exist before building prompts/init)
- Milestone 3 depends on Milestone 1 (tool schemas) and Milestone 2 (session init for sub-sessions)
- Milestone 4 depends on Milestones 2 and 3 (needs session init factory and tools)
- Milestone 5 depends on Milestone 4 (needs TaskAgentManager to spawn sessions)
- Milestone 6 depends on Milestones 4 and 5 (needs working Task Agent sessions to message)

## Estimated Task Count

~18 tasks across 6 milestones.
