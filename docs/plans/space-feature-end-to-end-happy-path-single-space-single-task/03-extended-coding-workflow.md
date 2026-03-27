# Milestone 3: Extended Coding Workflow (V2)

## Goal and Scope

Create `CODING_WORKFLOW_V2` with the full pipeline: Planning → [PR Gate] → Plan Review → [Human Gate] → Coding → [PR Gate] → 3 Reviewers (parallel) → [Aggregate Gate: 3 yes votes] → QA → Done. This uses the Gate + Channel architecture from Milestone 1.

## Target Pipeline

```
Planning ──[PR Gate]──► Plan Review ──[Human Gate]──► Coding ──[PR Gate]──► Reviewer 1 ─┐
                                                        ▲                    Reviewer 2 ─┼─[Aggregate: 3 yes]──► QA ──[pass]──► Done
                                                        │                    Reviewer 3 ─┘                        │
                                                        │                                                         │
                                                        └── [reject, cyclic] ─────────────────────────────────────┘
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

| Channel | Gate Type | Gate Config | Cyclic | Description |
|---------|-----------|-------------|--------|-------------|
| Planning → Plan Review | PR Gate | - | no | Planner writes `{ prUrl }` to gate |
| Plan Review → Coding | Human Gate | - | no | Human approves plan in artifacts view |
| Coding → Reviewer 1 | PR Gate | - | no | Coder writes `{ prUrl }` to gate |
| Coding → Reviewer 2 | PR Gate | - | no | Same gate as above (shared) |
| Coding → Reviewer 3 | PR Gate | - | no | Same gate as above (shared) |
| Reviewer 1 → QA | Aggregate | `{ quorum: 3 }` | no | All 3 must approve |
| Reviewer 2 → QA | Aggregate | `{ quorum: 3 }` | no | Same aggregate gate (shared) |
| Reviewer 3 → QA | Aggregate | `{ quorum: 3 }` | no | Same aggregate gate (shared) |
| QA → Done | Task Result | `{ expression: 'passed' }` | no | QA passes |
| QA → Coding | Task Result | `{ expression: 'failed' }` | yes | QA fails, feedback to coder |
| Reviewer → Coding | Aggregate | on reject | yes | Any reviewer rejects, feedback to coder |

### Iteration Cap

- `maxIterations: 5` (higher than before because the pipeline is longer)
- Global counter per workflow run, incremented on each cyclic channel traversal
- When exhausted: workflow transitions to `failed` with `failureReason: 'maxIterationsReached'`

## Tasks

### Task 3.1: Define CODING_WORKFLOW_V2 Template

**Description**: Create the new workflow template in `built-in-workflows.ts` with all nodes, channels, and gate configurations.

**Subtasks**:
1. Define node ID constants for all 8 nodes (Planning, Plan Review, Coding, Reviewer 1/2/3, QA, Done)
2. Define the Planning node with `agentId: 'planner'`
3. Define the Plan Review node with `agentId: 'reviewer'`
4. Define the Coding node with `agentId: 'coder'`
5. Define 3 Reviewer nodes with `agentId: 'reviewer'`, marked as parallel
6. Define the QA node with `agentId: 'qa'`
7. Define the Done node (terminal)
8. Define all channels per the table above with correct gate types and configs
9. Set `maxIterations: 5` on the workflow template
10. Mark cyclic channels with `isCyclic: true`

**Acceptance Criteria**:
- Workflow template has 8 nodes with correct agent assignments
- Channel topology matches the specification exactly
- PR Gates, Human Gate, Aggregate Gate, Task Result Gates are all correctly configured
- 3 reviewer nodes are marked as parallel
- Aggregate gate requires quorum of 3
- Cyclic channels are marked correctly
- `maxIterations: 5` is set
- Unit test validates the full template structure

**Depends on**: Milestone 1 (new gate types must exist)

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

**Description**: Update `TaskAgentManager` to support parallel node execution. When the Coding node completes and the PR Gate opens, all 3 reviewer nodes should activate simultaneously.

**Subtasks**:
1. Update `TaskAgentManager.activateNode()` to handle multiple target nodes from a single gate transition
2. When a PR Gate opens with 3 downstream channels (Coding → Reviewer 1/2/3), spawn all 3 reviewer sessions
3. Each reviewer session operates in the same task worktree (read-only for reviewers)
4. Track parallel node completion: each reviewer's `report_done` writes to the shared Aggregate Gate
5. The Aggregate Gate evaluates after each write — only activates QA when quorum is met
6. Unit tests: parallel activation, incremental voting, quorum detection

**Acceptance Criteria**:
- 3 reviewer nodes activate simultaneously when Code PR Gate opens
- Each reviewer writes its vote independently to the Aggregate Gate
- QA activates only when all 3 reviewers approve (quorum = 3)
- Parallel sessions don't interfere with each other
- Unit tests cover parallel execution and voting

**Depends on**: Task 3.1, Milestone 1 (Aggregate Gate evaluator)

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
