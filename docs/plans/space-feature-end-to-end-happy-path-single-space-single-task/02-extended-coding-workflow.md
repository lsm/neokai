# Milestone 2: Extended Coding Workflow (Phase 1)

## Goal and Scope

Create a new `CODING_WORKFLOW_V2` template that replaces the simple Plan → Code → Verify → Done pipeline with Plan → Code → Review → Done. This introduces a single-pass Reviewer step with a feedback loop back to the Coder. The old Verify node is removed entirely — QA will be added as a separate node in Milestone 4.

## Target Workflow Graph (M2 — 4 nodes)

```
Plan ---[human gate]--> Code ---[always gate]--> Review ---[task_result gate: passed]--> Done
                                              ^
                                              | [task_result: failed]
                                              +--- (reviewer sends feedback to coder)
```

**Happy path**: Plan → (human approves) → Code → Review → Done
**Failure path**: Code → Review (rejected) → Code → Review → ... → Done

**Key design decisions**:
- **No Verify node in V2**. Verify is removed entirely. Milestone 4 will add QA as a dedicated verification node between Review and Done.
- **All cyclic channels route to Code, never to Plan**. When the Reviewer rejects code, feedback goes to the Coder directly. The Coder fixes the code without needing to re-plan. This avoids requiring human approval on every iteration.
- **Single reviewer (not parallel)** for this milestone — proves the gate mechanism.
- Reviewer sends feedback to Coder via `send_message` when issues found.
- Reviewer signals `passed` or `failed` via `report_done` with appropriate result.

### Channel Definitions

| Channel | Type | Gate | Cyclic |
|---------|------|------|--------|
| Plan → Code | forward | `human` | no |
| Code → Review | forward | `always` | no |
| Review → Done | forward | `task_result` expression: `passed` | no |
| Review → Code | backward | `task_result` expression: `failed` | yes |

### Iteration Cap Behavior

- `maxIterations` is set to `3` on the workflow run (configurable per-space in the future).
- The iteration counter is **global** (per workflow run), incremented each time ANY cyclic channel is traversed.
- When `maxIterations` is reached:
  1. The workflow run transitions to `needs_attention` status with error metadata `{ reason: 'maxIterationsReached' }`.
  2. A `workflow_run_failed` notification is emitted to the human.
  3. The human can then: (a) increase `maxIterations` and resume, (b) manually intervene and restart, or (c) cancel the run.
  > **Note**: The current `WorkflowRunStatus` type (`packages/shared/src/types/space.ts:304`) does not include `'failed'`. The type expansion to add `'waiting_for_approval'` and `'failed'` (or use `'needs_attention'` with error metadata) is deferred to M5 Task 5.1, where the human gate first needs `waiting_for_approval`. For M2, the iteration cap uses the existing `'needs_attention'` status with structured error metadata.
- The iteration count is persisted in the `SpaceWorkflowRun` record so it survives restarts.

## Tasks

### Task 2.1: Define CODING_WORKFLOW_V2 Template

**Description**: Create a new `CODING_WORKFLOW_V2` template in `built-in-workflows.ts` with 4 nodes (Plan, Code, Review, Done) and the channel topology described above.

**Subtasks**:
1. Add node ID constants: `tpl-coding-planner`, `tpl-coding-coder`, `tpl-coding-reviewer`, `tpl-coding-done`
2. Define the reviewer node with `agentId: 'reviewer'` and instructions matching the enhanced reviewer prompt from M1 Task 1.3
3. Define channels per the table above — note: NO Verify node, NO Verify→Plan channel
4. Set `maxIterations: 3` on the workflow template (default, overridable per run)
5. Update `seedBuiltInWorkflows` to also seed `CODING_WORKFLOW_V2` alongside existing workflows (additive, not replacing). V2 gets `tag: 'default'`.
6. Add unit test in `built-in-workflows.test.ts` validating:
   - 4 nodes with correct agent assignments
   - Channel topology matches the specification
   - No Verify node or Verify→Plan channel exists
   - Cyclic channel has `isCyclic: true`
   - `maxIterations` is set correctly
   - Seeding is idempotent (no duplicates on re-seed)

**Acceptance Criteria**:
- New workflow template has 4 nodes: Plan, Code, Review, Done
- No Verify node exists in V2
- Channel topology: Plan→Code (human), Code→Review (always), Review→Done (passed), Review→Code (failed, cyclic)
- Cyclic channels have `isCyclic: true` for iteration tracking
- `maxIterations: 3` is set as default
- Unit test validates the full template structure
- Workflow seeds successfully at space creation time alongside V1

**Depends on**: nothing

**Agent type**: coder

---

### Task 2.2: Wire Reviewer-to-Coder Feedback Loop

**Description**: Ensure the `send_message` flow from Reviewer to Coder works correctly through the channel router. When the Reviewer finds issues, it uses `send_message` to route feedback back to the Coder, and the Coder receives the message and can address it.

**Subtasks**:
1. Verify that the existing `ChannelRouter.deliverMessage()` handles the Review→Code cross-node DM correctly
2. Ensure the Coder's `node-agent-tools` properly registers `send_message` and routes it through the channel resolver
3. Test that the Review→Code channel's `task_result: failed` gate prevents re-delivery of passed results
4. Verify the iteration counter is incremented when the cyclic Review→Code channel is traversed
5. Add unit test exercising the feedback loop: coder completes → reviewer rejects → coder receives feedback → coder completes again → reviewer approves → done

**Acceptance Criteria**:
- Reviewer can send feedback to Coder via `send_message` MCP tool
- Coder receives the message in its sub-session
- The cyclic channel correctly increments the global iteration counter
- Unit test covers the full feedback loop including iteration counting

**Depends on**: Task 2.1

**Agent type**: coder

---

### Task 2.3: Update Space Chat Agent to Use V2 Workflow

**Description**: Update the `suggest_workflow` logic and the space chat agent's guidance to prefer `CODING_WORKFLOW_V2` as the default for coding tasks.

**Subtasks**:
1. Verify that `CODING_WORKFLOW_V2` has `tag: 'default'` and that `workflow-selector.ts` (or equivalent logic in `space-chat-agent.ts`) ranks it first for coding-type requests
2. If no `workflow-selector.ts` exists, implement the selection logic in the Space chat agent's MCP tools (`suggest_workflow` handler) — reference existing code in `packages/daemon/src/lib/space/agents/space-chat-agent.ts`
3. Ensure backward compatibility: existing spaces keep their old workflows (idempotent seeding)

**Acceptance Criteria**:
- `suggest_workflow` returns `CODING_WORKFLOW_V2` as top match for coding tasks
- Existing spaces are not affected (idempotent seeding)
- Unit tests for workflow selection cover the new template

**Depends on**: Task 2.1

**Agent type**: coder
