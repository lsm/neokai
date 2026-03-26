# Space Feature: End-to-End Happy Path

## Goal Summary

Make the happy path for a single space with a single task using a single workflow work end-to-end: human converses with Space Agent, creates a task, Space Agent selects the default coding workflow, and the workflow runs through Planner -> (human gate) -> Coder -> Verify -> Done with proper gate enforcement, agent-to-agent messaging, and completion detection.

**Scope constraints**: Single task, single space, single workflow run. No goals/missions involved. No parallel reviewers (that comes later).

## Current State Analysis

### What Already Exists (Working Infrastructure)

1. **Space data model**: `Space`, `SpaceTask`, `SpaceWorkflow`, `SpaceWorkflowRun`, `SpaceAgent` types in `packages/shared/src/types/space.ts` -- fully defined with channels, gates, multi-agent nodes.

2. **Space CRUD**: `SpaceManager`, `SpaceAgentManager`, `SpaceWorkflowManager`, `SpaceTaskManager` -- all backed by SQLite repos with reactive DB notifications.

3. **Built-in workflows**: `CODING_WORKFLOW` (Plan -> Code -> Verify -> Done with human gate), `RESEARCH_WORKFLOW`, `REVIEW_ONLY_WORKFLOW` in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`. Seeded at space creation time.

4. **Preset agents**: Coder, General, Planner, Reviewer -- seeded via `seedPresetAgents()` at space creation.

5. **Channel routing**: `ChannelRouter` with gate evaluation (`always`, `human`, `condition`, `task_result`), `ChannelResolver` for channel topology, `ChannelGateEvaluator`.

6. **Agent-centric messaging**: Node agents use `send_message` (channel-validated), `report_done`, `list_peers`, `list_reachable_agents` via MCP tools.

7. **Task Agent**: Session-level orchestrator (`TaskAgentManager`) that spawns sub-sessions per workflow node, monitors completion via `CompletionDetector`, handles lazy node activation.

8. **Custom agent factory**: `createCustomAgentInit()` builds `AgentSessionInit` from `SpaceAgent` config with proper system prompts, tools, and role-based defaults.

9. **Space Runtime**: `SpaceRuntime` with tick loop, executor map, rehydration, completion detection, and notification sink.

10. **Space chat agent**: Conversational coordinator that can `start_workflow_run`, `create_standalone_task`, `suggest_workflow`, `list_workflows`, etc.

11. **E2E tests**: Space creation, workflow visual editor, multi-agent editor, export/import, agent-centric workflow tests.

12. **Online tests**: `task-agent-lifecycle.test.ts`, `space-agent-coordination.test.ts`.

### What Needs to Be Built / Fixed

1. **Default workflow template for the described pipeline**: The current `CODING_WORKFLOW` is a simple 4-node graph (Plan -> Code -> Verify -> Done). The goal asks for a richer 6-step pipeline (Planner -> 2 Plan Reviewers -> Coder -> 3 Code Reviewers -> QA -> Task Agent). We need to **bridge** the existing infrastructure to support this incrementally.

2. **End-to-end integration testing**: No single test exercises the full happy path from conversation -> task creation -> workflow run start -> agent execution -> gate enforcement -> completion. The existing tests are unit/online tests for individual components.

3. **Node agent prompt specialization**: Node agents (planner, coder, reviewer) need proper system prompts that include git workflow, review posting, PR creation, bypass markers, and review feedback handling -- currently only the custom agent factory provides a basic git workflow prompt.

4. **Single-pass reviewer support**: The goal description wants eventual parallel async reviewers, but we start with single-pass to prove gate mechanism. Need to add a "single reviewer" step that the existing reviewer agent can fill.

5. **QA agent step**: A verification agent that checks test coverage, CI pipeline status, and PR mergeability. Currently `CODING_WORKFLOW` has a "Verify & Test" step using a general agent, but the prompt is minimal.

6. **Task Agent summary step**: A "Done" step where the Task Agent summarizes work and PR status for the human.

7. **Online integration test for the full workflow**: Exercise the pipeline with mocked SDK (dev proxy) to prove the end-to-end flow.

## High-Level Approach

**Phase 1 -- Stabilize and extend the existing CODING_WORKFLOW** (Milestones 1-3):
- Add a single-pass code reviewer step between Coder and Verify
- Enhance node agent prompts (git workflow, review posting, PR management)
- Prove the existing channel/gate system works end-to-end

**Phase 2 -- Add QA agent and completion verification** (Milestones 4-5):
- Add a dedicated QA node that checks tests, CI, PR mergeability
- Add a gate that loops back to Coder on QA failure
- Wire the completion flow so Task Agent reports final status to human

**Phase 3 -- End-to-end testing and hardening** (Milestones 6-8):
- Online integration test with dev proxy
- E2E test exercising the full UI flow
- Fix bugs found during integration

## Milestones

1. **Enhanced node agent prompts** -- Add git/PR/review-specific system prompts for planner, coder, and reviewer node agents working in the Space system (mirrors the room system's prompt quality)

2. **Extended coding workflow** -- Add a single-pass Reviewer step to the default coding workflow between Coder and Verify, with proper channel gates

3. **Node agent session factory improvements** -- Ensure custom agent sessions have proper worktree isolation, feature flags, and MCP tool access for PR operations

4. **QA agent node** -- Add a dedicated QA agent step to the workflow that verifies tests, CI pipeline, and PR mergeability; loop back to Coder on failure

5. **Human gate and completion flow** -- Wire the human gate on plan approval to actually pause the workflow and resume on human signal; ensure Task Agent reports final status

6. **Online integration test** -- Exercise the full happy path with dev proxy: conversation -> task creation -> workflow run -> planner -> human approve -> coder -> reviewer -> QA -> done

7. **E2E test** -- Playwright test exercising the full UI flow from space chat through task creation and workflow execution

8. **Bug fixes and hardening** -- Fix issues discovered during integration and E2E testing; add missing error handling and edge case coverage

## Cross-Milestone Dependencies

- Milestone 1 (prompts) and Milestone 2 (extended workflow) can be developed in parallel
- Milestone 3 (session factory) depends on Milestone 1 (prompts define what tools agents need)
- Milestone 4 (QA agent) depends on Milestone 2 (extended workflow provides the structure to add to)
- Milestone 5 (human gate/completion) depends on Milestone 4 (QA agent must exist for the full pipeline)
- Milestone 6 (online test) depends on Milestone 5 (full pipeline must work)
- Milestone 7 (E2E test) depends on Milestone 5 (full pipeline must work); can start in parallel with M6
- Milestone 8 (hardening) depends on M6 and M7

## Total Estimated Task Count

16 tasks across 8 milestones
