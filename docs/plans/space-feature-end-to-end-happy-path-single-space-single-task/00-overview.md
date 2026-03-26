# Space Feature: End-to-End Happy Path

## Goal Summary

Make the happy path for a single space with a single task using a single workflow work end-to-end: human converses with Space Agent, creates a task, Space Agent selects the default coding workflow, and the workflow runs through Plan → (human gate) → Code → Review → QA → Done with proper gate enforcement, agent-to-agent messaging, and completion detection.

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

10. **Space chat agent**: Conversational coordinator in `packages/daemon/src/lib/space/agents/space-chat-agent.ts` that can `start_workflow_run`, `create_standalone_task`, `suggest_workflow`, `list_workflows`, etc.

11. **E2E tests**: Space creation, workflow visual editor, multi-agent editor, export/import, agent-centric workflow tests.

12. **Online tests**: `task-agent-lifecycle.test.ts`, `space-agent-coordination.test.ts`.

### What Needs to Be Built / Fixed

1. **Extended workflow template**: The current `CODING_WORKFLOW` is a simple 4-node graph (Plan -> Code -> Verify -> Done). The goal asks for a richer pipeline (Plan -> Code -> Review -> QA -> Done). We need to **create a new V2 workflow** that replaces Verify with a proper Review → QA chain.

2. **End-to-end integration testing**: No single test exercises the full happy path from conversation -> task creation -> workflow run start -> agent execution -> gate enforcement -> completion. The existing tests are unit/online tests for individual components.

3. **Node agent prompt specialization**: Node agents (planner, coder, reviewer, QA) need proper system prompts that include git workflow, review posting, PR creation, bypass markers, and review feedback handling -- currently only the custom agent factory provides a basic git workflow prompt.

4. **Single-pass reviewer support**: The goal description wants eventual parallel async reviewers, but we start with single-pass to prove gate mechanism. Need to add a "single reviewer" step that the existing reviewer agent can fill.

5. **QA agent step**: A verification agent that checks test coverage, CI pipeline status, and PR mergeability. Currently `CODING_WORKFLOW` has a "Verify & Test" step using a general agent, but the prompt is minimal. QA replaces Verify entirely.

6. **Human gate UX**: The human gate mechanism exists in the backend (ChannelGateEvaluator supports `human` type gates), but there is no frontend UI for humans to see the gate, understand what's being requested, and approve/reject. This needs a full stack implementation.

7. **Worktree isolation for node agents**: Currently `TaskAgentManager.spawnSubSession()` passes `workspacePath: space.workspacePath` directly with no worktree isolation. All node agents share the same working directory. Need to investigate and implement proper git worktree isolation.

8. **Task Agent summary step**: A "Done" step where the Task Agent summarizes work and PR status for the human.

9. **Online integration test for the full workflow**: Exercise the pipeline with mocked SDK (dev proxy) to prove the end-to-end flow.

## High-Level Approach

**Phase 1 -- Extend the workflow and enhance agents** (Milestones 1-3):
- Enhance node agent prompts (git workflow, review posting, PR management)
- Create extended CODING_WORKFLOW_V2: Plan → Code → Review → Done (4 nodes)
- Implement worktree isolation and session factory improvements

**Phase 2 -- Add QA, human gate, and completion verification** (Milestones 4-6):
- Add QA node to workflow: Plan → Code → Review → QA → Done (5 nodes)
- Build human gate UX (frontend widget + backend RPC + state transitions)
- Wire completion flow so Task Agent reports final status to human
- Implement conversation-to-task entry point

**Phase 3 -- End-to-end testing and hardening** (Milestones 7-9):
- Online integration tests with dev proxy (broken into focused sub-tests)
- E2E test exercising the full UI flow
- Fix bugs found during integration and E2E testing

## Milestones

