# Space Feature: End-to-End Happy Path

## Goal Summary

Make the happy path for a single space with a single task using a single workflow work end-to-end: human converses with Space Agent, creates a task, Space Agent selects the default coding workflow, and the workflow runs through the full pipeline with proper gate enforcement, agent-to-agent messaging, and completion detection.

**Scope constraints**: Single task, single space, single workflow run. No goals/missions involved.

## Target Workflow Pipeline

```
Planning → [PR Gate] → Plan Review (reviewer agents) → [Human Gate] → Coding Agent → [PR Gate] → 3 Coding Reviewers (parallel) → [Aggregate Gate: 3 yes votes required] → QA → Task Agent (Done)
```

**Gate types**:
- **PR Gate**: Blocks until a PR is created. Stores the PR URL. Agents downstream can read it.
- **Human Gate**: Blocks until a human approves. Shows artifacts view with all changes in the worktree.
- **Aggregate Gate**: Blocks until a quorum is met (e.g., 3/3 reviewers vote "yes"). Stores each reviewer's vote.
- **Task Result Gate**: Simple pass/fail based on agent's `report_done` result.

## Core Architecture: Gates + Channels

**CRITICAL DESIGN DECISION**: The Space workflow uses a Gate + Channel model instead of a complex state machine. This is fundamentally simpler and more composable than tracking many states with complex transition rules.

### Gates

A **Gate** is a simple condition that can pass or not, **with a data store**. Gates hold the data they need (PR URLs, review results, approval status). Agents can read and write gate data.

```typescript
interface Gate {
  id: string;
  type: 'pr' | 'human' | 'aggregate' | 'task_result' | 'always';
  // The gate's data store — agents can read/write this
  data: Record<string, unknown>;
  // Evaluate whether the gate passes
  evaluate(): boolean;
}
```

**Gate data examples**:
- PR Gate: `{ prUrl: 'https://github.com/...', prNumber: 123, branch: 'feat/xyz' }`
- Human Gate: `{ approved: true, approvedBy: 'user123', approvedAt: '2025-...' }`
- Aggregate Gate: `{ votes: { reviewer1: 'approve', reviewer2: 'approve', reviewer3: 'approve' }, quorum: 3 }`
- Task Result Gate: `{ result: 'passed', summary: '...' }`

**Key property**: Gates persist their data to SQLite in a dedicated `gate_data` table (keyed by `runId + gateId`), separate from the static channel/gate definitions. This separation ensures: (a) gate data changes frequently during a run while channel definitions are static, (b) gate data is per-run while channels are per-workflow, and (c) atomic reads/writes without deserializing a JSON blob from the channel definition.

Agents read/write gate data via MCP tools (`read_gate`, `write_gate`, `list_gates`). The gate's `evaluate()` checks its own data store — no external state machine needed.

### Gate Discovery

Agents discover available gates via two mechanisms:
1. **`list_gates` MCP tool**: Returns all gates for the current workflow run with their IDs, types, and current data. Agents call this at session start to understand the workflow topology.
2. **Workflow context injection**: When a node agent is spawned, the `TaskAgentManager` injects a `workflowContext` section into the agent's task message containing: the node's upstream/downstream gate IDs, gate types, and human-readable descriptions (e.g., "Code PR Gate: write your PR URL here after creating the PR").

### Gate Write Permissions

Each gate has an `allowedWriterRoles` list (persisted in the gate definition, not the data store):
- Plan PR Gate: `['planner']`
- Human Gate: `['human']` (written via RPC, not MCP tool)
- Code PR Gate: `['coder']`
- Aggregate Gate: `['reviewer']`
- Task Result Gate: `['qa']`

When an unauthorized agent calls `write_gate`, the tool returns an error: `"Permission denied: role '{role}' cannot write to gate '{gateId}'"`. The authorization check uses the agent's `nodeRole` from the MCP server config.

### WorkflowRunStatus Strategy

The current `WorkflowRunStatus` type is: `'pending' | 'in_progress' | 'completed' | 'cancelled' | 'needs_attention'`. Rather than adding `'failed'`, **all failure scenarios use the existing `'needs_attention'` status** with a structured `failureReason` field added to `SpaceWorkflowRun`:

