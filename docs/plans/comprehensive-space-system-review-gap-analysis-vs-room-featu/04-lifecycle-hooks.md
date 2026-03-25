# M4: Lifecycle Hooks + Advanced Runtime

> **⚠️ Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Acceptance Criteria

- [ ] Design document for lifecycle hook architecture is approved.
- [ ] Space step agents are bounced when they exit without creating a PR.
- [ ] Workflow transitions are blocked when advance hooks fail.
- [ ] Bypass markers allow skipping hooks for research tasks.

---

## Task 6a: Design Space Lifecycle Hook Architecture

- **Priority:** HIGH
- **Agent Type:** general
- **Dependencies:** Task 3 (dead loop detection -- see `02-runtime-reliability.md`)
- **Description:** Room's lifecycle hooks are deeply coupled to the Worker/Leader session group model. Space uses a fundamentally different model. This task produces a design document.

- **Files to analyze:**
  - `packages/daemon/src/lib/room/runtime/lifecycle-hooks.ts` -- all hook functions, `HookResult`, `WorkerExitHookContext`, `LeaderCompleteHookContext`, bypass markers
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- `handleSubSessionComplete()` (exit hooks integration point)
  - `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- `advance()` (advance hooks integration point)
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `processRunTick()` (run-level hooks)

- **Key architectural questions:**
  1. **Exit hooks** fire in `TaskAgentManager.handleSubSessionComplete()` after `setTaskStatus(stepTask.id, 'completed')`. If a hook fails, should we: (a) revert the status back to `in_progress`, or (b) prevent the completion in the first place by running hooks BEFORE `setTaskStatus`? Room runs hooks AFTER worker completes but BEFORE routing to leader.
  2. **Advance hooks** fire in `WorkflowExecutor.advance()` before the transition is committed. This is straightforward -- throw `WorkflowGateError` to block.
  3. **Shared workspace concurrency**: Multiple step agents may be creating PRs on the same repo simultaneously. Room avoids this with per-task worktrees. Space needs: (a) branch name coordination (prefix with task ID), or (b) locking, or (c) accept that PR creation may conflict and let agents retry.
  4. **Configuration surface**: Hooks should be configurable per-workflow-node (different steps may have different requirements). Default hooks should apply to all coding tasks.

- **Deliverable:** `docs/plans/space-lifecycle-hooks-design.md`

- **Acceptance Criteria:** Design document with: (a) hook-to-Space mapping table, (b) concurrency strategy, (c) configuration surface, (d) integration points, (e) implementation plan.

---

## Task 6b: Implement Core Space Exit Hooks

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** Task 6a (design approved), Task 3
- **Description:** Implement core exit hooks based on Task 6a's design.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/space-lifecycle-hooks.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- integrate hook runner

- **Interface design** (adapted from Room):
  ```ts
  interface SpaceHookResult {
    pass: boolean;
    bypassed?: boolean;
    reason?: string;
    bounceMessage?: string;
  }

  interface SpaceExitHookContext {
    workspacePath: string;
    taskId: string;
    stepNodeId: string;
    agentOutput?: string;
    workflowNodeId?: string;
  }

  // Core hooks to implement:
  async function checkSpaceNotOnBaseBranch(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;
  async function checkSpacePrExists(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;
  async function checkSpacePrSynced(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;

  // Gate runner:
  async function runSpaceExitGate(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;
  ```

- **Integration in `handleSubSessionComplete()`:**
  ```ts
  // After setTaskStatus succeeds, BEFORE notifying Task Agent:
  const hookResult = await runSpaceExitGate({ workspacePath, taskId, stepId, agentOutput });
  if (!hookResult.pass && hookResult.bounceMessage) {
    await taskManager.setTaskStatus(stepTask.id, 'in_progress', { error: hookResult.bounceMessage });
    // Inject bounce message into sub-session
    return;
  }
  ```

- **Edge cases:**
  - Hook function throws an exception -- catch, log, and bounce with a generic message.
  - Git/gh CLI not available -- hooks should gracefully fail and bounce with installation instructions.
  - Shared workspace: another agent modified the branch between hook check and action.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-lifecycle-hooks.test.ts`
  - Test scenarios: (a) pass when on feature branch, (b) bounce when on base branch, (c) pass when PR exists, (d) bounce when no PR, (e) pass when PR synced, (f) bounce when PR behind, (g) bypass markers skip hooks

- **Acceptance Criteria:** Space step agents that complete without creating a PR are bounced with a clear diagnostic.

---

## Task 6c: Implement Space Advance Hooks and Bypass Markers

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** Task 6a (design approved), Task 6b
- **Description:** Implement advance hooks and bypass markers based on Task 6a's design.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-lifecycle-hooks.ts` -- add advance hooks
  - `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- integrate into `advance()`

- **Hooks to implement:**
  ```ts
  async function checkSpacePrMerged(ctx, opts?): Promise<SpaceHookResult>;
  async function checkSpacePrIsMergeable(ctx, opts?): Promise<SpaceHookResult>;
  async function checkSpacePrHasReviews(ctx, opts?): Promise<SpaceHookResult>;
  async function runSpaceAdvanceGate(ctx, opts?): Promise<SpaceHookResult>;
  ```

- **Bypass markers:** Reuse Room's `BYPASS_GATES_MARKERS` constants (`RESEARCH_ONLY:`, `VERIFICATION_COMPLETE:`, etc.). Detect markers in the agent's output text (first/last N characters).

- **Integration in `WorkflowExecutor.advance()`:**
  ```ts
  // Before committing the transition:
  const hookResult = await this.runAdvanceHooks?.(context);
  if (hookResult && !hookResult.pass) {
    throw new WorkflowGateError(hookResult.reason ?? 'Advance blocked by hook');
  }
  ```

- **Stale PR cleanup:** Port `closeStalePr()` from Room. Call when a new PR is detected for a task that already had a PR (different PR URL).

- **Testing:**
  - Extend `packages/daemon/tests/unit/space/space-lifecycle-hooks.test.ts`
  - Test scenarios: (a) advance blocked when PR not merged, (b) advance allowed when PR merged, (c) advance blocked when PR has conflicts, (d) bypass markers skip hooks, (e) stale PR closed when new PR created

- **Acceptance Criteria:** Workflow transitions blocked by advance hooks. Bypass markers work.
