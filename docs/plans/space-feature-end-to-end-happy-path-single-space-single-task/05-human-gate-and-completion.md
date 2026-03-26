# Milestone 5: Human Gate and Completion Flow

## Goal and Scope

Build the full-stack human gate UX so humans can see when a workflow is waiting for approval, understand what's being requested, and approve or reject. Wire the completion flow so the Task Agent reports final status to the human. This milestone makes the space "human-in-a-loop" end-to-end.

## Human Gate UX Specification

### What the human sees
1. **Chat message** from the Space Agent: "The plan is ready for your review. [View Plan](link) — Type 'approve' or click the button below."
2. **Workflow view indicator**: The workflow visualization shows the Plan node as "completed", the Plan→Code channel as "waiting for approval" (highlighted/pulsing), and the Code node as "blocked".
3. **Action button** (optional, MVP is chat-based): An "Approve" / "Reject" button appears in the workflow view or in the chat message area.

### How the human approves
1. **Primary mechanism**: Type "approve" (or "yes", "ok", "looks good") in the Space chat. The Space chat agent parses the message and calls the approval RPC.
2. **RPC mechanism**: `spaceWorkflowRun.approveGate` RPC handler that accepts `{ runId, channelId, decision: 'approve' | 'reject' }`.
3. **State transition**: The RPC handler sets `humanApproved: true` on the workflow run's config (or `humanRejected: true`), which the `ChannelGateEvaluator` checks on next gate evaluation.

### What happens on rejection
- The workflow run transitions to `failed` status with reason `humanRejected`.
- The human can then provide feedback and restart, or create a new task.

