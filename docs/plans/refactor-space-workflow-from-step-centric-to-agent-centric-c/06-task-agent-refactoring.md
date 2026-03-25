# Milestone 6: Task Agent Refactoring

## Goal

Redefine the Task Agent's role from pipeline-advancing orchestrator to collaboration manager. Update the system prompt, MCP tools, and behaviors to reflect the agent-centric model.

## Scope

- Update Task Agent system prompt to emphasize collaboration management
- Update MCP tools for the agent-centric model
- Introduce `report_workflow_done` tool for workflow-level completion
- Update the Task Agent's initial message builder
- Deprecate `advance_workflow` (keep for backward compat but mark as legacy)

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
   - Keep backward-compatible sections for workflows that still use the old model
2. In `buildTaskAgentInitialMessage()`:
   - If the workflow has cross-node channels, include channel information in the initial message
   - Include a "collaboration map" showing agent roles, their nodes, and available channels
   - Adjust the start instruction based on whether the workflow uses agent-centric or step-centric model

**Acceptance Criteria**:
- System prompt clearly describes the collaboration manager role
- Prompt includes guidance for both agent-centric and step-centric workflows
- Initial message provides useful collaboration context when cross-node channels exist
- Backward compatible with existing workflows (old model still works)

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

### Task 6.3: Deprecate advance_workflow Tool

**Description**: Mark `advance_workflow` as legacy/optional and update its documentation. It remains available for step-centric workflows but is not the primary advancement mechanism.

**Subtasks**:
1. Update the `advance_workflow` tool description to note it is legacy for step-centric workflows
2. In the Task Agent system prompt, note that `advance_workflow` is for step-centric workflows only
3. Add a deprecation warning in the `advance_workflow` handler when the workflow has cross-node channels configured
   - The warning should be returned as part of the tool result, not thrown
   - Suggest using `send_message` with cross-node channels instead
4. Keep the tool fully functional for backward compatibility

**Acceptance Criteria**:
- `advance_workflow` still works for step-centric workflows
- A deprecation warning is returned when used with agent-centric workflows
- No breaking changes to existing workflows
- Task Agent prompt provides clear guidance on when to use which tool

**Dependencies**: Tasks 6.1, 6.2

**Agent Type**: coder

---

### Task 6.4: Update Task Agent MCP Server Configuration

**Description**: Wire the new dependencies (CrossNodeChannelRouter, CompletionDetector) into the Task Agent's MCP server configuration.

**Subtasks**:
1. In `TaskAgentManager`, pass `CrossNodeChannelRouter` and `CompletionDetector` to `createTaskAgentMcpServer()`
2. Update `TaskAgentToolsConfig` to accept the new dependencies
3. Update `report_workflow_done` and `advance_workflow` to use `CompletionDetector`

**Acceptance Criteria**:
- Task Agent MCP server has access to cross-node channel routing
- Task Agent can query completion status
- No circular dependencies

**Dependencies**: Tasks 6.2, 6.3, 4.3

**Agent Type**: coder

---

### Task 6.5: Tests for Refactored Task Agent

**Description**: Write tests for the refactored Task Agent behavior.

**Subtasks**:
1. Update `packages/daemon/tests/unit/space/task-agent-tools.test.ts`:
   - Add tests for `report_workflow_done`
   - Add tests for `advance_workflow` deprecation warning with cross-node channels
   - Verify backward compatibility with step-centric workflows
2. Update `packages/daemon/tests/unit/space/task-agent.test.ts`:
   - Verify new system prompt content includes collaboration management guidance
   - Verify initial message includes channel map for agent-centric workflows
3. Create `packages/daemon/tests/unit/space/task-agent-collaboration.test.ts`:
   - Test the full collaboration flow: spawn agents, agents communicate via channels, agents report done, Task Agent reports workflow done
   - Test gate-blocked flow: agent tries cross-node message, gate blocks, Task Agent escalates

**Acceptance Criteria**:
- All tests pass
- New collaboration tools work correctly
- Old step-centric tools still work
- No regressions in existing Task Agent tests

**Dependencies**: Tasks 6.2, 6.3, 6.4

**Agent Type**: coder
