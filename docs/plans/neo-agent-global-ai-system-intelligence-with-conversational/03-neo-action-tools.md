# Milestone 3: Neo Action Tools

## Goal

Implement write MCP tools that allow Neo to take actions across the system (room/space/config operations) with security tier enforcement.

## Scope

- Create action tool handlers with security tier checks
- Implement tiered confirmation logic (auto-execute, confirm, require-explicit)
- Tools modify system state: create/delete rooms, manage goals/tasks, configure MCP/skills
- **Reuse existing handlers**: Space-related action tools delegate to `global-spaces-tools.ts` handler functions, wrapped with Neo's security tier layer

### Confirmation Protocol (Two-Message Pattern)

The confirmation flow does **not** pause the SDK session. Instead it uses a standard two-message LLM pattern:

1. **Action tool returns early**: When a tool requires confirmation, it returns `{ confirmationRequired: true, pendingActionId: '<uuid>', description: '...', riskLevel: 'medium' }` as a normal tool result (no execution happens)
2. **LLM renders confirmation**: The system prompt instructs Neo to present confirmation results as user-facing cards (the frontend renders these as `NeoConfirmationCard` components)
3. **User responds**: User clicks Confirm/Cancel or types "yes"/"no" in the chat
4. **LLM calls confirm/cancel tool**: `confirm_action({ actionId })` executes the pending action; `cancel_action({ actionId })` discards it
5. **Pending action storage**: Pending actions are stored in-memory in `NeoAgentManager` with a TTL (5 minutes). Expired actions return an error on confirm.
6. **Panel close / navigate away**: Pending actions remain valid until TTL expires. User can return to the panel and confirm later within the window.

## Tasks

### Task 3.1: Security Tier System

**Description**: Implement the security tier enforcement logic that action tools use.

**Subtasks**:
1. Create `packages/daemon/src/lib/neo/security-tier.ts`:
   - Define `NeoSecurityMode` type: `'conservative' | 'balanced' | 'autonomous'`
   - Define `ActionRiskLevel` type: `'low' | 'medium' | 'high'`
   - Define `ActionClassification` map: hardcoded mapping of tool names to risk levels
   - Low risk: toggle settings, enable/disable skills, create goals, update preferences
   - Medium risk: delete space/room, cancel run, send message to agent, approve gates, manage MCPs
   - High risk: delete room with active tasks, bulk operations, irreversible changes
2. Create `shouldAutoExecute(securityMode, riskLevel)` function:
   - Conservative: nothing auto-executes
   - Balanced: low-risk auto-executes, medium confirms, high requires explicit
   - Autonomous: everything auto-executes
3. Create `getConfirmationRequired(securityMode, toolName)` function
4. Define `NeoActionResult` type: `{ success: boolean, confirmationRequired?: boolean, pendingActionId?: string, actionDescription?: string, riskLevel?: ActionRiskLevel, result?: unknown, error?: string }`
5. Create `PendingActionStore` class in the same file:
   - In-memory map of `pendingActionId -> { toolName, input, createdAt }`
   - TTL of 5 minutes -- expired actions are rejected on confirm
   - `store(action)`, `retrieve(actionId)`, `remove(actionId)`, `cleanup()` methods
6. Create `confirm_action` and `cancel_action` meta-tools:
   - `confirm_action({ actionId })`: retrieves pending action, executes it, removes from store
   - `cancel_action({ actionId })`: removes pending action without executing
7. Add unit tests for all security mode/risk level combinations, including pending action TTL expiry

**Acceptance Criteria**:
- Every action tool has a risk classification
- `shouldAutoExecute` returns correct values for all 9 combinations (3 modes x 3 risk levels)
- Unit tests achieve full coverage of the classification matrix

**Dependencies**: Task 1.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Room and Goal Action Tools

**Description**: Create MCP tools for room and goal write operations.