```typescript
failureReason?: 'humanRejected' | 'maxIterationsReached' | 'nodeTimeout' | 'agentCrash';
```

This avoids a cross-cutting type change that would affect the status machine, repository, RPC handlers, and all consumers. The `needs_attention` status already semantically means "requires human intervention" which is correct for all failure scenarios.

### Channels

A **Channel** controls who can talk to whom (communication flow). A channel connects two nodes and has a gate that controls when messages can flow.

```typescript
interface Channel {
  id: string;
  from: string;  // source node ID
  to: string;    // target node ID
  gate: Gate;    // controls when this channel opens
  isCyclic?: boolean;  // for feedback loops
}
```

### Why This Is Simpler

Instead of a state machine with states like `planning`, `waiting_for_plan_review`, `waiting_for_human_approval`, `coding`, `waiting_for_code_review`, `waiting_for_qa`, `done`, `failed`, `needs_attention` — each with complex transition rules — we have:

1. **Nodes** execute agents (one at a time or in parallel)
2. **Channels** connect nodes with gates
3. **Gates** are simple conditions with data stores
4. The workflow "state" is just: which nodes are active + what data is in each gate

Adding new behaviors = adding new gates and channels, not new states and transition rules.

## Current State Analysis

### What Already Exists (Working Infrastructure)

1. **Space data model**: `Space`, `SpaceTask`, `SpaceWorkflow`, `SpaceWorkflowRun`, `SpaceAgent` types in `packages/shared/src/types/space.ts` — fully defined with channels, gates, multi-agent nodes.

2. **Space CRUD**: `SpaceManager`, `SpaceAgentManager`, `SpaceWorkflowManager`, `SpaceTaskManager` — all backed by SQLite repos with reactive DB notifications.

