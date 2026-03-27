# Space Feature: End-to-End Happy Path

## Goal Summary

Make the happy path for a single space with a single task using a single workflow work end-to-end: human converses with Space Agent, creates a task, Space Agent selects the default coding workflow, and the workflow runs through the full pipeline with proper gate enforcement, agent-to-agent messaging, and completion detection.

**Scope constraints**: Single task, single space, single workflow run. No goals/missions involved.

## Target Workflow Pipeline

```
Planning → [check: prUrl exists] → Plan Review (1 reviewer) → [check: approved] → Coding → [check: prUrl exists] → 3 Code Reviewers (parallel) → [check: ≥3 approve votes] → QA → Done
```

## Core Architecture: Channels + Gates

**CRITICAL DESIGN DECISION**: The Space workflow uses a Channel + Gate model instead of a complex state machine. This is fundamentally simpler and more composable than tracking many states with complex transition rules.

### Channels and Gates Are Separate Concepts

- A **Channel** is a unidirectional pipe between two nodes: `{ from, to }`. Just a connection. No condition logic.
- A **Gate** is an optional filter attached to a channel: `{ condition, data }`. It controls when communication can flow through the channel.

A channel **without** a gate is always open — messages flow freely.
A channel **with** a gate is filtered — communication only flows when the gate's condition passes.

For **bidirectional** communication between two nodes, create TWO channels (one per direction), each with its own optional gate.

```typescript
// Channel = just a pipe between nodes
interface Channel {
  id: string;
  from: string;          // source node ID
  to: string;            // target node ID
  gateId?: string;       // optional — if absent, channel is always open
  isCyclic?: boolean;    // for feedback loops
}

// Gate = independent filter entity, referenced by channels via gateId
// A single gate can be shared by multiple channels (e.g., code-pr-gate shared by 3 reviewer channels)
interface Gate {
  id: string;
  condition: GateCondition;             // what to check — composable predicates
  data: Record<string, unknown>;        // persistent data store — agents read/write this
  allowedWriterRoles: string[];         // who can write — ['planner'], ['reviewer'], etc.
  description: string;                  // human-readable — "Write your PR URL here after creating the PR"
  resetOnCycle: boolean;                // whether data is cleared when a cyclic channel fires
}
```

**Example — bidirectional planner ↔ reviewer**:
- Channel A: `planner → reviewer`, Gate: `plan-pr-gate` (condition: `check: prUrl exists`) — reviewer can't start until planner creates a PR
- Channel B: `reviewer → planner`, No gate — always open for feedback messages

### Composable Conditions

Instead of a type hierarchy, conditions are small pluggable predicates that check gate data:

```typescript
type GateCondition =
  | { type: 'check'; field: string; op?: '==' | '!=' | 'exists'; value?: unknown }  // check a single field
  | { type: 'count'; field: string; matchValue: unknown; min: number }              // count matching entries in a map
  | { type: 'all'; conditions: GateCondition[] }                                    // AND — all sub-conditions must pass
  | { type: 'any'; conditions: GateCondition[] }                                    // OR — at least one sub-condition must pass
```

**No `always` condition type** — a channel without a gate is implicitly always open. Four condition types cover every gate behavior:

| Gate use case | Condition | Example |
|---------------|-----------|---------|
| PR created | `{ type: 'check', field: 'prUrl', op: 'exists' }` | Passes when `data.prUrl` is truthy |
| Human approval | `{ type: 'check', field: 'approved', op: '==', value: true }` | Passes when `data.approved === true` |
| QA passed | `{ type: 'check', field: 'result', op: '==', value: 'passed' }` | Passes when `data.result === 'passed'` |
| QA failed (cyclic) | `{ type: 'check', field: 'result', op: '==', value: 'failed' }` | Passes when `data.result === 'failed'` |
| Review rejected (cyclic) | `{ type: 'check', field: 'result', op: '==', value: 'rejected' }` | Passes when `data.result === 'rejected'` |
| 3 reviewer votes | `{ type: 'count', field: 'votes', matchValue: 'approve', min: 3 }` | Passes when ≥3 entries in `data.votes` equal `'approve'` |
| Composite AND | `{ type: 'all', conditions: [...] }` | Passes when ALL sub-conditions pass |
| Composite OR | `{ type: 'any', conditions: [...] }` | Passes when ANY sub-condition passes |

