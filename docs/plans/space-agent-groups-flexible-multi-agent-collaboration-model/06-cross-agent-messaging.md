# Milestone 6: Cross-Agent Messaging with Channel Enforcement

## Goal

Enable agents within the same session group to communicate with each other via declared channel topology. Direct agent-to-agent messaging along declared channels is the **primary** communication model. Task Agent mediated routing is a **fallback** for undeclared paths. This allows scenarios like reviewers sending feedback to a coder along a declared `reviewer → coder` channel, with the channel topology enforced at the messaging layer.

## Scope

- Implement channel-validated direct peer messaging as the primary model
- Add `send_feedback` MCP tool that validates against declared `WorkflowStep.channels` before routing
- Add `request_peer_input` MCP tool as Task Agent mediated fallback (for undeclared channels)
- Add `list_group_members` and `relay_message` MCP tools for Task Agent
- Resolve channel topology at step-start time and pass to each agent session's tool context
- Message routing scoped to groups (no cross-group leakage)
- Concurrency handling: `messageInjector` serializes writes per-session; concurrent injections are queued
- Unit tests and integration tests for channel validation and message routing

---

### Task 6.1: Channel Resolution and Task Agent Messaging Tools

**Description:** Implement the channel resolution layer and add MCP tools to the Task Agent for group awareness and message relay. The channel topology (resolved at step-start in Task 4.2) is read from the session group metadata and used to validate all messaging operations.

**Subtasks:**
1. Create a `ChannelResolver` utility that loads the resolved channels for a group/step and provides a validation API:
   - `canSend(fromRole: string, toRole: string): boolean` — checks if a declared channel permits this direction
   - `getPermittedTargets(fromRole: string): string[]` — returns all roles the sender can message
   - `getResolvedChannels(): ResolvedChannel[]` — returns the full resolved topology
   - The resolver reads from the session group metadata (where Task 4.2 stores the resolved channels at step-start)
2. Add `list_group_members` tool to the Task Agent MCP server (`task-agent-tools.ts`):
   - Returns all members of the current group with their sessionId, role, agentId, status, **and permitted channels** (so the Task Agent knows the topology)
   - Uses `SpaceSessionGroupRepository` to look up the group by taskId
