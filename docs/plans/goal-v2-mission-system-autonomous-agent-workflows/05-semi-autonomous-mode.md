# Milestone 5: Semi-Autonomous Mode

## Milestone Goal

Implement `semi_autonomous` autonomy level for coder and general tasks: the Leader auto-approves without waiting for human input, uses a deferred post-tool callback to avoid reentrancy, records `approvalSource` in session group metadata, and escalates to `needs_human` after consecutive failures. Planning tasks remain supervised regardless.

## Tasks

### Task 5.1: Auto-Approval Gate and Escalation Logic

**Agent**: coder
**Description**: Modify the `submit_for_review` branch of `handleLeaderTool` in `RoomRuntime` to auto-approve coder/general tasks when the goal's `autonomyLevel` is `semi_autonomous`. Add `approvalSource` to `TaskGroupMetadata`. Add consecutive-failure tracking and escalation.

**Subtasks** (ordered implementation steps):

1. Locate `TaskGroupMetadata` (in `packages/daemon/src/lib/room/state/session-group-repository.ts` or a shared types file) and add:
   ```ts
   approvalSource?: 'human' | 'leader_semi_auto';
   ```

2. In the `handleLeaderTool` function in `packages/daemon/src/lib/room/runtime/room-runtime.ts`, find the `submit_for_review` tool branch (around the area that calls `taskGroupManager.submitForReview()`). After `submitForReview()` succeeds:
   a. Fetch the goal for this task (via `this.goalManager.getGoal(goalId)`)
   b. Determine worker role from group metadata (`workerRole`)
   c. If `goal.autonomyLevel === 'semi_autonomous'` AND `workerRole !== 'planner'`:
      - Return a modified tool result text: `"PR submitted. Auto-approving under semi-autonomous mode."`
      - Schedule a post-tool callback using `queueMicrotask(() => this.autoApproveTask(groupId, taskId))` (or `setTimeout(fn, 0)` as fallback). The callback MUST NOT run inline within `handleLeaderTool` to avoid reentrancy.
   d. Otherwise (supervised or planner): existing behavior unchanged.

3. Implement `autoApproveTask(groupId, taskId)` private method:
   a. Idempotency guard: read group metadata; if `approvalSource` is already set, log and return immediately (prevents double-resume on retry or restart)
   b. Set `approvalSource = 'leader_semi_auto'` in group metadata via `groupRepo.updateMetadata()`
   c. Set `approved = true` in group metadata
   d. Call `resumeLeaderFromHuman(taskId, "PR auto-approved under semi-autonomous mode. Proceed with merge and complete_task.")` -- this injects the continuation message into the Leader session so it runs in a **follow-up turn**

4. Update `resumeWorkerFromHuman` (where human approvals set `approved = true`) to also set `approvalSource = 'human'` in group metadata.

5. Add `DaemonEventMap` entry for `goal.task.auto_completed` in `packages/daemon/src/lib/daemon-hub.ts`:
   ```ts
   'goal.task.auto_completed': {
     sessionId: string;  // 'room:${roomId}'
     roomId: string;
     goalId: string;
     taskId: string;
     taskTitle: string;
     prUrl?: string;
     approvalSource: 'leader_semi_auto';
   };
   ```

6. Emit `goal.task.auto_completed` in `autoApproveTask` after the resume call succeeds.

7. Consecutive-failure escalation -- update the task completion/failure paths in `RoomRuntime`:
   a. On successful task completion for a `semi_autonomous` goal: reset `consecutive_failures` to 0 via `GoalManager.updateGoal(goalId, { consecutiveFailures: 0 })`
   b. On task failure (`needs_attention`) for a `semi_autonomous` goal: increment `consecutive_failures` via `GoalManager.updateGoal(goalId, { consecutiveFailures: goal.consecutiveFailures + 1 })`; if `consecutiveFailures >= goal.maxConsecutiveFailures`, call `GoalManager.needsHumanGoal(goalId)` and emit `goal.updated`

8. Verify lifecycle hooks still run: `checkLeaderPrMerged()` / `checkWorkerPrMerged()` must not be bypassed by the auto-approval path.

9. Write unit tests in `packages/daemon/tests/unit/room/`:
   - Auto-approve fires for `semi_autonomous` coder task (checks group metadata after)
   - Auto-approve does NOT fire for `supervised` goal
   - Auto-approve does NOT fire for `planner` task even with `semi_autonomous`
   - Idempotency: calling `autoApproveTask` twice does not double-resume
   - `approvalSource` is set to `'human'` on human approval, `'leader_semi_auto'` on auto
   - Consecutive failure counter increments on failure, resets on success
   - Escalation to `needs_human` when `consecutiveFailures >= maxConsecutiveFailures`

10. Write an online test at `packages/daemon/tests/online/room/room-semi-autonomous.test.ts` covering a coder task completing end-to-end without human approval.

**Acceptance Criteria**:
- `supervised` mode is completely unchanged
- `semi_autonomous` auto-approves coder/general tasks via deferred callback (not inline)
- Planning tasks always require human approval regardless of `autonomyLevel`
- `approvalSource` is correctly set in session group metadata for both human and auto approval
- Lifecycle hooks (`checkLeaderPrMerged`, `checkWorkerPrMerged`) still run
- `goal.task.auto_completed` event is emitted with correct payload
- Consecutive failure counter increments/resets correctly
- Escalation to `needs_human` fires when threshold reached
- All unit and online tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 1 (types, especially `AutonomyLevel`), Milestone 2 (schema for `consecutiveFailures`/`maxConsecutiveFailures` columns and GoalManager update methods)
