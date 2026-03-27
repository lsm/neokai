# Milestone 2: Planner 3-Phase Sequential Pipeline

## Milestone Goal

Restructure the planner agent to use a 3-phase sequential pipeline: explorer -> fact-checker -> plan-writer. The planner orchestrates all three phases, passing accumulated context forward. The plan-writer's broken "spawn Explore agents" instruction is removed since sub-agents cannot spawn further sub-agents.

## Scope

- `packages/daemon/src/lib/room/agents/planner-agent.ts` - Main changes
- `packages/daemon/tests/unit/room/planner-agent.test.ts` - Update existing tests

## Tasks

### Task 2.1: Add explorer and fact-checker sub-agent definitions for planner

**Description:** Add two new sub-agent builder functions to `planner-agent.ts`: `buildPlannerExplorerAgentDef()` for codebase exploration and `buildPlannerFactCheckerAgentDef()` for web-based fact checking. These are spawned by the planner sequentially before the plan-writer.

**Subtasks:**
1. Define `buildPlannerExplorerAgentDef(): AgentDefinition` - read-only codebase exploration agent
   - Tools: `['Read', 'Grep', 'Glob', 'Bash']`
   - Model: `'inherit'`
   - Prompt: explore the codebase areas relevant to the goal, return structured findings about file paths, patterns, dependencies, architecture, and complexity assessment
   - Structured output: `---EXPLORER_FINDINGS---` block with sections for: relevant files, patterns found, dependencies, estimated complexity, key concerns
2. Define `buildPlannerFactCheckerAgentDef(): AgentDefinition` - web research and validation agent
   - Tools: `['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob']` (Read/Grep/Glob for checking package.json, config files)
   - Model: `'inherit'`
   - Prompt: receive explorer findings, validate assumptions about external technologies, check API versions, library patterns, flag stale information
   - Structured output: `---FACT_CHECK_RESULT---` block with sections for: validated assumptions, flagged issues, recommended versions/patterns, corrections to explorer findings
3. Neither sub-agent should have Task/TaskOutput/TaskStop tools (no recursive spawning)
4. Export both functions for test access

**Acceptance Criteria:**
- Both functions return valid `AgentDefinition` objects
- Neither has Task/Write/Edit tools
- Explorer focuses on codebase analysis, fact-checker focuses on web validation
- Structured output formats are documented in prompts
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** None
**Agent type:** coder

---

### Task 2.2: Update plan-writer prompt to remove broken Explore instruction

**Description:** The current `buildPlanWriterPrompt()` instructs the plan-writer to "spawn Explore sub-agents" via `Task(subagent_type: "Explore", ...)`. This is broken because the plan-writer is itself a sub-agent and cannot spawn further sub-agents. Remove this instruction entirely. The plan-writer now receives explorer and fact-checker output as context in its task prompt (passed by the planner). The plan-writer retains Read/Grep/Glob/Bash for its own verification during writing.

**Subtasks:**
1. Remove the "Step 1: Codebase Exploration" section that references `Task(subagent_type: "Explore", ...)`
2. Remove `Task`, `TaskOutput`, `TaskStop` from the plan-writer's tools list (it cannot spawn sub-agents)
3. Add a new "Context" section explaining that the plan-writer receives pre-gathered explorer findings and fact-checker results as input
4. Keep Read/Grep/Glob/Bash tools so the plan-writer can verify and read additional files during writing
5. Keep WebSearch/WebFetch tools so the plan-writer can do targeted lookups during writing
6. Update the prompt to emphasize that the plan-writer should use its own tools to verify findings, not just transcribe them

**Acceptance Criteria:**
- Plan-writer prompt has no reference to spawning Explore sub-agents
- Plan-writer tools list does not include Task/TaskOutput/TaskStop
- Plan-writer retains Read/Grep/Glob/Bash/WebSearch/WebFetch for verification
- Prompt explains that explorer/fact-checker context is provided as input
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** None
**Agent type:** coder

---

### Task 2.3: Update planner system prompt for 3-phase orchestration

**Description:** Update `buildPlannerSystemPrompt()` to describe the 3-phase pipeline. The planner now orchestrates: (1) spawn explorer to gather codebase context, (2) spawn fact-checker with explorer findings, (3) spawn plan-writer with both sets of findings. The planner passes accumulated context forward at each phase.

**Subtasks:**
1. Replace the current Phase 1 description (single plan-writer spawn) with the 3-phase pipeline:
   - Phase 1: Spawn `explorer` with goal context, collect `---EXPLORER_FINDINGS---`
   - Phase 2: Spawn `fact-checker` with goal context + explorer findings, collect `---FACT_CHECK_RESULT---`
   - Phase 3: Spawn `plan-writer` with goal context + explorer findings + fact-checker results
2. Document the context-passing pattern: each phase's output is included verbatim in the next phase's task prompt
3. Preserve WebSearch/WebFetch in planner's own tools for pre-planning verification
4. Update Phase 2 (task creation after approval) to remain unchanged
5. Keep the existing feedback handling ("If the Leader sends feedback...")

**Acceptance Criteria:**
- Planner system prompt describes 3-phase pipeline with explicit phase ordering
- Context-passing pattern is clearly documented
- Planner knows to collect structured output blocks from each sub-agent
- Phase 2 (task creation) is unchanged
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 2.1, Task 2.2
**Agent type:** coder

---

### Task 2.4: Update createPlannerAgentInit to include all three sub-agents

**Description:** Update `createPlannerAgentInit()` to include explorer, fact-checker, and plan-writer in the `agents` map. The planner always uses the agent/agents pattern with all three sub-agents available.

**Subtasks:**
1. Add `explorer` (from `buildPlannerExplorerAgentDef()`) to the agents map
2. Add `fact-checker` (from `buildPlannerFactCheckerAgentDef()`) to the agents map
3. Keep `plan-writer` (from `buildPlanWriterAgentDef()`) in the agents map
4. Verify the Planner agent definition's tools include Task/TaskOutput/TaskStop for orchestrating sub-agents
5. No changes to MCP server configuration (planner-tools stays the same)

**Acceptance Criteria:**
- `createPlannerAgentInit()` returns init with agents map containing: Planner, explorer, fact-checker, plan-writer
- All three sub-agents lack Task tools (no recursive spawning)
- Planner agent retains Task/TaskOutput/TaskStop for orchestration
- MCP tools (create_task, update_task, remove_task) are unchanged
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 2.1, Task 2.2, Task 2.3
**Agent type:** coder

---

### Task 2.5: Update planner-agent unit tests

**Description:** Update `packages/daemon/tests/unit/room/planner-agent.test.ts` to cover the 3-phase pipeline, new sub-agent definitions, and the updated plan-writer prompt.

**Subtasks:**
1. Add tests for `buildPlannerExplorerAgentDef()` - verify tools, model, prompt, no Task tools
2. Add tests for `buildPlannerFactCheckerAgentDef()` - verify tools, model, prompt, no Task tools
3. Update plan-writer prompt tests to verify no Explore sub-agent references
4. Update plan-writer tests to verify no Task/TaskOutput/TaskStop in tools
5. Update planner system prompt tests to verify 3-phase pipeline description
6. Update `createPlannerAgentInit` tests to verify agents map contains all four agents (Planner, explorer, fact-checker, plan-writer)
7. Add test verifying none of the three sub-agents have Task tools

**Acceptance Criteria:**
- All existing tests updated and passing
- New tests cover both new sub-agent definitions
- Tests verify plan-writer no longer references Explore sub-agents
- Tests verify 3-phase pipeline in planner prompt
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 2.4
**Agent type:** coder
