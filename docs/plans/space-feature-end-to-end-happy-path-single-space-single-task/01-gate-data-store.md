# Milestone 1: Unified Gate with Composable Conditions

## Goal and Scope

Implement the core Gate + Channel architecture: a single unified Gate entity with a persistent data store and composable conditions. No class hierarchy of gate types — one Gate concept, three condition types, one set of MCP tools. This is the foundation that all other milestones build on.

## Architecture

### The Unified Gate

Every gate in the workflow is the same entity. The only variation is the **condition config** — a small predicate that checks the gate's data store.

```typescript
// In packages/shared/src/types/space.ts
interface Gate {
  id: string;                           // e.g., 'plan-pr-gate', 'review-votes-gate'
  condition: GateCondition;             // composable predicate — NOT a class hierarchy
  data: Record<string, unknown>;        // persistent data store (SQLite)
  allowedWriterRoles: string[];         // who can write — ['planner'], ['reviewer'], etc.
  description: string;                  // human-readable — injected into agent task messages
  resetOnCycle: boolean;                // whether data resets when a cyclic channel fires
}

// Three condition types cover ALL workflow behaviors
type GateCondition =
  | { type: 'always' }
  | { type: 'check'; field: string; op?: '==' | '!=' | 'exists'; value?: unknown }
  | { type: 'count'; field: string; matchValue: unknown; min: number }
```

### Condition Evaluation

One `evaluate(gate)` function with a switch on `condition.type`:

- **`always`**: Returns `true`.
- **`check`**: Checks a single field in `gate.data`.
  - `op: 'exists'` (default if no `op`): `data[field] != null && data[field] !== ''`
  - `op: '=='`: `data[field] === value`
  - `op: '!='`: `data[field] !== value`
- **`count`**: Counts entries in a map field that match a value.
  - `Object.values(data[field] || {}).filter(v => v === matchValue).length >= min`

### How Each Workflow Gate Maps to Conditions

| Gate ID | Condition Config | Passes when... |
|---------|-----------------|----------------|
| `plan-pr-gate` | `{ type: 'check', field: 'prUrl' }` | Planner writes PR URL |
| `plan-approval-gate` | `{ type: 'check', field: 'approved', op: '==', value: true }` | Human approves |
| `code-pr-gate` | `{ type: 'check', field: 'prUrl' }` | Coder writes PR URL |
| `review-votes-gate` | `{ type: 'count', field: 'votes', matchValue: 'approve', min: 3 }` | ≥3 reviewers approve |
| `review-reject-gate` | `{ type: 'check', field: 'result', op: '==', value: 'rejected' }` | Any reviewer rejects |
| `qa-result-gate` | `{ type: 'check', field: 'result', op: '==', value: 'passed' }` | QA passes |
| `qa-fail-gate` | `{ type: 'check', field: 'result', op: '==', value: 'failed' }` | QA fails |

**Note**: These are all the same Gate entity with different condition configs. No `PRGate`, `AggregateGate`, `HumanGate` classes.

## Tasks

### Task 1.1: Implement Unified Gate Type and Data Store Schema

**Description**: Replace the existing separate gate type system in `packages/shared/src/types/space.ts` with the unified `Gate` interface. Add the `gate_data` SQLite table for persistent data stores.

**Subtasks**:
1. Audit the existing gate types in `packages/shared/src/types/space.ts` — currently supports `always`, `human`, `condition`, `task_result` as separate types
2. Replace with the unified `Gate` interface: `{ id, condition: GateCondition, data, allowedWriterRoles, description, resetOnCycle }`
3. Define the `GateCondition` discriminated union with three types: `always`, `check`, `count`
4. Create a dedicated `gate_data` table in SQLite keyed by `(run_id, gate_id)` with a JSON `data` column. Rationale: (a) gate data changes frequently during a run while gate definitions are static, (b) gate data is per-run while gate definitions are per-workflow template, (c) separate table enables atomic reads/writes without JSON blob deserialization, (d) concurrent writes (e.g., 3 reviewers voting) benefit from row-level granularity.
5. Add `allowedWriterRoles: string[]` to the gate definition schema (static, per-gate)
6. Add `resetOnCycle: boolean` to the gate definition schema — controls whether data is cleared on cyclic channel traversal
7. Add `failureReason` optional field to `SpaceWorkflowRun` interface: `failureReason?: 'humanRejected' | 'maxIterationsReached' | 'nodeTimeout' | 'agentCrash'`. All failure scenarios use existing `'needs_attention'` status with this field.
8. Migrate existing gate definitions to the new unified format (backward-compatible: map old `human` type to `{ type: 'check', field: 'approved', op: '==', value: true }`, etc.)
9. Unit tests: type validation, schema creation, data persistence round-trip, gate_data table CRUD, backward-compatible migration

**Acceptance Criteria**:
- Single unified `Gate` interface replaces all separate gate types
- Three condition types (`always`, `check`, `count`) cover all workflow behaviors
- Gate data persisted to SQLite `gate_data` table and survives daemon restart
- Existing gate definitions are migrated to unified format
- Unit tests verify persistence round-trip and migration

**Depends on**: nothing

**Agent type**: coder

---

### Task 1.2: Implement Unified Gate Evaluator

**Description**: Implement a single `evaluate(gate)` function that handles all three condition types. Replace the existing per-type evaluator logic in `ChannelGateEvaluator`.

**Subtasks**:
1. Create `evaluateGate(gate: Gate): boolean` function:
   - Switch on `gate.condition.type`
   - `always` → return `true`
   - `check` → read `gate.data[field]`, apply op (`exists`, `==`, `!=`)
   - `count` → read `gate.data[field]` as a map, count values matching `matchValue`, check `>= min`
