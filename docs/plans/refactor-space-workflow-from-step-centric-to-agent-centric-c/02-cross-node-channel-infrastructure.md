# Milestone 2: Cross-Node Channel Infrastructure

## Goal

Extend the channel system to support cross-node channels (channels that span between different workflow nodes, not just within a single node). This enables the agent-centric model where agents communicate across step boundaries through gated channels.

## Scope

- Introduce `CrossNodeChannel` type for inter-node communication
- Add DB schema migration for cross-node channel storage
- Extend `SpaceWorkflow` to include cross-node channels
- Create `CrossNodeChannelResolver` that merges within-node and cross-node channels
- Update workflow serialization/deserialization for export/import

## Tasks

### Task 2.1: Define CrossNodeChannel Types

**Description**: Create new types for channels that span between workflow nodes. These channels define the **policy layer** — which agents can communicate across nodes and under what conditions. The agent-facing **addressing layer** (the `target` parameter in `send_message`) is implemented in Milestone 4 and matched against these policies at delivery time.

Think of `CrossNodeChannel` as channel configuration (like Slack channel settings: who can post, restrictions), while `target` in `send_message` is addressing (who the agent wants to talk to). The router matches them at delivery time.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`, create `CrossNodeChannel` interface:
   ```
   interface CrossNodeChannel {
     id: string;                          // unique identifier
     fromNode: string;                    // source node ID
     fromRole: string | '*';              // source role in the from-node
     toNode: string;                      // target node ID
     toRole: string | string[] | '*';     // target role(s) in the to-node
     toAgent?: number;                    // target specific agent by 1-based index (for DM addressing)
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
- `SpaceWorkflow` can carry cross-node channels
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

## Rollback Strategy

- **DB migration** (Task 2.3): Adds a nullable `cross_node_channels TEXT` column to `space_workflows`. The column can be dropped without data loss.
- **Type changes** (Task 2.1): The `crossNodeChannels` field is optional on `SpaceWorkflow`. Removing it is a non-breaking type change.
- **Export/import** (Task 2.4): Changes are additive. Older exports without cross-node channels import correctly (field is optional).
