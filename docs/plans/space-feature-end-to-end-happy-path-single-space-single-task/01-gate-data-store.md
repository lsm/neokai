# Milestone 1: Gate Data Store and New Gate Types

## Goal and Scope

Implement the core Gate + Channel architecture: gates with persistent data stores that agents can read/write, plus three new gate types (PR Gate, Aggregate Gate, enhanced Human Gate). This is the foundation that all other milestones build on.

## Architecture

### Gate Data Store

Every gate in the workflow has a persistent data store (JSON blob in SQLite). Agents interact with gate data via MCP tools. The gate's `evaluate()` method checks its own data store to determine if the gate passes.

```typescript
// In packages/shared/src/types/space.ts
interface GateData {
  [key: string]: unknown;
}

interface Gate {
  id: string;
  type: 'pr' | 'human' | 'aggregate' | 'task_result' | 'always';
  data: GateData;       // persisted to SQLite
  config: GateConfig;   // static config (quorum count, etc.)
}

// Discriminated union for gate configs
type GateConfig =
  | { type: 'always' }
  | { type: 'task_result'; expression: string }
  | { type: 'human' }
  | { type: 'pr' }
  | { type: 'aggregate'; quorum: number };
```

### Gate Evaluation

Each gate type has a simple evaluate function that checks its own data:

- **always**: Always passes → `true`
- **task_result**: `data.result === config.expression`
- **human**: `data.approved === true`
- **pr**: `data.prUrl != null && data.prUrl !== ''`
- **aggregate**: `Object.values(data.votes || {}).filter(v => v === 'approve').length >= config.quorum`

## Tasks

### Task 1.1: Extend Gate Types and Add Data Store Schema

**Description**: Extend the existing gate type system in `packages/shared/src/types/space.ts` to support the new gate types (`pr`, `aggregate`) and add the `data` field to the gate interface. Update the SQLite schema to persist gate data.

**Subtasks**:
1. Audit the existing gate types in `packages/shared/src/types/space.ts` — currently supports `always`, `human`, `condition`, `task_result`
2. Add new gate types: `pr` and `aggregate`
3. Add `GateData` type and `data: GateData` field to the gate/channel interface
4. Add `GateConfig` discriminated union with per-type config (e.g., `quorum` for aggregate)
5. Create a dedicated `gate_data` table in SQLite keyed by `(run_id, gate_id)` with a JSON `data` column. This is preferred over a JSON column on the channel/gate record because: (a) gate data changes frequently during a run while channel definitions are static, (b) gate data is per-run while channels are per-workflow template, (c) a separate table allows atomic reads/writes without deserializing from the channel definition, and (d) concurrent writes (e.g., 3 reviewers voting) benefit from row-level granularity.
6. Add `allowedWriterRoles: string[]` to the gate definition schema (static, per-gate, persisted alongside the gate type and config). Example: Plan PR Gate → `['planner']`, Aggregate Gate → `['reviewer']`.
7. Add `failureReason` optional field to `SpaceWorkflowRun` interface: `failureReason?: 'humanRejected' | 'maxIterationsReached' | 'nodeTimeout' | 'agentCrash'`. All failure scenarios use the existing `'needs_attention'` status with this field, avoiding a cross-cutting `WorkflowRunStatus` type change.
8. Add migration or schema update for existing databases
9. Unit tests: type validation, schema creation, data persistence round-trip, gate_data table CRUD

**Acceptance Criteria**:
- Gate types include `pr`, `aggregate`, `human`, `task_result`, `always`
- Gate data is persisted to SQLite and survives daemon restart
- Gate config supports per-type configuration (quorum for aggregate)
- Unit tests verify persistence round-trip

**Depends on**: nothing

**Agent type**: coder

---

### Task 1.2: Implement Gate Evaluators for New Types

**Description**: Implement `evaluate()` logic for the new gate types (PR Gate, Aggregate Gate) and enhance the existing Human Gate evaluator to use the data store instead of workflow run config flags.

**Subtasks**:
1. Refactor `ChannelGateEvaluator` to read from the gate's `data` store instead of workflow run config
2. Implement PR Gate evaluator: passes when `data.prUrl` is non-empty
3. Implement Aggregate Gate evaluator: passes when `Object.values(data.votes).filter(v => v === 'approve').length >= config.quorum`
4. Update Human Gate evaluator: passes when `data.approved === true` (reads from gate data, not workflow run config)
5. Ensure existing `task_result` and `always` evaluators still work
6. Unit tests for each gate evaluator with various data states

**Acceptance Criteria**:
- PR Gate blocks until PR URL is written to gate data
- Aggregate Gate blocks until quorum is reached
- Human Gate reads from gate data store (not workflow run config flags)
- All existing gate types continue to work
- Unit tests cover pass/fail conditions for each gate type

**Depends on**: Task 1.1

**Agent type**: coder

---

### Task 1.3: Implement `read_gate`, `write_gate`, and `list_gates` MCP Tools

