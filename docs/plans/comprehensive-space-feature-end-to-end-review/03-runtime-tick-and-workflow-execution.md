# Milestone 3: Runtime Tick and Workflow Execution

## Goal

Verify that task execution via runtime ticks works correctly: tasks are picked up, workflow executors are created, agents are spawned, and crash recovery functions properly.

## Scope

Happy path 5 (Task execution via runtime ticks).

## Tasks

### Task 3.1: Audit runtime tick loop for task pickup correctness

**Description:** Verify the 5-second tick loop in `space-runtime.ts` correctly picks up queued tasks, creates workflow executors, and starts node agent sessions. Identify any race conditions or dropped tasks.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/runtime/space-runtime.ts` focusing on the tick method and executor management.
2. Read `packages/daemon/src/lib/space/runtime/workflow-executor.ts` for how executors process workflow runs.
3. Check existing tests in `packages/daemon/tests/unit/space/space-runtime.test.ts` for tick loop coverage.
4. Add unit tests for: tick picks up new tasks with workflow runs, tick skips already-running tasks, multiple ticks do not duplicate executors, tick handles executor creation failure gracefully.
5. Run `cd packages/daemon && bun test tests/unit/space/space-runtime*` to verify.

**Acceptance Criteria:**
- Unit tests verify tick loop correctly manages executor lifecycle.
- No race conditions in task pickup are identified (or they are fixed).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 2.1

**Agent type:** coder

### Task 3.2: Verify workflow executor node progression

**Description:** Ensure the workflow executor correctly progresses through workflow nodes: evaluates gates, transitions between nodes, handles parallel branches, and completes runs.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/runtime/workflow-executor.ts` for graph navigation and condition evaluation.
2. Read `packages/daemon/src/lib/space/runtime/gate-evaluator.ts` and `gate-script-executor.ts`.
3. Read `packages/daemon/src/lib/space/runtime/completion-detector.ts` for completion model.
4. Check existing tests in `packages/daemon/tests/unit/space/` for workflow executor coverage.
5. Add unit tests for: linear node progression, parallel branch execution, gate evaluation (pass/fail), gate script execution, completion detection when all agents done.
6. Run tests to verify.

**Acceptance Criteria:**
- Unit tests cover linear, parallel, and gated workflow progressions.
- Gate evaluation (field-based and script-based) is tested.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 3.1

**Agent type:** coder

### Task 3.3: Verify crash recovery and rehydration

**Description:** The runtime rehydrates in-progress workflow runs on startup. Verify this works correctly: runs resume from the correct node, agent sessions are restored, and no work is lost.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/runtime/space-runtime.ts` for rehydration logic.
2. Read `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` for lifecycle management.
3. Check existing tests in `packages/daemon/tests/unit/space/space-runtime*` for recovery tests.
4. Add unit tests for: rehydrate picks up in-progress runs, rehydrate skips completed/cancelled runs, agent sessions are correctly associated after rehydration.
5. Run tests to verify.

**Acceptance Criteria:**
- Crash recovery correctly resumes in-progress workflow runs.
- Unit tests verify rehydration from various states.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 3.1

**Agent type:** coder

### Task 3.4: Verify task agent session lifecycle

**Description:** The Task Agent manages the lifecycle of a task's execution: spawning workflow runs, managing node agent sub-sessions, and handling completion. Verify this end-to-end.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` for session lifecycle.
2. Read `packages/daemon/src/lib/space/agents/task-agent.ts` for the task agent prompt.
3. Read `packages/daemon/src/lib/space/tools/task-agent-tools.ts` for task agent MCP tools.
4. Check existing tests in `packages/daemon/tests/online/space/task-agent-lifecycle.test.ts`.
5. Add unit tests for: task agent session creation, sub-session spawning for node agents, session cleanup on task completion, session association with task.
6. Run tests to verify.

**Acceptance Criteria:**
- Task agent session lifecycle is fully tested: creation, sub-session spawning, cleanup.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 3.1

**Agent type:** coder
