# Milestone 6: Integration Verification

## Milestone Goal

Verify that the room runtime correctly wires all restructured agents. Ensure the `QueryOptionsBuilder` correctly propagates agent/agents configuration to the SDK, and that the room runtime's agent spawning paths all work with the always-on pattern.

## Scope

- `packages/daemon/src/lib/room/runtime/room-runtime.ts` - Verify integration points
- `packages/daemon/src/lib/agent/query-options-builder.ts` - Verify agent/agents propagation
- `packages/daemon/tests/unit/room/` - Integration-focused unit tests

## Tasks

### Task 6.1: Verify QueryOptionsBuilder propagates always-on agents correctly

**Description:** Review and test that `QueryOptionsBuilder.build()` correctly handles the agent/agents configuration from the always-on pattern. When `session.config.agent` and `session.config.agents` are set (which they always are now), they should flow through to the SDK `Options` correctly. Verify there are no edge cases where the agents map is dropped or overwritten.

**Subtasks:**
1. Review the `QueryOptionsBuilder.build()` method for agent/agents handling (lines 147-149)
2. Verify that when `coordinatorMode` is OFF (which it is for room agents), the agent/agents from session config are used directly
3. Verify that when `coordinatorMode` is ON, the coordinator agents are used instead (this path should be unchanged)
4. Add unit test: verify `QueryOptionsBuilder` preserves agent/agents from session config
5. Add unit test: verify `coordinatorMode` does not interfere with room agent configurations
6. Verify worktree isolation text injection works correctly when agents are always present (the worktree prompt injection in coordinator mode iterates over agents - verify this also works for room agents)

**Acceptance Criteria:**
- No bugs found in QueryOptionsBuilder's handling of always-on agents
- Unit tests verify agent/agents propagation
- Worktree isolation works correctly with always-on agents
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Milestones 1-4 (all implementation complete)
**Agent type:** coder

---

### Task 6.2: Verify room-runtime agent spawning paths

**Description:** Review the room runtime's agent spawning paths to ensure they work correctly with the restructured agents. The key integration points are: `startGoalAutonomous()` which spawns coder/planner sessions, and `createLeaderCallbacks()` which creates leader sessions. Verify no code paths assume the old conditional pattern.

**Subtasks:**
1. Review `room-runtime.ts` `startGoalAutonomous()` (around line 4120) - verify it calls `createCoderAgentInit()` and `createPlannerAgentInit()` correctly
2. Review `room-runtime.ts` leader creation paths - verify they call `createLeaderAgentInit()` correctly
3. Check if any code in room-runtime inspects `agentSubagents.worker` separately from the agent factory - if so, it may need updating
4. Review `room-runtime.ts` lines 1304, 1420, 1553 where `agentSubagents` is directly accessed - verify these are for reviewer/leader config checks, not coder agent checks
5. Add integration-style unit test: mock the room runtime's agent spawning and verify the correct init objects are produced for coder, planner, and leader agents
6. Document any edge cases or assumptions found

**Acceptance Criteria:**
- All room-runtime agent spawning paths verified compatible with always-on pattern
- No code paths assume conditional agent/agents
- Integration tests verify correct init production
- Any necessary fixes applied
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 6.1
**Agent type:** coder

---

### Task 6.3: Token overhead measurement and optimization

**Description:** Measure the token overhead introduced by always including agent definitions in the session config. Compare the token count of agent definitions before and after restructuring. If overhead is significant (>2000 tokens per agent type), optimize by shortening prompts or restructuring agent definitions.

**Subtasks:**
1. Write a measurement script that calculates the approximate token count of each agent definition's prompt text
2. Measure before: calculate tokens for current coder init (simple path without helpers) vs. new always-on init
3. Measure before: calculate tokens for current leader init (simple path without reviewers) vs. new always-on init
4. Measure before: calculate tokens for current planner init vs. new 3-phase init
5. If overhead exceeds 2000 tokens per agent type, identify optimization opportunities (shorter prompts, reduced duplication)
6. Apply optimizations if needed
7. Document the token overhead comparison in a test file or comment

**Acceptance Criteria:**
- Token overhead is measured and documented
- If overhead is excessive, optimizations are applied
- All agent prompts remain clear and functional after any optimization
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Milestones 1-4 (all implementation complete)
**Agent type:** coder
