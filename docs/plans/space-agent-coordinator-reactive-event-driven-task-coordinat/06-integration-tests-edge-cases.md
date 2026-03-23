# Milestone 6: Integration Tests & Edge Cases

## Goal

Comprehensive integration tests covering the full notification pipeline, autonomy-level-based decision paths, and edge cases. This ensures the entire Layer 4a system works end-to-end and handles real-world scenarios gracefully.

## Scope

- Integration tests exercising the full flow: task status change -> SpaceRuntime tick -> NotificationSink -> session message
- Autonomy level behavior tests (supervised vs semi_autonomous paths)
- Edge case tests (concurrent notifications, rapid task state changes, runtime restart with pending notifications)
- Online tests with dev proxy for Space Agent prompt + tool interaction

---

### Task 6.1: Full pipeline integration tests

**Description:** Write integration tests that exercise the complete notification pipeline from task state change through SpaceRuntime tick to message delivery in the Space Agent session.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/unit/space/space-runtime-notifications.test.ts`
2. Test: task transitions to `needs_attention` -> tick -> `MockNotificationSink` receives `task_needs_attention` event
3. Test: workflow run gate blocked -> tick -> sink receives `workflow_run_needs_attention` event
4. Test: workflow run completes -> tick -> sink receives `workflow_run_completed` event
5. Test: task exceeds timeout -> tick -> sink receives `task_timeout` event
6. Test: normal task completion and advancement -> tick -> sink receives NO notification (mechanical only)
7. Test: standalone task `needs_attention` -> tick -> sink receives notification
8. Test: multiple events in single tick (two tasks fail simultaneously) -> sink receives both events

**Acceptance criteria:**
- All event types are verified end-to-end through the real SpaceRuntime tick loop
- Mechanical-only transitions produce zero notifications
- Multiple concurrent events are all delivered
- Tests use real DB (SQLite in-memory) and real SpaceRuntime, only mocking the NotificationSink

**Dependencies:** Task 2.2, Task 2.3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.2: Autonomy level behavior tests

**Description:** Write tests verifying that the Space Agent prompt and tool behavior differs correctly between `supervised` and `semi_autonomous` autonomy levels.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/unit/space/space-agent-autonomy.test.ts`
2. Test: prompt generation with `supervised` autonomy includes "notify human of ALL events" instruction
3. Test: prompt generation with `semi_autonomous` autonomy includes "retry once autonomously" instruction
4. Test: prompt generation with no autonomy level defaults to supervised instructions
5. Test: notification sink message format includes the space's autonomy level so the agent can read it and make context-appropriate decisions
6. Test: `retry_task` tool is callable at both autonomy levels — verify the tool itself returns success regardless of level (the autonomy gate is in the prompt, not the tool code)

**Acceptance criteria:**
- Prompt content varies correctly based on autonomy level
- Default (no autonomy level set) produces supervised-mode prompt
- Notification messages include autonomy context
- Tests document the behavioral contract for each autonomy level

**Dependencies:** Task 4.1, Task 1.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.3: Edge case and resilience tests

**Description:** Test edge cases and failure modes to ensure the notification system is robust under adverse conditions.

**Agent type:** coder

**Subtasks:**
1. Test: notification sink throws an error -> SpaceRuntime tick does not crash, error is logged, other runs still processed
2. Test: task changes status rapidly (needs_attention -> pending -> in_progress -> needs_attention) between ticks -> only the final state generates a notification
3. Test: SpaceRuntime rehydration with pending notifications (runtime restart while tasks are in needs_attention) -> notifications emitted on first tick after restart
4. Test: notification deduplication for standalone tasks (same task, same status, multiple ticks) -> only one notification
5. Test: workflow run cancelled externally while notification is in flight -> no stale notification delivered
6. Test: session not available when notification fires (session deleted) -> graceful degradation, no crash

**Acceptance criteria:**
- NotificationSink errors do not crash the tick loop
- Rapid state changes do not produce spurious notifications
- Rehydration correctly re-evaluates notification-worthy states
- Deduplication prevents notification spam
- All edge cases are documented by test descriptions

**Dependencies:** Task 5.1, Task 5.2, Task 2.3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.4: Online tests with dev proxy for Space Agent tool interaction

**Description:** Write online tests using the dev proxy (`NEOKAI_USE_DEV_PROXY=1`) to verify that the Space Agent actually calls the correct coordination tools when it receives `[TASK_EVENT]` notifications. These tests exercise the full LLM-driven decision loop with mocked API responses.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/online/space/space-agent-coordination.test.ts`
2. Test: inject a `[TASK_EVENT]` message with `task_needs_attention` kind into a provisioned Space Agent session (using dev proxy). Verify the agent calls `get_task_detail` and/or `retry_task` tool in its response (via tool_use blocks in the mocked response).
3. Test: in `supervised` mode, inject a `[TASK_EVENT]` and verify the agent's response includes escalation text (asking the human for guidance) rather than autonomous action.
4. Test: in `semi_autonomous` mode, inject a `[TASK_EVENT]` and verify the agent attempts `retry_task` autonomously.
5. Configure dev proxy mock responses that simulate realistic Claude responses with tool calls for each scenario.

**Acceptance criteria:**
- Online tests run with `NEOKAI_USE_DEV_PROXY=1` and do NOT make real API calls
- Tests verify the Space Agent prompt + tool interaction produces expected behavior
- Both autonomy levels are tested for correct agent decision-making
- Tests follow the existing online test patterns (see `packages/daemon/tests/online/`)

**Dependencies:** Task 5.2, Task 4.1, Task 3.3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
