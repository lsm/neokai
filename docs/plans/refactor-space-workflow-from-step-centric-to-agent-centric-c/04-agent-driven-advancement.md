# Milestone 4: Agent-Driven Advancement via Gated Channels

## Goal

Enable agents to drive workflow progression through gated cross-node channels, replacing `advance()` as the primary workflow driver. When an agent sends a message through a gated cross-node channel, the gate is evaluated and if it passes, the message is delivered to the target agent in the next node, effectively advancing the workflow.

## Scope

- Implement gated message delivery for cross-node channels
- Create the channel-routing + gate-enforcement layer in the executor
- Update `send_message` to support cross-node delivery
- Add `check_cross_node_channels` tool to step agents
- Wire gate evaluation into the message delivery path

## Tasks

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
       fromRole: string;
       toRole: string;
       fromNode: string;
       toNode: string;
       context: ChannelGateContext;
     }): Promise<{ allowed: boolean; reason?: string; channelId?: string }>

     // Deliver a message through a cross-node channel
     // 1. Ensure target node has active tasks/sessions (activate if needed — see Task 4.1a)
     // 2. Resolve the target agent's session
     // 3. Evaluate the gate
     // 4. If allowed, inject the message
     // 5. If gate blocked, return the reason (agent can retry or escalate)
     async deliverMessage(params: {
       workflowRunId: string;
       fromRole: string;
       fromSessionId: string;
       toRole: string;
       fromNode: string;
       toNode: string;
       message: string;
       context: ChannelGateContext;
     }): Promise<{ delivered: boolean; reason?: string; targetSessions: string[] }>

     // List available cross-node channels from the current node
     listOutboundChannels(params: {
       workflowRunId: string;
       fromNode: string;
       fromRole: string;
     }): ResolvedCrossNodeChannel[]
   }
   ```
3. Gate evaluation uses `ChannelGateEvaluator` from Milestone 1
4. For human gates: return `{ allowed: false, reason: 'Waiting for human approval' }` -- the agent can use `request_human_input` (existing tool) and retry

**Acceptance Criteria**:
- `canDeliver()` correctly evaluates gate conditions
- `deliverMessage()` routes messages across nodes after gate evaluation
- Gate-blocked messages return clear reasons
- The router is unit-testable with mock dependencies

**Dependencies**: Tasks 1.3, 2.2, 4.1a

**Agent Type**: coder

---

### Task 4.1a: Target-Node Activation Strategy (Lazy Activation)

**Description**: Define and implement the strategy for activating target nodes when a cross-node channel fires but the target node's agents have not yet been spawned. In the current architecture, `advance()` creates pending `SpaceTask` records which are prerequisites for `spawn_step_agent`. Without `advance()`, something else must materialize those tasks/sessions.

**Chosen approach: Lazy activation by the router.** When `CrossNodeChannelRouter.deliverMessage()` targets a node that has no active tasks or sessions, the router itself creates the pending tasks for that node by calling `SpaceTaskManager` (or an equivalent path). This ensures agents are materialized on-demand when cross-node channels fire, without requiring pre-spawning or Task Agent orchestration.

**Why lazy activation over alternatives:**
- **Pre-spawning all nodes** at workflow start wastes resources and can confuse agents that receive messages before they have context.
- **Requiring the Task Agent to explicitly activate** adds coordination complexity and reintroduces a central controller pattern we're trying to move away from.
- **Lazy activation** is the most agent-centric: the system reacts to agent initiative, not the other way around.

**Subtasks**:
1. In `CrossNodeChannelRouter.deliverMessage()`, before resolving the target agent's session:
   - Query `SpaceTaskRepository` for active tasks on the target node (`workflowRunId` + `nodeId`)
   - If no active tasks exist, call `SpaceTaskManager.createTasksForNode()` to create pending tasks for the target node's agents
   - The task creation follows the same logic as `WorkflowExecutor.advance()` but is scoped to a specific target node (no transition evaluation needed)
2. Extract node activation logic from `WorkflowExecutor.advance()` into a reusable `activateNode(runId: string, nodeId: string): Promise<SpaceTask[]>` method (or a standalone function) that:
   - Looks up the node definition from the workflow
   - Creates `SpaceTask` records for each agent role on the node
   - Creates or reuses the `SpaceSessionGroup` for the node
   - Returns the created tasks
3. Reuse this `activateNode()` in both `CrossNodeChannelRouter` and `WorkflowExecutor.advance()` to avoid duplication
4. Handle edge cases:
   - Node already has active tasks → skip activation (no-op)
   - Node activation fails (e.g., workflow paused/cancelled) → return error in delivery result
   - Concurrent activation attempts → use DB-level uniqueness constraint on `(workflowRunId, nodeId, slotRole)` to prevent duplicate tasks
5. Add idempotency: calling `activateNode()` multiple times for the same node is safe (existing tasks are not duplicated)

**Acceptance Criteria**:
- `deliverMessage()` automatically activates the target node if no active tasks exist
- `activateNode()` creates tasks and session groups correctly
- Duplicate activation attempts are handled idempotently
- `WorkflowExecutor.advance()` uses the same `activateNode()` internally (no duplication)
- Unit tests cover: first activation, idempotent re-activation, concurrent activation, activation of cancelled run
- The existing `advance()` path is not broken by the refactoring

**Dependencies**: Tasks 2.2, 2.3

**Agent Type**: coder

---

### Task 4.2: Extend send_message for Cross-Node Delivery

**Description**: Update the `send_message` tool in step-agent-tools.ts to support cross-node delivery via gated channels.

**Subtasks**:
1. Add `CrossNodeChannelRouter` as an optional dependency to `StepAgentToolsConfig`
2. In the `send_message` handler, after checking within-node channels:
   - If no within-node match is found, check cross-node channels
   - If a cross-node channel matches, use `CrossNodeChannelRouter.deliverMessage()`
   - Return appropriate results for both within-node and cross-node delivery
3. The `target` parameter in `SendMessageSchema` uses a **structured object** for cross-node targets (no `role@node` string syntax):
   - Current behavior: `target: 'coder'` (within-node only, plain string)
   - New cross-node behavior: `target: { role: 'reviewer', node: 'verify' }` (structured object)
   - **No `role@node` string syntax is supported** — the structured form is unambiguous and avoids parsing edge cases with `@` in role/node names
   - Backward compatible: plain string still means within-node delivery
4. Update `SendMessageSchema` in `step-agent-tool-schemas.ts` to accept the new target format:
   ```
   target: z.union([
     z.string(),                          // within-node: 'coder'
     z.object({ role: z.string(), node: z.string() })  // cross-node
   ])
   ```

**Acceptance Criteria**:
- `send_message` can deliver messages within a node (existing behavior) and across nodes (new)
- Cross-node delivery is gated -- blocked if gate condition fails
- Plain role strings still work for within-node delivery (backward compatible)
- Cross-node targets must use `{ role, node }` object syntax (no `role@node` string form)
- Clear error messages when cross-node delivery is blocked by a gate

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

### Task 4.4: Add check_cross_node_channels Tool

**Description**: Add a tool that lets step agents query which cross-node channels are available to them and whether the gates currently allow delivery.

**Subtasks**:
1. Create schema `CheckCrossNodeChannelsSchema` in `step-agent-tool-schemas.ts`
2. Add `check_cross_node_channels` handler in `step-agent-tools.ts`:
   - Lists outbound cross-node channels from the current node for the agent's role
   - For each channel, shows: target node, target role, gate type, gate status (open/closed), gate description
   - Useful for agents to understand what transitions are available and which gates they need to satisfy
3. Add the tool to `createStepAgentMcpServer()`

**Acceptance Criteria**:
- Step agents can query available cross-node channels
- Gate status information is included (open/closed and reason)
- The tool helps agents make informed decisions about when to send cross-node messages

**Dependencies**: Tasks 4.1

**Agent Type**: coder

---

### Task 4.5: Unit and Integration Tests for Agent-Driven Advancement

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
3. Create `packages/daemon/tests/unit/space/step-agent-cross-node-messaging.test.ts`
4. Test cases for `send_message` cross-node extension:
   - Within-node delivery still works (backward compat)
   - Cross-node delivery with open gate succeeds
   - Cross-node delivery with closed gate returns reason
   - Mixed within-node and cross-node routing

**Acceptance Criteria**:
- All tests pass
- Cross-node messaging works end-to-end in tests
- Gate evaluation is correctly applied to cross-node messages
- No regressions in within-node messaging

**Dependencies**: Tasks 4.2, 4.4

**Agent Type**: coder

## Rollback Strategy

- **CrossNodeChannelRouter** (Task 4.1): New class, no existing behavior modified. Can be removed entirely without affecting step-centric workflows.
- **Target-node activation** (Task 4.1a): The `activateNode()` extraction from `advance()` is a refactoring. If it introduces bugs, `advance()` can temporarily call its original inline logic while the extraction is fixed.
- **send_message extension** (Task 4.2): The cross-node path only activates when `CrossNodeChannelRouter` is injected (which only happens when cross-node channels exist). Within-node delivery is unchanged.
- **Lazy activation side effect**: If a cross-node message auto-activates a node and this causes issues, the activation can be made opt-in via a workflow setting.