3. Add `relay_message(targetSessionId: string, message: string)` tool to the Task Agent:
   - Injects a user-turn message into the target sub-session using `messageInjector`
   - Validates that the target session is a member of the same group (no cross-group messaging). **Important**: Use DB lookup via `SpaceSessionGroupRepository` (not just the in-memory `taskId -> groupId` map) to ensure correctness after daemon restarts.
   - The Task Agent is **not constrained by channel topology** — it can relay to any member in the group (it's the coordinator/fallback)
   - `messageInjector` serializes writes per-session: if the target is mid-conversation, the message queues behind the current turn. Two concurrent injections into the same target are serialized (no interleaving).
   - Returns confirmation or error
4. Update the Task Agent's system prompt to explain: (a) it can relay messages between step agents, (b) the channel topology for the current step, (c) it should respect channel intentions but can override when coordination requires it
5. Add the `onSubSessionComplete` callback to include the completed agent's result summary, so the Task Agent can decide whether to relay feedback

**Acceptance Criteria:**
- `ChannelResolver` correctly validates send permissions based on declared channels
- Task Agent can list all members of its group with channel information
- Task Agent can send messages to any active member in the group (unrestricted by channels)
- Cross-group messaging is rejected with a clear error
- Messages appear in the target session as user turns

**Dependencies:** Task 2.2 (group persistence with members), Task 4.2 (multi-agent steps + channel resolution)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.2: Step Agent Peer Communication Tools (Channel-Validated)

**Description:** Add MCP tools to step agents for direct peer communication. The `send_feedback` tool (primary model) validates against declared channels before routing. The `request_peer_input` tool (fallback) routes through the Task Agent for undeclared paths.

**Subtasks:**
1. Add `send_feedback(target: string | string[], message: string)` tool as the **primary** direct messaging tool for step agents:
   - `target` supports three forms:
     - `target: 'coder'` — point-to-point to a single role
     - `target: '*'` — broadcast to all roles the sender has a channel to
     - `target: ['coder', 'reviewer']` — targeted multicast to specific roles
   - **Validates against declared channels** before routing: uses `ChannelResolver.canSend(senderRole, targetRole)` to check if a channel permits this direction for each target
   - If channel validation passes: resolves the target role(s) to session ID(s), injects the message as a user-turn into each target session via `messageInjector`
   - If channel validation fails (no declared channel permits this direction): returns a clear error explaining which channels are available, and suggests using `request_peer_input` as a fallback
   - **Hub-spoke enforcement**: In a fan-out bidirectional channel `A ↔ [B,C,D]`, spoke agents (B, C, D) can only target the hub (A) — not each other. The resolver marks spoke→hub entries with `isHubSpoke: true` so validation knows spokes are restricted to the hub.
   - For fan-out one-way channels (`A → [B,C,D]`): hub sends to all spokes, spokes cannot reply
   - For bidirectional point-to-point (`A ↔ B`): permits both directions symmetrically
   - Uses `messageInjector` from the session factory
2. Add `request_peer_input(targetRole: string, question: string)` tool as the **fallback** Task Agent mediated routing:
   - Available when no direct channel is declared between sender and target, OR when the step has no `channels` at all (open communication)
   - Sends the question to the Task Agent session with context about which agent is asking and what role they want input from
   - The Task Agent decides which specific peer to route to (since multiple agents may share a role)
   - Returns an acknowledgment that the request has been submitted (NOT a blocking call)
   - **Async response mechanism**: The peer's answer flows back via the Task Agent, which injects it into the requesting agent's session as a new user turn (via `messageInjector`), prefixed with `[Peer response from {role}]: ...`. The requesting agent processes this on its next conversation turn.
   - Update the step agent system prompt to explain that `request_peer_input` is asynchronous: the response will arrive as a new user turn, not as the tool's return value
3. Add `list_peers()` tool for step agents:
   - Returns other members of the same group (excluding self) with their role, status, sessionId, **and which channels connect them** (so the agent knows its permitted communication paths)
   - Shows both direct channels (from declared topology) and the fallback `request_peer_input` option
4. Update step agent system prompts to explain the communication model:
   - "You have declared channels to these roles: [list]. Use `send_feedback` for direct messages along these channels."
   - "For roles without a declared channel, use `request_peer_input` to ask the Task Agent to relay."
   - Include the channel topology in the system prompt context (from the resolved channels passed at step-start)

**Acceptance Criteria:**
- `send_feedback` validates against declared channels and rejects unauthorized directions
- `send_feedback` correctly handles one-way, bidirectional point-to-point, fan-out one-way, and fan-out bidirectional (hub-spoke) patterns
- Hub-spoke: hub can broadcast/multicast to spokes, spokes can only reply to hub (not to each other)
- `send_feedback` supports `target: string`, `target: '*'`, and `target: string[]` forms
- `request_peer_input` remains available as fallback for undeclared paths
- Step agents can discover their permitted channels via `list_peers()`
- Steps with no `channels` declared: all peer communication goes through `request_peer_input` (open/mediated model)
- All communication is scoped to the group

**Dependencies:** Task 6.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.3: Unit Tests for Cross-Agent Messaging

**Description:** Write comprehensive unit tests for all messaging tools and routing logic.

**Subtasks:**
1. Create test file `packages/daemon/tests/unit/cross-agent-messaging.test.ts`
2. Test `ChannelResolver.canSend()`: correctly permits/denies based on declared channels
3. Test `ChannelResolver` with all topology patterns:
   - `A → B` one-way: A can send to B, B cannot send to A
   - `A ↔ B` bidirectional point-to-point: both directions permitted
   - `A → [B, C, D]` fan-out one-way: A can send to B, C, D; none can send back to A
   - `A ↔ [B, C, D]` fan-out bidirectional (hub-spoke): A can send to B, C, D; B, C, D can each reply to A; B cannot send to C (spoke isolation)
   - `* → B` wildcard: any role can send to B
   - `A → *` wildcard: A can send to any role
4. Test `send_feedback` tool: validates against channels and injects message on success
5. Test `send_feedback` channel denial: rejects message when no channel permits the direction, returns clear error
6. Test `send_feedback` fan-out one-way: hub sends to all spokes, spokes cannot reply
7. Test `send_feedback` hub-spoke bidirectional: hub broadcasts to spokes, spoke replies to hub only, spoke-to-spoke rejected
8. Test `send_feedback` target modes: `target: 'role'` (point-to-point), `target: '*'` (broadcast), `target: ['a','b']` (multicast)
7. Test `request_peer_input` tool: request is routed to Task Agent (fallback path)
8. Test `list_group_members` tool: returns correct members with channel information
9. Test `relay_message` tool: Task Agent can relay to any member (not constrained by channels)
10. Test `relay_message` validation: rejects cross-group targets
11. Test `list_peers` tool: returns correct peers with their permitted channel connections
12. Test group scoping: verify that messages cannot leak between different task groups
13. Test error cases: messaging a completed/failed member, messaging a non-existent session
14. Test the `request_peer_input` async response flow: request is sent, Task Agent receives it, response is injected back into requesting agent's session as a user turn
15. Test step with no channels declared: all communication goes through `request_peer_input` (open model)

**Acceptance Criteria:**
- All tests pass with `cd packages/daemon && bun test tests/unit/cross-agent-messaging.test.ts`
- Channel validation is thoroughly tested for all topology patterns
- Group scoping is verified (no cross-group leakage)
- Error handling is tested for all edge cases
- Tests mock the session factory and message hub appropriately

**Dependencies:** Task 6.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.4: Integration Test for Cross-Group Isolation and Channel Enforcement

**Description:** Write a daemon integration test that creates real groups with declared channels and verifies: (a) messages are properly scoped to groups, (b) channel topology is enforced, and (c) bidirectional exchanges complete correctly. Unit tests with mocks cannot fully verify these security boundaries.

**Subtasks:**
1. Create test file `packages/daemon/tests/unit/cross-agent-messaging-integration.test.ts`
2. Set up two separate task groups with multiple members each (using real DB, not mocks)
3. Attempt to send a message from a member in group A to a member in group B — verify it is rejected
4. Send a message from a member in group A to another member in group A along a declared channel — verify it succeeds
5. Attempt to send a message in a direction not permitted by declared channels — verify it is rejected with a clear error
6. **Test bidirectional point-to-point A ↔ B exchange**: set up a `bidirectional` channel between two agents, send messages in both directions, verify both are delivered correctly and the full exchange completes
7. **Test fan-out one-way delivery**: set up `A → [B, C, D]` channel, send from A, verify B, C, and D all receive the message; verify B cannot reply to A
8. **Test hub-spoke bidirectional**: set up `A ↔ [B, C, D]` channel, verify: (a) A broadcasts to all spokes, (b) each spoke independently replies to A, (c) spoke B attempting to send to spoke C is rejected (spoke isolation)
8. Test concurrent message injection: two agents inject into the same target simultaneously — verify messages are serialized (no interleaving, both delivered)
9. Verify that group lookups and channel resolution work correctly after simulated data reload (testing the DB-based validation, not just in-memory state)

**Acceptance Criteria:**
- All tests pass with `cd packages/daemon && bun test tests/unit/cross-agent-messaging-integration.test.ts`
- Cross-group messaging is definitively rejected
- Channel direction enforcement is verified (one-way cannot reverse)
- Bidirectional point-to-point exchange completes correctly
- Fan-out one-way delivers to all targets, no reverse permitted
- Hub-spoke bidirectional: hub broadcasts, spokes reply to hub only, spoke isolation verified
- Concurrent injection is serialized correctly
- Tests use real DB (SQLite in-memory) not mocks

**Dependencies:** Task 6.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
