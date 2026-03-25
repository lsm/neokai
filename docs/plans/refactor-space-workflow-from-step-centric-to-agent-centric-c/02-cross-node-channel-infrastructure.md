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
     fromNode: string;                    // source node name
     toNode?: string;                     // target node name (fan-out to all agents in that node)
     toAgent?: string;                    // target agent name (DM to specific agent — used instead of toNode)
     direction: 'one-way' | 'bidirectional';
     gate?: WorkflowCondition;            // policy enforcement
     isCyclic?: boolean;                  // when true, each delivery through this channel increments the run's iteration counter
     label?: string;                      // human-readable label
   }
   ```
   Note: either `toNode` or `toAgent` is provided, not both. `toNode` fans out to all agents in the target node. `toAgent` delivers to a specific agent by name.
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
     toNode: string;
     toAgentName?: string;          // set when CrossNodeChannel.toAgent is provided (DM)
     direction: 'one-way';
     gate?: WorkflowCondition;
     gateLabel?: string;
     label?: string;
     isFanOut: boolean;             // true when toNode is set (fan-out to all agents), false for DM
   }
   ```
3. Resolution algorithm:
   - For each `CrossNodeChannel`, look up the source and target nodes by name
   - If `toAgent` is provided: resolve to a specific agent by name within `toNode`, set `isFanOut: false`
   - If `toNode` is provided (no `toAgent`): set `isFanOut: true` (all agents in target node receive)
   - Expand bidirectional channels to two one-way entries
   - Skip self-loops (fromNode === toNode) and unresolvable node/agent references
4. Create `validateCrossNodeChannels(workflow: SpaceWorkflow): string[]` for validation:
   - Verify `fromNode` references a valid node in the workflow
   - Verify `toNode` (if provided) references a valid node
   - Verify `toAgent` (if provided) references a valid agent name in the target node
   - Verify either `toNode` or `toAgent` is provided (not both, not neither)
5. Create `resolveAllChannels(workflow: SpaceWorkflow): { nodeChannels: Map<string, ResolvedChannel[]>, crossNodeChannels: ResolvedCrossNodeChannel[] }` that resolves both types

**Acceptance Criteria**:
- Cross-node channels resolve to concrete routing rules (fan-out or DM)
- Bidirectional channels expand to two one-way entries
- Fan-out channels (`toNode`) correctly target all agents in the destination node
- DM channels (`toAgent`) correctly target a specific agent by name
- Validation catches invalid node references and unknown agent names
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
   - Simple cross-node channel resolution (node A -> node B fan-out)
   - DM resolution (node A -> specific agent in node B)
   - Bidirectional cross-node channels
   - Mixed within-node and cross-node channels resolve correctly together
   - Validation catches invalid node references
   - Validation catches unknown agent names in cross-node channels
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
