# Milestone 4: Space Agent Prompt Updates

## Goal

Update the Space Agent system prompts (`space-chat-agent.ts` and `global-spaces-agent.ts`) to include autonomy level instructions, event handling guidance, escalation rules, and new tool usage guidance. The prompt is what turns the Space Agent from a passive assistant into a reactive coordinator.

## Scope

- Updated `buildSpaceChatSystemPrompt()` with event handling and autonomy sections
- Updated `buildGlobalSpacesAgentPrompt()` with coordination guidance
- New `SpaceChatAgentContext` fields for autonomy level
- Unit tests for prompt content

---

### Task 4.1: Update space-chat-agent.ts prompt with coordinator behavior

**Description:** Extend `buildSpaceChatSystemPrompt()` to include sections on event handling, autonomy levels, escalation rules, and new coordination tools.

**Agent type:** coder

**Subtasks:**
1. Add `autonomyLevel?: SpaceAutonomyLevel` to `SpaceChatAgentContext`
2. Add an "Event Handling" section to the prompt that explains:
   - The agent will receive `[TASK_EVENT]` prefixed messages from SpaceRuntime
   - Each event has a JSON payload with `kind`, `taskId`/`runId`, `reason`, etc.
   - How to interpret each event kind (`task_needs_attention`, `workflow_run_needs_attention`, `task_timeout`, `workflow_run_completed`)
3. Add an "Autonomy Level" section that explains the two modes:
   - `supervised`: notify human of ALL judgment-required events, provide recommendations, wait for approval
   - `semi_autonomous`: can retry failed tasks once, can reassign tasks, escalate after one failed retry or when uncertain
4. Add an "Escalation" section that explains when and how to escalate:
   - What happened (task/workflow context)
   - What was considered
   - What is recommended
   - A clear question for the human
5. Add a "Coordination Tools" section documenting: `create_standalone_task`, `get_task_detail`, `retry_task`, `cancel_task`, `reassign_task`
6. Update existing unit tests and add new tests verifying:
   - Autonomy level instructions appear in prompt when set
   - Event handling section is always included
   - Escalation rules match the configured autonomy level

**Acceptance criteria:**
- Prompt includes event handling guidance with all four event kinds
- Prompt includes autonomy-level-specific instructions (different text for supervised vs semi_autonomous)
- Prompt includes escalation pattern template
- Prompt includes documentation for all new coordination tools
- Existing prompt tests still pass
- New tests verify autonomy-aware prompt content

**Dependencies:** Task 1.1 (SpaceAutonomyLevel type), Task 3.2 (tools exist for prompt to reference)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.2: Update global-spaces-agent.ts prompt with coordination guidance

**Description:** Extend `buildGlobalSpacesAgentPrompt()` to include guidance for the new coordination tools and event handling behavior.

**Agent type:** coder

**Subtasks:**
1. Add a "Task Coordination" section to the global prompt listing the new tools: `create_standalone_task`, `get_task_detail`, `retry_task`, `cancel_task`, `reassign_task`
2. Add guidance for when to use each tool (retry vs. cancel vs. reassign decision tree)
3. Add a note about autonomy levels and how they affect behavior per-space
4. Update unit tests to verify the new sections are present

**Acceptance criteria:**
- Global prompt includes task coordination tool documentation
- Decision tree guidance helps the agent choose between retry/cancel/reassign
- Unit tests verify new prompt sections

**Dependencies:** Task 3.3 (global tools exist for prompt to reference)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
