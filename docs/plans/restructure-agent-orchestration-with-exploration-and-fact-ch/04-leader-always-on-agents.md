# Milestone 4: Leader Always-On Agent/Agents Pattern

## Milestone Goal

Update the leader agent to always use the agent/agents pattern, even when no reviewers or helpers are configured via `room.config.agentSubagents`. The leader should always have built-in explorer and fact-checker sub-agents available for its own analysis work, with user-configured reviewers and helpers merged on top.

## Scope

- `packages/daemon/src/lib/room/agents/leader-agent.ts` - `createLeaderAgentInit()` changes
- `packages/daemon/tests/unit/room/leader-agent.test.ts` - Update existing tests

## Tasks

### Task 4.1: Add built-in sub-agents to leader and remove conditional branching

**Description:** Update `createLeaderAgentInit()` to always use the agent/agents pattern. Add built-in `leader-explorer` and `leader-fact-checker` sub-agents that are always available. Remove the conditional `if (hasSubAgents)` branch that falls back to the simple path without agent/agents.

**Subtasks:**
1. Define `buildLeaderExplorerAgentDef(): AgentDefinition` - read-only exploration for leader analysis
   - Tools: `['Read', 'Grep', 'Glob', 'Bash']`
   - Model: `'inherit'`
   - Prompt: perform codebase analysis delegated by the leader, return structured findings
   - No Task tools (one level max)
2. Define `buildLeaderFactCheckerAgentDef(): AgentDefinition` - web research for leader decisions
   - Tools: `['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob']`
   - Model: `'inherit'`
   - Prompt: validate technical decisions, check API docs, verify best practices
   - No Task tools (one level max)
3. Remove the conditional `if (hasSubAgents)` / else branching in `createLeaderAgentInit()`
4. Always construct the Leader agent definition with `agent: 'Leader'`
5. Always build agents map with: `Leader`, `leader-explorer`, `leader-fact-checker`, plus any reviewer agents, plus any helper agents from room config
6. Update `buildLeaderSystemPrompt()` to always mention available sub-agents (explorer, fact-checker, and any configured reviewers/helpers)
7. Remove the "simple path" code that returns init without agent/agents

**Acceptance Criteria:**
- `createLeaderAgentInit()` always returns init with `agent: 'Leader'` and `agents` map
- `agents` map always contains `Leader`, `leader-explorer`, `leader-fact-checker`
- When reviewers/helpers are configured, they are merged into the agents map
- When no reviewers/helpers are configured, only built-in sub-agents are present
- No code path returns init without agent/agents pattern
- Leader system prompt mentions built-in sub-agents
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Milestone 3 (Task 3.2)
**Agent type:** coder

---

### Task 4.2: Update leader unit tests for always-on pattern

**Description:** Update leader agent unit tests to verify the always-on agent/agents pattern and built-in sub-agents.

**Subtasks:**
1. Add tests for `buildLeaderExplorerAgentDef()` and `buildLeaderFactCheckerAgentDef()`
2. Update `createLeaderAgentInit` tests to assert `agent: 'Leader'` is always present
3. Update tests to assert agents map always contains `Leader`, `leader-explorer`, `leader-fact-checker`
4. Add test: when no reviewers/helpers configured, init still has agent/agents with built-ins
5. Add test: when reviewers configured, they are merged alongside built-ins
6. Add test: when helpers configured, they are merged alongside built-ins
7. Verify built-in sub-agents lack Task tools

**Acceptance Criteria:**
- All existing tests updated and passing
- New tests cover built-in sub-agent definitions
- Tests verify always-on pattern
- Tests verify sub-agent tool restrictions
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 4.1
**Agent type:** coder