2. Refactor `ChannelGateEvaluator` to call `evaluateGate()` instead of per-type logic
3. Ensure the evaluator reads from the gate's `data` store (from `gate_data` table), not from workflow run config
4. Handle edge cases: missing field → `check` with `exists` returns false; missing map field → `count` returns 0
5. Remove the old per-type evaluator code paths (`human`, `pr`, `aggregate`, `task_result` as separate branches)
6. Unit tests for each condition type with various data states, including edge cases (null data, empty map, missing field)

**Acceptance Criteria**:
- Single `evaluateGate()` function handles all conditions
- No separate evaluator per gate type — one code path with a 3-way switch
- All existing gate behaviors continue to work (verified by backward-compat tests)
- Unit tests cover all condition types and edge cases

**Depends on**: Task 1.1

**Agent type**: coder

---

### Task 1.3: Implement `read_gate`, `write_gate`, and `list_gates` MCP Tools

**Description**: Create MCP tools that allow node agents to discover, read from, and write to gate data stores. These tools are added to the `node-agent-tools` MCP server. All gates use the same tools — no type-specific APIs.

**Subtasks**:
1. Add `list_gates` MCP tool to `node-agent-tools`:
   - Parameters: none (uses the current workflow run context from the MCP server config)
   - Returns: array of `{ gateId, condition, description, allowedWriterRoles, currentData }` for all gates in the run
   - Agents call this at session start to discover available gates
2. Add `read_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string }`
   - Returns: the gate's current `data` object from the `gate_data` table
3. Add `write_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string, data: Record<string, unknown> }` (merge semantics — new keys added, existing keys updated)
   - **Authorization check**: reads calling agent's `nodeRole` from MCP server config, compares against gate's `allowedWriterRoles`. Unauthorized → error: `"Permission denied: role '{role}' cannot write to gate '{gateId}'"`
   - Persists updated data to `gate_data` table
   - Triggers gate re-evaluation (may unblock channel)
4. Wire tools into `TaskAgentManager` with workflow run context (runId, gate definitions)
5. **Workflow context injection**: When `TaskAgentManager.spawnSubSession()` creates a node agent, inject `workflowContext` into the task message containing: upstream/downstream gate IDs, condition descriptions, and human-readable instructions (e.g., "code-pr-gate: write your PR URL here after creating the PR")
6. **Vote keys**: For gates using `count` condition (vote counting), use `nodeId` (not `agentId`) as the map key. Prevents collision if an agent is re-spawned after a crash.
7. Unit tests: list_gates, read/write round-trip, permission enforcement, gate re-evaluation on write, vote key collision handling

**Acceptance Criteria**:
- All gates use the same `read_gate`/`write_gate`/`list_gates` tools — no type-specific APIs
- Writing to a gate triggers re-evaluation (may unblock downstream channel)
- Permission model prevents unauthorized writes (clear error message)
- Workflow context injection provides gate IDs in task message
- Unit tests verify all tool behaviors

**Depends on**: Task 1.2

**Agent type**: coder

---

### Task 1.4: Integrate Unified Gate with Channel Router

**Description**: Update the `ChannelRouter` to use the unified gate's data store and `evaluateGate()` for routing decisions. Implement gate data reset on cyclic traversal using the `resetOnCycle` flag.

**Subtasks**:
1. Update `ChannelRouter.deliverMessage()` to call `evaluateGate(gate)` using the gate's data store
2. Add `onGateDataChanged(gateId)` method that triggers re-evaluation of the associated channel
3. When a gate transitions from blocked → passed, activate the target node
4. Handle vote-counting gates: multiple agents write to the same gate. Each write triggers re-evaluation, but only the final vote meeting the `min` threshold unblocks the channel.
5. **Implement `resetOnCycle` behavior**: When the `ChannelRouter` traverses a cyclic channel, reset the `data` to `{}` for all downstream gates where `resetOnCycle === true`. Specifically in the V2 workflow:
   - `review-votes-gate` (`resetOnCycle: true`) → resets to `{}` — all 3 reviewers must re-vote
   - `review-reject-gate` (`resetOnCycle: true`) → resets to `{}`
   - `qa-result-gate` (`resetOnCycle: true`) → resets to `{}`
   - `qa-fail-gate` (`resetOnCycle: true`) → resets to `{}`
   - `code-pr-gate` (`resetOnCycle: false`) → **preserved** (PR URL doesn't change)
   - The reset is atomic with the cyclic traversal (same SQLite transaction)
6. Ensure gate data changes are persisted before evaluation (SQLite transactions for atomic read-evaluate-write)
7. Handle concurrent writes (e.g., 3 reviewers voting simultaneously): serialize via SQLite write lock, re-evaluate after each write
8. Unit tests: gate transition triggers node activation, vote-counting gate with incremental writes, concurrent write handling, **resetOnCycle behavior** (verify data cleared for resetOnCycle:true, preserved for resetOnCycle:false)

**Acceptance Criteria**:
- Channel router uses unified `evaluateGate()` for all routing
- Gate data changes trigger re-evaluation and potential node activation
- Vote-counting gates handle incremental writes correctly
- `resetOnCycle` flag controls which gates are cleared on cyclic traversal
- No race conditions (SQLite transactions)
- Concurrent writes serialized correctly
- Unit tests cover all scenarios including reset behavior

**Depends on**: Task 1.3

**Agent type**: coder
