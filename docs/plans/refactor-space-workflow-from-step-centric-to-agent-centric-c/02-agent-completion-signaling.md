# Milestone 2: Agent Completion Signaling

## Goal

Add explicit agent completion signaling. Agents will explicitly report when they are done, enabling the all-agents-done completion detection in a later milestone. Agent state is tracked on `space_tasks` — no session group tables are used.

## Scope

- Add `report_done` tool to step agents
- Track per-agent completion state on `space_tasks`
- Add completion state query capability
- Add liveness guard with timeout for stuck agents
- Rename `slot_role` → `agent_name` on `space_tasks` (aligns with "no role" design)
- Unit tests

## Tasks

### Task 2.1: Agent Completion State on space_tasks

**Description**: Document that agent completion state is tracked on `space_tasks`, not on session group members. The `space_tasks` table already has `status`, `completed_at`, and `task_agent_session_id` — we add `completion_summary` for the agent's done report.

**Subtasks**:
1. Document that agent completion state is stored on `space_tasks`:
   - `status`: uses existing `'in_progress' | 'completed' | 'needs_attention' | 'cancelled'` values. When an agent reports done, status transitions to `'completed'`.
   - `completion_summary`: new column — stores the agent's optional summary when reporting done
   - `completed_at`: existing column — set when status transitions to `'completed'`
2. No new types needed on `SpaceSessionGroupMember` — that table is being removed entirely (Task 8.2)

**Acceptance Criteria**:
- Agent completion state is documented as living on `space_tasks`
- No new `SpaceSessionGroupMember` fields are added

**Dependencies**: None

**Agent Type**: coder

---

### Task 2.2: DB Migration — space_tasks Updates

**Description**: Add the `completion_summary` column and rename `slot_role` to `agent_name` on `space_tasks`.

