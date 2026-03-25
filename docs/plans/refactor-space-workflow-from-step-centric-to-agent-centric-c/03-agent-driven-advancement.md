# Milestone 3: Agent-Driven Advancement via Gated Channels

## Goal

Enable agents to drive workflow progression through gated channels. When an agent sends a message to a target (plain string), the router resolves it as an agent name (DM) or node name (fan-out), matches it against channel policies, evaluates gates, and delivers. This replaces `advance()` as the workflow driver.

One `ChannelRouter` handles everything — within-node and cross-node, DM and fan-out.

## Scope

- Implement `ChannelRouter` for gated message delivery
- Implement lazy target-node activation
- Update `send_message` with unified string-based addressing
- Add `list_reachable_agents` tool to step agents
- Remove `advance()` and replace with agent-driven progression
- Wire gate evaluation into the message delivery path

## Tasks

### Task 3.0: Target-Node Activation (Lazy Activation)

**Description**: Implement lazy activation of target nodes. When `ChannelRouter.deliverMessage()` targets a node that has no active tasks or sessions, the router creates the pending tasks for that node on-demand. This task is a prerequisite of Task 3.1 (the router uses `activateNode()` defined here).

**Subtasks**:
1. In `ChannelRouter.deliverMessage()`, before resolving the target agent's session:
   - Query `SpaceTaskRepository` for active tasks on the target node (`workflowRunId` + `nodeId`)
   - If no active tasks exist, call `SpaceTaskManager.createTasksForNode()` to create pending tasks for the target node's agents
2. Create a standalone `activateNode(runId: string, nodeId: string): Promise<SpaceTask[]>` function (in a new file or within the router module) that:
   - Looks up the node definition from the workflow
   - Creates `SpaceTask` records for each agent on the node
   - Returns the created tasks
   - Note: No session group creation — agent state is tracked on `space_tasks` directly (see overview "Agent State on space_tasks")
3. Handle edge cases:
   - Node already has active tasks → skip activation (no-op)
   - Node activation fails (e.g., workflow paused/cancelled) → return error in delivery result
   - Concurrent activation attempts → use DB-level uniqueness constraint on `(workflowRunId, nodeId, agentName)` to prevent duplicate tasks (the `agentName` column is renamed from `slotRole` in Task 2.2)
4. Add idempotency: calling `activateNode()` multiple times for the same node is safe (existing tasks are not duplicated)

**Acceptance Criteria**:
- `deliverMessage()` automatically activates the target node if no active tasks exist
- `activateNode()` creates tasks and session groups correctly
- Duplicate activation attempts are handled idempotently
- Unit tests cover: first activation, idempotent re-activation, concurrent activation, activation of cancelled run

**Dependencies**: Tasks 1.3, 1.5

**Agent Type**: coder

---

### Task 3.1: ChannelRouter