3. **Built-in workflows**: `CODING_WORKFLOW` (Plan -> Code -> Verify -> Done with human gate), `RESEARCH_WORKFLOW`, `REVIEW_ONLY_WORKFLOW` in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`. Seeded at space creation time.

4. **Preset agents**: Coder, General, Planner, Reviewer — seeded via `seedPresetAgents()` at space creation.

5. **Channel routing**: `ChannelRouter` with gate evaluation (`always`, `human`, `condition`, `task_result`), `ChannelResolver` for channel topology, `ChannelGateEvaluator`.

6. **Agent-centric messaging**: Node agents use `send_message` (channel-validated), `report_done`, `list_peers`, `list_reachable_agents` via MCP tools.

7. **Task Agent**: Session-level orchestrator (`TaskAgentManager`) that spawns sub-sessions per workflow node, monitors completion via `CompletionDetector`, handles lazy node activation.

8. **Custom agent factory**: `createCustomAgentInit()` builds `AgentSessionInit` from `SpaceAgent` config with proper system prompts, tools, and role-based defaults.

9. **Space Runtime**: `SpaceRuntime` with tick loop, executor map, rehydration, completion detection, and notification sink.

10. **Space chat agent**: Conversational coordinator in `packages/daemon/src/lib/space/agents/space-chat-agent.ts` that can `start_workflow_run`, `create_standalone_task`, `suggest_workflow`, `list_workflows`, etc.

11. **E2E tests**: Space creation, workflow visual editor, multi-agent editor, export/import, agent-centric workflow tests.

12. **Online tests**: `task-agent-lifecycle.test.ts`, `space-agent-coordination.test.ts`.

### What Needs to Be Built / Fixed

1. **Gate + Channel architecture refactor**: The existing `ChannelGateEvaluator` supports basic gate types but lacks the **gate data store** concept. Gates need to persist data (PR URLs, review votes, approval status) that agents can read/write. This is the core architectural change.

2. **New gate types**: PR Gate (checks PR exists, stores URL), Aggregate Gate (quorum voting), and enhanced Human Gate (stores approval + shows artifacts).

3. **Extended workflow template**: Create `CODING_WORKFLOW_V2` matching the target pipeline with PR gates, parallel reviewers, and aggregate gate.

4. **Node agent prompt specialization**: Node agents need proper system prompts with git workflow, PR creation, review posting, gate data writing.

5. **Parallel reviewer support**: The workflow needs 3 reviewer nodes that run in parallel, with an aggregate gate requiring all 3 to approve before QA runs.

6. **QA agent step**: Verification agent that checks test coverage, CI status, and PR mergeability.

7. **Human gate UI with canvas visualization**: Live workflow visualization on a canvas. Clicking a human gate opens an artifacts view showing all changes in the worktree. Clicking individual changes renders file diffs. Similar to GitHub Actions visualization but with human-in-the-loop nodes.

8. **Worktree isolation (one per task)**: Currently no worktree isolation exists. Need ONE worktree per task (shared by all agents in that task), with short human-readable folder names (e.g., `alpha-3`, `nova-7`).

9. **Gate data MCP tools**: Agents need `read_gate` and `write_gate` MCP tools to interact with gate data stores.

10. **End-to-end integration testing**: No single test exercises the full pipeline.

## High-Level Approach

**Phase 1 — Gate + Channel architecture and workflow template** (Milestones 1-3):
- Implement gate data store and new gate types (PR, Aggregate, enhanced Human)
- Enhance node agent prompts (git workflow, review posting, PR management, gate interaction)
- Create extended CODING_WORKFLOW_V2 with the full pipeline
- Implement worktree isolation (one per task, short names)

**Phase 2 — QA, human gate UI, and completion** (Milestones 4-6):
- Add QA node to the pipeline
- Build human gate canvas UI with artifacts view and diff rendering
- Wire completion flow so Task Agent reports final status
- Implement conversation-to-task entry point

**Phase 3 — End-to-end testing and hardening** (Milestones 7-9):
- Online integration tests with dev proxy
- E2E Playwright test exercising the full UI flow
- Bug fixes and hardening

## Milestones

1. **Gate data store and new gate types** — Implement the gate data store (persisted to SQLite), `read_gate`/`write_gate` MCP tools, and new gate types: PR Gate, Aggregate Gate, enhanced Human Gate

2. **Enhanced node agent prompts** — Add git/PR/review-specific system prompts for planner, coder, reviewer, and QA agents, including gate data interaction instructions

3. **Extended coding workflow (V2)** — Create CODING_WORKFLOW_V2 with the full pipeline: Planning → [PR Gate] → Plan Review → [Human Gate] → Coding → [PR Gate] → 3 Reviewers (parallel) → [Aggregate Gate] → QA → Done

4. **Worktree isolation (one per task)** — Implement single worktree per task with short human-readable names (e.g., `alpha-3`, `nova-7`), shared by all agents in the task

5. **QA agent node** — Add QA as the verification step before Done, with QA→Code feedback loop

6. **Human gate canvas UI** — Build live workflow canvas visualization with clickable human gates that show artifacts view with file diffs (GitHub Actions-style but with human-in-the-loop)

7. **Online integration test** — Exercise the full happy path with dev proxy, broken into focused per-component sub-tests

8. **E2E test** — Playwright test exercising the full UI flow from space chat through task creation and workflow execution

9. **Bug fixes and hardening** — Fix issues discovered during testing; add error handling and edge case coverage

## Final Workflow Graph

```
Planning ──[PR Gate]──► Plan Review (reviewers) ──[Human Gate]──► Coding ──[PR Gate]──► Reviewer 1 ─┐
                                                                    ▲                    Reviewer 2 ─┼─[Aggregate Gate: 3 yes]──► QA ──[Task Result: pass]──► Done
                                                                    │                    Reviewer 3 ─┘                            │
                                                                    │                                                             │
                                                                    └──────────── [Task Result: fail, cyclic] ────────────────────┘
                                                                    │                         │
                                                                    └── [Review reject, cyclic]┘
