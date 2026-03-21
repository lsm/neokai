# Milestone 5: Multi-Agent Export/Import and Visual Editor

## Goal

Update the workflow export/import format to support multi-agent steps with channel topology, and update the visual workflow editor to allow adding/removing agents from a step and drawing directed channel edges between agents.

## Scope

- Update `ExportedWorkflowStep` type for multi-agent + channels support
- Update export/import logic in `export-format.ts` (channels use `agentRef` role names, not IDs)
- Update visual workflow editor step node rendering with channel edge visualization
- Unit tests for export/import round-trip including channels

---

### Task 5.1: Update Export/Import Format for Multi-Agent Steps

**Description:** Extend `ExportedWorkflowStep` to support an `agents` array and `channels` topology alongside the existing `agentRef` field, and update export/import logic for backward compatibility.

**Subtasks:**
1. Add `agents?: Array<{ agentRef: string; instructions?: string }>` to `ExportedWorkflowStep` type in `packages/shared/src/types/space.ts`
2. Add `channels?: WorkflowChannel[]` to `ExportedWorkflowStep` — channels use role names (same `from`/`to` strings as the internal type) since roles are already portable string references, unlike agent IDs
3. Make `agentRef` optional on `ExportedWorkflowStep` (it becomes shorthand for single-agent)
4. In `packages/daemon/src/lib/space/export-format.ts`, update the export function:
   - If step has `agents` array, export each entry with `agentRef` resolved from agent name
   - If step has only `agentId`, export as single `agentRef` (backward compat)
   - If step has `channels`, export them as-is (they already use role strings, not IDs)
5. In the import function:
   - If exported step has `agents` array, resolve each `agentRef` to an `agentId` by name lookup
   - If exported step has only `agentRef`, resolve to single `agentId` (backward compat)
   - If exported step has `channels`, import them as-is (validate that `from`/`to` role strings match the resolved agents)
6. Handle missing agent references gracefully during import (warn and skip or error)

**Acceptance Criteria:**
- Export/import round-trip preserves multi-agent step configuration AND channel topology
- Old single-agent export format (no channels) imports correctly
- New multi-agent + channels export format is clean JSON
- Channel role references are validated against imported agents
- TypeScript compiles cleanly

**Dependencies:** Task 4.1 (needs `WorkflowStepAgent` type)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Update Visual Workflow Editor for Multi-Agent Steps

**Description:** Update the visual workflow editor to render and edit multi-agent steps with channel topology visualization. Each step node should show the list of agents and the directed communication channels between them.

**Subtasks:**
1. In the step node component, if a step has `agents` array, render multiple agent badges/chips instead of a single agent name
2. **Render channel edges between agent nodes within a step**: When a step has `channels`, draw directed edges (arrows) between agent badges to visualize the messaging topology:
   - `A → B` (one-way): single arrow from A to B
   - `A ↔ B` (bidirectional point-to-point): double-headed arrow or two arrows
   - `A → [B, C, D]` (fan-out one-way): arrows from A to B, C, D
   - `A ↔ [B, C, D]` (fan-out bidirectional / hub-spoke): arrows from A to B, C, D with reply arrows from each spoke back to A. Visually distinguish the hub-spoke pattern (e.g., hub node centered, spokes radiating out, or a distinct hub icon)
   - Show the optional `label` on the edge if present
3. In the step edit panel/modal, add an "Agents" section that:
   - Shows the current list of agents for the step
   - Allows adding an agent from the space's agent list (dropdown/select)
   - Allows setting per-agent instructions (text area)
   - Allows removing an agent from the step
4. In the step edit panel/modal, add a "Channels" section that:
   - Shows the current list of channels for the step
   - Allows adding a channel: select `from` agent role, `to` agent role(s), direction (`one-way`/`bidirectional`), optional label
   - Supports `*` wildcard for `from` or `to` (UI shows "All agents")
   - Supports multi-select for `to` (fan-out pattern)
   - Allows removing a channel
   - **Alternative: allow users to draw channels by clicking/dragging between agent badges** (visual connection mode)
5. When editing, switching between single-agent mode (just `agentId`) and multi-agent mode (the `agents` array) should be seamless -- UI auto-upgrades to multi-agent when a second agent is added
6. Validate that at least one agent is assigned to each step
7. Validate channel role references: `from`/`to` must reference roles present in the step's agents (or `*`)
8. Update the step creation flow in the editor to support multi-agent + channels from the start

**Acceptance Criteria:**
- Steps with multiple agents render clearly in the visual editor
- Channel topology is visualized as directed edges between agent badges
- Users can add/remove agents and channels from steps via the UI
- Per-agent instructions are editable
- Channel direction (one-way/bidirectional) and fan-out are visually distinguishable
- Single-agent steps (no channels) continue to display and edit correctly
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
4. Test backward compatibility: old format with single `agentRef` imports correctly (no channels)
5. Test round-trip: export then import produces equivalent workflow definition including channels
6. Test error handling: import with unknown `agentRef` name
7. Test per-agent instructions preservation through export/import
8. Test channel topology round-trip: `channels` with one-way, bidirectional, fan-out, and wildcard patterns are preserved through export/import
9. Test channel validation on import: channels referencing roles not present in imported agents produce errors

**Acceptance Criteria:**
- All tests pass
- Round-trip fidelity is verified for both single/multi-agent steps and channel topologies
- Error cases produce clear error messages

**Dependencies:** Task 5.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.4: E2E Test for Multi-Agent Step Editor

**Description:** Write a Playwright E2E test verifying the multi-agent step editing and channel topology interaction in the visual workflow editor.

**Subtasks:**
1. Create test file `packages/e2e/tests/features/space-multi-agent-editor.e2e.ts`
2. Set up a Space with multiple agents via the UI
3. Create a workflow and add a step with a single agent
4. Edit the step to add a second agent — verify both agents appear as badges/chips
5. **Add a channel between two agents**: configure an `A → B` one-way channel — verify the directed edge/arrow appears in the step visualization
6. **Add a bidirectional channel**: configure `A ↔ B` — verify the bidirectional edge appears
7. Remove one agent — verify only one remains and associated channels are removed
8. Save the workflow and re-open — verify multi-agent configuration AND channel topology persists
9. Follow all E2E test rules from CLAUDE.md

**Acceptance Criteria:**
- Test passes with `make run-e2e TEST=tests/features/space-multi-agent-editor.e2e.ts`
- Test creates and cleans up its own test data
- Verifies the full add/remove/persist lifecycle for both agents and channels through the UI
- Channel edges are visually verified (directed arrows between agent badges)

**Dependencies:** Task 5.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
