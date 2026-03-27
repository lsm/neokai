# Plan: Leader Agent — Add `complete_task(no_pr)` Capability

## Goal Summary

The `complete_task` flow requires either a PR (via `submit_for_review` → human approval → merge → `complete_task`) or a bypass marker. There is no first-class path for tasks that legitimately produce no PR (e.g., "create more tasks", "investigate CI failures", "research a topic"). Leaders are forced into the PR path or `fail_task`, neither of which fits.

> **Note:** Part A (`create_task`) was already implemented in PR #999 and merged to `dev`. This plan covers only Part B (`complete_task` with `no_pr`).

## Approach

Currently `complete_task` in `RoomRuntime.handleLeaderTool` (line 1282) enforces:
- For coder/general/planner roles: `group.approved` must be true
- If not approved: "Call `submit_for_review` with the PR URL first"

We add a bypass for tasks that produce no code changes. This requires changes across 3 files with precise type/contract updates.

**Design:** Add optional `no_pr` and `artifacts` fields to the leader's `complete_task` tool. When `no_pr=true`:
- The approval gate is bypassed
- `summary` and `artifacts` are combined into the existing `result` field
- `groupRepo.setApprovalSource(groupId, 'leader_no_pr')` is called to record the source
- For semi-autonomous goals, `goal.task.auto_completed` is emitted

**Type/contract changes required (3 files):**

**File 1: `session-group-repository.ts`**
```diff
 // Line 103 — SessionGroupMetadata interface
- approvalSource?: 'human' | 'leader_semi_auto';
+ approvalSource?: 'human' | 'leader_semi_auto' | 'leader_no_pr';

 // Line 672 — setApprovalSource method
- setApprovalSource(groupId: string, source: 'human' | 'leader_semi_auto' | null): void {
+ setApprovalSource(groupId: string, source: 'human' | 'leader_semi_auto' | 'leader_no_pr' | null): void {
```

**File 2: `room-runtime.ts`**
```diff
 // Line 1208-1215 — handleLeaderTool params type
 params: {
   message?: string;
   mode?: 'immediate' | 'defer';
   summary?: string;
   reason?: string;
   pr_url?: string;
   progress_summary?: string;
+  no_pr?: boolean;
+  artifacts?: string;
 }
```

**`complete_task` handler pseudocode** — shows exact placement, early return, and `setApprovalSource` ordering:

```ts
// In handleLeaderTool, case 'complete_task' at line 1282:
case 'complete_task': {
  const summary = params.summary ?? '';

  // --- NEW: no_pr bypass branch (before existing approval gate) ---
  if (params.no_pr) {
    const artifacts = params.artifacts ?? '';
    const combinedResult = [summary, artifacts].filter(Boolean).join('\n\n');

    // CRITICAL: set approvalSource BEFORE complete() so the group
    // metadata is persisted before the task status changes.
    this.groupRepo.setApprovalSource(groupId, 'leader_no_pr');

    // Lifecycle gate still runs for no_pr — blocks planning tasks without draft children
    {
      const hookTask = await this.taskManager.getTask(group.taskId);
      if (hookTask) {
        // ... same gate setup as existing path (lines 1308-1329) ...
        const gateResult = await runLeaderCompleteGate(hookCtx, this.hookOptions);
        if (!gateResult.pass) {
          this.groupRepo.setApprovalSource(groupId, null); // roll back on gate failure
          // ... same dead-loop check and bounce logic as existing path ...
          return jsonResult({ success: false, error: gateResult.reason });
        }
      }
    }

    await this.taskGroupManager.complete(groupId, combinedResult);
    this.cleanupMirroring(groupId, 'Task completed (no PR).');
    await this.emitTaskUpdateById(group.taskId);
    await this.emitGoalProgressForTask(group.taskId);

    // Semi-autonomous goal handling — same as existing path
    {
      const completeGoals = await this.goalManager.getGoalsForTask(group.taskId);
      const completeGoal = completeGoals[0] ?? null;
      if (completeGoal?.autonomyLevel === 'semi_autonomous') {
        if ((completeGoal.consecutiveFailures ?? 0) > 0) {
          await this.goalManager.updateConsecutiveFailures(completeGoal.id, 0);
        }
        if (this.daemonHub) {
          const completedTask = await this.taskManager.getTask(group.taskId);
          void this.daemonHub.emit('goal.task.auto_completed', {
            sessionId: `room:${this.roomId}`,
            roomId: this.roomId,
            goalId: completeGoal.id,
            taskId: group.taskId,
            taskTitle: completedTask?.title ?? '',
            prUrl: completedTask?.prUrl ?? '',
            approvalSource: group.approvalSource, // dynamic — will be 'leader_no_pr'
          });
        }
      }
    }

    await this.promoteDraftTasksIfPlanning(group.taskId);
    this.scheduleTick();
    return jsonResult({ success: true, message: 'Task completed successfully (no PR).' });
    // ★ EARLY RETURN — does NOT fall through to the existing approval gate below
  }

  // --- EXISTING: approval gate (unchanged for non-no_pr path) ---
  if (
    (group.workerRole === 'coder' || group.workerRole === 'general' || group.workerRole === 'planner') &&
    !group.approved
  ) {
    // ... existing approval gate logic (lines 1289-1303) ...
  }
  // ... rest of existing complete_task logic unchanged ...
}
```

