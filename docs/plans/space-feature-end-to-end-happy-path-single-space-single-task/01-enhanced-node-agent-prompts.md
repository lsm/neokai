# Milestone 1: Enhanced Node Agent Prompts

## Goal and Scope

Upgrade the system prompts for planner, coder, and reviewer node agents in the Space system to match the quality and completeness of the Room system's agent prompts. The current `custom-agent.ts` provides a basic git workflow, but lacks review-specific instructions, bypass markers, feedback handling, and the structured output patterns that the Room system's agents use.

## Tasks

### Task 1.1: Enhance Coder Node Agent System Prompt

**Description**: Update `buildCustomAgentSystemPrompt()` in `packages/daemon/src/lib/space/agents/custom-agent.ts` to include the full git workflow instructions, bypass markers for research-only tasks, and review feedback handling -- mirroring the Room system's `buildCoderSystemPrompt()`.

**Subtasks**:
1. Read `packages/daemon/src/lib/room/agents/coder-agent.ts` (`buildCoderSystemPrompt()`) and identify all prompt sections
2. Add bypass markers section (RESEARCH_ONLY, VERIFICATION_COMPLETE, INVESTIGATION_RESULT, ANALYSIS_COMPLETE) to the custom agent prompt when role is 'coder'
3. Add review feedback handling section: how to fetch GitHub reviews by ID, verify feedback, push fixes
4. Ensure PR creation flow includes duplicate PR prevention (`gh pr list --head`)
5. Add instructions for existing PR context (push to update, don't create new PR)
6. Update the `SlotOverrides` to support appending additional prompt sections

**Acceptance Criteria**:
- Coder node agents in Spaces produce the same quality of git/PR workflow behavior as Room coder agents
- Bypass markers work for research-only tasks in Space workflow
- Review feedback URL extraction and addressing works via `send_message` to reviewers
- Unit tests pass for updated prompt builder

**Depends on**: nothing

**Agent type**: coder

---

### Task 1.2: Enhance Planner Node Agent System Prompt

**Description**: Create a specialized planner prompt for Space node agents with role 'planner' that includes plan-writer sub-agent spawning, two-phase planning (plan document + task creation), and review feedback handling.

**Subtasks**:
1. Add a `buildPlannerNodeAgentPrompt()` function in `custom-agent.ts` that activates when `SpaceAgent.role === 'planner'`
2. Include two-phase instructions: Phase 1 (explore + plan document + PR), Phase 2 (merge PR + create tasks)
3. Add instructions for `send_message` to reviewers to get plan review feedback
4. Include task creation tool usage guidance (`create_task` MCP tool from Task Agent)
5. Ensure the prompt works with the existing `injectWorkflowContext` flag on `SpaceAgent` to embed workflow structure into the task message (reference existing implementation, not a new feature)

**Acceptance Criteria**:
- Planner node agents create proper plan documents on feature branches with PRs
- Planner can receive and address reviewer feedback via `send_message`
- Planner handles Phase 2 (merge + create tasks) after plan approval
- Unit tests cover the new prompt builder

**Depends on**: nothing (parallel with 1.1)

**Agent type**: planner

**Description**: Create a specialized reviewer prompt for Space node agents with role 'reviewer' that includes PR review posting via REST API, severity classification (P0-P3), and structured review output format.

**Subtasks**:
1. Add a `buildReviewerNodeAgentPrompt()` function in `custom-agent.ts` that activates when `SpaceAgent.role === 'reviewer'`
2. Include PR review process: read changed files, evaluate correctness/completeness/security
3. Add review posting via REST API (`GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews`)
4. Add structured output format: `---REVIEW_POSTED---` block with URL, recommendation, severity counts
5. Note: self-review prevention (EVENT=COMMENT when reviewing own PR) is NOT needed for Space node agents. In the Space workflow, the reviewer is a separate agent from the coder — it never creates its own PR. This check exists in the Room system for human reviewers and is not applicable here.

**Acceptance Criteria**:
- Reviewer node agents post proper PR reviews with severity classification
- Reviews include P0-P3 issue counts and structured output
- Reviewer prompt does NOT include self-review prevention logic (unnecessary for automated agents)
- Unit tests cover the new prompt builder

**Depends on**: nothing (parallel with 1.1 and 1.2)

**Agent type**: reviewer
