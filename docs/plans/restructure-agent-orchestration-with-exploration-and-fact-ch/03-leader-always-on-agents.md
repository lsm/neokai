# Milestone 3: Leader Always-On Agent/Agents Pattern

## Milestone Goal

Update the leader agent to always use the agent/agents pattern, even when no reviewers or helpers are configured via `room.config.agentSubagents`. The leader should always have built-in `leader-explorer` and `leader-fact-checker` sub-agents available for its own analysis work. Additionally, enhance reviewers (which are sub-agents dynamically constructed inside `createLeaderAgentInit()` via `buildReviewerAgents()`) with `reviewer-explorer` and `reviewer-fact-checker` sub-agents so they can understand the full context of changes and validate implementation quality.

**Note:** Reviewers are not standalone agent types — they are sub-agents of the leader, built via `buildReviewerAgents()` in `leader-agent.ts`. They already have `Read`, `Grep`, `Glob`, `Bash`, `WebFetch`, `WebSearch` tools. This milestone adds dedicated explorer and fact-checker sub-agents to reviewers so they can delegate focused exploration and fact-checking work.

## Scope

- `packages/daemon/src/lib/room/agents/leader-agent.ts` — `createLeaderAgentInit()` and `buildReviewerAgents()` changes
- `packages/daemon/tests/unit/room/leader-agent.test.ts` — Update existing tests

## Tasks

### Task 3.1: Add built-in sub-agents for leader and reviewers

**Description:** Add four new sub-agent builder functions to `leader-agent.ts`: `buildLeaderExplorerAgentDef()` and `buildLeaderFactCheckerAgentDef()` for the leader's own analysis, and `buildReviewerExplorerAgentDef()` and `buildReviewerFactCheckerAgentDef()` for reviewer sub-agents.

**Important behavioral note:** The current "simple path" uses `systemPrompt: { type: 'preset', preset: 'claude_code', append: buildLeaderSystemPrompt(config) }` (append mode), while the agent/agents path uses `systemPrompt: { type: 'preset', preset: 'claude_code' }` with the system prompt embedded in the Leader agent definition's `prompt` field. After removing the simple path, `buildLeaderSystemPrompt()` will always be embedded in the agent definition's `prompt` field (not appended to the top-level systemPrompt). Verify there is no behavioral difference from this change (the prompt content is the same, just delivered via a different mechanism).

**Subtasks:**
1. Define `buildLeaderExplorerAgentDef(): AgentDefinition` — read-only exploration for leader analysis
   - Tools: `['Read', 'Grep', 'Glob', 'Bash']`
   - Model: `'inherit'`
   - Prompt: perform codebase analysis delegated by the leader, return structured findings
   - No Task tools (one level max)