```diff
 // Line 1374 — goal.task.auto_completed event condition
 // Widened for defense-in-depth (no_pr branch returns early before reaching this,
 // but this ensures correctness if future code paths also set approvalSource).
- if (group.approvalSource === 'leader_semi_auto' && this.daemonHub) {
+ if ((group.approvalSource === 'leader_semi_auto' || group.approvalSource === 'leader_no_pr') && this.daemonHub) {

 // Line 1383 — fix hardcoded approvalSource literal to use dynamic group value
 // BUG: currently hardcodes 'leader_semi_auto' even when approvalSource is 'human'.
- approvalSource: 'leader_semi_auto',
+ approvalSource: group.approvalSource!,
```

```diff
 // Line 1586-1590 — createLeaderCallbacks.completeTask
- completeTask: async (_groupId: string, summary: string, progressSummary?: string) => {
-   return this.handleLeaderTool(groupId, 'complete_task', {
-     summary,
-     progress_summary: progressSummary,
-   });
- },
+ completeTask: async (
+   _groupId: string,
+   summary: string,
+   progressSummary?: string,
+   no_pr?: boolean,
+   artifacts?: string
+ ) => {
+   return this.handleLeaderTool(groupId, 'complete_task', {
+     summary,
+     progress_summary: progressSummary,
+     no_pr,
+     artifacts,
+   });
+ },
```

**File 3: `leader-agent.ts`**
```diff
 // Line 61-65 — LeaderToolCallbacks.completeTask signature
 export interface LeaderToolCallbacks {
   ...
-  completeTask(groupId: string, summary: string, progressSummary?: string): Promise<LeaderToolResult>;
+  completeTask(groupId: string, summary: string, progressSummary?: string, no_pr?: boolean, artifacts?: string): Promise<LeaderToolResult>;
   ...
 }

 // Line 517-522 — createLeaderToolHandlers.complete_task wrapper
 // This wrapper bridges the MCP tool schema args to the LeaderToolCallbacks interface.
- async complete_task(args: {
-   summary: string;
-   progress_summary?: string;
- }): Promise<LeaderToolResult> {
-   return callbacks.completeTask(groupId, args.summary, args.progress_summary);
- },
+ async complete_task(args: {
+   summary: string;
+   progress_summary?: string;
+   no_pr?: boolean;
+   artifacts?: string;
+ }): Promise<LeaderToolResult> {
+   return callbacks.completeTask(groupId, args.summary, args.progress_summary, args.no_pr, args.artifacts);
+ },

 // Line 572-581 — complete_task MCP tool schema
 tool(
   'complete_task',
   'Accept the work and mark the task as completed',
   {
     summary: z.string().describe('...'),
     progress_summary: progressSummaryField,
+    no_pr: z.boolean().optional()
+      .describe('Set to true when the task produced no PR (e.g., research, investigation, task creation)'),
+    artifacts: z.string().optional()
+      .describe('Free-form description of what was produced or accomplished (use with no_pr=true)'),
   },
   (args) => handlers.complete_task(args)
 ),
```

