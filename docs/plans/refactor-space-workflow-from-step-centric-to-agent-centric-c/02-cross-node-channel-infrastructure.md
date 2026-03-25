# Milestone 2: Cross-Node Channel Infrastructure

## Goal

Extend the channel system to support cross-node channels (channels that span between different workflow nodes, not just within a single node). This enables the agent-centric model where agents communicate across step boundaries through gated channels instead of relying on `advance()`.

## Scope

- Introduce `CrossNodeChannel` type for inter-node communication
- Add DB schema migration for cross-node channel storage
- Extend `SpaceWorkflow` to include cross-node channels
- Create `CrossNodeChannelResolver` that merges within-node and cross-node channels
- Update workflow serialization/deserialization for export/import

## Tasks

### Task 2.1: Define CrossNodeChannel Types

**Description**: Create new types for channels that span between workflow nodes, as opposed to the current within-node `WorkflowChannel`.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`, create `CrossNodeChannel` interface:
   ```
   interface CrossNodeChannel {
     id: string;                          // unique identifier
     fromNode: string;                    // source node ID
     fromRole: string | '*';              // source role in the from-node
     toNode: string;                      // target node ID
     toRole: string | string[] | '*';     // target role(s) in the to-node
     direction: 'one-way' | 'bidirectional';
     gate?: WorkflowCondition;            // policy enforcement
     label?: string;                      // human-readable label
   }
   ```
2. Create `CrossNodeChannelInput` type (omits `id`)
3. Add `crossNodeChannels?: CrossNodeChannel[]` to `SpaceWorkflow` interface
4. Add `crossNodeChannels?: CrossNodeChannelInput[]` to `CreateSpaceWorkflowParams` and `UpdateSpaceWorkflowParams`
5. Update `ExportedSpaceWorkflow` and import/export types to include cross-node channels
6. Create `ExportedCrossNodeChannel` type using node names instead of IDs

**Acceptance Criteria**:
- `CrossNodeChannel` type is fully defined with all fields
- `SpaceWorkflow` can carry cross-node channels alongside existing `transitions`
- Export/import format supports cross-node channels with portable node names
- TypeScript typecheck passes

**Dependencies**: Task 1.1 (for gate field on channels)

**Agent Type**: coder

---

### Task 2.2: Cross-Node Channel Resolution

**Description**: Create utility functions to resolve cross-node channels into concrete routing rules (analogous to `resolveNodeChannels` for within-node channels).

**Subtasks**:
1. In `packages/shared/src/types/space-utils.ts`, create `resolveCrossNodeChannels(workflow: SpaceWorkflow): ResolvedCrossNodeChannel[]`
2. Define `ResolvedCrossNodeChannel` interface:
   ```
   interface ResolvedCrossNodeChannel {
     channelId: string;
     fromNode: string;
     fromRole: string;
     fromAgentId: string;
     toNode: string;
     toRole: string;
     toAgentId: string;
     direction: 'one-way';
     gate?: WorkflowCondition;
     gateLabel?: string;
     label?: string;
     isHubSpoke: boolean;
   }
   ```
3. Resolution algorithm:
   - For each `CrossNodeChannel`, look up the source and target nodes
   - Resolve `fromRole` / `toRole` against the agents in those nodes (via `resolveNodeAgents`)
   - Expand wildcards and bidirectional/hub-spoke patterns (same logic as `expandChannel`)
   - Skip self-loops and unresolvable roles
4. Create `validateCrossNodeChannels(workflow: SpaceWorkflow, agents: SpaceAgent[]): string[]` for validation
5. Create `resolveAllChannels(workflow: SpaceWorkflow): { nodeChannels: Map<string, ResolvedChannel[]>, crossNodeChannels: ResolvedCrossNodeChannel[] }` that resolves both types

**Acceptance Criteria**:
- Cross-node channels resolve to concrete per-agent-pair routing rules
- Wildcards (`*`) expand to all agents in the respective node
- Bidirectional channels expand to two one-way entries
- Hub-spoke patterns work across nodes
- Validation catches invalid role references and ambiguous configurations
- `resolveAllChannels()` provides a unified resolution API

**Dependencies**: Tasks 1.2, 2.1

**Agent Type**: coder

---

### Task 2.3: DB Schema and Repository for Cross-Node Channels

**Description**: Add database storage for cross-node channels on the `SpaceWorkflow` table and update the workflow repository.

**Subtasks**:
1. Add a migration (**use the next available migration number at implementation time**; currently 51) to add a `cross_node_channels TEXT` column to `space_workflows` table (JSON-serialized array of `CrossNodeChannel`). The plan intentionally does not hardcode the migration number since it drifts over time.
2. Update `packages/daemon/src/storage/repositories/space-workflow-repository.ts` to:
   - Serialize `crossNodeChannels` to JSON when persisting
   - Deserialize from JSON when loading
3. Write a unit test for the migration in `packages/daemon/tests/unit/storage/` (following existing patterns like `migration-spaces-autonomy-level_test.ts`)
4. Update the workflow repository tests to cover cross-node channel CRUD

**Acceptance Criteria**:
- Migration adds column without breaking existing data
- Cross-node channels persist and load correctly via the repository
- Migration test passes
- Existing workflow CRUD operations are not affected

**Dependencies**: Task 2.1

**Agent Type**: coder

---

### Task 2.4: Update Export/Import for Cross-Node Channels

**Description**: Update the export/import format to include cross-node channels, with proper node-name-based references.

**Subtasks**:
1. Update `packages/daemon/src/lib/space/export-format.ts` to handle `ExportedCrossNodeChannel`:
   - Export: convert node IDs to names, agent IDs to agent names
   - Import: convert names back to IDs, validate references
2. Add cross-node channels to the export bundle schema validation
3. Write unit tests for export/import with cross-node channels

**Acceptance Criteria**:
- Exported workflow bundles include cross-node channels
- Imported bundles correctly resolve node/agent name references
- Import validation catches missing node or agent references
- Unit tests pass

**Dependencies**: Tasks 2.1, 2.3

**Agent Type**: coder

---

### Task 2.5: Integration Tests for Cross-Node Channels

**Description**: Write integration tests that exercise cross-node channel resolution end-to-end.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/cross-node-channel-resolution.test.ts`
2. Test cases:
   - Simple cross-node channel resolution (coder in node A -> reviewer in node B)
   - Wildcard expansion across nodes
   - Bidirectional cross-node channels
   - Hub-spoke across nodes (coordinator -> multiple workers)
   - Mixed within-node and cross-node channels resolve correctly together
   - Validation catches invalid cross-node channel references