**Description**: Create a `ChannelRouter` that handles all message delivery through gated channels — within-node and cross-node, DM and fan-out. One router for everything.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/runtime/channel-router.ts`
2. Implement `ChannelRouter` class:
   ```
   class ChannelRouter {
     constructor(config: {
       workflowRunRepo: SpaceWorkflowRunRepository;
       workflowManager: SpaceWorkflowManager;
       taskRepo: SpaceTaskRepository;
       taskManager: SpaceTaskManager;
       gateEvaluator: ChannelGateEvaluator;
       workspacePath: string;
     })

     // Check if a channel exists and its gate allows delivery
     async canDeliver(params: {
       workflowRunId: string;
       fromAgentName: string;
       fromNode: string;
       target: string;              // agent name or node name
       context: ChannelGateContext;
     }): Promise<{ allowed: boolean; reason?: string; channelId?: string }>

     // Deliver a message through a channel
     // 1. Resolve target string: agent name → DM, node name → fan-out
     // 2. Find matching WorkflowChannel policy (from + to)
     // 3. Ensure target node has active tasks/sessions (activate if needed — see Task 3.0)
     // 4. Resolve target agent's session (specific agent for DM, all agents for fan-out)
     // 5. Evaluate the gate
     // 6. If allowed, inject the message into the target agent's session (resolved via space_tasks)
     // 7. If gate blocked, return the reason (agent can retry or escalate)
     // 8. If matching channel is cyclic (isCyclic=true), increment iteration counter
     async deliverMessage(params: {
       workflowRunId: string;
       fromAgentName: string;
       fromNode: string;
       fromSessionId: string;
       target: string;
       message: string;
       context: ChannelGateContext;
     }): Promise<{ delivered: boolean; reason?: string; targetSessions: string[] }>

     // List channels from the current agent's perspective
     listOutboundChannels(params: {
       workflowRunId: string;
       fromAgentName: string;
       fromNode: string;
     }): ResolvedChannel[]
   }
   ```
3. Gate evaluation uses `ChannelGateEvaluator` from Milestone 1
4. **Iteration tracking**: When `deliverMessage()` matches a `WorkflowChannel` with `isCyclic: true`:
   - Increment the run's `iterationCount` via `workflowRunRepo.updateRun()`
   - Check against `run.maxIterations` — if `iterationCount >= maxIterations`, deny delivery with reason: "Iteration cap reached (N/M): cyclic channel from X to Y would exceed maximum iterations"
   - This replaces the old `advance()` behavior where `followTransition()` checked `isCyclic` on `WorkflowTransition`
5. For human gates: return `{ allowed: false, reason: 'Waiting for human approval' }` — the agent can use `request_human_input` (existing tool) and retry

**Acceptance Criteria**:
- `canDeliver()` correctly evaluates gate conditions
- `deliverMessage()` routes messages after gate evaluation (within-node and cross-node)
- Gate-blocked messages return clear reasons
- Cyclic channels (`isCyclic: true`) increment `iterationCount` and enforce `maxIterations`
- Iteration cap is checked before delivery (not after)
- One router handles all message delivery (no separate within-node/cross-node paths)

**Dependencies**: Tasks 1.3, 1.4, 3.0

**Agent Type**: coder

---

### Task 3.2: Unified send_message with String-Based Target

**Description**: Update the `send_message` tool to use a single `target: z.string()` parameter. The `ChannelRouter` handles all delivery — no separate within-node vs cross-node code paths.

**Subtasks**:
1. Add `ChannelRouter` as an optional dependency to `StepAgentToolsConfig`
2. Update `SendMessageSchema` in `step-agent-tool-schemas.ts`:
   ```
   target: z.string()    // agent name (DM) or node name (fan-out)
   ```
3. In the `send_message` handler:
   - Call `ChannelRouter.deliverMessage()` with the target string
   - The router handles resolution (agent name → DM, node name → fan-out) and gate evaluation
   - Return the delivery result
4. **Target resolution algorithm** (implemented in the router, documented here for clarity):
   1. **Agent match**: Check if `target` matches any agent name (globally unique within the workflow). If so, deliver as a DM to that agent.
   2. **Node match**: Check if `target` matches any node name. If so, deliver as fan-out to all agents on that node.
   3. **No match**: Return `{ delivered: false, reason: 'Unknown target: no agent or node found with this name' }`
   4. **Gate evaluation**: For the matching channel policy, evaluate its `gate`. If allowed, deliver. If blocked, return the reason.

**Acceptance Criteria**:
- `send_message` target is a plain string — no structured objects
- Same code path for within-node and cross-node delivery
- Target resolves as: agent name → DM, node name → fan-out to all agents in that node
- Clear error messages when target is unknown or gate blocks delivery

**Dependencies**: Task 3.1

**Agent Type**: coder

---

### Task 3.3: Wire ChannelRouter into Task Agent

**Description**: Wire the `ChannelRouter` into the Task Agent's tool configuration so step agents can use gated messaging.

**Subtasks**:
1. In `TaskAgentManager`, create `ChannelRouter` instances and inject them into step agent MCP server configs
2. Update `createSubSessionFactory` / `buildStepAgentMcpServerForSession` to pass the router
3. Ensure the router has access to all needed dependencies (repos, evaluator, workspace path)

**Acceptance Criteria**:
- Step agent MCP servers have channel routing capability
- The router is created with correct dependencies for each sub-session
- No circular dependency issues

**Dependencies**: Tasks 3.1, 3.2

**Agent Type**: coder

---

### Task 3.4: Add list_reachable_agents Tool

**Description**: Add a tool that lets step agents query who they can reach. Returns a flat list of agent names and node names.

**Subtasks**:
1. Create schema `ListReachableAgentsSchema` in `step-agent-tool-schemas.ts`
2. Add `list_reachable_agents` handler in `step-agent-tools.ts`:
   - Lists all targets the calling agent can reach (within-node peers + cross-node agents and nodes)
   - For each reachable target, shows: name (agent name or node name), type (agent or node), gate status (open/closed)
   - Returns a flat list — no channel internals exposed
3. Add the tool to `createStepAgentMcpServer()`

**Acceptance Criteria**:
- Step agents can query who they can reach
- Gate status information is included (open/closed and reason) for cross-node targets
- Within-node peers are listed separately from cross-node targets
- The tool uses agent-friendly terminology (not "channels" or "policies")

**Dependencies**: Task 3.1

**Agent Type**: coder

---

### Task 3.5: Remove advance() and Replace with Agent-Driven Progression

**Description**: Remove `advance()` from `WorkflowExecutor` and `SpaceRuntime`. Agent-driven messaging is now the sole advancement mechanism.

**Subtasks**:
1. In `packages/daemon/src/lib/space/runtime/workflow-executor.ts`:
   - Remove `advance()` method entirely
   - Remove any condition evaluation logic that was only used by `advance()` (now in `ChannelGateEvaluator`)
   - Clean up unused imports and types related to transition-based advancement
2. In `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Remove all `advance()` calls from `processRunTick()` and `executeTick()`
   - Remove the "all tasks completed on current step → advance" detection logic
   - The tick loop now only handles: liveness checks, agent completion (milestones 2/4), and stuck-member auto-completion
