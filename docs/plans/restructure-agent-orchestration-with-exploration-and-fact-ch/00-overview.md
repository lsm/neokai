# Restructure Agent Orchestration with Exploration and Fact-Checking

## Goal Summary

Restructure the planner, coder, and reviewer agents to support proper multi-stage orchestration with exploration, fact-checking, and delegation capabilities. The core changes are:

1. **Planner** gains a 3-phase sequential pipeline: explorer -> fact-checker -> plan-writer (replacing the broken "spawn Explore agents" instruction)
2. **Coder** always uses the agent/agents pattern with built-in explorer and tester sub-agents (removing the conditional branch on `room.config.agentSubagents.worker`)
3. **Reviewer** gains exploration and fact-checking sub-agents for deeper code understanding
4. **Leader** always uses the agent/agents pattern with built-in explorer and fact-checker sub-agents, even when no user-configured reviewers or helpers are present

## High-Level Approach

- Each agent type gets built-in sub-agent definitions that are always available (no room config dependency)
- Sub-agents are one-level only (no recursive spawning)
- The `agentSubagents.worker` config path continues to work for user-defined custom helpers, but built-in sub-agents (explorer, tester, fact-checker) are always present. Built-in names take precedence; user-configured helpers with colliding names (e.g., `explorer`) are prefixed with `custom-` to avoid conflicts
- Token overhead is minimized by keeping sub-agent prompts concise and only including them in the agents map (not inlined into the parent prompt)
- **System prompt strategy:** When removing the "simple path," the parent agent's system prompt (previously appended via `{ type: 'preset', preset: 'claude_code', append: ... }`) is embedded into the agent definition's `prompt` field instead. `buildCoderSystemPrompt()` and `buildLeaderSystemPrompt()` always receive built-in sub-agent names so sub-agent usage instructions are always present.

## Sub-Agent Naming Convention

All sub-agents use a consistent `<parent>-<role>` prefix to avoid name collisions and clarify ownership:

| Parent   | Sub-agents                                              |
|----------|---------------------------------------------------------|
| Coder    | `coder-explorer`, `coder-tester`                        |
| Planner  | `planner-explorer`, `planner-fact-checker`, `plan-writer` |
| Reviewer | `reviewer-explorer`, `reviewer-fact-checker`            |
| Leader   | `leader-explorer`, `leader-fact-checker`                |

Note: `plan-writer` keeps its existing name since it is already established in the codebase.

## Milestones

1. **Coder always-on agent/agents** — Remove conditional branching, always provide Task/TaskOutput/TaskStop with built-in coder-explorer and coder-tester sub-agents. Unit tests included.
2. **Planner 3-phase pipeline** — Replace plan-writer's broken Explore instruction with sequential planner-explorer -> planner-fact-checker -> plan-writer sub-agents. Unit tests included.
3. **Reviewer exploration and fact-checking** — Add reviewer-explorer and reviewer-fact-checker sub-agents to reviewer, always use agent/agents pattern. Unit tests included.
4. **Leader always-on agent/agents** — Update leader to always use agent/agents pattern with leader-explorer and leader-fact-checker, even without room-configured reviewers. Unit tests included.
5. **Online tests** — Dev-proxy-based online tests verifying agent orchestration behavior and context-passing between sub-agents.
6. **Integration verification** — Verify room runtime and QueryOptionsBuilder correctly wire all restructured agents.

## Cross-Milestone Dependencies

- Milestone 1 (Coder) and Milestone 2 (Planner) are independent and can proceed in parallel
- Milestone 3 (Reviewer) has no code-level dependency on Milestone 1 (they modify separate files: `leader-agent.ts` vs `coder-agent.ts`), but follows the same always-on pattern established there
- Milestone 4 (Leader) depends on Milestone 3 (reviewer sub-agents are defined in the same file, `leader-agent.ts`)
- Milestone 5 (Online tests) depends on Milestones 1-4 (all implementation + unit tests complete)
- Milestone 6 (Integration) depends on Milestone 5

## Key Sequencing Decisions

- The coder is restructured first because it establishes the always-on pattern that reviewer and leader will follow
- The planner is restructured independently since its 3-phase pipeline is a distinct pattern
- Unit tests are included in each implementation milestone (Tasks X.3 / X.5 / X.3 / X.2) to keep implementation and tests in the same PR for easier review
- Online tests and integration verification are separate milestones because they test cross-cutting behavior after all implementations are complete

## Breaking Changes

- **Plan-writer loses Task/TaskOutput/TaskStop tools**: The current plan-writer has Task tools and its prompt instructs it to "spawn Explore sub-agents." This is broken (sub-agents can't spawn sub-agents in the SDK). Removing these tools is intentional — the plan-writer now receives pre-gathered explorer and fact-checker findings as context. Existing tests (`planner-agent.test.ts` line 302-307, "has Task tool for spawning Explore sub-agents") must be updated to assert the opposite.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Always-on agent/agents increases session init latency | Low — agent definitions are data, not API calls; they are included in the initial SDK options, not spawned eagerly | Monitor SDK session creation time in online tests |
| Planner 3-phase pipeline triples planning API cost | Medium — three sequential sub-agent calls instead of one | Explorer and fact-checker are cheap (read-only/web-only); the overall planning quality improvement should offset cost. Can skip fact-checker for simple goals in a follow-up |
| Sub-agent name collisions with user-configured helpers | Medium — user may name a custom helper `explorer` | Built-in names take precedence; colliding user-defined names are auto-prefixed with `custom-` |
| Each milestone is independently revertible | N/A — this is a benefit | Each milestone modifies a separate agent factory file (`coder-agent.ts`, `planner-agent.ts`, `leader-agent.ts`). Milestones 1-4 can be reverted independently by reverting the PR. Milestones 5-6 (tests only) can be reverted without affecting production behavior |
| Sub-agent errors (timeout, rate limit) in planner pipeline | Medium — a failing explorer or fact-checker blocks plan creation | Planner prompt includes error-handling guidance: if a sub-agent fails, log the error and proceed to the next phase with partial context rather than aborting |

## Total Estimated Task Count

17 tasks across 6 milestones