The `all`/`any` types are **recursive** — sub-conditions can themselves be `all`/`any`, enabling arbitrarily complex logic. For the current V2 workflow, simple `check`/`count` conditions suffice, but composite conditions enable future gates like "PR exists AND CI passes" in a single gate.

**Why this is better**: Channels are simple pipes. Gates are optional filters. No class hierarchy, no separate evaluator per type. One `evaluate(gate)` function with a recursive switch on `condition.type`. Adding a new behavior = defining a new condition config, not a new class. A channel without a gate replaces the old `always` condition type.

### Structured `send_message` Data

The `send_message` MCP tool carries structured data alongside natural language text:

```typescript
{
  text: string,                         // natural language message
  data?: Record<string, unknown>        // structured data (extensible)
}
```

Use cases:
- Reviewer sends feedback: `{ text: 'Approved with suggestions', data: { reviewUrl, gateData: { 'review-votes-gate': { votes: { approve: 1 } } } } }`
- Planner sends plan: `{ text: 'Plan ready for review', data: { planDocPath, prUrl } }`
- Gate data updates can be embedded in message `data` and applied on delivery through the channel

### Gate Data Store

Gates persist their data to SQLite in a dedicated `gate_data` table (keyed by `runId + gateId`), separate from channel and gate definitions. This separation ensures: (a) gate data changes frequently during a run while definitions are static, (b) gate data is per-run while definitions are per-workflow, and (c) atomic reads/writes without deserializing a JSON blob.

**Gate data examples**:
- PR gate: `{ prUrl: 'https://github.com/...', prNumber: 123, branch: 'feat/xyz' }`
- Human approval gate: `{ approved: true, approvedBy: 'user123', approvedAt: '2025-...' }`
- Vote gate: `{ votes: { 'reviewer-1-node': 'approve', 'reviewer-2-node': 'approve', 'reviewer-3-node': 'approve' } }`
- QA result gate: `{ result: 'passed', summary: '...' }`

### Gate and Channel Discovery

Agents discover the workflow topology via MCP tools and injected context:
1. **`list_channels` MCP tool**: Returns all channels for the current workflow run with their IDs, from/to nodes, and whether they have a gate attached.
2. **`list_gates` MCP tool**: Returns all gates with their IDs, conditions, descriptions, and current data.
3. **`read_gate` / `write_gate` MCP tools**: Read from and write to gate data stores.
4. **Workflow context injection**: When a node agent is spawned, the `TaskAgentManager` injects a `workflowContext` section into the agent's task message containing: upstream/downstream channel and gate IDs with human-readable descriptions.

### Gate Write Permissions

Each gate has an `allowedWriterRoles` list (persisted in the gate definition):
- `plan-pr-gate`: `['planner']`
- `plan-approval-gate`: `['human']` (written via RPC, not MCP tool)
- `code-pr-gate`: `['coder']`
- `review-votes-gate`: `['reviewer']`
- `review-reject-gate`: `['reviewer']`
- `qa-result-gate`: `['qa']`
- `qa-fail-gate`: `['qa']`

When an unauthorized agent calls `write_gate`, the tool returns an error: `"Permission denied: role '{role}' cannot write to gate '{gateId}'"`. The authorization check uses the agent's `nodeRole` from the MCP server config.

### WorkflowRunStatus Strategy

The current `WorkflowRunStatus` type is: `'pending' | 'in_progress' | 'completed' | 'cancelled' | 'needs_attention'`. Rather than adding `'failed'`, **all failure scenarios use the existing `'needs_attention'` status** with a structured `failureReason` field added to `SpaceWorkflowRun`:

```typescript
failureReason?: 'humanRejected' | 'maxIterationsReached' | 'nodeTimeout' | 'agentCrash';
```

This avoids a cross-cutting type change that would affect the status machine, repository, RPC handlers, and all consumers.

