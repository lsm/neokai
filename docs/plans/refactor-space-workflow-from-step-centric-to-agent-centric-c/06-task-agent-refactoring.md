# Milestone 6: Task Agent Refactoring

## Goal

Redefine the Task Agent's role from pipeline-advancing orchestrator to collaboration manager. Update the system prompt, MCP tools, and behaviors to reflect the agent-centric model.

## Scope

- Update Task Agent system prompt to emphasize collaboration management
- Add `report_workflow_done` tool for workflow-level completion
- Wire new dependencies (CrossNodeChannelRouter, CompletionDetector) into Task Agent
- Tests

## Tasks

### Task 6.1: Update Task Agent System Prompt

**Description**: Rewrite the Task Agent system prompt in `packages/daemon/src/lib/space/agents/task-agent.ts` to reflect the agent-centric collaboration model.

**Subtasks**:
1. In `buildTaskAgentSystemPrompt()`:
   - Update the role description: from "workflow orchestrator that advances steps" to "collaboration manager that coordinates agents"
   - Update the tool descriptions to emphasize channel-based communication
   - Add guidance on:
     - Monitoring agent completion state via `list_group_members`
     - Handling gate-blocked cross-node messages (agents report back, Task Agent escalates)
     - When to use `request_human_input` for human gates
     - When the workflow is complete (all agents report done)
     - Using `send_message` with string-based target addressing: agent name for DM, node name for fan-out to all agents in that node
     - Using `list_reachable_agents` to discover who agents can communicate with
2. In `buildTaskAgentInitialMessage()`:
   - Include channel information in the initial message (cross-node channels from the workflow)
   - Include a "collaboration map" showing agents, their nodes, and who they can reach
   - Provide start instructions that direct the Task Agent to begin work

**Acceptance Criteria**:
- System prompt clearly describes the collaboration manager role
- Initial message provides useful collaboration context including channel map
- Prompt includes guidance for using cross-node messaging and monitoring completion

**Dependencies**: Tasks 4.4, 5.2

**Agent Type**: coder

---

### Task 6.2: Add report_workflow_done Tool

**Description**: Add a `report_workflow_done` MCP tool to the Task Agent for explicitly marking the workflow run as completed.

**Subtasks**:
1. Create schema `ReportWorkflowDoneSchema` in `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts`:
   ```
   { summary?: string }
   ```
2. Add `report_workflow_done` handler in `task-agent-tools.ts`:
   - Validates the workflow run exists and is in_progress
   - Marks the workflow run as `'completed'`
   - Sets `completedAt` timestamp
   - Calls `report_result` internally to mark the task as completed
   - Emits a `workflow_run_completed` notification
3. Add the tool to `createTaskAgentMcpServer()`
4. Update the Task Agent system prompt to mention the new tool

**Acceptance Criteria**:
- Task Agent has a `report_workflow_done` tool
- Calling the tool marks the workflow run as completed
- The task is also marked as completed (via `report_result` internally)
- Notification is emitted for real-time updates

**Dependencies**: Task 5.2

**Agent Type**: coder

---

### Task 6.3: Wire New Dependencies into Task Agent

**Description**: Wire the `CrossNodeChannelRouter` and `CompletionDetector` into the Task Agent's MCP server configuration.

**Subtasks**:
1. In `TaskAgentManager`, pass `CrossNodeChannelRouter` and `CompletionDetector` to `createTaskAgentMcpServer()`
2. Update `TaskAgentToolsConfig` to accept the new dependencies
3. Update `report_workflow_done` to use `CompletionDetector` for validation

**Acceptance Criteria**:
- Task Agent MCP server has access to cross-node channel routing
- Task Agent can query completion status
- No circular dependencies

**Dependencies**: Tasks 6.2, 4.3

**Agent Type**: coder

---

### Task 6.4: Verify Task Agent MCP Server Configuration

**Description**: Verify the Task Agent's MCP server is clean and consistent after the `advance_workflow` removal (done in Task 4.5).

**Subtasks**:
1. Verify no remaining references to `advance_workflow` in `TaskAgentToolsConfig` and `createTaskAgentMcpServer()` (should already be clean from Task 4.5)
2. Verify the tool list includes: `spawn_step_agent`, `list_group_members`, `report_result`, `report_workflow_done`, `request_human_input`
3. Verify no references to the old step-advancement model remain

**Acceptance Criteria**:
- Task Agent MCP server only exposes agent-centric tools
- No references to `advance_workflow` or the old model remain
- Tool list is clean and consistent

**Dependencies**: Tasks 6.1, 6.2, 6.3

**Agent Type**: coder

---

### Task 6.5: Tests for Refactored Task Agent

**Description**: Write tests for the refactored Task Agent behavior.

**Subtasks**:
1. Update `packages/daemon/tests/unit/space/task-agent-tools.test.ts`:
   - Add tests for `report_workflow_done`
   - Remove tests for `advance_workflow`
   - Verify tool set is correct
2. Update `packages/daemon/tests/unit/space/task-agent.test.ts`:
   - Verify new system prompt content includes collaboration management guidance
   - Verify initial message includes channel map
3. Create `packages/daemon/tests/unit/space/task-agent-collaboration.test.ts`:
   - Test the full collaboration flow: spawn agents, agents communicate via channels, agents report done, Task Agent reports workflow done
   - Test gate-blocked flow: agent tries cross-node message, gate blocks, Task Agent escalates

**Acceptance Criteria**:
- All tests pass
- New collaboration tools work correctly
- No references to old step-centric tools in tests

**Dependencies**: Tasks 6.2, 6.3, 6.4

**Agent Type**: coder

## Rollback Strategy

- **System prompt changes** (Task 6.1): Prompt changes take effect on the next Task Agent session creation. Reverting is instant — no persisted state depends on it.
- **report_workflow_done** (Task 6.2): New tool. Can be removed from the tool list without side effects.
- **MCP wiring** (Task 6.3): New dependencies injected into MCP server config. Reverting removes the injections — step agent tools work without them.
