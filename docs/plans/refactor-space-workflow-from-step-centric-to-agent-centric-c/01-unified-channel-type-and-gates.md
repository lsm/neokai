# Milestone 1: Unified Channel Type and Gate Infrastructure

## Goal

Create one unified `WorkflowChannel` type that handles all messaging — within-node and cross-node, DM and fan-out. Extend it with gate support and cyclic iteration tracking. This replaces the old node-scoped `WorkflowChannel` and eliminates the need for a separate `CrossNodeChannel` type.

One type. One resolver. One router (built in Milestone 3). One DB column.

## Scope

- Extend `WorkflowChannel` with `isCyclic`, `gate` fields; clarify `from`/`to` semantics
- Extend `ResolvedChannel` with `isFanOut`, `isCyclic`, `gate`
- Create unified `resolveChannels()` function
- Create `ChannelGateEvaluator`
- Add `channels` column to `space_workflows` DB table
- Move channels from `WorkflowNode.channels` to `SpaceWorkflow.channels`
- Update export/import for unified channels
- Tests

## Tasks

### Task 1.1: Extend WorkflowChannel Type

**Description**: Extend the existing `WorkflowChannel` type to support all messaging patterns — within-node DMs, within-node broadcast, cross-node DMs, and cross-node fan-out. Add gate and cyclic iteration tracking.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`, update `WorkflowChannel`:
   ```
   interface WorkflowChannel {
     id: string;
     from: string;           // sender: agent name or node name
     to: string;             // recipient: agent name or node name
     direction: 'one-way' | 'bidirectional';
     isCyclic?: boolean;     // when true, each delivery increments the run's iteration counter
     gate?: WorkflowCondition; // policy enforcement
     label?: string;
   }
   ```
   - Remove `node?: string` field if it exists (no longer needed — `from`/`to` encode the source/target)
   - Clarify `from`/`to`: agent name → DM, node name → fan-out to all agents in that node
2. Update `WorkflowChannelInput` type (used in create/update params)
3. Move `channels` from `WorkflowNode.channels?: WorkflowChannel[]` to `SpaceWorkflow.channels?: WorkflowChannel[]` — all channels are now workflow-level
4. Add `channels?: WorkflowChannelInput[]` to `CreateSpaceWorkflowParams` and `UpdateSpaceWorkflowParams`
5. Remove any `crossNodeChannels` field from `SpaceWorkflow` if it was added in a previous iteration
6. Create `ExportedWorkflowChannel` type for export/import

**Acceptance Criteria**:
- `WorkflowChannel` supports all messaging patterns (within-node, cross-node, DM, fan-out)
- Gate and cyclic fields are present
- `SpaceWorkflow` carries a single `channels` array (no separate cross-node field)
- `WorkflowNode` no longer has a `channels` field
- TypeScript typecheck passes

**Dependencies**: None

**Agent Type**: coder

---

### Task 1.2: Extend ResolvedChannel Type

**Description**: Extend the existing `ResolvedChannel` type with fields needed for gate evaluation, fan-out detection, and cyclic tracking.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`, update `ResolvedChannel`:
   ```
   interface ResolvedChannel {
     channelId: string;
     from: string;             // original: agent name or node name
     to: string;               // original: agent name or node name
     toNodeName: string;       // resolved target node name
     isFanOut: boolean;        // true when to is a node name (fan-out to all agents)
     direction: 'one-way';     // bidirectional expanded to two one-way entries
     isCyclic?: boolean;
     gate?: WorkflowCondition;
     gateLabel?: string;
     label?: string;
   }
   ```
2. Remove any separate `ResolvedCrossNodeChannel` type if it exists — one resolved type for everything

**Acceptance Criteria**:
- `ResolvedChannel` captures all information needed for routing and gate evaluation
- `isFanOut` distinguishes DM from fan-out
- Gate and cyclic fields present
- Only one resolved channel type exists

**Dependencies**: Task 1.1

**Agent Type**: coder

---

### Task 1.3: Unified Channel Resolution

**Description**: Create a single `resolveChannels()` function that resolves all channels in a workflow into `ResolvedChannel` entries. This replaces any separate `resolveNodeChannels()` or `resolveCrossNodeChannels()` functions.

**Subtasks**:
1. In `packages/shared/src/types/space-utils.ts`, create `resolveChannels(workflow: SpaceWorkflow): ResolvedChannel[]`
2. Resolution algorithm:
   - For each `WorkflowChannel`, determine if `from` and `to` are agent names or node names
   - Set `isFanOut: true` when `to` resolves to a node name
   - Resolve `toNodeName` by looking up the node that contains the target agent/node
   - Expand bidirectional channels to two one-way `ResolvedChannel` entries
   - Skip self-loops and unresolvable references
3. Create `validateChannels(workflow: SpaceWorkflow): string[]`:
   - Verify `from` references a valid agent or node
   - Verify `to` references a valid agent or node
   - Verify gate expressions are valid (if gate type is `condition`)
4. Remove or deprecate any old `resolveNodeChannels()` function (no longer needed)

