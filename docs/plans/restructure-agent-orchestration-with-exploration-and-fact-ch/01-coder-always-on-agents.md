# Milestone 1: Coder Always-On Agent/Agents Pattern

## Milestone Goal

Remove the conditional branching in `createCoderAgentInit()` that only enables the agent/agents pattern when `room.config.agentSubagents.worker` is configured. The coder should always have Task/TaskOutput/TaskStop tools with built-in explorer and tester sub-agents, regardless of room configuration. User-configured helpers from `agentSubagents.worker` are merged on top of built-ins.

## Scope

- `packages/daemon/src/lib/room/agents/coder-agent.ts` - Main changes
- `packages/daemon/tests/unit/room/coder-agent.test.ts` - Update existing tests

## Tasks

### Task 1.1: Add built-in explorer sub-agent definition to coder-agent.ts

**Description:** Create a `buildExplorerAgentDef()` function in `coder-agent.ts` that returns an `AgentDefinition` for a read-only codebase exploration sub-agent. The explorer has Read, Grep, Glob, and Bash tools (no Write/Edit). Its prompt instructs it to explore the codebase and return structured findings about file paths, patterns, dependencies, and architecture. It must NOT spawn further sub-agents (no Task tool).

**Subtasks:**
1. Define `buildExplorerAgentDef(): AgentDefinition` in `coder-agent.ts`
2. Explorer tools: `['Read', 'Grep', 'Glob', 'Bash']`
3. Explorer model: `'inherit'` (uses parent coder's model)
4. Explorer prompt: role definition, rules (read-only, no sub-agents, concise summary), structured output format (`---EXPLORE_RESULT---` block)
5. Export the function for use in tests

**Acceptance Criteria:**
- `buildExplorerAgentDef()` returns a valid `AgentDefinition`
- Explorer has no Write/Edit/Task tools
- Explorer prompt explicitly forbids spawning sub-agents
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** None
**Agent type:** coder

---

### Task 1.2: Restructure createCoderAgentInit to always use agent/agents pattern

**Description:** Remove the conditional `if (helperAgents && helperNames && helperNames.length > 0)` branch in `createCoderAgentInit()`. The function should always return an init using the agent/agents pattern with `agent: 'Coder'` and an `agents` map containing: the Coder agent def, the built-in explorer, the built-in tester, and any user-configured helpers from `agentSubagents.worker`.

**Subtasks:**
1. Remove the conditional branching - always use agent/agents pattern
2. Always include `agent: 'Coder'` in the returned init
3. Always include `agents` map with: `Coder` (main agent def), `explorer` (from `buildExplorerAgentDef()`), `tester` (from `buildTesterAgentDef()`), plus any user-configured helpers
4. Update `buildCoderSystemPrompt()` to always include sub-agent usage instructions (explorer + tester are always available), not just when helpers are configured
5. Update the system prompt to include strategy guidance based on task complexity:
   - Simple tasks (single component, <5 files): implement directly
   - Complex tasks: spawn explorer first, then implement with clean context
   - Large multi-component tasks: delegate implementation to sub-agents, review and integrate
6. Remove the "simple path" code branch that returns init without agent/agents
7. Ensure WebSearch/WebFetch remain in the Coder's own tools list for direct fact-checking

**Acceptance Criteria:**
- `createCoderAgentInit()` always returns init with `agent: 'Coder'` and `agents` map
- `agents` map always contains `Coder`, `explorer`, and `tester`
- When `agentSubagents.worker` is configured, those helpers are also in the `agents` map
- When `agentSubagents.worker` is NOT configured, only built-in sub-agents are present
- Coder system prompt always includes sub-agent usage instructions
- No code path returns init without agent/agents pattern
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 1.3: Update coder-agent unit tests

**Description:** Update `packages/daemon/tests/unit/room/coder-agent.test.ts` to reflect the always-on agent/agents pattern. Add tests for the new explorer sub-agent. Verify that the conditional branching is fully removed.

**Subtasks:**
1. Add test for `buildExplorerAgentDef()` - verify tools, model, prompt content
2. Update existing `createCoderAgentInit` tests to assert `agent: 'Coder'` is always present
3. Update existing tests to assert `agents` map always contains `Coder`, `explorer`, `tester`
4. Add test: when no `agentSubagents.worker`, init still has agent/agents with built-ins only
5. Add test: when `agentSubagents.worker` is configured, helpers are merged with built-ins
6. Update system prompt tests to verify sub-agent instructions are always present
7. Add test: explorer sub-agent has no Task/Write/Edit tools (no recursive spawning, no file modification)

**Acceptance Criteria:**
- All existing tests updated and passing
- New tests cover explorer sub-agent definition
- Tests verify always-on pattern (no conditional branching)
- Tests verify sub-agent tools restrictions
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 1.2
**Agent type:** coder