**Subtasks**:
1. Create `packages/daemon/src/lib/neo/tools/neo-action-tools.ts` with the two-layer pattern
2. Implement room tools:
   - `create_room`: creates a new room with name, description, workspace path
   - `delete_room`: deletes a room (medium/high risk depending on active sessions)
   - `update_room_settings`: updates room-level settings
3. Implement goal tools:
   - `create_goal`: creates a goal in a specified room
   - `update_goal`: updates goal fields
   - `set_goal_status`: transitions goal status
4. Implement task tools:
   - `create_task`: creates a task in a room
   - `update_task`: updates task fields
   - `set_task_status`: transitions task status
   - `approve_task` / `reject_task`: task review actions
5. Each tool checks security tier before execution, returns `confirmationRequired` if needed
6. Add unit tests for each tool handler (both auto-execute and confirmation paths)

**Acceptance Criteria**:
- Room/goal/task CRUD operations work through Neo tools
- Security tier enforcement works correctly
- Confirmation flow returns structured data when required
- Unit tests cover both execution and confirmation code paths

**Dependencies**: Task 3.1, Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.3: Space and Workflow Action Tools

**Description**: Create MCP tools for space and workflow write operations.

**Subtasks**:
1. Add to `neo-action-tools.ts`:
   - `create_space` / `delete_space` / `update_space`
   - `start_workflow_run` / `cancel_workflow_run`
   - `approve_gate` / `reject_gate`
2. **Delegate to existing handlers**: Import and reuse handler functions from `global-spaces-tools.ts` (e.g., `createSpaceHandler`, `deleteSpaceHandler`, `startWorkflowRunHandler`). Neo wraps these with security tier checks before delegating to the shared handler.
3. `delete_space` is medium risk; `cancel_workflow_run` is medium risk
4. Each tool checks security tier, returns confirmation if needed
5. Add unit tests

**Acceptance Criteria**:
- Space CRUD and workflow control work through Neo tools
- Gate approval/rejection works correctly
- Security tier enforcement applied
- Unit tests pass

**Dependencies**: Task 3.1, Task 2.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.4: Configuration and Messaging Action Tools

**Description**: Create MCP tools for configuration management and cross-agent messaging.

**Subtasks**:
1. Add to `neo-action-tools.ts`:
   - `add_mcp_server` / `update_mcp_server` / `delete_mcp_server` / `toggle_mcp_server`
   - `add_skill` / `update_skill` / `delete_skill` / `toggle_skill`
   - `update_app_settings`: update global app settings (model, preferences)
   - `send_message_to_room`: inject a message into a room session
   - `send_message_to_task`: inject a message into a space task agent session
   - `stop_session`: stop a running agent session
   - `pause_schedule` / `resume_schedule`: control recurring goal schedules
2. `send_message_to_room` uses `sessionManager.injectMessage()` with `origin: 'neo'` metadata
3. MCP/skill management tools use `AppMcpLifecycleManager` and `SkillsManager`
4. Add unit tests

**Acceptance Criteria**:
- Configuration tools work correctly
- Messages injected by Neo carry origin metadata
- All security tiers applied correctly
- Unit tests pass

**Dependencies**: Task 3.1, Task 2.3

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.5: Attach Action Tools to Neo Session

**Description**: Wire action tools MCP server into Neo's provisioning, combining with query tools.

**Subtasks**:
1. Create `packages/daemon/src/lib/neo/tools/neo-tools-server.ts` that combines query and action tools into a single MCP server (or two named servers)
2. Update `NeoAgentManager.provision()` to create and attach the combined tool server
3. Pass all action-specific dependencies (RoomManager, SpaceManager, etc.)
4. Update system prompt to reference all available tools with their risk classifications
5. Add integration test: Neo session has both query and action tools available

**Acceptance Criteria**:
- Neo session has full tool set (query + action)
- System prompt accurately describes available tools
- Integration test passes

**Dependencies**: Tasks 3.2, 3.3, 3.4, Task 2.4

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
