# Milestone 5: Human Gate and Completion Flow

## Goal and Scope

Wire the human gate on plan approval to properly pause the workflow and resume on human signal. Ensure the Task Agent reports final status to the human when the workflow completes. This milestone makes the space "human-in-a-loop" end-to-end.

## Tasks

### Task 5.1: Fix Human Gate Pause/Resume in Space Workflow

**Description**: The `CODING_WORKFLOW_V2` has a `human` gate on the Plan -> Code channel. When the planner completes, the channel should block delivery until a human approves. The current implementation must be verified and fixed to ensure:

1. The workflow run transitions to a blocked/waiting state when hitting a human gate
2. The human can approve via the Space chat (or RPC) to unblock the gate
3. After approval, the channel delivers the message and the coder starts

**Subtasks**:
1. Audit `ChannelGateEvaluator` for `human` type gates -- verify it checks `run.config.humanApproved`
2. Verify `ChannelRouter.deliverMessage()` returns a `ChannelGateBlockedError` for human gates
3. Ensure the Task Agent surfaces the human gate via `request_human_input` tool
4. Verify the human approval flow: human sends message -> Task Agent receives -> sets `humanApproved` in run config -> retries gate
5. Test the full pause/resume cycle: planner finishes -> gate blocks -> human approves -> coder starts
6. Add unit test for human gate blocking and unblocking

**Acceptance Criteria**:
- Workflow pauses at Plan -> Code gate until human approves
- Human can approve via Space chat or RPC
- After approval, coder starts automatically
- Workflow run status reflects the waiting state
- Unit tests cover the gate blocking and approval flow

**Depends on**: Task 2.1 (extended workflow with human gate)

**Agent type**: coder

---

### Task 5.2: Implement Completion Notification and Summary

**Description**: When the workflow run reaches the Done node (all agents report done), the Task Agent should produce a final summary for the human: what was done, current PR status, any open issues, and next steps.

**Subtasks**:
1. Verify `CompletionDetector` correctly detects when all agents in the workflow run have completed
2. Ensure `SpaceRuntime` transitions the workflow run to 'completed' status
3. Verify the notification sink fires `workflow_run_completed` event
4. Ensure the Task Agent session receives the completion notification
5. Update the Task Agent prompt to produce a human-readable summary on completion:
   - What was implemented (from Coder's result)
   - PR link and status (open, merged, review requested)
   - Review summary (from Reviewer's result)
   - QA verification status
   - Suggested next steps
6. Test that the Space chat agent receives and surfaces the summary

**Acceptance Criteria**:
- Workflow run transitions to 'completed' when all agents finish
- Task Agent produces a summary message
- Space chat agent surfaces the summary to the human
- Notification events are properly emitted
- Unit tests verify completion detection and summary flow

**Depends on**: Task 4.2 (QA agent in workflow)

**Agent type**: coder

---

### Task 5.3: Space Chat Agent Task Creation from Conversation

**Description**: Ensure the Space chat agent can create a task from a human's conversational request and automatically start the appropriate workflow run. This is the "entry point" of the happy path.

**Subtasks**:
1. Verify the Space chat agent can parse a human request like "implement user authentication" and call `start_workflow_run` with the correct workflow ID
2. Ensure the task description includes all context from the conversation
3. Verify the workflow run starts and the first node (Plan) gets spawned
4. Test the end-to-end conversation flow: human describes work -> Space Agent creates task -> workflow starts -> Plan node activates
5. Add unit test for the Space Agent's task creation decision logic

**Acceptance Criteria**:
- Human can describe work in the Space chat and have it automatically routed to a workflow
- Task is created with proper description and context
- Workflow run starts with the correct workflow
- Plan node agent receives the task and begins working
- Unit tests cover the conversation-to-task flow

**Depends on**: Task 5.1 (human gate works for the full pipeline)

**Agent type**: coder