3. Remove `advance_workflow` tool from `packages/daemon/src/lib/space/tools/task-agent-tools.ts`:
   - Remove the tool handler
   - Remove the tool from `createTaskAgentMcpServer()`
   - Remove the schema from `task-agent-tool-schemas.ts`
4. Update the Task Agent system prompt to remove any references to `advance_workflow`
5. Run existing tests and fix any that depended on `advance()` behavior:
   - Update or remove tests in `workflow-executor.test.ts` that test `advance()`
   - Update `space-runtime.test.ts` tests that test the old tick loop advancement

**Acceptance Criteria**:
- `advance()` is removed from `WorkflowExecutor`
- `advance_workflow` tool is removed from Task Agent
- The tick loop no longer calls `advance()`
- All existing tests pass (updated as needed)
- No dead code referencing the old advancement model remains

**Dependencies**: Task 3.3

**Agent Type**: coder

---

### Task 3.6: Unit and Integration Tests for Agent-Driven Advancement

**Description**: Write comprehensive tests for the agent-driven advancement system.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/channel-router.test.ts`
2. Test cases for `ChannelRouter`:
   - Gate-open delivery succeeds
   - Gate-closed delivery returns reason
   - Human gate blocks and allows after approval
   - Condition gate runs shell expression
   - Task result gate evaluates correctly
   - Node name target routes to all agents in target node (fan-out)
   - Agent name target routes to specific agent (DM)
   - Invalid target returns error
   - Lazy activation of target node on first delivery
   - Cyclic channel delivery increments iteration count
   - Iteration cap blocks delivery when reached
   - Non-cyclic channel delivery does NOT increment iteration count
   - Idempotent activation on subsequent deliveries
3. Create `packages/daemon/tests/unit/space/send-message-unified.test.ts`
4. Test cases for `send_message`:
   - Agent name target → DM delivery
   - Node name target → fan-out delivery
   - Cross-node DM delivery with open gate
   - Cross-node fan-out delivery with open gate
   - Delivery with closed gate returns reason
   - Unknown target returns "no agent or node found" error
   - Within-node delivery works through same router

**Acceptance Criteria**:
- All tests pass
- Messaging works end-to-end for all patterns (within-node, cross-node, DM, fan-out)
- Gate evaluation is correctly applied
- No regressions

**Dependencies**: Tasks 3.2, 3.4, 3.5

**Agent Type**: coder

## Rollback Strategy

- **ChannelRouter** (Task 3.1): New class, no existing behavior modified. Can be removed entirely.
- **Target-node activation** (Task 3.0): New `activateNode()` function. Can be removed without affecting other code.
- **send_message update** (Task 3.2): The new path only activates when `ChannelRouter` is injected.
- **advance() removal** (Task 3.5): This is a destructive change. The `advance()` code is preserved in git history. If rollback is needed, the method can be restored from the pre-milestone commit.