**`no_pr` + planning task gate interaction:** The lifecycle gate check at line 1326 runs _after_ the approval gate. For `no_pr` completions, we skip the approval gate but still run the lifecycle gate. Planning tasks with `no_pr=true` are still blocked unless `draftTaskCount > 0`. Correct behavior — a planning task that didn't create child tasks should not be completable.

**What does NOT change:**
- No new DB columns — `result` field stores combined text; `prUrl`/`prNumber` stay null
- No schema migration needed
- `submit_for_review` + human approval path unchanged for PR-producing tasks

---

## Tasks

### Task 1: Add `no_pr` bypass to `complete_task`

**Description:** Extend the `approvalSource` type union and add the `no_pr` bypass to the `complete_task` handler chain. Changes span 3 files with precise diffs provided in the Approach section above.

**Subtasks:**

1. **`session-group-repository.ts`** — Extend `approvalSource` union type:
   - Line 103: Add `'leader_no_pr'` to the `approvalSource` discriminated union
   - Line 672: Add `'leader_no_pr'` to the `setApprovalSource` method parameter type

2. **`room-runtime.ts`** — Update handler params and runtime logic:
   - Line 1208-1215: Add `no_pr?: boolean` and `artifacts?: string` to the `handleLeaderTool` params type
   - Line 1282: In the `complete_task` case, add a `no_pr` branch _before_ the approval gate (line 1289). See the full pseudocode in the Approach section above. Key requirements:
     - **Early return** — the `no_pr` branch must `return jsonResult(...)` at the end to avoid falling through to the existing approval gate
     - **Ordering** — `setApprovalSource(groupId, 'leader_no_pr')` must be called BEFORE `taskGroupManager.complete()` so the group metadata is persisted before status changes
     - **Gate rollback** — if the lifecycle gate fails, roll back with `setApprovalSource(groupId, null)`
     - **Event payload** — `approvalSource` in the `goal.task.auto_completed` event uses the dynamic value from `group.approvalSource` (not a hardcoded string), so both `'leader_semi_auto'` and `'leader_no_pr'` are emitted correctly
   - Line 1374: Widen `goal.task.auto_completed` condition from `=== 'leader_semi_auto'` to `=== 'leader_semi_auto' || === 'leader_no_pr'`
   - Line 1383: Fix hardcoded `approvalSource: 'leader_semi_auto'` to `approvalSource: group.approvalSource!` — this is an existing bug where the event always reports `'leader_semi_auto'` even when the actual source is `'human'`
   - Line 1586-1590: Update `createLeaderCallbacks.completeTask` to accept and forward `no_pr` and `artifacts` params

3. **`leader-agent.ts`** — Update tool schema, handler wrapper, and callback interface:
   - Line 61-65: Update `LeaderToolCallbacks.completeTask` signature to include `no_pr?: boolean` and `artifacts?: string`
   - Line 517-522: Update `createLeaderToolHandlers.complete_task` wrapper to accept and forward `no_pr` and `artifacts` from MCP args to the callback
   - Line 572-581: Add `no_pr` and `artifacts` fields to the `complete_task` MCP tool schema