1. **Enhanced node agent prompts** -- Add git/PR/review-specific system prompts for planner, coder, and reviewer node agents (mirrors the room system's prompt quality)

2. **Extended coding workflow (Phase 1)** -- Create CODING_WORKFLOW_V2 with 4 nodes: Plan → Code → Review → Done, with Review→Code feedback loop

3. **Node agent session factory improvements** -- Implement worktree isolation, configure feature flags, and ensure MCP tool access for node agent sessions

4. **QA agent node** -- Add QA as the 5th node (replaces Verify): Plan → Code → Review → QA → Done, with QA→Code and Review→Code feedback loops

5. **Human gate and completion flow** -- Build full-stack human gate UX (backend + frontend) and wire completion notifications to human

6. **Online integration test** -- Exercise the full happy path with dev proxy, broken into focused per-component sub-tests

7. **E2E test** -- Playwright test exercising the full UI flow from space chat through task creation and workflow execution

8. **Bug fixes and hardening** -- Fix issues discovered during testing; add error handling, iteration cap exhaustion, and edge case coverage

## Final Workflow Graph

```
Plan ---[human gate]--> Code ---[always gate]--> Review ---[task_result gate: passed]--> QA ---[task_result gate: passed]--> Done
                                              ^                    |                          |
                                              |                    | [task_result: failed]     | [task_result: failed]
                                              +--------------------+                          |
                                                                   (reviewer feedback         +------------------+
                                                                    to coder via send_message)                    |
                                                                                                                       |
                                              +----------------------------------------------+
                                              | (QA feedback to coder via channel)
```

**All cyclic channels route back to Code, never to Plan.** This ensures:
- Code-level issues (review feedback, QA failures) are fixed by the Coder directly without requiring re-planning
- The human gate only fires once (Plan → Code), not on every iteration
- The Coder can iterate on feedback from both Reviewer and QA independently

**Iteration cap**: `maxIterations` is a global counter on the workflow run, incremented each time ANY cyclic channel is traversed. When the cap is reached, the workflow run transitions to `failed` status with a `failureReason` of `'maxIterationsReached'` (see M5 Task 5.1 for the `WorkflowRunStatus` type expansion and `failureReason` field addition). A notification is sent to the human requesting manual intervention. Note: the current `WorkflowRunStatus` type in `packages/shared/src/types/space.ts` does not include `'failed'` — until M5 lands, this uses `needs_attention` with error metadata as an interim.

## Cross-Milestone Dependencies

- Milestone 1 (prompts) and Milestone 2 (extended workflow) can be developed in parallel
- Milestone 3 (session factory) can start in parallel with M2; depends on M1 only for Task 3.1 (coder prompt defines git workflow needs)
- Milestone 4 (QA agent) depends on Milestone 2 (V2 workflow template provides the base to extend) -- does NOT depend on M3
- Milestone 5 (human gate/completion) depends on Milestone 4 (full 5-node pipeline must exist)
- Milestone 6 (online test) depends on Milestone 5 (full pipeline with human gate must work)
- Milestone 7 (E2E test) depends on Milestone 5 (full pipeline with human gate must work); can start in parallel with M6
- Milestone 8 (hardening) depends on M6 and M7

## V2 Workflow Seeding Strategy

- `CODING_WORKFLOW_V2` is seeded alongside the existing workflows (additive, not replacing)
- Existing spaces are not affected (idempotent seeding)
- The V2 workflow gets a `tag: 'default'` so `workflow-selector.ts` ranks it first for coding-type requests
- The existing `CODING_WORKFLOW` (V1) is kept for backward compatibility but is no longer the default
- New spaces created after the V2 seed will have both V1 and V2 available, with V2 as the suggested default
- **V1→V2 migration is out of scope for this PR.** Existing spaces that were seeded with V1 retain the V1 workflow. V1's `Verify → Plan (on fail)` loop remains (which sends failures back to the Planner, not the Coder — this is intentional for V1's simpler topology). A future PR can add a migration that switches existing spaces to V2.

## Total Estimated Task Count

28 tasks across 8 milestones
