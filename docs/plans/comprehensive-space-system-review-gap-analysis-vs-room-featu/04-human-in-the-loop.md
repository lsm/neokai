# M4: Human-in-the-Loop

> **Design revalidation notice:** Before implementing any task, revalidate file paths, function signatures, and integration points against the current codebase.

**Milestone goal:** After this milestone, humans can approve workflow gates from the browser, respond to questions posed by Task Agents, pause and resume workflows, and route messages to specific agent sessions during execution.

**Scope:** Human gate approval UI, message routing to agents, workflow pause/resume, and the Space Agent's orchestration of human interactions.

---

## Task 4.1: Human Gate Approval UI

**Priority:** P0
**Agent type:** coder
**Depends on:** Task 1.2 (WorkflowRunView), Task 3.1 (real-time events)

### Description

The `human` condition type and `request_human_input` tool already exist in the backend. When a workflow run reaches a human gate, the run enters `needs_attention`. The Space Agent receives a notification. But there is no UI surface for the human to approve the gate and resume the workflow. This task adds the approval UI.

### Subtasks

1. Add a `spaceWorkflowRun.approveGate` RPC handler that:
   - Accepts `{ runId, gateNodeId? }`.
   - Sets `run.config.humanApproved = true`.
   - Resets run status from `needs_attention` to `in_progress`.
   - The `WorkflowGateError` handler in `SpaceRuntime.processRunTick()` already checks `humanApproved` -- no executor changes needed.
