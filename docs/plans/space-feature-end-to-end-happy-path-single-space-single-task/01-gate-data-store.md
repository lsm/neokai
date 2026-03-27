# Milestone 1: Separated Channels + Gates with Composable Conditions

## Goal and Scope

Implement the core Channel + Gate architecture: channels as simple unidirectional pipes and gates as independent entities with persistent data stores and composable conditions. No class hierarchy of gate types — one Gate concept, four condition types (including `all`/`any` composition), one set of MCP tools. Channels and gates are fully separated — a channel without a gate is always open. This is the foundation that all other milestones build on.

## Architecture

### Channels and Gates Are Separate Concepts

A **Channel** is a unidirectional pipe between two nodes. A **Gate** is an optional filter attached to a channel.

```typescript
// In packages/shared/src/types/space.ts

// Channel = just a pipe between nodes
interface Channel {
  id: string;
  from: string;          // source node ID
  to: string;            // target node ID
  gateId?: string;       // optional — if absent, channel is always open
  isCyclic?: boolean;    // for feedback loops
}

// Gate = optional filter attached to a channel
interface Gate {
  id: string;                           // e.g., 'plan-pr-gate', 'review-votes-gate'
  channelId: string;                    // which channel this gate is attached to
  condition: GateCondition;             // composable predicate — NOT a class hierarchy
  data: Record<string, unknown>;        // persistent data store (SQLite)
  allowedWriterRoles: string[];         // who can write — ['planner'], ['reviewer'], etc.
  description: string;                  // human-readable — injected into agent task messages
  resetOnCycle: boolean;                // whether data resets when a cyclic channel fires
}

// Four condition types cover ALL gate behaviors (including composition)
// No 'always' type — a channel without a gate is implicitly always open
type GateCondition =
  | { type: 'check'; field: string; op?: '==' | '!=' | 'exists'; value?: unknown }
  | { type: 'count'; field: string; matchValue: unknown; min: number }
  | { type: 'all'; conditions: GateCondition[] }   // AND — all must pass
  | { type: 'any'; conditions: GateCondition[] }    // OR — at least one must pass
```

### Bidirectional Communication

Each channel is unidirectional. For bidirectional flow, create TWO channels (one per direction), each with its own optional gate:

```
planner ──[plan-pr-gate]──► reviewer    (gated: reviewer can't start until PR exists)
planner ◄─────────────────── reviewer    (no gate: feedback flows freely)
```

### Structured `send_message` Data

`send_message` carries structured data alongside natural language text:

```typescript
{
  text: string,                         // natural language message
  data?: Record<string, unknown>        // structured data (extensible)
}
```

Gate data updates can be embedded in message `data` and applied on delivery through the channel.

### Condition Evaluation

One `evaluate(gate)` function with a switch on `condition.type`:

- **`check`**: Checks a single field in `gate.data`.
  - `op: 'exists'` (default if no `op`): `data[field] != null && data[field] !== ''`
  - `op: '=='`: `data[field] === value`
  - `op: '!='`: `data[field] !== value`
- **`count`**: Counts entries in a map field that match a value.
  - `Object.values(data[field] || {}).filter(v => v === matchValue).length >= min`
- **`all`**: AND composition — `conditions.every(c => evaluate(c, gate.data))`.
  - Empty `conditions` array returns `true` (vacuous truth).
- **`any`**: OR composition — `conditions.some(c => evaluate(c, gate.data))`.
  - Empty `conditions` array returns `false`.

For channels without a gate: no evaluation needed — always open.

### How Each Workflow Gate Maps to Conditions

| Gate ID | Attached to Channel | Condition Config | Passes when... |
|---------|-------------------|-----------------|----------------|
| `plan-pr-gate` | planning → plan-review | `{ type: 'check', field: 'prUrl' }` | Planner writes PR URL |
| `plan-approval-gate` | plan-review → coding | `{ type: 'check', field: 'approved', op: '==', value: true }` | Human approves |
| `code-pr-gate` | coding → reviewer-1/2/3 | `{ type: 'check', field: 'prUrl' }` | Coder writes PR URL |
| `review-votes-gate` | reviewer-1/2/3 → qa | `{ type: 'count', field: 'votes', matchValue: 'approve', min: 3 }` | ≥3 reviewers approve |
| `review-reject-gate` | reviewer-1/2/3 → coding | `{ type: 'check', field: 'result', op: '==', value: 'rejected' }` | Any reviewer rejects |
| `qa-result-gate` | qa → done | `{ type: 'check', field: 'result', op: '==', value: 'passed' }` | QA passes |
| `qa-fail-gate` | qa → coding | `{ type: 'check', field: 'result', op: '==', value: 'failed' }` | QA fails |

**Note**: These are all the same Gate entity with different condition configs. No `PRGate`, `AggregateGate`, `HumanGate` classes. Channels without gates (e.g., feedback channels) are always open.

