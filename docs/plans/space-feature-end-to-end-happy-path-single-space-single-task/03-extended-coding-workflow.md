# Milestone 3: Extended Coding Workflow (V2)

## Goal and Scope

Create `CODING_WORKFLOW_V2` with the full pipeline using separated channels and gates with composable conditions. Channels are simple pipes; gates are optional filters attached to channels. This uses the Channel + Gate architecture from Milestone 1.

## Target Pipeline

```
Planning ──[check: prUrl]──► Plan Review ──[check: approved]──► Coding ──[check: prUrl]──► Reviewer 1 ─┐
                                                                   ▲                       Reviewer 2 ─┼─[count: votes.approve ≥ 3]──► QA ──[check: result == passed]──► Done
                                                                   │                       Reviewer 3 ─┘                                │
                                                                   │                                                                    │
                                                                   └── [check: result == rejected/failed, cyclic] ─────────────────────┘
```

### Node Definitions

| Node | Agent Role | Parallel | Description |
|------|-----------|----------|-------------|
| Planning | planner | no | Creates plan document, opens plan PR |
| Plan Review | reviewer | no (single for MVP) | Reviews the plan PR |
| Coding | coder | no | Implements the plan, opens code PR |
| Reviewer 1/2/3 | reviewer | yes (3 parallel) | Review code PR independently |
| QA | qa | no | Runs tests, checks CI, verifies mergeability |
| Done | - | no | Terminal node, Task Agent summarizes |

### Channel Definitions

Channels are simple unidirectional pipes. Gates are independent entities optionally attached to channels. A channel without a gate is always open. Channels that share the same gate instance are noted below.

| Channel ID | From → To | Gate ID | Cyclic | Description |
|------------|-----------|---------|--------|-------------|
| `ch-plan-to-review` | Planning → Plan Review | `plan-pr-gate` | no | Gated: planner writes `{ prUrl }` |
| `ch-review-to-coding` | Plan Review → Coding | `plan-approval-gate` | no | Gated: human approves plan |
| `ch-coding-to-rev1` | Coding → Reviewer 1 | `code-pr-gate` | no | **Shared gate**: all 3 reviewer channels |
| `ch-coding-to-rev2` | Coding → Reviewer 2 | `code-pr-gate` | no | (same gate instance) |
| `ch-coding-to-rev3` | Coding → Reviewer 3 | `code-pr-gate` | no | (same gate instance) |
| `ch-rev1-to-qa` | Reviewer 1 → QA | `review-votes-gate` | no | **Shared gate**: all 3 reviewers vote here |
| `ch-rev2-to-qa` | Reviewer 2 → QA | `review-votes-gate` | no | (same gate instance) |
| `ch-rev3-to-qa` | Reviewer 3 → QA | `review-votes-gate` | no | (same gate instance) |
| `ch-qa-to-done` | QA → Done | `qa-result-gate` | no | Gated: QA passes |
| `ch-qa-to-coding` | QA → Coding | `qa-fail-gate` | yes | Gated: QA fails, feedback to coder |
| `ch-rev-to-coding` | Reviewers → Coding | `review-reject-gate` | yes | Gated: any reviewer rejects |

### Gate Definitions

All gates are the same entity — they differ only in their `condition` config and which channel they're attached to.

| Gate ID | Condition | `resetOnCycle` | `allowedWriterRoles` |
|---------|-----------|----------------|---------------------|
| `plan-pr-gate` | `check: prUrl exists` | false | `['planner']` |
| `plan-approval-gate` | `check: approved == true` | false | `['human']` |
| `code-pr-gate` | `check: prUrl exists` | false | `['coder']` |
| `review-votes-gate` | `count: votes.approve >= 3` | true | `['reviewer']` |
| `review-reject-gate` | `check: result == rejected` | true | `['reviewer']` |
| `qa-result-gate` | `check: result == passed` | true | `['qa']` |
| `qa-fail-gate` | `check: result == failed` | true | `['qa']` |

**Reject vs. votes gates**: `review-votes-gate` and `review-reject-gate` are **separate gate instances** with different conditions:
- `review-votes-gate`: condition `count: votes.approve >= 3`. Passes when all 3 approve.
- `review-reject-gate`: condition `check: result == rejected`. Any reviewer that rejects writes `{ result: 'rejected', feedback: '...' }` here, firing the cyclic channel back to Coding.
- A reviewer writes to BOTH gates: vote to `review-votes-gate`, and if rejecting, rejection to `review-reject-gate`.

**Gate data reset on cycles**: Uses the `resetOnCycle` flag (see M1). Gates with `resetOnCycle: true` have their data cleared to `{}` when any cyclic channel fires. Gates with `resetOnCycle: false` (like `code-pr-gate`) preserve their data. This ensures reviewers must re-vote from scratch after a fix.

### Iteration Cap

- `maxIterations: 5` (higher than before because the pipeline is longer)
- Global counter per workflow run, incremented on each cyclic channel traversal
- When exhausted: workflow transitions to `needs_attention` with `failureReason: 'maxIterationsReached'`