### Why This Is Simpler

Instead of a state machine with many states and complex transition rules, we have:

1. **Nodes** execute agents (one at a time or in parallel)
2. **Channels** are unidirectional pipes between nodes (bidirectional = two channels)
3. **Gates** are optional filters on channels — all the same type, all the same API
4. The workflow "state" is just: which nodes are active + what data is in each gate

Adding new behaviors = adding new gates with new condition configs, not new gate classes or state transitions. Making a channel always open = just remove the gate.

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

1. **Separate Channel + Gate architecture**: The existing implementation couples gates into channels. Refactor so channels are simple pipes and gates are independent entities optionally attached to channels. A channel without a gate is always open.

2. **Composable conditions**: Replace the current per-type evaluator logic with four condition types (`check`, `count`, `all`, `any`) that cover all workflow behaviors including AND/OR composition. No `always` type — a channel without a gate is implicitly always open.

3. **Extended workflow template**: Create `CODING_WORKFLOW_V2` matching the target pipeline with gates configured via conditions.

4. **Node agent prompt specialization**: Node agents need proper system prompts with git workflow, PR creation, review posting, gate data writing.

5. **Parallel reviewer support**: The workflow needs 3 reviewer nodes that run in parallel, with a vote-counting gate requiring all 3 to approve before QA runs.

6. **QA agent step**: Verification agent that checks test coverage, CI status, and PR mergeability.

7. **Approval gate UI with canvas visualization**: Live workflow visualization on a canvas. Clicking an approval gate (`plan-approval-gate`) opens an artifacts view showing all changes in the worktree.

8. **Worktree isolation (one per task)**: Currently no worktree isolation exists. Need ONE worktree per task (shared by all agents in that task), with folder/branch names derived from the task title via slugification (e.g., task "Add dark mode support" → folder `add-dark-mode-support`, branch `space/add-dark-mode-support`).

9. **Channel and Gate MCP tools**: Agents need `list_channels`, `list_gates`, `read_gate`, `write_gate` MCP tools to discover the workflow topology and interact with gate data stores. `send_message` needs structured `data` field alongside text.

10. **End-to-end integration testing**: No single test exercises the full pipeline.

## High-Level Approach

**Phase 1 — Unified Gate architecture and workflow template** (Milestones 1-3):
- Implement separated Channel + Gate architecture with composable conditions and data store
- Enhance node agent prompts with gate interaction instructions
- Create extended CODING_WORKFLOW_V2 with the full pipeline
- Implement worktree isolation (one per task, short names)

**Phase 2 — QA, approval gate UI, and completion** (Milestones 4-6):
- Add QA node to the pipeline
- Build approval gate canvas UI with artifacts view and diff rendering
- Wire completion flow so Task Agent reports final status
- Implement conversation-to-task entry point

**Phase 3 — End-to-end testing and hardening** (Milestones 7-9):
- Online integration tests with dev proxy
- E2E Playwright test exercising the full UI flow
- Bug fixes and hardening

## Milestones

1. **Separated Channels + Gates with composable conditions** — Implement channels as simple pipes and gates as independent entities with persistent data stores, four condition types (`check`, `count`, `all`/`any` for AND/OR composition), `list_channels`/`list_gates`/`read_gate`/`write_gate` MCP tools, structured `send_message` data, and channel router integration

2. **Enhanced node agent prompts** — Add git/PR/review-specific system prompts for planner, coder, reviewer, and QA agents, including gate data interaction instructions

3. **Extended coding workflow (V2)** — Create CODING_WORKFLOW_V2 with the full pipeline using separated channels and gates with composable conditions

4. **Worktree isolation (one per task)** — Implement single worktree per task with task-title-derived slug names (e.g., `add-dark-mode-support`), shared by all agents in the task

5. **QA agent node** — Add QA as the verification step before Done, with QA→Code feedback loop

6. **Approval gate canvas UI** — Build live workflow canvas visualization with clickable approval gates (`plan-approval-gate`) that show artifacts view with file diffs (GitHub Actions-style but with human-in-the-loop)

