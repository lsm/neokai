# Milestone 6: Built-in Workflow Replacement

## Goal

Replace the 3 built-in workflow templates (Coding, Research, Review-Only) with agent-centric equivalents. Since the feature is unreleased, this is a clean replacement — no migration needed.

## Scope

- Rewrite built-in workflows to use gated channels
- Remove transition-based workflow definitions
- Update seed logic
- Backend tests

## Tasks

### Task 6.1: Replace Built-in Workflows with Agent-Centric Model

**Description**: Rewrite the 3 built-in workflow templates in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` to use gated channels instead of transitions.

**Subtasks**:
1. **Coding Workflow** (Plan -> Code -> Verify -> Done with cycle):
   - Remove transition-based definition
   - Replace with channels:
     - Plan -> Code: `human` gate channel (planner sends to coder after human approval)
     - Code -> Verify: `always` gate channel (coder sends to verifier)
     - Verify -> Plan: `task_result` gate channel (verifier sends to planner on 'failed')
     - Verify -> Done: `task_result` gate channel (verifier sends to general on 'passed')
2. **Research Workflow** (Planner -> General):
   - Remove transition-based definition
   - Replace with a `always` gate channel from planner to general
3. **Review-Only Workflow** (single Coder node):
   - No changes needed (single-node workflow has no channels between nodes)
4. Update `seedBuiltInWorkflows()` to persist channels on `SpaceWorkflow` instead of transitions on nodes

**Acceptance Criteria**:
- All 3 built-in workflows use channels (no transitions)
- Coding workflow's gate logic is preserved in channel gates
- New spaces get agent-centric workflows
- Seed logic persists channels correctly

**Dependencies**: Tasks 1.5, 5.2

**Agent Type**: coder

---

### Task 6.2: Backend Tests for Replaced Workflows

**Description**: Write backend unit tests verifying the new built-in workflows.

**Subtasks**:
1. Update `packages/daemon/tests/unit/space/built-in-workflows.test.ts`:
   - Verify Coding workflow has channels with correct gates
   - Verify Research workflow has channels
   - Verify no transitions remain in the workflow definitions
2. Verify seed logic persists channels correctly

**Acceptance Criteria**:
- All backend tests pass
- New workflows have correct channel definitions
- No references to transitions in built-in workflow tests

**Dependencies**: Task 6.1

**Agent Type**: coder

## Rollback Strategy

- Built-in workflows are defined in code, not persisted data. Reverting the code restores the old definitions.
- New spaces always get the current built-in workflows at seed time. Existing spaces keep their persisted data.
