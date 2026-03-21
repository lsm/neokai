# Milestone 6: Cross-Agent Messaging

## Goal

Enable agents within the same session group to communicate with each other. This allows scenarios like reviewers sending feedback to a coder, coder responding with fixes, all within the same workflow step.

## Scope

- Implement Task Agent mediated messaging (Option C -- recommended starting point)
- Add `request_peer_input` and `send_feedback` MCP tools for step agents
- Add `list_group_members` and `relay_message` MCP tools for Task Agent
- Message routing scoped to groups (no cross-group leakage)
- Concurrency handling: `messageInjector` serializes writes per-session; concurrent injections are queued
- Unit tests and integration tests for message routing

---

### Task 6.1: Task Agent Mediated Messaging (MCP Tools)

**Description:** Add MCP tools to the Task Agent that allow it to relay messages between step agents in the same group. This is the foundation: step agents report to the Task Agent, which decides what to relay.

**Subtasks:**
1. Add `list_group_members` tool to the Task Agent MCP server (`task-agent-tools.ts`):
   - Returns all members of the current group with their sessionId, role, agentId, and status
   - Uses `SpaceSessionGroupRepository` to look up the group by taskId
2. Add `relay_message(targetSessionId: string, message: string)` tool to the Task Agent:
   - Injects a user-turn message into the target sub-session using `messageInjector`
   - Validates that the target session is a member of the same group (no cross-group messaging). **Important**: Use DB lookup via `SpaceSessionGroupRepository` (not just the in-memory `taskId -> groupId` map) to ensure correctness after daemon restarts.
   - `messageInjector` serializes writes per-session: if the target is mid-conversation, the message queues behind the current turn. Two concurrent injections into the same target are serialized (no interleaving).
   - Returns confirmation or error
3. Update the Task Agent's system prompt to explain it can relay messages between step agents
4. Add the `onSubSessionComplete` callback to include the completed agent's result summary, so the Task Agent can decide whether to relay feedback

**Acceptance Criteria:**
- Task Agent can list all members of its group
- Task Agent can send messages to any active member in the group
- Cross-group messaging is rejected with a clear error
- Messages appear in the target session as user turns

**Dependencies:** Task 2.2 (group persistence with members), Task 4.2 (multi-agent steps)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.2: Step Agent Peer Communication Tools

**Description:** Add MCP tools to step agents that allow them to request input from peers or send direct feedback, routed through the Task Agent.

**Subtasks:**
1. Add `request_peer_input(targetRole: string, question: string)` tool to step agent MCP servers:
   - Sends the question to the Task Agent session with context about which agent is asking and what role they want input from
   - The Task Agent decides which specific peer to route to (since multiple agents may share a role)
   - Returns an acknowledgment that the request has been submitted (NOT a blocking call)
   - **Async response mechanism**: The peer's answer flows back via the Task Agent, which injects it into the requesting agent's session as a new user turn (via `messageInjector`), prefixed with `[Peer response from {role}]: ...`. The requesting agent processes this on its next conversation turn. This leverages the existing `messageInjector` pattern already used for Task Agent → step agent communication.
   - Update the step agent system prompt to explain that `request_peer_input` is asynchronous: the response will arrive as a new user turn, not as the tool's return value
2. Add `send_feedback(targetSessionId: string, feedback: string)` tool for direct peer messaging:
   - Validates the target is in the same group
   - Injects the feedback as a user-turn message into the target session
   - Uses `messageInjector` from the session factory
3. Add `list_peers()` tool for step agents:
   - Returns other members of the same group (excluding self) with their role, status, and sessionId
   - Helps agents know who they can communicate with
4. Update step agent system prompts to mention these collaboration tools are available when working in a multi-agent group

**Acceptance Criteria:**
- Step agents can request input from peers by role
- Step agents can send direct feedback to specific peers
- Step agents can discover who else is in their group
- All communication is scoped to the group

**Dependencies:** Task 6.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.3: Unit Tests for Cross-Agent Messaging

**Description:** Write comprehensive unit tests for all messaging tools and routing logic.

**Subtasks:**
1. Create test file `packages/daemon/tests/unit/cross-agent-messaging.test.ts`
2. Test `list_group_members` tool: returns correct members for the task's group
3. Test `relay_message` tool: message is injected into target session
4. Test `relay_message` validation: rejects cross-group targets
5. Test `request_peer_input` tool: request is routed to Task Agent
6. Test `send_feedback` tool: feedback is injected into target session
7. Test `list_peers` tool: returns correct peers excluding self
8. Test group scoping: verify that messages cannot leak between different task groups
9. Test error cases: messaging a completed/failed member, messaging a non-existent session
10. Test the `request_peer_input` async response flow: request is sent, Task Agent receives it, response is injected back into requesting agent's session as a user turn

**Acceptance Criteria:**
- All tests pass with `cd packages/daemon && bun test tests/unit/cross-agent-messaging.test.ts`
- Group scoping is verified (no cross-group leakage)
- Error handling is tested for all edge cases
- Tests mock the session factory and message hub appropriately

**Dependencies:** Task 6.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.4: Integration Test for Cross-Group Message Isolation

**Description:** Write a daemon integration test that creates two real groups and verifies that messages are properly scoped — no cross-group leakage. Unit tests with mocks cannot fully verify this security boundary.

**Subtasks:**
1. Create test file `packages/daemon/tests/unit/cross-agent-messaging-integration.test.ts`
2. Set up two separate task groups with multiple members each (using real DB, not mocks)
3. Attempt to send a message from a member in group A to a member in group B — verify it is rejected
4. Send a message from a member in group A to another member in group A — verify it succeeds
5. Test concurrent message injection: two agents inject into the same target simultaneously — verify messages are serialized (no interleaving, both delivered)
6. Verify that group lookups work correctly after simulated data reload (testing the DB-based validation, not just in-memory map)

**Acceptance Criteria:**
- All tests pass with `cd packages/daemon && bun test tests/unit/cross-agent-messaging-integration.test.ts`
- Cross-group messaging is definitively rejected
- Concurrent injection is serialized correctly
- Tests use real DB (SQLite in-memory) not mocks

**Dependencies:** Task 6.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
