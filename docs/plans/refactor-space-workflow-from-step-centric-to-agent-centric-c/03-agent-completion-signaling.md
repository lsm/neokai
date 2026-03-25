# Milestone 3: Agent Completion Signaling

## Goal

Add explicit agent completion signaling to replace the implicit "all tasks completed on step = advance" model. Agents will explicitly report when they are done, enabling the all-agents-done completion detection in a later milestone.

## Scope

- Add `report_done` tool to step agents
- Track per-agent completion state in the session group
- Add completion state query capability
- Unit tests

## Tasks

### Task 3.1: Define Agent Completion State Types

**Description**: Create types for tracking per-agent completion within a workflow run.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`, add `SpaceSessionGroupMember.status` values: add `'done'` alongside existing `'active' | 'completed' | 'failed'`
   - `'done'` means the agent has finished its work and reported done (distinct from `'completed'` which means the session has ended)
2. Add optional `completionSummary?: string` field to `SpaceSessionGroupMember`
3. Add optional `doneAt?: number` (timestamp) field to `SpaceSessionGroupMember`

**Acceptance Criteria**:
- New member status values are defined
- Backward compatible (existing `'active' | 'completed' | 'failed'` values still work)
- TypeScript typecheck passes

**Dependencies**: None

**Agent Type**: coder

---

### Task 3.2: DB Migration for Completion Fields

**Description**: Add the completion-related columns to `space_session_group_members`.

**Subtasks**:
1. Add Migration 48 to:
   - Update the `status` CHECK constraint on `space_session_group_members` to include `'done'`
   - Add `completion_summary TEXT` column
   - Add `done_at INTEGER` column
2. Write a migration test following existing patterns
3. Update `packages/daemon/src/storage/repositories/space-session-group-repository.ts` to handle the new fields

**Acceptance Criteria**:
- Migration runs successfully on fresh and existing databases
- Repository methods can read/write the new fields
- Existing member CRUD is not affected
- Migration test passes

**Dependencies**: Task 3.1

**Agent Type**: coder

---

### Task 3.3: Add report_done Tool to Step Agent

**Description**: Add a `report_done` MCP tool to step agents, allowing them to explicitly signal completion with an optional summary.

**Subtasks**:
1. Create Zod schema `ReportDoneSchema` in `packages/daemon/src/lib/space/tools/step-agent-tool-schemas.ts`:
   ```
   { summary?: string }
   ```
2. In `packages/daemon/src/lib/space/tools/step-agent-tools.ts`, add `report_done` handler:
   - Updates the member status to `'done'` in the session group repository
   - Sets `completionSummary` and `doneAt` timestamp
   - Emits `spaceSessionGroup.memberUpdated` event via DaemonHub
3. Add `report_done` tool to the `createStepAgentMcpServer()` tool list
4. Update the step agent system prompt (in `packages/daemon/src/lib/space/agents/custom-agent.ts` if applicable, or in the spawn_step_agent message builder in task-agent-tools.ts) to mention `report_done`

**Acceptance Criteria**:
- Step agents have a `report_done` tool
- Calling `report_done` updates the member status in the DB
- Event is emitted for real-time UI updates
- The tool accepts an optional summary string

**Dependencies**: Tasks 3.2

**Agent Type**: coder

---

### Task 3.4: Add Query Completion State Capability

**Description**: Extend `list_peers` (and optionally add a new `check_completion` tool) to expose completion state of all group members, so agents can determine if all peers are done.

**Subtasks**:
1. Update `list_peers` handler in `step-agent-tools.ts` to include `doneAt` and `completionSummary` in the peer info response
2. Optionally add `status: 'done' | 'active' | 'completed' | 'failed'` to the peer response (already partially there)
3. Ensure the Task Agent's `list_group_members` tool also exposes completion state

**Acceptance Criteria**:
- `list_peers` shows which peers have reported done
- Task Agent's `list_group_members` shows completion state
- Completion state is queryable by any agent in the group

**Dependencies**: Tasks 3.2, 3.3

**Agent Type**: coder

---

### Task 3.5: Unit Tests for Agent Completion Signaling

**Description**: Write unit tests for the completion signaling system.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/agent-completion.test.ts`
2. Test cases:
   - `report_done` updates member status to 'done' in the DB
   - `report_done` sets completionSummary and doneAt
   - `report_done` emits memberUpdated event
   - `list_peers` includes completion state
   - Multiple agents can report done independently
   - Calling `report_done` twice is idempotent
3. Update existing step-agent-tools tests to verify `report_done` integration

**Acceptance Criteria**:
- All tests pass
- Completion signaling works correctly for single and multi-agent nodes
- No regressions in existing step-agent tool tests

**Dependencies**: Task 3.3

**Agent Type**: coder
