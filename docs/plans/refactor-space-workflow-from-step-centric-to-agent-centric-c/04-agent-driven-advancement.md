# Milestone 4: Agent-Driven Advancement via Gated Channels

## Goal

Enable agents to drive workflow progression through gated cross-node channels. When an agent sends a message to a target (within-node or cross-node), the router matches the target against channel policies and evaluates gates before delivery. This replaces `advance()` as the workflow driver.

The agent-facing API uses a **Slack-like addressing model**: nodes are like group chats (all agents on the same node share a channel), and cross-node communication uses a flexible `target` parameter. Channels are implicit from the agent's perspective — they just specify who they want to reach.

## Scope

- Implement gated message delivery for cross-node channels
- Create the channel-routing + gate-enforcement layer (policy side)
- Implement lazy target-node activation
- Update `send_message` with Slack-like target addressing (addressing side)
- Add `list_reachable_agents` tool to step agents
- Remove `advance()` and replace with agent-driven progression
- Wire gate evaluation into the message delivery path

## Tasks

> **Execution order note**: Task 4.1a (lazy activation) is a prerequisite of Task 4.1 (channel router). Despite the numbering, 4.1a must be completed first — the router depends on the `activateNode()` function defined in 4.1a.

### Task 4.1: Cross-Node Channel Routing Layer