## Tasks

### Task 1.1: Implement Separated Channel + Gate Types and Data Store Schema

**Description**: Replace the existing coupled gate/channel system in `packages/shared/src/types/space.ts` with separated `Channel` and `Gate` interfaces. Add the `gate_data` SQLite table for persistent data stores.

**Subtasks**:
1. Audit the existing gate types in `packages/shared/src/types/space.ts` — currently supports `always`, `human`, `condition`, `task_result` as separate types coupled into channels
2. Define the `Channel` interface: `{ id, from, to, gateId?, isCyclic? }` — a simple unidirectional pipe. No condition logic. A channel without `gateId` is always open.
3. Define the `Gate` interface: `{ id, channelId, condition: GateCondition, data, allowedWriterRoles, description, resetOnCycle }` — an independent entity attached to a channel
4. Define the `GateCondition` discriminated union with four types: `check`, `count`, `all` (AND composition), `any` (OR composition). No `always` type — a channel without a gate is implicitly always open. The `all`/`any` types are recursive — `conditions` is `GateCondition[]`, enabling arbitrarily nested logic.
5. Create a dedicated `gate_data` table in SQLite keyed by `(run_id, gate_id)` with a JSON `data` column. Rationale: (a) gate data changes frequently during a run while gate definitions are static, (b) gate data is per-run while gate definitions are per-workflow template, (c) separate table enables atomic reads/writes without JSON blob deserialization, (d) concurrent writes (e.g., 3 reviewers voting) benefit from row-level granularity.
6. Add `allowedWriterRoles: string[]` to the gate definition schema (static, per-gate)
7. Add `resetOnCycle: boolean` to the gate definition schema — controls whether data is cleared on cyclic channel traversal
8. Update `send_message` MCP tool to accept structured data alongside text: `{ text: string, data?: Record<string, unknown> }`. Gate data updates can be embedded in message `data`.
9. Add `failureReason` optional field to `SpaceWorkflowRun` interface: `failureReason?: 'humanRejected' | 'maxIterationsReached' | 'nodeTimeout' | 'agentCrash'`. All failure scenarios use existing `'needs_attention'` status with this field.
10. Migrate existing gate definitions to the new separated format (backward-compatible: map old `always` type to channel-without-gate, map old `human` type to gate with `{ type: 'check', field: 'approved', op: '==', value: true }`, etc.)
11. Unit tests: type validation, schema creation, data persistence round-trip, gate_data table CRUD, channel-without-gate routing, backward-compatible migration

**Acceptance Criteria**:
- Channels and gates are separate entities — channels are simple pipes, gates are optional filters
- A channel without a gate is always open (replaces old `always` condition type)
- Four condition types (`check`, `count`, `all`, `any`) cover all gate behaviors including composition
- `send_message` accepts structured `data` field
- Gate data persisted to SQLite `gate_data` table and survives daemon restart
- Existing definitions are migrated to separated format
- Unit tests verify persistence round-trip, gateless channels, and migration

**Depends on**: nothing

**Agent type**: coder

---

### Task 1.2: Implement Unified Gate Evaluator

**Description**: Implement a single `evaluate(gate)` function that handles all four condition types (including recursive `all`/`any`). Replace the existing per-type evaluator logic in `ChannelGateEvaluator`. For channels without a gate, no evaluation is needed — they are always open.

**Subtasks**:
1. Create `evaluateGate(gate: Gate): boolean` function:
   - Switch on `gate.condition.type`
   - `check` → read `gate.data[field]`, apply op (`exists`, `==`, `!=`)
   - `count` → read `gate.data[field]` as a map, count values matching `matchValue`, check `>= min`
   - `all` → recursively evaluate all sub-conditions, return `true` only if ALL pass. Empty array → `true` (vacuous truth).
   - `any` → recursively evaluate all sub-conditions, return `true` if ANY passes. Empty array → `false`.
2. Add `isChannelOpen(channel: Channel): boolean` helper: if `channel.gateId` is absent → return `true` (always open); otherwise → look up gate and call `evaluateGate()`
3. Refactor `ChannelGateEvaluator` to call `isChannelOpen()` instead of per-type logic
4. Ensure the evaluator reads from the gate's `data` store (from `gate_data` table), not from workflow run config
5. Handle edge cases: missing field → `check` with `exists` returns false; missing map field → `count` returns 0
6. Remove the old per-type evaluator code paths (`human`, `pr`, `aggregate`, `task_result`, `always` as separate branches)
7. Unit tests for each condition type with various data states, including edge cases (null data, empty map, missing field)
8. Unit tests for composite conditions: `all` with mixed pass/fail sub-conditions, `any` with mixed pass/fail, nested `all`/`any`, empty arrays
9. Unit tests for gateless channels: verify `isChannelOpen()` returns `true` when no gate is attached