### Post-rejection recovery
After a human rejects at the gate, the human has two recovery options:
1. **Restart the same run**: Call `spaceWorkflowRun.restart` RPC with `{ runId }`. This transitions the run from `failed` back to `running`, resets the blocked node to `pending`, and resumes the workflow from the node that was blocked (the Plan node, since that's where the human gate was). The iteration counter does NOT reset on restart. If the human wants to provide feedback to the planner before restarting, they can type a message in the Space chat, which will be delivered to the Plan node on restart.
2. **Create a new task**: The human describes new work or a revised request in the Space chat, and the Space chat agent creates a new task and workflow run from scratch. The old rejected run stays as `failed` for history.

## Tasks

### Task 5.1: Implement Human Gate Backend (Pause/Resume/State)

**Description**: Implement the full backend for the human gate: blocking, state transitions, RPC handler, and notification to the human.

**Owner**: This task owns ALL backend logic for the human gate.

**Subtasks**:
1. Audit `ChannelGateEvaluator` for `human` type gates — verify it checks the workflow run's config for human approval status
2. Implement `ChannelRouter.deliverMessage()` behavior for human gates: return a `ChannelGateBlockedError` with metadata (channelId, runId, gate type)
3. Implement the `spaceWorkflowRun.approveGate` RPC handler:
   - Accepts `{ runId, channelId, decision: 'approve' | 'reject' }`
   - Validates that the run is in `waiting_for_approval` status and the channel has a `human` gate
   - Updates run config: sets `humanApproved: true` or `humanRejected: true`
   - Triggers a re-evaluation of the blocked channel (resume the workflow tick loop)
4. Implement the `request_human_input` MCP tool for the Task Agent:
   - Tool available to the Task Agent session
   - Called when a human gate blocks a channel
   - Sends a notification event (`human_gate_blocked`) to the frontend
   - Parameters: `{ runId, channelId, message: string }` — the message describes what the human needs to approve
5. Add workflow run status transitions:
   - `running` → `waiting_for_approval` when a human gate blocks
   - `waiting_for_approval` → `running` when human approves
   - `waiting_for_approval` → `failed` when human rejects (reason: `humanRejected`)
6. Persist the `waiting_for_approval` status and the gate metadata in the workflow run record
7. Implement the `spaceWorkflowRun.restart` RPC handler for post-rejection recovery:
   - Accepts `{ runId }`
   - Validates that the run is in `failed` status with reason `humanRejected`
   - Transitions the run back to `running` status
   - Resets the blocked node to `pending` status
   - Resumes the workflow from the blocked node (does NOT reset iteration counter)
   - The human can type feedback in the Space chat before restarting — this feedback is delivered to the node on restart
8. Add unit tests:
   - Gate blocks delivery and returns correct error
   - RPC handler approves/rejects correctly
   - Status transitions are correct
   - `request_human_input` tool sends correct notification
   - Restart RPC: reject → restart → node reactivates → iteration counter preserved

**Acceptance Criteria**:
- Workflow pauses at Plan → Code gate and transitions to `waiting_for_approval` status
- `spaceWorkflowRun.approveGate` RPC handler works correctly
- After approval, workflow resumes and coder starts automatically
- After rejection, workflow transitions to `failed` with `humanRejected` reason
- `spaceWorkflowRun.restart` RPC handler recovers from rejection without resetting iteration counter
- `request_human_input` tool notifies the frontend
- Unit tests cover all state transitions and RPC flows

**Depends on**: Task 2.1 (extended workflow with human gate defined)

**Agent type**: coder

---

### Task 5.2: Implement Human Gate Frontend (Approval UI)

**Description**: Build the frontend UI components that display the human gate state and allow the human to approve or reject.

**Owner**: This task owns ALL frontend UI for the human gate.

**Subtasks**:
1. On Space chat load, **query the current workflow run status** from the DB/repo (not just subscribe to events). If a workflow run is in `waiting_for_approval` state when the chat loads, immediately display the approval UI. This handles the case where the human approves before the frontend subscription is active, or where the human refreshes the page.
2. Subscribe to `workflow_run_status_changed` live query events for real-time updates while the chat is open
3. When a `waiting_for_approval` state is detected (either from initial query or live event):
   - Display a system message in the Space chat: "Plan is ready for your review. Waiting for your approval."
   - Show the gate context: which node completed, what the next step is
3. Implement chat-based approval parsing:
   - When the human types a message in the Space chat while the workflow is in `waiting_for_approval`:
   - Parse the message for approval intent ("approve", "yes", "ok", "looks good", "go ahead")
   - Call `spaceWorkflowRun.approveGate` RPC with the decision
   - Show confirmation: "Plan approved. Starting coder..."
4. Implement the workflow view gate indicator (optional MVP enhancement):
   - Show the Plan→Code channel as "waiting" with a visual indicator
   - Show a small "Approve" / "Reject" button near the gate
5. Handle rejection flow:
   - Parse rejection intent ("reject", "no", "start over")
   - Call `spaceWorkflowRun.approveGate` with `decision: 'reject'`
   - Show confirmation: "Plan rejected. Workflow stopped."

**Reference**: Look at existing Space chat UI in `packages/web/src/` — specifically the space chat components and the workflow visualization components. The Space chat likely already has message rendering infrastructure; this task adds gate-specific message types and action handlers.

**Acceptance Criteria**:
- Human sees a system message when the workflow is waiting for approval
- Human can approve by typing in the Space chat
- Human can reject by typing in the Space chat
- Workflow view shows gate indicator (if MVP scope allows)
- After approval/rejection, confirmation message appears
- Unit tests (Vitest) for approval intent parsing logic

**Depends on**: Task 5.1 (backend RPC handler must exist)

**Agent type**: coder

---

### Task 5.3: Implement Completion Notification and Summary

**Description**: When the workflow run reaches the Done node (all agents report done), the Task Agent should produce a final summary for the human: what was done, current PR status, any open issues, and next steps.

**Subtasks**:
1. Verify `CompletionDetector` correctly detects when all agents in the workflow run have completed
2. Ensure `SpaceRuntime` transitions the workflow run to `completed` status
3. Verify the notification sink fires `workflow_run_completed` event
4. Ensure the Task Agent session receives the completion notification
5. Update the Task Agent prompt to produce a human-readable summary on completion:
   - What was implemented (from Coder's result)
   - PR link and status (open, merged, review requested)
   - Review summary (from Reviewer's result)
   - QA verification status
   - Suggested next steps
6. Test that the Space chat agent receives and surfaces the summary to the human

**Acceptance Criteria**:
- Workflow run transitions to `completed` when all agents finish
- Task Agent produces a summary message
- Space chat agent surfaces the summary to the human
- Notification events are properly emitted
- Unit tests verify completion detection and summary flow

**Depends on**: Task 4.2 (QA agent in workflow — full 5-node pipeline exists)

**Agent type**: coder

---

### Task 5.4: Space Chat Agent Task Creation from Conversation

**Description**: Ensure the Space chat agent can create a task from a human's conversational request and automatically start the appropriate workflow run. This is the "entry point" of the happy path.

**Reference implementation**: `packages/daemon/src/lib/space/agents/space-chat-agent.ts` — the Space chat agent already has MCP tools for `start_workflow_run`, `create_standalone_task`, `suggest_workflow`, and `list_workflows`. This task verifies and fixes the end-to-end flow.

**Subtasks**:
1. Audit the Space chat agent's intent recognition in `space-chat-agent.ts`:
   - Verify the agent's system prompt instructs it to call `create_standalone_task` followed by `start_workflow_run` when it detects a coding task request
   - Verify the workflow selection logic: the agent calls `suggest_workflow` (or uses its built-in logic) to pick `CODING_WORKFLOW_V2` for coding tasks
   - If the request is ambiguous ("fix the thing"), the agent asks the human for clarification before creating a task
   - If no matching workflow is found, the agent tells the human and suggests available workflows
2. Verify the task creation flow:
   - Agent calls `create_standalone_task` with the human's description as the task body
   - Task is persisted in the database
3. Verify the workflow run start:
   - Agent calls `start_workflow_run` with the correct workflow ID and task ID
   - The first node (Plan) gets spawned and receives the task
4. Test the end-to-end conversation flow: human describes work → Space Agent creates task → workflow starts → Plan node activates → human gate fires → human approves via RPC (Task 5.1 backend)
5. Add unit test for the Space Agent's task creation and workflow start decision logic

**Acceptance Criteria**:
- **Verifiable criterion**: When the human sends a message containing a clear coding task description (e.g., "implement user authentication"), the Space chat agent calls `create_standalone_task` followed by `start_workflow_run` with `CODING_WORKFLOW_V2` within the same conversation turn.
- **Verifiable criterion**: Task is created with the human's exact description as the task body, persisted in the DB.
- **Verifiable criterion**: Workflow run starts with status `running` and the Plan node activates with status `pending`.
- **Verifiable criterion**: When the human sends an ambiguous request ("fix the thing"), the agent responds with a clarification question and does NOT create a task.
- **Verifiable criterion**: The workflow run hits the human gate on Plan → Code and transitions to `waiting_for_approval` status (provable via Task 5.1's RPC handler).
- Unit tests cover: task creation on clear request, no task creation on ambiguous request, correct workflow selection

**Depends on**: Task 5.1 (human gate RPC backend must exist — the conversation entry point needs the workflow to actually run and hit the gate to prove the full flow; does NOT depend on Task 5.2/frontend)

**Agent type**: coder