**Description**: Create a `CrossNodeChannelRouter` that handles message delivery across workflow nodes, evaluating gates before delivery.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/runtime/cross-node-channel-router.ts`
2. Implement `CrossNodeChannelRouter` class:
   ```
   class CrossNodeChannelRouter {
     constructor(config: {
       workflowRunRepo: SpaceWorkflowRunRepository;
       workflowManager: SpaceWorkflowManager;
       taskRepo: SpaceTaskRepository;
       taskManager: SpaceTaskManager;
       gateEvaluator: ChannelGateEvaluator;
       sessionGroupRepo: SpaceSessionGroupRepository;
       workspacePath: string;
     })

     // Check if a cross-node channel exists and its gate allows delivery
     async canDeliver(params: {
       workflowRunId: string;
       fromNode: string;
       fromAgentName: string;
       toNode?: string;             // for fan-out delivery
       toAgentName?: string;        // for DM delivery (alternative to toNode)
       context: ChannelGateContext;
     }): Promise<{ allowed: boolean; reason?: string; channelId?: string }>

     // Deliver a message through a cross-node channel
     // 1. Match the target string against CrossNodeChannel policies:
     //    - If toAgentName provided: find policy with matching fromNode + toAgent
     //    - If toNode provided: find policy with matching fromNode + toNode
     // 2. Ensure target node has active tasks/sessions (activate if needed — see Task 4.1a)
     // 3. Resolve the target agent's session (specific agent for DM, all agents for fan-out)
     // 4. Evaluate the gate
     // 5. If allowed, inject the message
     // 6. If gate blocked, return the reason (agent can retry or escalate)
     // 7. If the matching channel is cyclic (isCyclic=true), increment the run's iteration counter
     async deliverMessage(params: {
       workflowRunId: string;
       fromNode: string;
       fromAgentName: string;
       fromSessionId: string;
       toNode?: string;
       toAgentName?: string;
       message: string;
       context: ChannelGateContext;
     }): Promise<{ delivered: boolean; reason?: string; targetSessions: string[] }>

     // List available cross-node channels from the current node
     listOutboundChannels(params: {
       workflowRunId: string;
       fromNode: string;
       fromAgentName: string;
     }): ResolvedCrossNodeChannel[]
   }
   ```
3. Gate evaluation uses `ChannelGateEvaluator` from Milestone 1
4. **Iteration tracking**: When `deliverMessage()` matches a `CrossNodeChannel` with `isCyclic: true`:
   - Increment the run's `iterationCount` via `workflowRunRepo.updateRun()`
   - Check against `run.maxIterations` — if `iterationCount >= maxIterations`, deny delivery with reason: "Iteration cap reached (N/M): cyclic channel from X to Y would exceed maximum iterations"
   - This replaces the old `advance()` behavior where `followTransition()` checked `isCyclic` on `WorkflowTransition`
5. For human gates: return `{ allowed: false, reason: 'Waiting for human approval' }` -- the agent can use `request_human_input` (existing tool) and retry

**Acceptance Criteria**:
- `canDeliver()` correctly evaluates gate conditions
- `deliverMessage()` routes messages across nodes after gate evaluation
- Gate-blocked messages return clear reasons
- Cyclic channels (`isCyclic: true`) increment `iterationCount` and enforce `maxIterations`
- Iteration cap is checked before delivery (not after) — prevents message delivery if cap would be exceeded
- The router is unit-testable with mock dependencies

**Dependencies**: Tasks 1.3, 2.2, 4.1a

**Agent Type**: coder

---

### Task 4.1a: Target-Node Activation (Lazy Activation)

**Description**: Implement the strategy for activating target nodes when a cross-node channel fires but the target node's agents have not yet been spawned.

**Chosen approach: Lazy activation by the router.** When `CrossNodeChannelRouter.deliverMessage()` targets a node that has no active tasks or sessions, the router itself creates the pending tasks for that node. This ensures agents are materialized on-demand when cross-node channels fire.

**Subtasks**:
1. In `CrossNodeChannelRouter.deliverMessage()`, before resolving the target agent's session:
   - Query `SpaceTaskRepository` for active tasks on the target node (`workflowRunId` + `nodeId`)
   - If no active tasks exist, call `SpaceTaskManager.createTasksForNode()` to create pending tasks for the target node's agents
2. Create a standalone `activateNode(runId: string, nodeId: string): Promise<SpaceTask[]>` function (in a new file or within the router module) that:
   - Looks up the node definition from the workflow
   - Creates `SpaceTask` records for each agent on the node
   - Creates or reuses the `SpaceSessionGroup` for the node
   - Returns the created tasks
3. Handle edge cases:
   - Node already has active tasks → skip activation (no-op)
   - Node activation fails (e.g., workflow paused/cancelled) → return error in delivery result
   - Concurrent activation attempts → use DB-level uniqueness constraint on `(workflowRunId, nodeId, slotRole)` to prevent duplicate tasks
4. Add idempotency: calling `activateNode()` multiple times for the same node is safe (existing tasks are not duplicated)

**Acceptance Criteria**:
- `deliverMessage()` automatically activates the target node if no active tasks exist
- `activateNode()` creates tasks and session groups correctly
- Duplicate activation attempts are handled idempotently
- Unit tests cover: first activation, idempotent re-activation, concurrent activation, activation of cancelled run

**Dependencies**: Tasks 2.2, 2.3

**Agent Type**: coder

---

### Task 4.2: Extend send_message for Cross-Node Delivery

**Description**: Update the `send_message` tool in step-agent-tools.ts to support cross-node delivery via gated channels, using a simple string-based addressing model. The `target` parameter is a plain string — the router resolves it at delivery time: if it matches an agent name, it's a DM; if it matches a node name, it's a fan-out to all agents in that node.

**Subtasks**:
1. Add `CrossNodeChannelRouter` as an optional dependency to `StepAgentToolsConfig`
2. In the `send_message` handler:
   - First, try within-node delivery (existing behavior): if `target` matches an agent name on the same node, deliver as DM to that agent. If `target` matches the current node name, broadcast to all agents on the node.
   - If no within-node match is found, try cross-node delivery via the router:
     - Resolve `target` as a node name (fan-out) or agent name (DM)
     - Call `CrossNodeChannelRouter.deliverMessage()` with the resolved target
   - Return appropriate results for both within-node and cross-node delivery
3. Update `SendMessageSchema` in `step-agent-tool-schemas.ts`:
   ```
   target: z.string()    // agent name (DM) or node name (fan-out)
   ```
4. **Target resolution algorithm**: When `send_message` receives a target string, the router resolves it as follows:
   1. **Agent match**: Check if `target` matches any agent name (globally unique within the workflow). If so, deliver as a DM to that agent. The router finds a `CrossNodeChannel` with matching `fromNode` (sender's node) and `toAgent` (target agent name).
   2. **Node match**: Check if `target` matches any node name. If so, deliver as fan-out to all agents on that node. The router finds a `CrossNodeChannel` with matching `fromNode` (sender's node) and `toNode` (target node name).
   3. **No match**: Return `{ delivered: false, reason: 'Unknown target: no agent or node found with this name' }`
   4. **Gate evaluation**: For the matching policy, evaluate its `gate`. If allowed, deliver. If blocked, return the reason.
5. **Within-node precedence**: If the target matches both a within-node peer and a cross-node agent/node, within-node delivery takes precedence (avoids unnecessary cross-node routing).

**Acceptance Criteria**:
- `send_message` can deliver messages within a node (existing behavior) and across nodes (new)
- `target` is a plain string — no structured objects
- Target resolves as: agent name → DM, node name → fan-out to all agents in that node
- Cross-node delivery is gated — blocked if gate condition fails
- Within-node delivery takes precedence over cross-node for ambiguous names
- Clear error messages when target is unknown or gate blocks delivery

**Dependencies**: Tasks 4.1

**Agent Type**: coder

---

### Task 4.3: Wire Cross-Node Router into Task Agent

**Description**: Wire the `CrossNodeChannelRouter` into the Task Agent's tool configuration so step agents can use cross-node messaging.

**Subtasks**:
1. In `TaskAgentManager`, create `CrossNodeChannelRouter` instances and inject them into step agent MCP server configs
2. Update `createSubSessionFactory` / `buildStepAgentMcpServerForSession` to pass the router
3. Ensure the router has access to all needed dependencies (repos, evaluator, workspace path)

**Acceptance Criteria**:
- Step agent MCP servers have cross-node channel routing capability
- The router is created with correct dependencies for each sub-session
- No circular dependency issues

**Dependencies**: Tasks 4.1, 4.2

**Agent Type**: coder

---

### Task 4.4: Add list_reachable_agents Tool

**Description**: Add a tool that lets step agents query who they can reach. This follows the Slack-like model — from the agent's perspective, channels are implicit and the tool just answers "who can I message?"

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

**Dependencies**: Tasks 4.1

**Agent Type**: coder

---

### Task 4.5: Remove advance() and Replace with Agent-Driven Progression

**Description**: Remove `advance()` from `WorkflowExecutor` and `SpaceRuntime`. Agent-driven cross-node messaging is now the sole advancement mechanism.

**Subtasks**:
1. In `packages/daemon/src/lib/space/runtime/workflow-executor.ts`:
   - Remove `advance()` method entirely
   - Remove any condition evaluation logic that was only used by `advance()` (now moved to `ChannelGateEvaluator`)
   - Clean up unused imports and types related to transition-based advancement
2. In `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Remove all `advance()` calls from `processRunTick()` and `executeTick()`
   - Remove the "all tasks completed on current step → advance" detection logic
   - The tick loop now only handles: liveness checks, agent completion (milestone 3/5), and stuck-member auto-completion
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