7. **Online integration test** — Exercise the full happy path with dev proxy, broken into focused per-component sub-tests

8. **E2E test** — Playwright test exercising the full UI flow from space chat through task creation and workflow execution

9. **Bug fixes and hardening** — Fix issues discovered during testing; add error handling and edge case coverage

## Final Workflow Graph

```
Planning ──[check: prUrl exists]──► Plan Review (1 reviewer) ──[check: approved]──► Coding ──[check: prUrl exists]──► Reviewer 1 ─┐
                                                                    ▲                                                  Reviewer 2 ─┼─[count: votes.approve ≥ 3]──► QA ──[check: result == passed]──► Done
                                                                    │                                                  Reviewer 3 ─┘                                │
                                                                    │                                                                                               │
                                                                    └──────────── [check: result == failed, cyclic] ────────────────────────────────────────────────┘
                                                                    │                         │
                                                                    └── [check: result == rejected, cyclic]┘
```

**Gate data flow**:
- Planner writes `{ prUrl, prNumber, branch }` → `plan-pr-gate` condition `check: prUrl exists` passes
- Plan reviewer reads plan PR from `plan-pr-gate` data
- Human clicks approve → `plan-approval-gate` data gets `{ approved: true }` → condition `check: approved == true` passes
- Coder writes `{ prUrl, prNumber, branch }` → `code-pr-gate` condition `check: prUrl exists` passes
- Each reviewer writes `{ votes: { [nodeId]: 'approve' | 'reject' } }` → `review-votes-gate` condition `count: votes.approve >= 3` passes when quorum met
- QA reads PR from `code-pr-gate` data, writes `{ result: 'passed' | 'failed', summary: '...' }` → `qa-result-gate`

**All cyclic channels route back to Coding, never to Planning.** This ensures:
- Code-level issues (review feedback, QA failures) are fixed by the Coder directly without re-planning
- The approval gate (`plan-approval-gate`) only fires once (Plan Review → Coding), not on every iteration
- The Coder can iterate on feedback from both reviewers and QA independently

**Iteration cap**: `maxIterations` is a global counter on the workflow run, incremented each time ANY cyclic channel is traversed. When the cap is reached, the workflow transitions to `needs_attention` with `failureReason: 'maxIterationsReached'`.

**Gate data reset on cycles**: When a cyclic channel fires, gates with `resetOnCycle: true` have their data cleared to `{}`. This ensures reviewers must re-vote from scratch after the Coder fixes issues. Gates with `resetOnCycle: false` (like `code-pr-gate`) preserve their data across cycles. See M1 Task 1.4 for implementation.

## Cross-Milestone Dependencies

- Milestone 1 (channels + gates) is the foundation — M2 and M3 depend on it
- Milestone 2 (prompts) depends on M1 (agents need gate MCP tools) AND M3 (prompts reference specific gate IDs). **M2 should be implemented after M3.**
- Milestone 3 (V2 workflow) depends on M1 (unified gate must exist)
- Milestone 4 (worktree) can start in parallel with M2/M3
- Milestone 5 (QA) depends on M3 (V2 workflow template must exist)
- Milestone 6 (approval gate UI) depends on M1 (gate data store) and M3 (V2 workflow with `plan-approval-gate`)
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
- **Task-title-derived slug names**: The worktree folder name is a slugified version of the task title (e.g., task "Add dark mode support" → `add-dark-mode-support`). This is self-documenting — you can see which worktree belongs to which task at a glance.
- Slugification: lowercase, hyphens for spaces/special chars, max 60 chars, collision suffix (`-2`, `-3`) if needed
- Agents work sequentially in the task worktree, so no conflicts
- **Branch naming**: `space/{slug}` (e.g., `space/add-dark-mode-support`) — same slug as the folder name, making worktrees and branches easy to correlate
- **Cleanup timing**: Worktrees are kept until the PR is merged or the task is explicitly deleted by the human. A TTL-based reaper (default: 7 days after workflow completion) cleans up stale worktrees. Immediate cleanup only on task cancellation.

## Total Estimated Task Count

~30 tasks across 9 milestones
