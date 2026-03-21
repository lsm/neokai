# Milestone 5: Multi-Agent Export/Import and Visual Editor

## Goal

Update the workflow export/import format to support multi-agent steps and update the visual workflow editor to allow adding/removing agents from a step.

## Scope

- Update `ExportedWorkflowStep` type for multi-agent support
- Update export/import logic in `export-format.ts`
- Update visual workflow editor step node rendering
- Unit tests for export/import round-trip

---

### Task 5.1: Update Export/Import Format for Multi-Agent Steps

**Description:** Extend `ExportedWorkflowStep` to support an `agents` array alongside the existing `agentRef` field, and update export/import logic for backward compatibility.

**Subtasks:**
1. Add `agents?: Array<{ agentRef: string; count?: number; instructions?: string }>` to `ExportedWorkflowStep` type in `packages/shared/src/types/space.ts`
2. Make `agentRef` optional on `ExportedWorkflowStep` (it becomes shorthand for single-agent)
3. In `packages/daemon/src/lib/space/export-format.ts`, update the export function:
   - If step has `agents` array, export each entry with `agentRef` resolved from agent name
   - If step has only `agentId`, export as single `agentRef` (backward compat)
4. In the import function:
   - If exported step has `agents` array, resolve each `agentRef` to an `agentId` by name lookup
   - If exported step has only `agentRef`, resolve to single `agentId` (backward compat)
5. Handle missing agent references gracefully during import (warn and skip or error)

**Acceptance Criteria:**
- Export/import round-trip preserves multi-agent step configuration
- Old single-agent export format imports correctly
- New multi-agent export format is clean JSON
- TypeScript compiles cleanly

**Dependencies:** Task 4.1 (needs `WorkflowStepAgent` type)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Update Visual Workflow Editor for Multi-Agent Steps

**Description:** Update the visual workflow editor to render and edit multi-agent steps. Each step node should show the list of agents and allow adding/removing agents.

**Subtasks:**
1. In the step node component, if a step has `agents` array, render multiple agent badges/chips instead of a single agent name
2. In the step edit panel/modal, add an "Agents" section that:
   - Shows the current list of agents for the step
   - Allows adding an agent from the space's agent list (dropdown/select)
   - Allows setting `count` per agent (number input, default 1)
   - Allows setting per-agent instructions (text area)
   - Allows removing an agent from the step
3. When editing, switching between single-agent mode (just `agentId`) and multi-agent mode (the `agents` array) should be seamless -- UI auto-upgrades to multi-agent when a second agent is added
4. Validate that at least one agent is assigned to each step
5. Update the step creation flow in the editor to support multi-agent from the start

**Acceptance Criteria:**
- Steps with multiple agents render clearly in the visual editor
- Users can add/remove agents from steps via the UI
- Count and per-agent instructions are editable
- Single-agent steps continue to display and edit correctly
- No visual regressions in the workflow editor

**Dependencies:** Task 4.1 (needs types), Task 5.1 (should align with export format)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.3: Export/Import Round-Trip Tests

**Description:** Write unit tests verifying that multi-agent workflow export and import produce correct results, including backward compatibility.

**Subtasks:**
1. Extend existing export/import tests (or create new file) in `packages/daemon/tests/unit/`
2. Test export of workflow with multi-agent step: agents array is correctly serialized with `agentRef` names
3. Test import of multi-agent step: `agentRef` names resolve to correct `agentId` UUIDs
4. Test backward compatibility: old format with single `agentRef` imports correctly
5. Test round-trip: export then import produces equivalent workflow definition
6. Test error handling: import with unknown `agentRef` name
7. Test `count` preservation through export/import

**Acceptance Criteria:**
- All tests pass
- Round-trip fidelity is verified for both single and multi-agent steps
- Error cases produce clear error messages

**Dependencies:** Task 5.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