**Subtasks**:
1. Add a migration (**use the next available migration number at implementation time**) to:
   - Add `completion_summary TEXT` column to `space_tasks` (nullable — stores agent's done report)
   - Rename `slot_role` column to `agent_name` on `space_tasks` (aligns with "no role" naming convention)
   - Update all code that reads/writes `slotRole` / `slot_role` to use `agentName` / `agent_name`
2. Write a migration test following existing patterns
3. No changes to `space_session_group_members` — that table is being dropped in Task 8.2

**Acceptance Criteria**:
- `completion_summary` column added to `space_tasks`
- `slot_role` renamed to `agent_name` on `space_tasks` — no "role" column remains
- Migration test passes
- All code that reads/writes `slotRole` is updated

**Dependencies**: Task 2.1

**Agent Type**: coder

---

### Task 2.3: Add report_done Tool to Step Agent

**Description**: Add a `report_done` MCP tool to step agents, allowing them to explicitly signal completion with an optional summary.

**Subtasks**:
1. Create Zod schema `ReportDoneSchema` in `packages/daemon/src/lib/space/tools/step-agent-tool-schemas.ts`:
   ```
   { summary?: string }
   ```
2. In `packages/daemon/src/lib/space/tools/step-agent-tools.ts`, add `report_done` handler:
   - Updates the task's `status` to `'completed'` in the `space_tasks` table (via task repository)
   - Sets `completion_summary` and `completed_at` timestamp
   - Emits a task update event via DaemonHub for real-time UI updates
3. Add `report_done` tool to the `createStepAgentMcpServer()` tool list
4. Update the step agent system prompt to mention `report_done`

**Acceptance Criteria**:
- Step agents have a `report_done` tool
- Calling `report_done` updates the task's status to `'completed'` in `space_tasks`
- Completion summary is persisted
- Event is emitted for real-time UI updates
- The tool accepts an optional summary string

**Dependencies**: Task 2.2

**Agent Type**: coder

---

### Task 2.4: Add Query Completion State Capability

**Description**: Extend `list_peers` (and optionally add a new `check_completion` tool) to expose completion state, so agents can determine if all peers are done.

**Subtasks**:
1. Update `list_peers` handler in `step-agent-tools.ts` to include completion state:
   - Query `space_tasks` WHERE `workflow_run_id = ? AND workflow_node_id = ?` to get all tasks on the current node
   - For each task, include: `agent_name`, `status`, `completion_summary`, `completed_at`
2. Optionally add `status` to the peer response (already partially there)
3. Ensure the Task Agent's `list_peers` tool also exposes completion state (query `space_tasks` by workflow run ID)

**Acceptance Criteria**:
- `list_peers` shows which peers have reported done
- Task Agent's `list_peers` shows completion state
- Completion state is queryable by any agent
- All queries use `space_tasks` directly (no session group traversal)

**Dependencies**: Task 2.2

**Agent Type**: coder

---

### Task 2.5: Unit Tests for Agent Completion Signaling

**Description**: Write unit tests for the completion signaling system.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/agent-completion.test.ts`
2. Test cases:
   - `report_done` updates task status to 'completed' in `space_tasks`
   - `report_done` sets completion_summary and completed_at
   - `report_done` emits task update event
   - `list_peers` includes completion state
   - Multiple agents can report done independently
   - Calling `report_done` twice is idempotent
3. Update existing step-agent-tools tests to verify `report_done` integration

**Acceptance Criteria**:
- All tests pass
- Completion signaling works correctly for single and multi-agent nodes
- No regressions in existing step-agent tool tests

**Dependencies**: Task 2.3

**Agent Type**: coder

---

### Task 2.6: Agent Liveness Guard — Timeout for report_done

**Description**: Add a timeout mechanism to prevent workflow runs from hanging indefinitely when an agent is alive but never calls `report_done` (e.g., agent crashes mid-task, hangs, runs out of context, or simply never decides it's done).

**Design**: Leverage the existing liveness detection infrastructure in `SpaceRuntime.processRunTick()`. The new timeout extends this to detect "alive but stuck" agents.

**Timeout strategy**:
- An agent is considered "potentially stuck" if ALL of the following are true:
  1. The agent's session is active (not crashed/disconnected)
  2. The agent's task status is `'in_progress'` (not `'completed'`, `'needs_attention'`, or `'cancelled'`)
  3. A configurable timeout has elapsed since the task was started or last updated (default: **10 minutes**)
- When an agent is detected as stuck:
  - The system auto-marks the task's status as `'completed'` with a system-generated completion summary: `"Auto-completed: all tasks finished but agent did not call report_done within {N} minutes"`
  - The `completed_at` timestamp is set to the auto-completion time
  - A warning event is emitted for real-time UI awareness
  - The workflow run is **not** escalated to `needs_attention` — this is a soft auto-completion

**Configuration**:
- Add a configurable timeout constant in `packages/daemon/src/lib/space/runtime/constants.ts`: `AGENT_REPORT_DONE_TIMEOUT_MS = 10 * 60 * 1000` (10 minutes)

**Subtasks**:
1. Create `autoCompleteStuckAgents(workflowRunId: string): Promise<AutoCompletedAgent[]>` in a new utility file `packages/daemon/src/lib/space/runtime/agent-liveness.ts`
2. In `SpaceRuntime.processRunTick()`, add a check that:
   - For each workflow run, queries `space_tasks` with status `'in_progress'`
   - For each in-progress task, checks if the time since the task's `created_at` (or `updated_at`) exceeds `AGENT_REPORT_DONE_TIMEOUT_MS`
   - If exceeded, auto-completes the task
3. Add unit tests:
   - Agent with no `report_done` within timeout → auto-completed
   - Agent with `report_done` called before timeout → not auto-completed
   - Agent with recently-updated task → not auto-completed (still working)
   - Multiple agents, some stuck and some not → only stuck ones auto-complete

**Acceptance Criteria**:
- Stuck agents are auto-completed after the timeout period
- Non-stuck agents (with recent activity or who called `report_done`) are unaffected
- The auto-completion emits an event for real-time UI awareness
- The timeout is configurable via a constant
- Unit tests cover all scenarios

**Dependencies**: Tasks 2.2, 2.3

**Agent Type**: coder

## Rollback Strategy

- **DB migration** (Task 2.2): Adds nullable column (`completion_summary`) and renames `slot_role` → `agent_name` on `space_tasks`. Both are reversible.
- **report_done tool** (Task 2.3): New tool added to step agents. Can be removed without affecting existing behavior.
- **Liveness guard** (Task 2.6): New logic in `processRunTick()`. Can be disabled with a one-line change.
