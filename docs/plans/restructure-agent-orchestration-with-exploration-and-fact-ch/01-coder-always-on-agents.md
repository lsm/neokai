# Milestone 1: Coder Always-On Agent/Agents Pattern

## Milestone Goal

Remove the conditional branching in `createCoderAgentInit()` that only enables the agent/agents pattern when `room.config.agentSubagents.worker` is configured. The coder should always have Task/TaskOutput/TaskStop tools with built-in `coder-explorer` and `coder-tester` sub-agents, regardless of room configuration. User-configured helpers from `agentSubagents.worker` are merged on top of built-ins.

## Scope

- `packages/daemon/src/lib/room/agents/coder-agent.ts` — Main changes
- `packages/daemon/tests/unit/room/coder-agent.test.ts` — Update existing tests

## Tasks

### Task 1.1: Add built-in coder-explorer sub-agent definition to coder-agent.ts

**Description:** Create a `buildCoderExplorerAgentDef()` function in `coder-agent.ts` that returns an `AgentDefinition` for a read-only codebase exploration sub-agent. The explorer has Read, Grep, Glob, and Bash tools (no Write/Edit). Its prompt instructs it to explore the codebase and return structured findings about file paths, patterns, dependencies, and architecture. It must NOT spawn further sub-agents (no Task tool).

**Subtasks:**
1. Define `buildCoderExplorerAgentDef(): AgentDefinition` in `coder-agent.ts`
2. Explorer tools: `['Read', 'Grep', 'Glob', 'Bash']`
3. Explorer model: `'inherit'` (uses parent coder's model)
4. Explorer prompt: role definition, rules (read-only, no sub-agents, concise summary), structured output format (`---EXPLORE_RESULT---` block)
5. Export the function for use in tests

**Acceptance Criteria:**
- `buildCoderExplorerAgentDef()` returns a valid `AgentDefinition`
- Explorer has no Write/Edit/Task tools
- Explorer prompt explicitly forbids spawning sub-agents
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** None
**Agent type:** coder

---

### Task 1.2: Restructure createCoderAgentInit to always use agent/agents pattern

**Description:** Remove the conditional `if (helperAgents && helperNames && helperNames.length > 0)` branch in `createCoderAgentInit()`. The function should always return an init using the agent/agents pattern with `agent: 'Coder'` and an `agents` map containing: the Coder agent def, the built-in `coder-explorer`, the built-in `coder-tester`, and any user-configured helpers from `agentSubagents.worker`.

**Important behavioral note:** The current "simple path" uses `systemPrompt: { type: 'preset', preset: 'claude_code', append: buildCoderSystemPrompt() }` (append mode), while the agent/agents path uses `systemPrompt: { type: 'preset', preset: 'claude_code' }` without append because the system prompt is embedded in the Coder agent definition's `prompt` field. After removing the simple path, `buildCoderSystemPrompt()` must always be called with the built-in sub-agent names (`['coder-explorer', 'coder-tester']` at minimum) so the sub-agent usage instructions section is always present. Currently, the simple path calls `buildCoderSystemPrompt()` without arguments, which skips sub-agent instructions entirely.

**Subtasks:**
1. Remove the conditional branching — always use agent/agents pattern
2. Always include `agent: 'Coder'` in the returned init
3. Always include `agents` map with: `Coder` (main agent def), `coder-explorer` (from `buildCoderExplorerAgentDef()`), `coder-tester` (from `buildTesterAgentDef()`), plus any user-configured helpers
4. Update `buildCoderSystemPrompt()` to always receive and include the built-in sub-agent names (`['coder-explorer', 'coder-tester']` at minimum) so the sub-agent usage instructions section is always present
5. Embed the system prompt in the Coder agent definition's `prompt` field (not in the top-level `systemPrompt.append`), matching the existing agent/agents path behavior
6. Update the system prompt to include strategy guidance based on task complexity with concrete examples:
   - **Simple tasks** (e.g., "fix typo in error message", "add a CSS class to button component" — single file, well-scoped): implement directly without sub-agents
   - **Complex tasks** (e.g., "add validation to the settings form", "refactor session cleanup logic" — touches 3-8 files across 1-2 packages): spawn `coder-explorer` first to understand the code structure, then implement with clean context
   - **Large multi-component tasks** (e.g., "add WebSocket reconnection with exponential backoff", "implement new RPC handler with frontend integration" — spans multiple packages, 8+ files): delegate exploration and implementation subtasks to sub-agents, review and integrate results
7. Remove the "simple path" code branch that returns init without agent/agents
8. Ensure WebSearch/WebFetch remain in the Coder's own tools list for direct fact-checking
9. Handle name collisions: if a user-configured helper has the same name as a built-in (`coder-explorer`, `coder-tester`), prefix the user's helper with `custom-`

**Acceptance Criteria:**
- `createCoderAgentInit()` always returns init with `agent: 'Coder'` and `agents` map
- `agents` map always contains `Coder`, `coder-explorer`, and `coder-tester`
- `buildCoderSystemPrompt()` always includes sub-agent usage instructions with built-in names
- System prompt is embedded in agent definition's `prompt` field, not in top-level `systemPrompt.append`
- When `agentSubagents.worker` is configured, those helpers are also in the `agents` map
- When `agentSubagents.worker` is NOT configured, only built-in sub-agents are present
- No code path returns init without agent/agents pattern
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 1.3: Update coder-agent unit tests

**Description:** Update `packages/daemon/tests/unit/room/coder-agent.test.ts` to reflect the always-on agent/agents pattern. Add tests for the new `coder-explorer` sub-agent. Verify that the conditional branching is fully removed.

**Subtasks:**
1. Add test for `buildCoderExplorerAgentDef()` — verify tools, model, prompt content
2. Update existing `createCoderAgentInit` tests to assert `agent: 'Coder'` is always present
3. Update existing tests to assert `agents` map always contains `Coder`, `coder-explorer`, `coder-tester`
4. Add test: when no `agentSubagents.worker`, init still has agent/agents with built-ins only
5. Add test: when `agentSubagents.worker` is configured, helpers are merged with built-ins
6. Add test: when user-configured helper name collides with built-in name, it is prefixed with `custom-`
7. Update system prompt tests to verify sub-agent instructions are always present and include built-in names
8. Add test: `coder-explorer` sub-agent has no Task/Write/Edit tools (no recursive spawning, no file modification)
9. Verify system prompt is embedded in agent def's `prompt` field, not in top-level `systemPrompt.append`

**Acceptance Criteria:**
- All existing tests updated and passing
- New tests cover `coder-explorer` sub-agent definition
- Tests verify always-on pattern (no conditional branching)
- Tests verify sub-agent tools restrictions
- Tests verify system prompt embedding strategy
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 1.2
**Agent type:** coder
