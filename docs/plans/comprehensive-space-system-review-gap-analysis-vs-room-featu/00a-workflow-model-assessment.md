# Task 0: Workflow Model Expressiveness Assessment

**Priority:** P0 (gates all subsequent implementation)
**Agent type:** general (design task)
**Depends on:** nothing

## Description

Before building execution infrastructure around the existing workflow definition model, this task evaluates whether the current 4 condition types are sufficient for the user vision: "Human should be able to define the workflow as they want with agents, connections, gates etc and the space / workflow runtime should use the defined workflow to work on tasks."

The assessment must determine whether common multi-agent workflow patterns can be expressed with the current model, identify gaps, and propose concrete additions. The output is a design document that M1 and subsequent milestones reference.

### Current Model Summary

The workflow model is a directed graph with:
- **Nodes** (`WorkflowNode`): steps with one or more agents (parallel execution within a node)
- **Edges** (`WorkflowTransition`): directed connections between nodes with optional conditions
- **Conditions** (`WorkflowCondition`): 4 types that guard whether a transition fires
  - `always` -- unconditionally follows the transition
  - `human` -- blocks until `run.config.humanApproved` is set to true
  - `condition` -- runs a shell expression; fires on exit code 0
  - `task_result` -- prefix-matches against the completed task's `result` field
- **Execution semantics**: `advance()` evaluates outgoing transitions in `order` and follows the first one whose condition passes. Multi-agent nodes wait for ALL agents to complete before advancing.
- **Cycle support**: `isCyclic` flag on transitions, `maxIterations` cap on the run.

### Patterns to Evaluate

| Pattern | Description | Can it be expressed? |
|---------|-------------|---------------------|
| Sequential chain | A -> B -> C -> Done | Yes: `always` conditions |
| Parallel fan-out | Node A has 3 agents that run concurrently | Yes: `agents[]` on a single node |
| Fan-out then fan-in | A spawns B and C in parallel, then D runs after both complete | No: current model only supports parallel execution WITHIN a single node. There is no way to spawn two separate nodes concurrently. The executor visits one node at a time. |
| Conditional branching | A -> B (if passed) or A -> C (if failed) | Yes: multiple transitions from A with `task_result` conditions, ordered by priority |
| Error routing | A -> B (on success), A -> Error Handler (on failure) | Partially: `task_result` condition can route on "failed" prefix, but only supports one "winning" task result for multi-agent nodes |
| AND gate | Wait for all parallel branches to complete | No: parallel execution only within a single node; cannot wait for multiple nodes |
| Quorum gate | Advance when N of M agents agree | No: no aggregate condition type |
| Time-based gate | Wait until 9am or until 60 seconds elapse | Partially: `condition` type runs shell commands, so `sleep 60` works but is blocking; no native timer support |
| Sub-workflow | Node A triggers a separate workflow, waits for its completion | No: single workflow per run |
| Dynamic agent creation | Create a new agent at runtime based on task output | No: agents must be pre-defined in the node |
| Retry with backoff | If agent fails, retry after delay | Partially: `maxRetries` on conditions covers retry count, but no backoff delay |

### Key Gaps Identified

1. **No inter-node parallelism** -- The executor processes one node at a time. A DAG with independent branches (A -> B, A -> C, B -> D, C -> D) is traversed linearly, not in parallel. This is the most significant gap.
2. **No composite conditions** -- Cannot express "advance only when condition X AND condition Y are both true." Each transition has exactly one condition.
3. **No quorum/aggregation conditions** -- Cannot express "advance when 2 of 3 reviewers approve."
4. **No sub-workflow support** -- Cannot compose workflows.
5. **Multi-agent `task_result` is non-deterministic** -- For nodes with `agents[]`, `resolveTaskResult()` picks the most recently completed task. The user cannot specify which agent's result drives the transition.

## Subtasks

1. **Read and document the complete condition evaluation logic** in `WorkflowExecutor.evaluateCondition()` and `advance()` (`packages/daemon/src/lib/space/runtime/workflow-executor.ts`). Document exactly how transitions are evaluated, how `order` affects priority, and how `task_result` resolves for multi-agent nodes.

2. **Map the 10 patterns above to the current model** with specific code references. For each pattern that IS expressible, provide an example workflow definition (nodes + transitions). For each that is NOT, explain exactly what is missing.

3. **Assess the visual editor's capability** to express each pattern. Read `VisualWorkflowEditor.tsx`, `EdgeConfigPanel.tsx`, `NodeConfigPanel.tsx`, and `serialization.ts` to determine:
   - Can the user create multiple transitions from the same node with different conditions? (Yes, via edge creation drag)
   - Can the user configure multi-agent nodes? (Yes, via NodeConfigPanel)
   - Are there any editor limitations that prevent expressing patterns the backend theoretically supports?

4. **Propose concrete additions to the condition type model** for gaps that are critical to the user vision. For each proposal:
   - New condition type name and parameters
   - How it integrates with the existing `evaluateCondition()` switch statement
   - How the EdgeConfigPanel UI would be extended
   - Impact on existing workflows (backward compatibility)

5. **Evaluate whether inter-node parallelism is needed for M1** or can be deferred. The current single-node-at-a-time model is sufficient for sequential chains, conditional branching, and cycles. Inter-node parallelism is a much larger architectural change (the executor would need to track multiple active nodes, the tick loop would need to handle partial completion, etc.). Recommend whether to defer this to a future milestone.

6. **Write the design document** at `docs/designs/workflow-condition-model-assessment.md` with:
   - Pattern expressiveness matrix (pattern vs. condition type, pass/fail)
   - Code-level analysis of each gap
   - Concrete proposals for new condition types (if any)
   - Recommendation on inter-node parallelism (defer or implement)
   - Recommendation on `task_result` non-determinism for multi-agent nodes (add `agentRole` filter?)
   - Impact on M1 scope (what changes if new condition types are needed)

### Files to read/analyze

- `packages/shared/src/types/space.ts` -- WorkflowCondition, WorkflowTransition, WorkflowNode types
- `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- evaluateCondition(), advance(), resolveTaskResult()
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- processRunTick(), how advance is triggered
- `packages/web/src/components/space/visual-editor/EdgeConfigPanel.tsx` -- condition type configuration UI
- `packages/web/src/components/space/visual-editor/NodeConfigPanel.tsx` -- multi-agent node configuration UI
- `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx` -- edge creation flow
- `packages/web/src/components/space/visual-editor/serialization.ts` -- serialization round-trip
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` -- existing template patterns

### Deliverable

A design document at `docs/designs/workflow-condition-model-assessment.md` (approximately 1500-2500 words) that:
- Answers definitively: "Are the current 4 condition types sufficient for the user vision?"
- Lists concrete gaps (with code references)
- Proposes additions with type signatures and UI mockup descriptions
- Provides a clear go/no-go for M1 implementation scope

### Acceptance Criteria

- [ ] All 10 patterns in the matrix are evaluated with code references
- [ ] Gaps are identified with specific missing capabilities
- [ ] Proposals for new condition types include type definitions
- [ ] Visual editor capability assessment is complete
- [ ] Inter-node parallelism recommendation is explicit (defer or implement)
- [ ] M1 scope impact is documented (what changes if new types are needed)
- [ ] Design document is written and reviewed
- [ ] Changes must be on a feature branch with a GitHub PR created via `gh pr create`