**Dependencies**: Tasks 4.3

**Agent Type**: coder

---

### Task 4.6: Unit and Integration Tests for Agent-Driven Advancement

**Description**: Write comprehensive tests for the agent-driven advancement system.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/cross-node-channel-router.test.ts`
2. Test cases for `CrossNodeChannelRouter`:
   - Gate-open delivery succeeds
   - Gate-closed delivery returns reason
   - Human gate blocks and allows after approval
   - Condition gate runs shell expression
   - Task result gate evaluates correctly
   - Wildcard channel routes to all agents in target node
   - Invalid channel reference returns error
   - Lazy activation of target node on first delivery
   - Cyclic channel delivery increments iteration count
   - Iteration cap blocks delivery when reached
   - Non-cyclic channel delivery does NOT increment iteration count
   - Idempotent activation on subsequent deliveries
3. Create `packages/daemon/tests/unit/space/step-agent-cross-node-messaging.test.ts`
4. Test cases for `send_message` cross-node extension:
   - Within-node delivery still works (agent name resolves to within-node peer)
   - Cross-node delivery with agent name target (DM to specific agent on another node)
   - Cross-node delivery with node name target (fan-out to all agents on another node)
   - Cross-node delivery with open gate succeeds
   - Cross-node delivery with closed gate returns reason
   - Mixed within-node and cross-node routing
   - Target string matching: agent name → DM, node name → fan-out
   - Unknown target returns "no agent or node found" error
   - Within-node precedence: ambiguous name resolves within-node first

**Acceptance Criteria**:
- All tests pass
- Cross-node messaging works end-to-end in tests
- Gate evaluation is correctly applied to cross-node messages
- No regressions in within-node messaging

**Dependencies**: Tasks 4.2, 4.4, 4.5

**Agent Type**: coder

## Rollback Strategy

- **CrossNodeChannelRouter** (Task 4.1): New class, no existing behavior modified. Can be removed entirely.
- **Target-node activation** (Task 4.1a): New `activateNode()` function. Can be removed without affecting other code.
- **send_message extension** (Task 4.2): The cross-node path only activates when `CrossNodeChannelRouter` is injected. Within-node delivery is unchanged.
- **advance() removal** (Task 4.5): This is a destructive change. The `advance()` code should be preserved in git history. If rollback is needed, the method can be restored from the pre-milestone commit.