2. Add a "Gate Approval" banner to `WorkflowRunView`:
   - When `run.status === 'needs_attention'` and the reason contains "human" or "gate":
     - Show a prominent banner explaining that a human gate is blocking.
     - Show the gate condition description (from the workflow definition's `condition.description`).
     - Show an "Approve" button that calls `spaceWorkflowRun.approveGate`.
   - When the human approves, the SpaceRuntime tick loop picks up the status reset and the Task Agent retries `advance_workflow`.
3. Subscribe to `space.workflowRun.statusChanged` event (from Task 3.1) to auto-dismiss the banner when the run resumes.

### Files to modify/create

- `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` -- Add `approveGate` handler
- `packages/web/src/components/space/WorkflowRunView.tsx` -- Add gate approval banner
- `packages/web/src/lib/space-store.ts` -- Add `approveGate` action

### Implementation approach

The `humanApproved` flag in `run.config` is already consumed by `WorkflowExecutor.evaluateCondition()` (line ~241 of workflow-executor.ts). The executor re-reads the run from DB on every `advance()` call (line ~316). So setting `humanApproved = true` and resetting status to `in_progress` is sufficient -- the next tick will cause the Task Agent to retry `advance_workflow` and the gate will pass.

### Edge cases

- Run is in `needs_attention` for a non-gate reason (e.g., cycle cap) -- banner should not show "Approve" button for non-gate reasons. Parse the reason or check if the current step has a `human` condition.
- Multiple human gates in sequence -- each approval clears the flag. The next gate will require a new approval.
- Human approves while Task Agent is still processing -- the approval is persisted in DB, consumed on next advance.

### Testing

- Unit test: `approveGate` RPC sets `humanApproved` and resets status.
- Component test: Gate approval banner renders when run is blocked by human gate.
- Component test: Approve button calls RPC and banner dismisses on status change.
- Integration test: Full gate flow: workflow reaches human gate, human approves, workflow resumes.

### Acceptance criteria

- [ ] `spaceWorkflowRun.approveGate` RPC handler works
- [ ] Gate approval banner renders when human gate blocks the run
- [ ] Banner shows condition description
- [ ] Approve button sets humanApproved and resets status
- [ ] Workflow resumes after approval (Task Agent retries advance_workflow)
- [ ] Banner dismisses on status change
- [ ] Non-gate needs_attention does not show approval button
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 4.2: Human Response to Task Agent Questions

**Priority:** P1
**Agent type:** coder
**Depends on:** Task 1.3 (TaskDetailView), Task 4.1 (gate approval pattern)

### Description

The `request_human_input` tool (in Task Agent MCP tools) sets the task to `needs_attention` and stores the question in `task.currentStep`. When the human responds (via the existing `space.task.sendMessage` RPC), the message is injected into the Task Agent session. But there is no UI to surface the question to the human and collect their response.

### Subtasks

1. Add a "Question" banner to `TaskDetailView` (or the task list in `SpaceTaskPane`):
   - When a task has `status === 'needs_attention'` and `task.currentStep` contains a question (not a step name):
     - Show the question text prominently.
     - Show a text input for the human's response.
     - "Send Response" button that calls `space.task.sendMessage` RPC with the response.
   - After sending, the task transitions back to `in_progress` (the SpaceRuntime tick loop handles this -- see `processRunTick` logic for resetting needs_attention tasks, or the Task Agent resets it in `advance_workflow`).
2. Add a "Question" indicator in the task list items (e.g., a question mark icon) for tasks awaiting human input.
3. Subscribe to `space.task.statusChanged` event (from Task 3.1) to auto-dismiss the banner when the task resumes.

### Files to modify

- `packages/web/src/components/space/TaskDetailView.tsx` -- Add question response UI
- `packages/web/src/components/space/SpaceTaskPane.tsx` -- Add question indicator
- `packages/web/src/lib/space-store.ts` -- Add `sendTaskMessage` action if not exists

### Implementation approach

The `space.task.sendMessage` RPC already exists (in `space-task-message-handlers.ts`). The `request_human_input` tool stores the question in `task.currentStep` and `task.error`. Detect questions by checking if `task.status === 'needs_attention'` and `task.currentStep` does not match any step name in the workflow definition. The human's response is injected into the Task Agent session via the existing RPC, which triggers the Task Agent to continue.

### Edge cases

- Question on a task without a workflow (standalone task) -- show question banner using `task.currentStep` directly.
- Multiple tasks asking questions simultaneously -- show all banners, human can respond in any order.
- Task Agent sends a second question before human responds to the first -- update the banner text.

### Testing

- Component test: Question banner renders when task is needs_attention with a question.
- Component test: Response input sends message via RPC.
- Component test: Banner dismisses on status change.
- Component test: Question indicator shows in task list.
- Integration test: Full flow: Task Agent asks question, human responds, workflow resumes.

### Acceptance criteria

- [ ] Question banner renders with the task's question text
- [ ] Human can type and send a response
- [ ] Response is delivered to the Task Agent session
- [ ] Banner dismisses when task resumes
- [ ] Question indicator shows in task list
- [ ] Multiple simultaneous questions are handled
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 4.3: Workflow Pause and Resume

**Priority:** P1
**Agent type:** coder
**Depends on:** Task 4.1 (gate approval pattern)

### Description

Add the ability to pause a running workflow and resume it later. This is different from cancel -- paused workflows retain their state and can be resumed without starting over.

### Subtasks

1. Add `paused` to the `WorkflowRunStatus` type union.
2. Add a `spaceWorkflowRun.pause` RPC handler:
   - Sets run status to `paused`.
   - Does NOT cancel tasks -- in-progress tasks continue to completion, but no new tasks are spawned.
3. Add a `spaceWorkflowRun.resume` RPC handler:
   - Sets run status back to `in_progress`.
   - The next tick picks up the run and continues advancement.
4. Modify `SpaceRuntime.processRunTick()` to skip runs with `status === 'paused'` (do not spawn new tasks, do not advance).
5. Modify `SpaceRuntime.processRunTick()` to continue in-progress tasks even when the run is paused (do not interrupt running agents).
6. Add Pause/Resume buttons to `WorkflowRunView` (for in_progress runs).

### Files to modify

- `packages/shared/src/types/space.ts` -- Add `paused` to WorkflowRunStatus
- `packages/daemon/src/storage/schema/migrations.ts` -- Update CHECK constraint
- `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` -- Add pause/resume handlers
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Handle paused status in processRunTick
- `packages/web/src/components/space/WorkflowRunView.tsx` -- Add pause/resume buttons

### Implementation approach

Pause is a simple status flag change. The tick loop already skips runs that are not `in_progress`. Adding `paused` to the skip list is trivial. The key insight is that pause should NOT interrupt running agents -- it only prevents new task spawning and advancement. When resumed, the normal tick flow takes over.

### Edge cases

- Pause during a human gate -- valid, the human can still approve (and the pause blocks advancement until resumed).
- Pause while Task Agent is spawning a step agent -- the spawn completes, but no new spawns happen after.
- Pause during a cyclic workflow iteration -- iteration count is preserved.
- Daemon restart while paused -- `rehydrateExecutors()` includes paused runs (change the filter to include `paused`).

### Testing

- Unit test: `pause` RPC sets status to `paused`.
- Unit test: `resume` RPC sets status to `in_progress`.
- Unit test: Tick loop skips paused runs.
- Unit test: In-progress tasks continue during pause.
- Unit test: Rehydrate includes paused runs.
- Component test: Pause/Resume buttons render and work.

### Acceptance criteria

- [ ] `paused` status is supported in the type system and DB
- [ ] Pause stops new task spawning but does not interrupt running agents
- [ ] Resume restores normal tick behavior
- [ ] Daemon restart preserves paused state
- [ ] UI buttons work correctly
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 4.4: Space Agent Orchestration of Human Interactions

**Priority:** P2
**Agent type:** general (design + implementation)
**Depends on:** Tasks 4.1, 4.2, 4.3

### Description

Enhance the Space Agent's system prompt and notification handling to properly orchestrate human interactions during workflow execution. The Space Agent receives `SessionNotificationSink` events but may not handle all human-interaction scenarios correctly. This task ensures the Space Agent can:

1. Correctly interpret gate-blocked notifications and inform the human (not try to fix it autonomously).
2. Handle task failure notifications by summarizing the error for the human.
3. Respond to `request_human_input` events by relaying the question to the human.
4. Manage pause/resume requests from the human.

### Subtasks

1. Review and update the Space Agent system prompt (in `space-chat-agent.ts` or `global-spaces-agent.ts`) to include:
   - Clear instructions on how to handle each notification type.
   - Instructions to NOT attempt to resolve `human` gates autonomously.
   - Instructions to relay questions from Task Agents to the human.
   - Instructions to respect the space's autonomy level.
2. Add a `spaceWorkflowRun.updateConfig` RPC handler that allows the Space Agent (or human) to update run config (e.g., `maxIterations`, custom fields) without changing status.
3. Add integration between the Space Agent's tool set and the new human-interaction RPCs:
   - Space Agent can call `approveGate` on behalf of the human (in semi_autonomous mode).
   - Space Agent can call `pause`/`resume` in semi_autonomous mode.
4. Test the full orchestration flow: workflow reaches gate -> Space Agent notified -> Space Agent informs human -> human approves -> Space Agent confirms -> workflow resumes.

### Files to modify

- `packages/daemon/src/lib/space/agents/space-chat-agent.ts` -- Update system prompt
- `packages/daemon/src/lib/space/agents/global-spaces-agent.ts` -- Update system prompt
- `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` -- Add `updateConfig` handler
- `packages/daemon/src/lib/space/tools/global-spaces-tools.ts` -- Add workflow interaction tools

### Implementation approach

The Space Agent already receives `[TASK_EVENT]` notifications via `SessionNotificationSink`. The notifications include JSON payloads with structured data. Enhance the system prompt to parse and act on these events correctly. The key change is ensuring the Space Agent does NOT try to resolve human gates or rate limits autonomously in `supervised` mode.

### Edge cases

- Space Agent in `supervised` mode receives a gate notification -- should inform the human, not try to approve.
- Space Agent in `semi_autonomous` mode receives a task failure -- may retry once autonomously, then escalate.
- Multiple notifications arrive simultaneously -- the Space Agent should process them in order.

### Testing

- Manual test: Full orchestration flow with Coding workflow (human gate).
- Manual test: Semi-autonomous mode handles simple task failures.
- Prompt test: Verify system prompt correctly instructs the Space Agent on notification handling.

### Acceptance criteria

- [ ] Space Agent system prompt covers all notification types
- [ ] Space Agent does NOT resolve human gates in supervised mode
- [ ] Space Agent relays questions from Task Agents to humans
- [ ] Semi-autonomous mode handles simple failures autonomously
- [ ] `updateConfig` RPC allows modifying run config
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