3. Use existing test helpers from `packages/daemon/tests/unit/helpers/space-test-db.ts`

**Acceptance Criteria**:
- All integration tests pass
- Cross-node channels integrate cleanly with existing within-node channel system
- No regressions in existing within-node channel tests

**Dependencies**: Tasks 2.2, 2.3

**Agent Type**: coder

---

### Task 2.6: Dual-Model Conflict Resolution Rules

**Description**: Define and implement the conflict resolution strategy for workflows that have both `WorkflowTransition` edges AND `CrossNodeChannel` definitions (dual-model coexistence). This addresses what happens when both models exist simultaneously or when they race against each other.

**Conflict resolution rules:**

1. **Cross-node channels take precedence over transitions**: When a workflow run has any `crossNodeChannels` defined, the agent-centric model is the primary advancement mechanism. Transitions are kept for data compatibility but are not evaluated by the executor for advancement.

2. **`advance()` becomes a no-op for agent-centric runs**: When `WorkflowExecutor.advance()` is called on a workflow run that has `crossNodeChannels` configured, it returns `{ advanced: false, reason: 'Workflow uses agent-centric model (cross-node channels configured)' }` without creating tasks or changing `currentNodeId`. This prevents races between `advance()` and agent-driven messaging.

3. **Mid-run migration is supported**: If a user adds cross-node channels to a running workflow that previously used only transitions:
   - The next `processRunTick()` detects the change (queries `crossNodeChannels` at tick time, not cached at run start)
   - `advance()` is immediately disabled for that run
   - Any nodes that were activated via `advance()` retain their existing tasks/sessions
   - Future advancement is agent-driven only

4. **Task Agent guidance**: The Task Agent system prompt (updated in Milestone 6) will include explicit instructions: "If this workflow has cross-node channels, do NOT call `advance_workflow`. Use `send_message` with cross-node targets instead."

5. **No race condition between models**: Since `advance()` is disabled when cross-node channels exist, there is no race. The check is done at the start of `advance()` (synchronous query) and `processRunTick()` (same query). Both paths are protected.

**Subtasks**:
1. Create a helper function `hasCrossNodeChannels(workflow: SpaceWorkflow): boolean` in `space-utils.ts`
2. In `WorkflowExecutor.advance()`, add the guard at the top:
   ```ts
   if (hasCrossNodeChannels(workflow)) {
     return { advanced: false, reason: 'Workflow uses agent-centric model' };
   }
   ```
3. In `SpaceRuntime.processRunTick()`, use `hasCrossNodeChannels()` to choose between completion models (this feeds into Milestone 5)
4. Add unit tests for the conflict resolution:
   - Workflow with both transitions and cross-node channels: `advance()` returns no-op
   - Workflow with only transitions: `advance()` works as before
   - Workflow with only cross-node channels: `advance()` returns no-op
   - Mid-run channel addition: next tick detects and switches model

**Acceptance Criteria**:
- `advance()` is a no-op when cross-node channels exist
- No race condition between `advance()` and agent-driven messaging
- Mid-run model switching is handled gracefully
- Unit tests cover all conflict scenarios
- Existing transition-only workflows are unaffected

**Dependencies**: Task 2.1

**Agent Type**: coder

## Rollback Strategy

- **DB migration** (Task 2.3): Adds a nullable `cross_node_channels TEXT` column to `space_workflows`. This is fully reversible — the column can be dropped without data loss (it's only populated for workflows that use cross-node channels, and existing workflows have `NULL`).
- **Type changes** (Task 2.1): The `crossNodeChannels` field is optional on `SpaceWorkflow`. Removing it is a non-breaking type change.
- **Export/import** (Task 2.4): Export/import changes are additive. Older exports without cross-node channels import correctly (field is optional).
- **Conflict resolution** (Task 2.6): The `advance()` guard checks for `crossNodeChannels` presence. If reverted, `advance()` works normally for all workflows.