## Tasks

### Task 3.1: Define CODING_WORKFLOW_V2 Template

**Description**: Create the new workflow template in `built-in-workflows.ts` with all nodes, channels (as simple pipes), and gates (as independent entities attached to channels).

**Subtasks**:
1. Define node ID constants for all 8 nodes (Planning, Plan Review, Coding, Reviewer 1/2/3, QA, Done)
2. Define the Planning node with `agentId: 'planner'`
3. Define the Plan Review node with `agentId: 'reviewer'`
4. Define the Coding node with `agentId: 'coder'`
5. Define 3 Reviewer nodes with `agentId: 'reviewer'`, marked as parallel
6. Define the QA node with `agentId: 'qa'`
7. Define the Done node (terminal)
8. Define all channels per the Channel Definitions table — each channel is a simple pipe with `from`, `to`, optional `gateId`, and `isCyclic` flag
9. Define all gates per the Gate Definitions table — each gate is an independent entity with `condition` config (`check` or `count`), `channelId`, `allowedWriterRoles`, `resetOnCycle` flag, and `description`. Note: V2 uses only `check` and `count` conditions; `all`/`any` composites are available for future workflows.
10. Set `maxIterations: 5` on the workflow template
11. Mark cyclic channels with `isCyclic: true`

**Acceptance Criteria**:
- Workflow template has 8 nodes with correct agent assignments
- Channels are simple pipes — no condition logic in channels
- Gates are independent entities attached to channels via `gateId`
- Channel and gate topology matches the specification exactly
- `check` conditions used for PR URL, approval, and result gates
- `count` condition used for vote-counting gate (`review-votes-gate`)
- 3 reviewer nodes are marked as parallel
- Cyclic channels are marked correctly
- `maxIterations: 5` is set
- Unit test validates the full template structure

**Depends on**: Milestone 1 (separated channels + gates must exist)

**Agent type**: coder

---

### Task 3.2: Update Workflow Seeding

**Description**: Update `seedBuiltInWorkflows` to seed `CODING_WORKFLOW_V2` alongside existing workflows. Add QA to preset agents.

**Subtasks**:
1. Add QA to `PRESET_AGENTS` in `seed-agents.ts`:
   - Role: `'qa'`
   - Tools: `['Read', 'Bash', 'Grep', 'Glob']` (read-only + bash for running tests)
   - Description: "QA agent. Verifies test coverage, CI pipeline status, and PR mergeability."
2. Update `seedBuiltInWorkflows` to also seed `CODING_WORKFLOW_V2` (additive, not replacing)
3. V2 gets `tag: 'default'` so workflow selector ranks it first
4. Existing `CODING_WORKFLOW` (V1) kept for backward compatibility
5. Verify idempotent seeding (no duplicates on re-seed)

**Acceptance Criteria**:
- QA agent is seeded alongside Coder, General, Planner, Reviewer
- V2 workflow is seeded alongside V1
- V2 has `tag: 'default'`
- Seeding is idempotent
- Unit tests validate seeding

**Depends on**: Task 3.1

**Agent type**: coder

---

### Task 3.3: Implement Parallel Node Execution

**Description**: Update `TaskAgentManager` to support parallel node execution. When the Coding node completes and `code-pr-gate` opens, all 3 reviewer nodes should activate simultaneously.

**Subtasks**:
1. Update `TaskAgentManager.activateNode()` to handle multiple target nodes from a single gate transition
2. When `code-pr-gate` passes (condition `check: prUrl exists`) with 3 downstream channels, spawn all 3 reviewer sessions simultaneously
3. Each reviewer session operates in the same task worktree (read-only for reviewers)
4. Track parallel node completion: each reviewer writes its vote to the shared `review-votes-gate`
5. The gate's `count: votes.approve >= 3` condition evaluates after each write — only activates QA when threshold is met
6. Unit tests: parallel activation, incremental voting, quorum detection

**Acceptance Criteria**:
- 3 reviewer nodes activate simultaneously when `code-pr-gate` condition passes
- Each reviewer writes its vote independently to `review-votes-gate`
- QA activates only when `count` condition meets threshold (≥3 approve votes)
- Parallel sessions don't interfere with each other
- Unit tests cover parallel execution and voting

**Depends on**: Task 3.1, Milestone 1 (channel + gate evaluator)

**Agent type**: coder

---

### Task 3.4: Update Space Chat Agent for V2 Workflow

**Description**: Update the `suggest_workflow` logic to prefer `CODING_WORKFLOW_V2` as the default for coding tasks.

**Subtasks**:
1. Verify V2's `tag: 'default'` makes it the top suggestion for coding tasks
2. If no selector logic exists, implement it in the Space chat agent's MCP tools
3. Ensure backward compatibility with existing spaces

**Acceptance Criteria**:
- `suggest_workflow` returns V2 as top match for coding tasks
- Existing spaces unaffected
- Unit tests for workflow selection

**Depends on**: Task 3.2

**Agent type**: coder
