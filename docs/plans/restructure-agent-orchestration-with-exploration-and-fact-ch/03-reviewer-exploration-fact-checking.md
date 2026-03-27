# Milestone 3: Reviewer Exploration and Fact-Checking

## Milestone Goal

Add `reviewer-explorer` and `reviewer-fact-checker` built-in sub-agents to the reviewer, and make the reviewer always use the agent/agents pattern. The reviewer should be able to understand the full context of changes (not just the diff) and validate implementation against current docs/best practices.

**Note:** Reviewer agent definitions live in `leader-agent.ts` because reviewers are sub-agents of the leader. This milestone modifies the same file as Milestone 4 but focuses on reviewer-specific changes.

## Scope

- `packages/daemon/src/lib/room/agents/leader-agent.ts` — Reviewer agent definitions within the leader agent factory
- `packages/daemon/tests/unit/room/leader-agent.test.ts` — Update existing tests

## Tasks

### Task 3.1: Add built-in reviewer-explorer and reviewer-fact-checker sub-agents

**Description:** Add `buildReviewerExplorerAgentDef()` and `buildReviewerFactCheckerAgentDef()` functions to `leader-agent.ts`. These are built-in sub-agents available to every reviewer agent, enabling them to understand surrounding code context and validate implementation quality. This milestone has no code-level dependency on Milestone 1 (separate file: `leader-agent.ts` vs `coder-agent.ts`), but follows the same always-on sub-agent pattern.

**Subtasks:**
1. Define `buildReviewerExplorerAgentDef(): AgentDefinition` — read-only exploration for understanding code context around changes
   - Tools: `['Read', 'Grep', 'Glob', 'Bash']`
   - Model: `'inherit'`
   - Prompt: explore the codebase around changed files to understand the full context (callers, callees, related tests, architectural patterns), return structured findings
   - Structured output: `---CONTEXT_FINDINGS---` block
2. Define `buildReviewerFactCheckerAgentDef(): AgentDefinition` — validate implementation against current docs/best practices
   - Tools: `['WebSearch', 'WebFetch']` (web-only; codebase access is the explorer's responsibility)
   - Model: `'inherit'`
   - Prompt: check that implementation follows current best practices, verify API usage against latest docs, flag deprecated patterns
   - Structured output: `---FACT_CHECK_RESULT---` block
3. Neither sub-agent has Task/Write/Edit tools
4. Export both functions

**Acceptance Criteria:**
- Both functions return valid `AgentDefinition` objects
- Neither has Task/Write/Edit tools
- Explorer focuses on understanding code context around changes
- Fact-checker has only `['WebSearch', 'WebFetch']` tools
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** None (follows pattern from Milestone 1, but no code dependency — separate files)
**Agent type:** coder

---

### Task 3.2: Update buildReviewerAgents to always include built-in sub-agents

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

### Task 3.3: Update reviewer and leader unit tests

**Description:** Update `packages/daemon/tests/unit/room/leader-agent.test.ts` to cover the new reviewer sub-agents and updated reviewer tools/prompts.

**Subtasks:**
1. Add tests for `buildReviewerExplorerAgentDef()` — verify tools, model, prompt, no Task tools
2. Add tests for `buildReviewerFactCheckerAgentDef()` — verify tools are `['WebSearch', 'WebFetch']` only, model, prompt, no Task tools
3. Update `buildReviewerAgents` tests to verify agents map includes `reviewer-explorer` and `reviewer-fact-checker`
4. Verify reviewer agents have Task/TaskOutput/TaskStop in tools
5. Verify reviewer prompts mention sub-agent usage with correct names (`reviewer-explorer`, `reviewer-fact-checker`)
6. Add test: reviewer sub-agents lack Task tools (no recursive spawning)

**Acceptance Criteria:**
- All existing tests updated and passing
- New tests cover both reviewer sub-agent definitions
- Tests verify reviewer tools include Task
- Tests verify no recursive spawning capability in sub-agents
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Dependencies:** Task 3.2
**Agent type:** coder
