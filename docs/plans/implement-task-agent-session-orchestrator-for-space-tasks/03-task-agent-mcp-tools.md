# Milestone 3: Task Agent MCP Tools

## Goal

Implement the 5 MCP tools that give the Task Agent the ability to orchestrate workflow execution. These tools are served via an MCP server that is attached to the Task Agent session at runtime.

## Tasks

### Task 3.1: Implement Task Agent Tool Handlers

**Description:** Create the handler functions for all 5 Task Agent MCP tools. These handlers encapsulate the business logic and can be tested independently of the MCP server layer, following the pattern in `space-agent-tools.ts`.

**Subtasks:**
1. Create `packages/daemon/src/lib/space/tools/task-agent-tools.ts`
2. Define `TaskAgentToolsConfig` interface containing: `taskId`, `spaceId`, `workflowRunId`, `workspacePath`, `runtime` (SpaceRuntime), `workflowManager`, `taskRepo`, `workflowRunRepo`, `agentManager` (SpaceAgentManager), `sessionFactory` (a callback for creating and starting sub-sessions), `messageInjector` (a callback for injecting messages into sub-sessions)
3. Implement `createTaskAgentToolHandlers(config)` returning handler functions:
   - `spawn_step_agent`: Looks up the workflow step by ID, calls `resolveAgentInit()` to get session init for the step's agent, calls `sessionFactory` to create and start the sub-session, injects the task message via `messageInjector`, updates the SpaceTask's `currentStep` field, returns the sub-session ID
   - `check_step_status`: Queries the processing state of the current step's sub-session via `sessionFactory.getProcessingState()`, checks if the step's task is completed, returns status summary
   - `advance_workflow`: Gets the WorkflowExecutor for the current run, verifies current step tasks are completed, calls `executor.advance()` to transition to the next step, creates the new SpaceTask for the next step, returns the new step info. Handles `WorkflowGateError` by returning a gate-blocked status instead of throwing.
   - `report_result`: Updates the SpaceTask status (completed/needs_attention/cancelled) via SpaceTaskManager, sets result/error fields, returns confirmation
   - `request_human_input`: Updates the SpaceTask status to `needs_attention` with the question in the `currentStep` field, returns a message instructing the Task Agent to wait for human input
4. Write comprehensive unit tests for each handler covering success paths, error paths, and edge cases (step not found, session not started, workflow already complete, etc.)
5. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- All 5 handlers implement correct business logic
- `spawn_step_agent` creates sub-sessions using existing `resolveAgentInit()` infrastructure
- `advance_workflow` correctly delegates to `WorkflowExecutor.advance()` and handles gate errors
- `report_result` properly transitions task status
- `request_human_input` pauses execution and surfaces the question
- Unit tests cover success, error, and edge cases for each handler

**Dependencies:** Task 1.3 (tool schemas), Task 2.2 (session init factory for understanding sub-session creation pattern)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Create Task Agent MCP Server Factory

**Description:** Create the MCP server factory that wires up the 5 tool handlers into an MCP server compatible with the Claude Agent SDK, following the pattern in `createSpaceAgentMcpServer()`.

**Subtasks:**
1. In `packages/daemon/src/lib/space/tools/task-agent-tools.ts`, implement `createTaskAgentMcpServer(config: TaskAgentToolsConfig)` that:
   - Creates handlers via `createTaskAgentToolHandlers(config)`
   - Registers each tool using `tool()` from `@anthropic-ai/claude-agent-sdk` with the Zod schemas from Task 1.3
   - Returns the MCP server via `createSdkMcpServer()`
2. Export `createTaskAgentMcpServer` and the type from `packages/daemon/src/lib/space/index.ts`
3. Write integration-style unit tests that create the MCP server and verify tool registration
4. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- MCP server registers all 5 tools with correct names, descriptions, and schemas
- Server follows the same patterns as `createSpaceAgentMcpServer`
- Tests verify tool registration and basic handler delegation

**Dependencies:** Task 3.1 (needs handlers)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