**Acceptance Criteria**:
- Single `evaluateGate()` function handles all conditions including recursive `all`/`any`
- Channels without a gate are always open (no `always` condition type needed)
- No separate evaluator per gate type — one code path with a 4-way switch
- All existing gate behaviors continue to work (verified by backward-compat tests)
- Unit tests cover all condition types, edge cases, and gateless channels

**Depends on**: Task 1.1

**Agent type**: coder

---

### Task 1.3: Implement Channel and Gate MCP Tools

**Description**: Create MCP tools that allow node agents to discover channels and gates, read from and write to gate data stores, and send structured messages. These tools are added to the `node-agent-tools` MCP server. All gates use the same tools — no type-specific APIs.

**Subtasks**:
1. Add `list_channels` MCP tool to `node-agent-tools`:
   - Parameters: none (uses the current workflow run context from the MCP server config)
   - Returns: array of `{ channelId, from, to, gateId?, isCyclic }` for all channels in the run
   - Agents call this at session start to understand the workflow topology
2. Add `list_gates` MCP tool to `node-agent-tools`:
   - Parameters: none
   - Returns: array of `{ gateId, channelId, condition, description, allowedWriterRoles, currentData }` for all gates in the run
3. Add `read_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string }`
   - Returns: the gate's current `data` object from the `gate_data` table
4. Add `write_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string, data: Record<string, unknown> }` (merge semantics — new keys added, existing keys updated)
   - **Authorization check**: reads calling agent's `nodeRole` from MCP server config, compares against gate's `allowedWriterRoles`. Unauthorized → error: `"Permission denied: role '{role}' cannot write to gate '{gateId}'"`
   - Persists updated data to `gate_data` table
   - Triggers gate re-evaluation (may unblock the channel this gate is attached to)
5. Update `send_message` MCP tool to accept structured data: `{ text: string, data?: Record<string, unknown> }`. The `data` field is extensible and can carry gate data updates, PR URLs, review metadata, etc. On delivery through a channel, if `data` contains gate-targeted updates, they are applied to the appropriate gate's data store.
6. Wire tools into `TaskAgentManager` with workflow run context (runId, channel definitions, gate definitions)
7. **Workflow context injection**: When `TaskAgentManager.spawnSubSession()` creates a node agent, inject `workflowContext` into the task message containing: upstream/downstream channel IDs and gate IDs, condition descriptions, and human-readable instructions (e.g., "code-pr-gate: write your PR URL here after creating the PR")
8. **Vote keys**: For gates using `count` condition (vote counting), use `nodeId` (not `agentId`) as the map key. Prevents collision if an agent is re-spawned after a crash.
9. Unit tests: list_channels, list_gates, read/write round-trip, permission enforcement, gate re-evaluation on write, structured send_message data delivery, vote key collision handling

**Acceptance Criteria**:
- `list_channels` returns all channels; `list_gates` returns all gates — separate queries reflecting the separated architecture
- All gates use the same `read_gate`/`write_gate` tools — no type-specific APIs
- `send_message` accepts structured `data` alongside text
- Writing to a gate triggers re-evaluation (may unblock the attached channel)
- Permission model prevents unauthorized writes (clear error message)
- Workflow context injection provides channel and gate IDs in task message
- Unit tests verify all tool behaviors

**Depends on**: Task 1.2

**Agent type**: coder

---

### Task 1.4: Integrate Separated Channels + Gates with Channel Router

**Description**: Update the `ChannelRouter` to use the separated channel/gate architecture. Channels without gates are always open. Channels with gates use `evaluateGate()` for routing decisions. Implement gate data reset on cyclic traversal using the `resetOnCycle` flag.

**Subtasks**:
1. Update `ChannelRouter.deliverMessage()` to use `isChannelOpen(channel)`: if channel has no gate → always deliver; if channel has a gate → call `evaluateGate(gate)` using the gate's data store
2. Add `onGateDataChanged(gateId)` method that triggers re-evaluation of the channel the gate is attached to
3. When a gated channel transitions from blocked → open, activate the target node. Gateless channels activate the target node immediately.
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
8. Unit tests: gateless channel always delivers, gated channel blocks until condition passes, gate transition triggers node activation, vote-counting gate with incremental writes, concurrent write handling, **resetOnCycle behavior** (verify data cleared for resetOnCycle:true, preserved for resetOnCycle:false)

**Acceptance Criteria**:
- Channel router uses `isChannelOpen()` for all routing — gateless channels always open, gated channels use `evaluateGate()`
- Gate data changes trigger re-evaluation of the attached channel and potential node activation
- Vote-counting gates handle incremental writes correctly
- `resetOnCycle` flag controls which gates are cleared on cyclic traversal
- No race conditions (SQLite transactions)
- Concurrent writes serialized correctly
- Unit tests cover all scenarios including gateless channels and reset behavior

**Depends on**: Task 1.3

**Agent type**: coder
