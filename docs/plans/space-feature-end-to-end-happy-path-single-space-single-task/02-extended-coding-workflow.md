# Milestone 2: Extended Coding Workflow

## Goal and Scope

Extend the default `CODING_WORKFLOW` from a simple 4-node graph to a 5-node graph that includes a single-pass Reviewer step between Coder and Verify. This proves the gate mechanism and agent-to-agent messaging work for the review handoff. The Reviewer uses the enhanced prompt from Milestone 1.

## Target Workflow Graph

```
Plan --[human gate]--> Code --[always gate]--> Review --[task_result gate: passed]--> Verify --[task_result gate: passed]--> Done
                                  ^                      |
                                  |                      |  [task_result: failed]
                                  +---[task_result: failed]---+
                                        (reviewer sends feedback to coder)
```

**Key design decisions**:
- Single reviewer (not parallel) for this milestone -- proves the gate mechanism
- Reviewer sends feedback to Coder via `send_message` when issues found
- Reviewer signals `passed` or `failed` via `report_done` with appropriate result
- Verify step remains the final quality gate before Done
- Coder -> Review channel uses `always` gate (automatic handoff)
- Review -> Coder channel uses `task_result` gate with expression `failed` (cyclic)
- Review -> Verify channel uses `task_result` gate with expression `passed`

## Tasks

### Task 2.1: Define Extended Coding Workflow Template

**Description**: Create a new `CODING_WORKFLOW_V2` template in `built-in-workflows.ts` with 5 nodes and the channel topology described above.

**Subtasks**:
1. Add node ID constants for the 5 nodes: `tpl-coding-planner`, `tpl-coding-coder`, `tpl-coding-reviewer`, `tpl-coding-verify`, `tpl-coding-done`
2. Define the reviewer node with `agentId: 'reviewer'` and appropriate instructions
3. Define channels: Plan->Code (human gate), Code->Review (always), Review->Code (task_result: failed, cyclic), Review->Verify (task_result: passed), Verify->Plan (task_result: failed, cyclic), Verify->Done (task_result: passed)
4. Set `maxIterations` appropriately to cap the Coder->Review->Coder loop
5. Update `seedBuiltInWorkflows` to also seed `CODING_WORKFLOW_V2` alongside the existing workflows (additive, not replacing)

**Acceptance Criteria**:
- New workflow template has 5 nodes with proper agent assignments
- Channel topology correctly routes messages between nodes
- Cyclic channels have `isCyclic: true` for iteration tracking
- Unit test in `built-in-workflows.test.ts` validates the new template structure
- Workflow seeds successfully at space creation time

**Depends on**: nothing

**Agent type**: coder

---

### Task 2.2: Wire Reviewer-to-Coder Feedback Loop

**Description**: Ensure the `send_message` flow from Reviewer to Coder works correctly through the channel router. When the Reviewer finds issues, it uses `send_message` to route feedback back to the Coder, and the Coder receives the message and can address it.

**Subtasks**:
1. Verify that the existing `ChannelRouter.deliverMessage()` handles the Review->Code cross-node DM correctly
2. Ensure the Coder's `node-agent-tools` properly registers `send_message` and routes it through the channel resolver
3. Test that the Review->Code channel's `task_result: failed` gate prevents re-delivery of passed results
4. Add unit test exercising the feedback loop: coder completes -> reviewer rejects -> coder receives feedback -> coder completes again

**Acceptance Criteria**:
- Reviewer can send feedback to Coder via `send_message` MCP tool
- Coder receives the message in its sub-session
- The cyclic channel correctly increments the iteration counter
- Unit test covers the full feedback loop

**Depends on**: Task 2.1

**Agent type**: coder

---

### Task 2.3: Update Space Chat Agent to Use V2 Workflow

**Description**: Update the `suggest_workflow` logic and the space chat agent's guidance to prefer `CODING_WORKFLOW_V2` as the default for coding tasks.

**Subtasks**:
1. Add a tag `'default'` to `CODING_WORKFLOW_V2` and ensure `workflow-selector.ts` ranks it first for coding-type requests
2. Update `suggest_workflow` RPC handler to consider the new workflow
3. Ensure backward compatibility: existing spaces keep their old workflows

**Acceptance Criteria**:
- `suggest_workflow` returns `CODING_WORKFLOW_V2` as top match for coding tasks
- Existing spaces are not affected (idempotent seeding)
- Unit tests for workflow selector cover the new template

**Depends on**: Task 2.1

**Agent type**: coder
