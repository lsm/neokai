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
7. Add unit tests:
   - Gate blocks delivery and returns correct error
   - RPC handler approves/rejects correctly
   - Status transitions are correct
   - `request_human_input` tool sends correct notification

**Acceptance Criteria**:
- Workflow pauses at Plan → Code gate and transitions to `waiting_for_approval` status
- `spaceWorkflowRun.approveGate` RPC handler works correctly
- After approval, workflow resumes and coder starts automatically
- After rejection, workflow transitions to `failed` with `humanRejected` reason
- `request_human_input` tool notifies the frontend
- Unit tests cover all state transitions and RPC flows

**Depends on**: Task 2.1 (extended workflow with human gate defined)

**Agent type**: coder

---

### Task 5.2: Implement Human Gate Frontend (Approval UI)

**Description**: Build the frontend UI components that display the human gate state and allow the human to approve or reject.

**Owner**: This task owns ALL frontend UI for the human gate.

**Subtasks**:
1. Subscribe to `workflow_run_status_changed` live query events in the Space chat to detect `waiting_for_approval` status
2. When a `waiting_for_approval` event arrives:
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
1. Audit the Space chat agent's intent recognition: verify it can parse a human request like "implement user authentication" and decide to create a task + start a workflow
2. Verify the workflow selection logic:
   - The agent calls `suggest_workflow` (or uses its built-in logic) to pick `CODING_WORKFLOW_V2` for coding tasks
   - If the request is ambiguous, the agent asks the human for clarification before starting
3. Verify the task creation flow:
   - Agent calls `create_standalone_task` with the human's description as the task body
   - Task is persisted in the database
4. Verify the workflow run start:
   - Agent calls `start_workflow_run` with the correct workflow ID and task ID
   - The first node (Plan) gets spawned and receives the task
5. Test the end-to-end conversation flow: human describes work → Space Agent creates task → workflow starts → Plan node activates → human gate fires
6. Add unit test for the Space Agent's task creation and workflow start decision logic

**Acceptance Criteria**:
- Human can describe work in the Space chat and have it automatically routed to a workflow
- Task is created with proper description and context from the conversation
- Workflow run starts with `CODING_WORKFLOW_V2`
- Plan node agent receives the task and begins working
- If the request is ambiguous, the agent asks for clarification
- Unit tests cover the conversation-to-task-to-workflow flow

**Depends on**: Task 5.2 (human gate UI must exist for the full entry-to-gate flow)

**Agent type**: coder
