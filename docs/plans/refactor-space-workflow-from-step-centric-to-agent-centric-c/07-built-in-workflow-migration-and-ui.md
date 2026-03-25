# Milestone 7: Built-in Workflow Migration

## Goal

Migrate the 3 built-in workflow templates (Coding, Research, Review-Only) to the agent-centric model. This milestone focuses on backend workflow definition changes and can run in parallel with Milestone 8 (UI updates).

## Scope

- Rewrite built-in workflows to use cross-node gated channels instead of transitions
- Update seed logic to persist cross-node channels
- Backend tests for migrated workflows

## Tasks

### Task 7.1: Migrate Built-in Workflows to Agent-Centric Model

**Description**: Rewrite the 3 built-in workflow templates in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` to use cross-node gated channels.

**Subtasks**:
1. **Coding Workflow** (Plan -> Code -> Verify -> Done with cycle):
   - Replace transitions with cross-node channels:
     - Plan -> Code: `human` gate channel (planner sends to coder after human approval)
     - Code -> Verify: `always` gate channel (coder sends to verifier)
     - Verify -> Plan: `task_result` gate channel (verifier sends to planner on 'failed')
     - Verify -> Done: `task_result` gate channel (verifier sends to general on 'passed')
   - Keep existing transitions for backward compatibility (dual model — see Task 2.6 conflict resolution)
   - Add cross-node channels to the workflow definition
2. **Research Workflow** (Planner -> General):
   - Add a cross-node `always` gate channel from planner to general
3. **Review-Only Workflow** (single Coder node):
   - No changes needed (single-node workflow has no transitions/channels between nodes)
4. Update `seedBuiltInWorkflows()` to persist cross-node channels

**Acceptance Criteria**:
- All 3 built-in workflows include cross-node channels alongside existing transitions
- Coding workflow's gate logic is preserved in channel gates
- New spaces get workflows with both models (backward compatible)
- Existing spaces are not affected (they keep their current workflow data)

**Dependencies**: Tasks 2.3, 6.2

**Agent Type**: coder

---

### Task 7.2: Backend Tests for Migrated Workflows

**Description**: Write backend unit tests verifying the migrated built-in workflows have correct cross-node channels and that the dual-model conflict resolution works.

**Subtasks**:
1. Update `packages/daemon/tests/unit/space/built-in-workflows.test.ts`:
   - Verify Coding workflow has cross-node channels with correct gates
   - Verify Research workflow has cross-node channels
   - Verify transitions still exist (dual model)
2. Verify conflict resolution rules from Task 2.6:
   - Built-in workflows with cross-node channels: `advance()` returns no-op
   - Agent-driven advancement works via cross-node channels
3. Verify seed logic persists cross-node channels correctly

**Acceptance Criteria**:
- All backend tests pass
- Migrated workflows have correct cross-node channel definitions
- Dual-model conflict resolution is verified for built-in workflows
- No regressions in existing built-in workflow tests

**Dependencies**: Tasks 7.1, 2.6

**Agent Type**: coder

## Rollback Strategy

- Built-in workflow migration only affects new spaces (existing spaces keep their persisted workflow data)
- If issues arise, the `seedBuiltInWorkflows()` function can be reverted to remove cross-node channels from new spaces
- The dual-model conflict resolution (Task 2.6) ensures that reverting cross-node channels falls back to the transition-based model automatically
- No DB schema changes in this milestone (cross-node channels column was added in Task 2.3)