2. Define `buildLeaderFactCheckerAgentDef(): AgentDefinition` — web research for leader decisions
   - Tools: `['WebSearch', 'WebFetch']` (web-only; codebase access is the explorer's responsibility)
   - Model: `'inherit'`
   - Prompt: validate technical decisions, check API docs, verify best practices
   - No Task tools (one level max)
3. Define `buildReviewerExplorerAgentDef(): AgentDefinition` — read-only exploration for understanding code context around changes
   - Tools: `['Read', 'Grep', 'Glob', 'Bash']`
   - Model: `'inherit'`
   - Prompt: explore the codebase around changed files to understand the full context (callers, callees, related tests, architectural patterns), return structured findings
   - Structured output: `---CONTEXT_FINDINGS---` block
   - No Task tools
4. Define `buildReviewerFactCheckerAgentDef(): AgentDefinition` — validate implementation against current docs/best practices
   - Tools: `['WebSearch', 'WebFetch']` (web-only; codebase access is the explorer's responsibility)
   - Model: `'inherit'`
   - Prompt: check that implementation follows current best practices, verify API usage against latest docs, flag deprecated patterns
   - Structured output: `---FACT_CHECK_RESULT---` block
   - No Task tools
5. Export all four functions for test access

**Acceptance Criteria:**
- All four functions return valid `AgentDefinition` objects
- None have Task/Write/Edit tools
- Leader sub-agents focus on leader-level analysis; reviewer sub-agents focus on code review context
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** None
**Agent type:** coder

---

### Task 3.2: Restructure createLeaderAgentInit to always use agent/agents pattern

**Description:** Remove the conditional `if (hasSubAgents)` branch in `createLeaderAgentInit()`. The function should always return an init using the agent/agents pattern with `agent: 'Leader'` and an `agents` map containing built-in leader sub-agents, reviewer agents (with their own sub-agents), and any user-configured helpers.

**Subtasks:**
1. Remove the conditional `if (hasSubAgents)` / else branching in `createLeaderAgentInit()`
2. Always construct the Leader agent definition with `agent: 'Leader'`
3. Always build agents map with: `Leader`, `leader-explorer`, `leader-fact-checker`, plus any reviewer agents, plus any helper agents from room config
4. Embed `buildLeaderSystemPrompt()` in the Leader agent definition's `prompt` field (not in top-level `systemPrompt.append`), matching the existing agent/agents path behavior
5. Update `buildLeaderSystemPrompt()` to always mention available built-in sub-agents (`leader-explorer`, `leader-fact-checker`) and any configured reviewers/helpers. Implementation approach: hardcode the built-in sub-agent names within the function (since they are always present), rather than passing them as a parameter. This matches the "always-on" semantics — unlike `buildCoderSystemPrompt()` which takes a names array, the leader prompt function already reads config internally
6. Remove the "simple path" code that returns init without agent/agents
7. Handle name collisions: if a user-configured helper has the same name as a built-in (`leader-explorer`, `leader-fact-checker`), prefix the user's helper with `custom-`

**Acceptance Criteria:**
- `createLeaderAgentInit()` always returns init with `agent: 'Leader'` and `agents` map
- `agents` map always contains `Leader`, `leader-explorer`, `leader-fact-checker`
- System prompt is embedded in agent definition's `prompt` field, not in top-level `systemPrompt.append`
- When reviewers/helpers are configured, they are merged into the agents map
- When no reviewers/helpers are configured, only built-in sub-agents are present
- No code path returns init without agent/agents pattern
- Leader system prompt mentions built-in sub-agents by name
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 3.1
**Agent type:** coder

---

### Task 3.3: Update buildReviewerAgents to include reviewer sub-agents

**Description:** Update `buildReviewerAgents()` in `leader-agent.ts` to always include `reviewer-explorer` and `reviewer-fact-checker` in the agents map alongside the reviewer agents themselves. Each reviewer agent's tools list should include Task/TaskOutput/TaskStop so it can spawn these sub-agents. Update the reviewer prompts (both SDK and CLI variants) to describe when and how to use the explorer and fact-checker.

**Subtasks:**
1. Add `reviewer-explorer` and `reviewer-fact-checker` to the agents map returned by `buildReviewerAgents()`
2. Add `Task`, `TaskOutput`, `TaskStop` to `REVIEWER_TOOLS` constant
3. Update `buildSdkReviewerPrompt()` to include sub-agent usage instructions:
   - Use `reviewer-explorer` to understand the context around changed files before reviewing
   - Use `reviewer-fact-checker` to validate implementation against current API docs when unsure
   - Do not use sub-agents for trivial reviews
4. Update `buildCliReviewerPrompt()` similarly
5. Reviewer sub-agents (`reviewer-explorer`, `reviewer-fact-checker`) must NOT have Task tools (one level max)

**Acceptance Criteria:**
- `buildReviewerAgents()` returns agents map with reviewer agents plus `reviewer-explorer` and `reviewer-fact-checker`
- Reviewer agents have Task/TaskOutput/TaskStop in their tools
- Reviewer prompts describe when to use `reviewer-explorer` and `reviewer-fact-checker`
- Sub-agents lack Task tools (no recursive spawning)
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 3.1
**Agent type:** coder

---

### Task 3.4: Update leader and reviewer unit tests

**Description:** Update `packages/daemon/tests/unit/room/leader-agent.test.ts` to cover the always-on agent/agents pattern, built-in leader sub-agents, and reviewer sub-agents.

**Subtasks:**
1. Add tests for `buildLeaderExplorerAgentDef()` and `buildLeaderFactCheckerAgentDef()`
2. Add tests for `buildReviewerExplorerAgentDef()` and `buildReviewerFactCheckerAgentDef()` — verify tools are `['WebSearch', 'WebFetch']` only for fact-checkers
3. Update `createLeaderAgentInit` tests to assert `agent: 'Leader'` is always present
4. Update tests to assert agents map always contains `Leader`, `leader-explorer`, `leader-fact-checker`
5. Add test: when no reviewers/helpers configured, init still has agent/agents with built-ins
6. Add test: when reviewers configured, they are merged alongside built-ins
7. Add test: when helpers configured, they are merged alongside built-ins
8. Add test: when user-configured helper name collides with built-in name, it is prefixed with `custom-`
9. Update `buildReviewerAgents` tests to verify agents map includes `reviewer-explorer` and `reviewer-fact-checker`
10. Verify reviewer agents have Task/TaskOutput/TaskStop in tools
11. Verify reviewer prompts mention sub-agent usage with correct names (`reviewer-explorer`, `reviewer-fact-checker`)
12. Verify all sub-agents (leader and reviewer) lack Task tools (no recursive spawning)
13. Verify system prompt is embedded in agent def's `prompt` field, not in top-level `systemPrompt.append`

**Acceptance Criteria:**
- All existing tests updated and passing
- New tests cover all four sub-agent definitions (leader + reviewer)
- Tests verify always-on pattern for leader
- Tests verify reviewer sub-agent integration
- Tests verify sub-agent tool restrictions
- Tests verify system prompt embedding strategy
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 3.2, Task 3.3
**Agent type:** coder
