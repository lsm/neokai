# Milestone 6: User Interaction in Task View

## Goal

Verify and harden user interaction within the task view: sending messages to the task agent, @mentioning specific agents, and message routing through channels.

## Scope

Happy path 11 (User interaction in task view).

## Tasks

### Task 6.1: Verify user-to-task-agent messaging

**Description:** Users can send messages to the task agent via the inline composer in `SpaceTaskPane`. Verify this flow works end-to-end: message is sent, task agent receives it, response appears in the unified thread.

**Subtasks:**
1. Read `packages/web/src/components/space/SpaceTaskPane.tsx` for the `handleThreadSend` function.
2. Read `packages/web/src/lib/space-store.ts` for `sendTaskMessage` and `ensureTaskAgentSession`.
3. Read `packages/daemon/src/lib/rpc-handlers/space-task-message-handlers.ts` for the backend handler.
4. Check existing tests in `packages/daemon/tests/unit/space/space-task-message-handlers*`.
5. Add unit tests for: message reaches task agent session, message appears in unified thread, error handling for missing session.
6. Add Vitest test for the composer: submit sends message, disabled during send, error displays.
7. Run tests to verify.

**Acceptance Criteria:**
- User messages are delivered to the task agent session.
- Messages appear in the unified thread.
- Error states are handled and displayed.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 4.1

**Agent type:** coder

### Task 6.2: Verify @mention routing to specific agents

**Description:** Users should be able to @mention specific agents in the task thread to route messages to them. Verify the channel router handles @mentions correctly.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/runtime/channel-router.ts` for message routing logic.
2. Read `packages/daemon/src/lib/space/runtime/channel-resolver.ts` for channel resolution.
3. Check if @mention parsing exists in the task message handler or if it needs to be added.
4. Check existing tests in `packages/daemon/tests/unit/space/channel-router*`.
5. If @mention routing is not implemented, add it: parse @AgentName from message text, route to the matching agent's session.
6. Add unit tests for: @mention routes to correct agent, multiple @mentions route to all mentioned agents, invalid @mention is handled gracefully.
7. Run tests to verify.

**Acceptance Criteria:**
- @mention in task thread routes message to the specified agent.
- Unit tests cover single mention, multiple mentions, and invalid mention cases.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 6.1

**Agent type:** coder

### Task 6.3: Add @mention autocomplete in task thread composer

**Description:** Add autocomplete/suggestion UI for @mentions in the task thread composer so users can easily select agents by name.

**Subtasks:**
1. Read `packages/web/src/components/space/SpaceTaskPane.tsx` for the textarea composer.
2. Read `packages/web/src/lib/space-store.ts` for `agents` signal (list of space agents).
3. Add @mention detection: when user types `@`, show a dropdown of available agents.
4. On selecting an agent from the dropdown, insert the agent name into the textarea.
5. Style the @mention dropdown to match the existing UI patterns.
6. Add Vitest tests: dropdown appears on `@` input, selecting agent inserts name, dropdown closes on selection.
7. Run tests to verify.

**Acceptance Criteria:**
- Typing `@` in the task thread composer shows an agent autocomplete dropdown.
- Selecting an agent inserts their name into the message.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 6.2

**Agent type:** coder
