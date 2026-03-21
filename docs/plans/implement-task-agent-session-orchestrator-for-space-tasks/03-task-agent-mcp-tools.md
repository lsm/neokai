# Milestone 3: Task Agent MCP Tools

## Goal

Implement the 5 MCP tools that give the Task Agent the ability to orchestrate workflow execution. These tools are served via an MCP server that is attached to the Task Agent session at runtime.

## Tasks

### Task 3.1: Implement Task Agent Tool Handlers

**Description:** Create the handler functions for all 5 Task Agent MCP tools. These handlers encapsulate the business logic and can be tested independently of the MCP server layer, following the pattern in `space-agent-tools.ts`.

**Subtasks:**
1. Create `packages/daemon/src/lib/space/tools/task-agent-tools.ts`
2. Define `TaskAgentToolsConfig` interface containing: `taskId`, `spaceId`, `workflowRunId`, `workspacePath`, `runtime` (SpaceRuntime), `workflowManager`, `taskRepo`, `workflowRunRepo`, `agentManager` (SpaceAgentManager), `sessionFactory` (a callback for creating and starting sub-sessions), `messageInjector` (a callback for injecting messages into sub-sessions), `onSubSessionComplete` (a callback `(stepId: string, sessionId: string) => Promise<void>` that the TaskAgentManager provides — it updates the SpaceTask status to `completed` for the step's task when the sub-session finishes)
3. Implement `createTaskAgentToolHandlers(config)` returning handler functions:
   - `spawn_step_agent`: Looks up the workflow step by ID, calls `resolveAgentInit()` to get session init for the step's agent, calls `sessionFactory` to create and start the sub-session, registers a completion callback on the sub-session (via `onSubSessionComplete` — see below) that marks the step's SpaceTask as completed when the sub-session finishes, injects the task message via `messageInjector`, updates the SpaceTask's `currentStep` field, returns the sub-session ID
   - `check_step_status`: Queries the processing state of the current step's sub-session via `sessionFactory.getProcessingState()`, checks if the step's task is completed, returns status summary. This is the primary mechanism for the Task Agent to detect sub-session completion — it polls this tool. The completion callback (from `spawn_step_agent`) ensures the SpaceTask status is updated in the DB even if the Task Agent hasn't polled yet.
   - `advance_workflow`: Gets the WorkflowExecutor for the current run, verifies current step tasks are completed in the DB (status set by the completion callback), calls `executor.advance()` to transition to the next step, creates the new SpaceTask for the next step, returns the new step info. Handles `WorkflowGateError` by returning a gate-blocked status instead of throwing.
   - `report_result`: Updates the SpaceTask status (completed/needs_attention/cancelled) via SpaceTaskManager, sets result/error fields, returns confirmation
   - `request_human_input`: Updates the SpaceTask status to `needs_attention` with the question in the `currentStep` field, returns a message instructing the Task Agent to wait for human input
4. Write comprehensive unit tests for each handler covering success paths, error paths, and edge cases (step not found, session not started, workflow already complete, etc.)
5. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- All 5 handlers implement correct business logic
- `spawn_step_agent` creates sub-sessions using existing `resolveAgentInit()` infrastructure and registers a completion callback that updates the step's SpaceTask status
- `check_step_status` correctly reports sub-session processing state and completion (polling-based detection)
- `advance_workflow` correctly delegates to `WorkflowExecutor.advance()` and handles gate errors; verifies step task is completed in DB before advancing
- `report_result` properly transitions task status
- `request_human_input` pauses execution and surfaces the question
- Unit tests cover success, error, and edge cases for each handler, including sub-session completion propagation

**Dependencies:** Task 1.3 (tool schemas). Note: This task does NOT depend on Task 2.2 — tool handlers use callback patterns (`sessionFactory`, `messageInjector`) and do not directly reference the session init factory.

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