**Acceptance Criteria**:
- One resolver handles all channel types (within-node, cross-node, DM, fan-out)
- Bidirectional channels expand to two one-way entries
- Validation catches invalid agent/node references
- No separate within-node vs cross-node resolution paths

**Dependencies**: Tasks 1.1, 1.2

**Agent Type**: coder

---

### Task 1.4: ChannelGateEvaluator

**Description**: Create the gate evaluation engine that checks whether a channel allows message delivery based on its `gate` condition.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/runtime/channel-gate-evaluator.ts`
2. Implement `ChannelGateEvaluator` class:
   ```
   class ChannelGateEvaluator {
     constructor(config: {
       workspacePath: string;
       taskRepo: SpaceTaskRepository;
     })

     async evaluateGate(params: {
       gate: WorkflowCondition;
       context: ChannelGateContext;
     }): Promise<{ allowed: boolean; reason?: string }>
   }
   ```
3. Gate evaluation logic:
   - `always` → always allow
   - `human` → check for human approval (via context)
   - `condition` → run shell expression in workspace directory
   - `task_result` → check task result value against expected
4. Handle gate evaluation context (workspace path, task results, etc.)
5. Add helper functions for constructing common gate conditions

**Acceptance Criteria**:
- All 4 gate types (`always`, `human`, `condition`, `task_result`) evaluate correctly
- Gate evaluation is unit-testable with mock dependencies
- Reuses existing `WorkflowCondition` type and condition evaluation patterns
- Clear error messages when gates block delivery

**Dependencies**: Task 1.1

**Agent Type**: coder

---

### Task 1.5: DB Schema — Unified Channels Column

**Description**: Add a single `channels` column to the `space_workflows` table to store all channels. This replaces any separate channel storage and provides one source of truth.

**Subtasks**:
1. Add a migration (**use the next available migration number at implementation time**) to add a `channels TEXT` column to `space_workflows` table (JSON-serialized array of `WorkflowChannel`). One column for all channels — no separate `cross_node_channels` column.
2. Update `packages/daemon/src/storage/repositories/space-workflow-repository.ts` to:
   - Serialize `channels` to JSON when persisting
   - Deserialize from JSON when loading
3. Remove any channel-related storage from `WorkflowNode` persistence (channels are now workflow-level)
4. Write a unit test for the migration in `packages/daemon/tests/unit/storage/` (following existing patterns like `migration-spaces-autonomy-level_test.ts`)
5. Update the workflow repository tests to cover channel CRUD

**Acceptance Criteria**:
- Migration adds column without breaking existing data
- All channels persist and load correctly via the repository
- One `channels` column on `space_workflows` (no separate cross-node column)
- Migration test passes
- Existing workflow CRUD operations are not affected

**Dependencies**: Task 1.1

**Agent Type**: coder

---

### Task 1.6: Update Export/Import for Unified Channels

**Description**: Update the export/import format to handle the unified `channels` array with proper name-based references.

**Subtasks**:
1. Update `packages/daemon/src/lib/space/export-format.ts` to handle `ExportedWorkflowChannel`:
   - Export: channels are already name-based (`from`/`to` use agent/node names), minimal transformation needed
   - Import: validate that `from`/`to` reference valid agents or nodes
2. Add channels to the export bundle schema validation
3. Remove any separate cross-node channel export/import logic
4. Write unit tests for export/import with unified channels

**Acceptance Criteria**:
- Exported workflow bundles include all channels
- Imported bundles correctly validate agent/node name references
- Import validation catches missing references
- Unit tests pass

**Dependencies**: Tasks 1.1, 1.5

**Agent Type**: coder

---

### Task 1.7: Tests for Unified Channels and Gates

**Description**: Comprehensive tests for the unified channel system.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/channel-resolution.test.ts`:
   - Within-node DM resolution (agent → agent on same node)
   - Within-node broadcast (agent → node name)
   - Cross-node DM (agent → agent on different node)
   - Cross-node fan-out (agent → node name on different node)
   - Bidirectional channel expansion
   - Self-loop detection
   - Invalid reference detection
2. Create `packages/daemon/tests/unit/space/channel-gate-evaluator.test.ts`:
   - `always` gate → allow
   - `human` gate → block until approved
   - `condition` gate → run expression, allow/block based on result
   - `task_result` gate → check task result
   - Gate with invalid expression → error
3. Create `packages/daemon/tests/unit/space/channel-validation.test.ts`:
   - Valid channels pass
   - Invalid agent/node references caught
   - Missing required fields caught

**Acceptance Criteria**:
- All tests pass
- One resolver, one test suite for all channel types
- Gate evaluation tested for all condition types
- No regressions

**Dependencies**: Tasks 1.3, 1.4, 1.6

**Agent Type**: coder

## Rollback Strategy

- **Type changes** (Task 1.1): The `WorkflowChannel` extension is additive (new fields). Removing new fields is a non-breaking type change. Moving `channels` from `WorkflowNode` to `SpaceWorkflow` is a structural change but the feature is unreleased.
- **DB migration** (Task 1.5): Adds a nullable `channels TEXT` column. Can be dropped without data loss.
- **Export/import** (Task 1.6): Changes are additive. Older exports without channels import correctly (field is optional).
