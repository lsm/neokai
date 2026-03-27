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
5. Update the SQLite schema for workflow runs to persist gate data (JSON column on the channel/gate record, or a separate `gate_data` table keyed by `runId + gateId`)
6. Add migration or schema update for existing databases
7. Unit tests: type validation, schema creation, data persistence round-trip

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

### Task 1.3: Implement `read_gate` and `write_gate` MCP Tools

**Description**: Create MCP tools that allow node agents to read from and write to gate data stores. These tools are added to the `node-agent-tools` MCP server so all workflow agents can interact with gates.

**Subtasks**:
1. Add `read_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string }` (or `{ channelId: string }`)
   - Returns: the gate's current `data` object
   - Agents use this to read PR URLs, review votes, approval status, etc.
2. Add `write_gate` MCP tool to `node-agent-tools`:
   - Parameters: `{ gateId: string, data: Record<string, unknown> }` (merge semantics — new keys are added, existing keys are updated)
   - Validates that the writing agent has permission to write to this gate (e.g., only the planner can write to the Plan PR Gate)
   - Persists the updated data to SQLite
   - Triggers a re-evaluation of the gate (which may unblock the channel)
3. Wire the tools into `TaskAgentManager` so they have access to the workflow run context
4. Add permission model: which agent roles can write to which gate types
   - Planner → Plan PR Gate
   - Human → Human Gate (via RPC, not MCP tool directly)
   - Coder → Code PR Gate
   - Reviewer → Aggregate Gate (votes)
   - QA → Task Result Gate
5. Unit tests: read/write round-trip, permission enforcement, gate re-evaluation on write

**Acceptance Criteria**:
- Agents can read gate data via `read_gate` MCP tool
- Agents can write gate data via `write_gate` MCP tool
- Writing to a gate triggers re-evaluation (may unblock downstream channel)
- Permission model prevents unauthorized gate writes
- Unit tests verify all tool behaviors

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
5. Ensure gate data changes are persisted before evaluation (no race conditions)
6. Unit tests: gate transition triggers node activation, aggregate gate with incremental votes, concurrent write handling

**Acceptance Criteria**:
- Channel router uses gate data store for all routing decisions
- Gate data changes trigger re-evaluation and potential node activation
- Aggregate gate handles incremental votes correctly (only unblocks on quorum)
- No race conditions between data persistence and evaluation
- Unit tests cover all routing scenarios

**Depends on**: Task 1.3

**Agent type**: coder
