# Milestone 1: Channel Gate Types and Evaluation

## Goal

Add gate/condition support to `WorkflowChannel`, enabling channels to enforce policies (condition checks) before message delivery. This is the foundational type change that all subsequent milestones build on.

## Scope

- Extend `WorkflowChannel` type to include an optional `gate` field
- Create `ChannelGateEvaluator` class to evaluate channel gates
- Add unit tests for gate evaluation
- Ensure backward compatibility (channels without gates work identically to current behavior)

## Tasks

### Task 1.1: Extend WorkflowChannel Type with Gate Field

**Description**: Add an optional `gate` field to `WorkflowChannel` that uses the existing `WorkflowCondition` type. This reuses the condition infrastructure already in `WorkflowTransition` rather than inventing a new condition system.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`, add `gate?: WorkflowCondition` to the `WorkflowChannel` interface
2. Update the JSDoc comment on `WorkflowChannel` to document the gate field
3. Add a `WorkflowChannelInput` type (analogous to `WorkflowTransitionInput`) that omits the `id` field (channels don't have IDs currently, but preparing for future use)
4. Export the new types from `packages/shared/src/types/space.ts`

**Acceptance Criteria**:
- `WorkflowChannel` has an optional `gate?: WorkflowCondition` field
- Existing code that creates `WorkflowChannel` objects without a gate still compiles and works
- TypeScript typecheck passes (`bun run typecheck`)
- `resolveNodeChannels()` in `packages/shared/src/types/space-utils.ts` passes through gate field unchanged to `ResolvedChannel`

**Dependencies**: None

**Agent Type**: coder

---

### Task 1.2: Extend ResolvedChannel with Gate Metadata

**Description**: Extend `ResolvedChannel` to carry gate metadata from the source `WorkflowChannel`, so gate evaluation can access the condition at routing time.

**Subtasks**:
1. In `packages/shared/src/types/space-utils.ts`, add `gate?: WorkflowCondition` and `gateLabel?: string` to `ResolvedChannel`
2. Update `expandChannel()` to copy `channel.gate` into each expanded `ResolvedChannel` entry
3. Update `validateNodeChannels()` to validate gate expressions if present (e.g., condition type requires non-empty expression)

**Acceptance Criteria**:
- `ResolvedChannel` carries the gate field when the source channel declares one
- `resolveNodeChannels()` produces `ResolvedChannel` entries with `gate` populated from the source
- Gate-less channels produce entries with `gate: undefined`
- `validateNodeChannels()` returns errors for invalid gate configurations (e.g., `condition` type with empty expression)

**Dependencies**: Task 1.1

**Agent Type**: coder

---

### Task 1.3: Create ChannelGateEvaluator

**Description**: Create a `ChannelGateEvaluator` class that evaluates whether a message can be delivered through a gated channel. This reuses the existing `WorkflowCondition` evaluation logic from `WorkflowExecutor.evaluateCondition()`.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/runtime/channel-gate-evaluator.ts`
2. Define `ChannelGateContext` interface: `{ workspacePath, humanApproved?, taskResult? }` (mirrors `ConditionContext`)
3. Define `ChannelGateResult` interface: `{ allowed: boolean; reason?: string }`
4. Extract condition evaluation logic from `WorkflowExecutor.evaluateCondition()` into a shared function (or import it) to avoid duplication
5. Implement `ChannelGateEvaluator.evaluate(channel: ResolvedChannel, context: ChannelGateContext): ChannelGateResult`
6. Channels without a gate always return `{ allowed: true }`
7. Channels with a gate delegate to the extracted condition evaluation logic
8. Inject a `CommandRunner` for `condition`-type gates (same pattern as `WorkflowExecutor`)

**Acceptance Criteria**:
- `ChannelGateEvaluator` correctly evaluates all 4 condition types: `always`, `human`, `condition`, `task_result`
- Gate-less channels always allow
- The evaluator is unit-testable with mock `CommandRunner`
- No duplication of condition evaluation logic between `WorkflowExecutor` and `ChannelGateEvaluator`

**Dependencies**: Task 1.2

**Agent Type**: coder

---

### Task 1.4: Unit Tests for ChannelGateEvaluator

**Description**: Write comprehensive unit tests for the new `ChannelGateEvaluator` class.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/channel-gate-evaluator.test.ts`
2. Test cases:
   - Gate-less channel always allows
   - `always` gate always allows
   - `human` gate blocks without approval, allows with approval
   - `condition` gate runs shell expression, allows on exit code 0
   - `condition` gate rejects on non-zero exit code
   - `condition` gate handles timeout
   - `task_result` gate matches prefix
   - `task_result` gate rejects non-matching prefix
   - `task_result` gate handles undefined task result
   - Invalid condition type returns disallowed
3. Use mock `CommandRunner` for all tests

**Acceptance Criteria**:
- All tests pass (`cd packages/daemon && bun test tests/unit/space/channel-gate-evaluator.test.ts`)
- Tests cover all 4 condition types plus gate-less channels
- Tests cover error paths (invalid expression, timeout, undefined task result)
- No real subprocesses are spawned in tests

**Dependencies**: Task 1.3

**Agent Type**: coder

---

### Task 1.5: Verify Shared Module Exports and Typecheck (folded into Tasks 1.1 and 1.2)

> **Note**: This task has been folded into the acceptance criteria of Tasks 1.1 and 1.2. The following verification steps are required as part of those tasks:
>
> - Verify `packages/shared/src/mod.ts` re-exports everything needed
> - Run `bun run typecheck` to verify no import errors
> - Run `bun run lint` to verify no lint errors
> - Ensure new types are accessible from `@neokai/shared`
>
> This is not a standalone task — it is a verification checklist completed as part of Tasks 1.1 and 1.2.

## Rollback Strategy

- This milestone is purely additive (new optional `gate` field on `WorkflowChannel`). No existing behavior is changed.
- No DB schema changes in this milestone.
- If issues arise, the `gate` field can be ignored by downstream code — channels without gates work identically to current behavior.
- The `ChannelGateEvaluator` class is new code with no impact on existing paths unless explicitly called.
