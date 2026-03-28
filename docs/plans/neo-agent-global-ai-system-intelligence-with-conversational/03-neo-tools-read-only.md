# Milestone 3: Neo Tool Registry (Read-Only)

## Goal

Implement the read-only system query tools that allow Neo to inspect the entire NeoKai system state. These tools give Neo visibility into rooms, spaces, goals, tasks, MCP servers, skills, and app settings.

## Tasks

### Task 3.1: System Query Tool Handlers (Rooms and Goals)

- **Description**: Create testable handler functions for room-related and goal-related read operations. Follow the two-layer pattern from `room-agent-tools.ts`: pure handler functions first, MCP server wrapper later.
- **Agent type**: coder
- **Depends on**: Task 2.1
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-query-tools.ts`
  2. Define `NeoQueryToolsConfig` interface with required dependencies: `Database` (raw BunDatabase for direct queries), `RoomRuntimeService` (for active room state), `GoalManager` factory, `TaskManager` factory
  3. Implement handler functions:
     - `list_rooms()` -- query rooms table, return id, name, status, goal count, active task count
     - `get_room_status(roomId)` -- detailed room info: goals summary, active tasks, session states
     - `get_room_details(roomId)` -- full room data including background, instructions, settings
     - `list_goals(filters?)` -- across all rooms, filterable by roomId, status, priority
     - `get_goal_details(goalId)` -- full goal info including metrics, execution history
     - `get_metrics(goalId)` -- metric history for measurable goals
  4. Return structured JSON results (not just text) for rich UI rendering
  5. Write unit tests in `packages/daemon/tests/unit/neo/tools/neo-query-tools.test.ts`
- **Acceptance criteria**:
  - All handlers return well-structured JSON with consistent shape
  - Filters work correctly (e.g., list_goals by room, by status)
  - Handlers gracefully handle missing resources (room not found, etc.)
  - Unit tests cover happy paths and error cases
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 3.2: System Query Tool Handlers (Spaces and Tasks)

- **Description**: Create handler functions for space-related and task-related read operations.
- **Agent type**: coder
- **Depends on**: Task 3.1
- **Subtasks**:
  1. Add to `packages/daemon/src/lib/neo/tools/neo-query-tools.ts` (or a separate file `neo-space-query-tools.ts` if the file gets large)
  2. Add `SpaceManager`, `SpaceAgentManager`, `SpaceTaskRepository`, `SpaceWorkflowRunRepository` to config
  3. Implement handler functions:
     - `list_spaces()` -- all spaces with name, status, agent count, workflow count
     - `get_space_status(spaceId)` -- space details, active workflows, task summary
     - `get_space_details(spaceId)` -- full space data including agents, workflows
     - `list_tasks(filters?)` -- across all rooms, filterable by roomId, goalId, status, type
     - `get_task_detail(taskId)` -- full task info including session state, dependencies
     - `list_space_agents(spaceId)` -- agents configured for a space
     - `list_space_workflows(spaceId)` -- workflows in a space
     - `list_space_runs(spaceId)` -- workflow runs with status
  4. Write unit tests in `packages/daemon/tests/unit/neo/tools/neo-space-query-tools.test.ts`
- **Acceptance criteria**:
  - All space/task handlers return consistent JSON shapes
  - Cross-room task listing works with appropriate filters
  - Unit tests cover all handlers
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 3.3: System Query Tool Handlers (Skills, MCP, Settings)

- **Description**: Create handler functions for skills, MCP servers, and app settings/system info queries.
- **Agent type**: coder
- **Depends on**: Task 3.1
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-config-query-tools.ts`
  2. Add `SkillsManager`, `AppMcpLifecycleManager`, `SettingsManager` to config
  3. Implement handler functions:
     - `list_mcp_servers()` -- all registered MCP servers with connection status
     - `get_mcp_server_status(serverName)` -- detailed server info, connected tools
     - `list_skills()` -- all skills with enabled/disabled state
     - `get_skill_details(skillId)` -- full skill configuration
     - `get_app_settings()` -- current global settings (sanitized -- no secrets)
     - `get_system_info()` -- version, uptime, workspace path, active session count, provider info
  4. Write unit tests in `packages/daemon/tests/unit/neo/tools/neo-config-query-tools.test.ts`
- **Acceptance criteria**:
  - Settings output does not leak API keys or secrets
  - System info provides useful diagnostic data
  - MCP server status accurately reflects connection state
  - Unit tests cover all handlers
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 3.4: Read-Only MCP Server Assembly

- **Description**: Wrap all read-only tool handlers into an MCP server that can be attached to the Neo session.
- **Agent type**: coder
- **Depends on**: Task 3.1, Task 3.2, Task 3.3
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-tools-server.ts`
  2. Create `createNeoReadToolsMcpServer(config)` function that:
     - Instantiates all query tool handler objects
     - Wraps each handler in a `tool()` definition with Zod schemas for parameters
     - Returns an MCP server via `createSdkMcpServer()`
  3. Define clear tool descriptions that help Neo understand when to use each tool
  4. Attach the MCP server to the Neo session via `NeoAgentHandle.getSession().setRuntimeMcpServers()` (the handle returned by `provisionNeoAgent()`)
  5. Write an integration test that verifies tools are registered and callable
- **Acceptance criteria**:
  - MCP server registers all read-only tools with correct parameter schemas
  - Tool descriptions are clear and helpful for the LLM
  - Neo session has the tools available after initialization
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