```

**Gate data flow**:
- Planner writes to PR Gate: `{ prUrl, prNumber, branch }`
- Plan reviewers read PR Gate data to find the plan PR
- Human reads gate artifacts view, clicks approve → Human Gate data: `{ approved: true }`
- Coder writes to PR Gate: `{ prUrl, prNumber, branch }`
- Each reviewer writes to Aggregate Gate: `{ votes: { [nodeId]: 'approve' | 'reject' } }` (keyed by node ID, not agent ID, to avoid collision if an agent is re-spawned)
- Aggregate Gate evaluates: passes when `Object.values(votes).filter(v => v === 'approve').length >= quorum`
- QA reads PR Gate data, runs tests, writes Task Result Gate data

**All cyclic channels route back to Coding, never to Planning.** This ensures:
- Code-level issues (review feedback, QA failures) are fixed by the Coder directly without re-planning
- The human gate only fires once (Plan Review → Coding), not on every iteration
- The Coder can iterate on feedback from both reviewers and QA independently

**Iteration cap**: `maxIterations` is a global counter on the workflow run, incremented each time ANY cyclic channel is traversed. When the cap is reached, the workflow transitions to `needs_attention` with error metadata `{ failureReason: 'maxIterationsReached' }`. Note: the current `WorkflowRunStatus` type does not include `'failed'` — all failure scenarios use the existing `'needs_attention'` status with a structured `failureReason` field. See M1 Task 1.1 for the type expansion details.

**Aggregate Gate reset on cycles**: When a cyclic channel fires (e.g., reviewer rejection or QA failure routes back to Coding), the Aggregate Gate's vote data is **reset to `{ votes: {} }`**. This ensures all 3 reviewers must re-vote from scratch after the Coder fixes issues. The reset is triggered by `ChannelRouter` when traversing any cyclic channel — it clears the gate data of all downstream gates between the cycle target (Coding) and the cycle source (Reviewer/QA). See M1 Task 1.4 for implementation details.

## Cross-Milestone Dependencies

- Milestone 1 (gate data store) is the foundation — M2 and M3 depend on it
- Milestone 2 (prompts) depends on M1 (agents need `read_gate`/`write_gate`/`list_gates` instructions) AND M3 (prompts reference specific gate IDs from the V2 workflow template). **M2 should be implemented after M3.** Alternatively, M2 prompts can use generic gate references (e.g., "the downstream PR gate") with M3 providing the concrete wiring, but implementing M3 first is cleaner.
- Milestone 3 (V2 workflow) depends on M1 (new gate types must exist)
- Milestone 4 (worktree) can start in parallel with M2/M3
- Milestone 5 (QA) depends on M3 (V2 workflow template must exist)
- Milestone 6 (human gate UI) depends on M1 (gate data store) and M3 (V2 workflow with human gate)
- Milestone 7 (online test) depends on M5 and M6
- Milestone 8 (E2E test) depends on M6; can start in parallel with M7
- Milestone 9 (hardening) depends on M7 and M8

## V2 Workflow Seeding Strategy

- `CODING_WORKFLOW_V2` is seeded alongside existing workflows (additive, not replacing)
- Existing spaces are not affected (idempotent seeding)
- V2 gets `tag: 'default'` so workflow selector ranks it first for coding-type requests
- Existing `CODING_WORKFLOW` (V1) kept for backward compatibility
- **V1→V2 migration is out of scope**

## Worktree Strategy

- **One worktree per task** (shared by all agents in that task — planner, coder, reviewer, QA all work in the same worktree)
- **Short, human-readable folder names**: `alpha-3`, `nova-7`, `flux-2` — short adjective + dash + number (similar to Codex naming)
- The worktree name does NOT need to associate with session IDs — the DB links everything
- Folder name just needs to be unique and memorable
- Agents work sequentially in the task worktree, so no conflicts
- **Branch naming**: `space/{worktree-name}` (e.g., `space/alpha-3`) — short because worktree names are already unique; no UUID-based task IDs in the branch name
- **Cleanup timing**: Worktrees are kept until the PR is merged or the task is explicitly deleted by the human. A TTL-based reaper (default: 7 days after workflow completion) cleans up stale worktrees. Immediate cleanup only on task cancellation.

## Total Estimated Task Count

~30 tasks across 9 milestones