**Description**: Create MCP tools that allow node agents to discover, read from, and write to gate data stores. These tools are added to the `node-agent-tools` MCP server so all workflow agents can interact with gates.

**Subtasks**:
1. Add `list_gates` MCP tool to `node-agent-tools`:
   - Parameters: none (uses the current workflow run context from the MCP server config)
   - Returns: array of `{ gateId, type, description, allowedWriterRoles, currentData }` for all gates in the run
   - Agents call this at session start to discover available gates and their IDs
2. Add `read_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string }`
   - Returns: the gate's current `data` object from the `gate_data` table
   - Agents use this to read PR URLs, review votes, approval status, etc.
3. Add `write_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string, data: Record<string, unknown> }` (merge semantics — new keys are added, existing keys are updated)
   - **Authorization check**: reads the calling agent's `nodeRole` from the MCP server config, compares against the gate's `allowedWriterRoles` list (from gate definition). If unauthorized, returns error: `"Permission denied: role '{role}' cannot write to gate '{gateId}'"`
   - Persists the updated data to the `gate_data` table in SQLite
   - Triggers a re-evaluation of the gate (which may unblock the channel)
4. Wire the tools into `TaskAgentManager` so they have access to the workflow run context (runId, gate definitions)
5. **Workflow context injection**: When `TaskAgentManager.spawnSubSession()` creates a node agent, inject a `workflowContext` block into the task message containing: the node's upstream/downstream gate IDs, gate types, and human-readable descriptions (e.g., "code-pr-gate: write your PR URL here after creating the PR"). This provides gate IDs without requiring agents to call `list_gates` first.
6. **Aggregate Gate vote keys**: Use `nodeId` (not `agentId`) as the vote key in `data.votes`. This prevents collision if an agent is re-spawned after a crash — the nodeId stays the same, and the re-spawned agent overwrites the previous vote cleanly.
7. Unit tests: list_gates returns correct gates, read/write round-trip, permission enforcement (authorized + unauthorized), gate re-evaluation on write, vote key collision handling

**Acceptance Criteria**:
- Agents can discover gates via `list_gates` MCP tool (returns IDs, types, descriptions)
- Agents can read gate data via `read_gate` MCP tool
- Agents can write gate data via `write_gate` MCP tool
- Writing to a gate triggers re-evaluation (may unblock downstream channel)
- Permission model prevents unauthorized gate writes (returns clear error message)
- Workflow context injection provides gate IDs in the task message
- Aggregate Gate votes use nodeId as key (not agentId)
- Unit tests verify all tool behaviors including permission enforcement

**Depends on**: Task 1.2

**Agent type**: coder

---

### Task 1.4: Integrate Gate Data Store with Channel Router

**Description**: Update the `ChannelRouter` to use the gate data store for routing decisions. When a gate's data changes (via `write_gate`), the router should re-evaluate the gate and potentially activate the next node.

**Subtasks**:
1. Update `ChannelRouter.deliverMessage()` to call `gate.evaluate()` using the gate's data store
2. Add a `onGateDataChanged(gateId)` method that triggers re-evaluation of the associated channel
3. When a gate transitions from blocked → passed, activate the target node (call `TaskAgentManager.activateNode()`)
4. Handle the Aggregate Gate case: multiple agents write to the same gate (3 reviewers voting). Each write triggers re-evaluation, but only the final vote that meets quorum unblocks the channel.
5. **Implement gate data reset on cyclic traversal**: When the `ChannelRouter` traverses a cyclic channel (e.g., reviewer rejection → Coding, or QA failure → Coding), it must **reset the gate data of all downstream gates** between the cycle target (Coding) and the cycle source. Specifically:
   - Aggregate Gate votes reset to `{ votes: {} }` — all 3 reviewers must re-vote from scratch
   - Code PR Gate data is preserved (the PR URL doesn't change)
   - Task Result Gate (QA) resets to `{}`
   - The reset is atomic with the cyclic channel traversal (same transaction)
   - This prevents stale approve votes from a previous round short-circuiting the re-review
6. Ensure gate data changes are persisted before evaluation (no race conditions). Use SQLite transactions for atomic read-evaluate-write cycles.
7. Handle concurrent writes to the same gate (e.g., 3 reviewers voting near-simultaneously): serialize writes via SQLite's write lock, re-evaluate after each write.
8. Unit tests: gate transition triggers node activation, aggregate gate with incremental votes, concurrent write handling, **gate data reset on cyclic traversal** (verify votes cleared, verify PR data preserved)

**Acceptance Criteria**:
- Channel router uses gate data store for all routing decisions
- Gate data changes trigger re-evaluation and potential node activation
- Aggregate gate handles incremental votes correctly (only unblocks on quorum)
- **Cyclic channel traversal resets downstream gate data** (Aggregate votes cleared, PR data preserved)
- No race conditions between data persistence and evaluation (SQLite transactions)
- Concurrent writes to the same gate are serialized correctly
- Unit tests cover all routing scenarios including reset behavior

**Depends on**: Task 1.3

**Agent type**: coder
