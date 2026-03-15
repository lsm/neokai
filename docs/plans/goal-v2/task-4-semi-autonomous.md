# Task 4: Semi-Autonomous Mode -- Narrowed Autonomy Slice

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: [Task 1](./task-1-schema-types.md)

## Description

Implement `semi_autonomous` mode for **coder and general tasks only**. Plan approval stays human-gated. This is the narrowest safe autonomy slice — Leader can complete non-planning work without human approval, but all plans still require human sign-off.

### 1. Scope limitation (explicit)

- Only applies to session groups where `workerRole === 'coder'` or `workerRole === 'general'`
- Planning tasks (`workerRole === 'planner'`) are ALWAYS supervised regardless of autonomy level
- Phase 2 planner gating (`isPlanApproved()` in `planner-agent.ts`) is unchanged — `approved` must still be set by human

### 2. Modify the approval flow (`room-runtime.ts`, `runLeaderCompleteGate` around line 843)

- Current flow: Leader calls `submit_for_review(prUrl)` -> `submittedForReview = true`, task moves to `review` status, PR URL/number recorded via `taskManager.reviewTask()` -> human calls `resumeLeaderFromHuman()` which sets `approved = true` and injects a continuation message into the Leader session -> Leader calls `complete_task`
- New flow for `semi_autonomous` AND `workerRole !== 'planner'`:
  - Leader still calls `submit_for_review(prUrl)` — this is kept because it records PR metadata (URL, PR number) on the task via `taskManager.reviewTask()`, which is needed for notification payloads and lifecycle hooks
  - `submit_for_review` returns its tool result normally (ending the current tool call, NOT the turn). The tool result message says "PR submitted. Auto-approving under semi-autonomous mode." instead of "Waiting for human approval"
  - **After the tool result is flushed** (not inline from `handleLeaderTool`), runtime auto-approves: sets `approved = true` in group metadata, sets `approvalSource = 'leader_semi_auto'`, then calls `resumeLeaderFromHuman()` with a machine-generated continuation message (e.g., "PR auto-approved under semi-autonomous mode. Proceed with merge and complete_task.")
  - **Timing constraint**: The auto-resume MUST be deferred until after the `submit_for_review` tool result has been returned and committed to the Leader session. Calling `resumeLeaderFromHuman()` inline from `handleLeaderTool` would inject a message while the original tool call is still being resolved, risking reentrancy/ordering issues. Implementation: use a post-tool-result callback (e.g., `queueMicrotask()`, `setTimeout(fn, 0)`, or an explicit post-tool hook in the runtime) to schedule the auto-approve + resume after the current tool handling completes.
  - **Idempotency guard**: Use `approvalSource` in group metadata as a guard — if `approvalSource` is already set (to `'leader_semi_auto'`), skip the auto-resume. This prevents duplicate resumes on retries or daemon restarts that re-process the same group state.
  - This reuses the existing continuation infrastructure — `resumeLeaderFromHuman()` injects a message into the Leader session, allowing it to continue and call `complete_task` in a **follow-up turn** (not the same turn as `submit_for_review`)
  - Lifecycle hooks still run: `checkLeaderPrMerged()` / `checkWorkerPrMerged()` — PR must actually be merged
- Implementation summary: in the `submit_for_review` branch of `handleLeaderTool`, after `taskGroupManager.submitForReview()` succeeds, check `goal.autonomyLevel`; if `semi_autonomous` and non-planner, return the modified tool result message and schedule the deferred auto-approve + resume via a post-tool callback

### 3. Record approval source in session group metadata

- Add `approvalSource?: 'human' | 'leader_semi_auto'` to `TaskGroupMetadata`
- Set to `'human'` when `resumeWorkerFromHuman()` sets `approved = true`
- Set to `'leader_semi_auto'` when runtime auto-approves in semi-autonomous mode
- This enables auditing of who approved what

### 4. Notification events

- Emit `goal.task.auto_completed` when a task completes without human review
- Payload: goal ID, task ID, task title, PR URL, files changed count, approval source
- Broadcast via MessageHub for UI consumption

### 5. Escalation policy

- Track `consecutive_failures` per mission (column from Task 1)
- When `consecutiveFailures >= maxConsecutiveFailures`: set goal status to `needs_human`
- Reset counter on successful task completion

## Acceptance Criteria

- `supervised` mode is completely unchanged (default behavior)
- `semi_autonomous` allows Leader to complete coder/general tasks without human approval
- Planning tasks always require human approval regardless of autonomy level
- `approvalSource` is correctly recorded in session group metadata
- Lifecycle hooks (`checkLeaderPrMerged`, `checkWorkerPrMerged`) still enforced
- Auto-resume is deferred (post-tool callback), not inline from `handleLeaderTool`
- Escalation triggers after consecutive failures; counter resets on success
- Notification events emitted with correct payload
- Unit tests for: gate behavior per autonomy level, planner exclusion, approval source recording, escalation counter
- Online tests for semi-autonomous coder task completion flow
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