**Acceptance criteria:**
- `approvalSource` type in `session-group-repository.ts` accepts `'leader_no_pr'`
- `handleLeaderTool` params type accepts `no_pr` and `artifacts`
- `LeaderToolCallbacks.completeTask` signature accepts `no_pr` and `artifacts`
- `createLeaderToolHandlers.complete_task` wrapper forwards `no_pr` and `artifacts`
- `complete_task` MCP tool schema includes `no_pr` and `artifacts` fields
- Leader can call `complete_task` with `no_pr=true, artifacts="..."` to bypass PR requirement
- `groupRepo.setApprovalSource(groupId, 'leader_no_pr')` is called before `taskGroupManager.complete()`
- When `no_pr=true`, task completes with `status='completed'` and `result` contains summary + artifacts
- When `no_pr` absent/false, existing behavior unchanged (approval gate enforced)
- `goal.task.auto_completed` fires for both `'leader_semi_auto'` and `'leader_no_pr'`, with correct dynamic `approvalSource` in the event payload
- Planning tasks with `no_pr=true` still blocked by draft-child gate

**Dependencies:** None

**Agent type:** coder

---

### Task 2: Update leader system prompt for `no_pr` capability

**Description:** Update `leaderToolContractSection()` in `leader-agent.ts` to document the `no_pr` flag. The system prompt organizes tools into 3 categories (Review Tools, Task Management Tools, Context Tools).

**Subtasks:**
1. Update `complete_task` description in "Review Tools" to document `no_pr` and `artifacts`:
   - When to use `no_pr`: research, investigation, meta-tasks ("create more tasks"), any work without code changes
   - When NOT to use `no_pr`: coding tasks that should produce a PR
   - `artifacts` describes what was accomplished/produced

**Acceptance criteria:**
- `complete_task(no_pr, artifacts)` documented in Review Tools section
- Existing prompt tests pass (the `buildLeaderSystemPrompt` test at line 145 in `leader-agent.test.ts` checks for tool names)

**Dependencies:** Task 1 (the capability must be implemented before documenting)

**Agent type:** coder

---

### Task 3: Add tests for `complete_task(no_pr)`

**Description:** Add tests to the file that already tests `handleLeaderTool`'s `complete_task` scenarios.

**Subtasks — `packages/daemon/tests/unit/room/room-runtime-leader-tools.test.ts`:**

The `handleLeaderTool` describe block at line 22 already tests `complete_task` scenarios (lines 23, 40, 91, 120, 169). Add new tests in this describe block:

- `complete_task` with `no_pr=true, artifacts="..."` succeeds without `group.approved`
- `complete_task` without `no_pr` still fails when `group.approved` is false (regression guard)
- `no_pr` completion stores combined summary+artifacts in task `result` field
- `prUrl`/`prNumber` remain null for no_pr completions
- `groupRepo.getGroup(groupId).approvalSource` equals `'leader_no_pr'` after no_pr completion
- Semi-autonomous goal emits `goal.task.auto_completed` with `approvalSource: 'leader_no_pr'`
- Planning task with `no_pr=true` still fails the draft-child lifecycle gate

**Acceptance criteria:**
- All existing tests pass
- `complete_task(no_pr)` covered: bypass, result storage, approvalSource persistence, event emission, planning gate

**Dependencies:** Task 1 (sequential — tests require implementation to be complete)

**Agent type:** coder

---

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/src/lib/room/state/session-group-repository.ts` | Extend `approvalSource` type union to include `'leader_no_pr'` (lines 103, 672) |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | Add `no_pr`/`artifacts` to `handleLeaderTool` params; add `no_pr` bypass in `complete_task` with early return; fix hardcoded `approvalSource` at line 1383; widen `goal.task.auto_completed` condition; update `createLeaderCallbacks.completeTask` to forward new params |
| `packages/daemon/src/lib/room/agents/leader-agent.ts` | Add `no_pr`/`artifacts` to `complete_task` MCP tool schema; update `createLeaderToolHandlers.complete_task` wrapper; update `LeaderToolCallbacks.completeTask` signature; update `leaderToolContractSection()` prompt |
| `packages/daemon/tests/unit/room/room-runtime-leader-tools.test.ts` | Add `complete_task(no_pr)` tests |
