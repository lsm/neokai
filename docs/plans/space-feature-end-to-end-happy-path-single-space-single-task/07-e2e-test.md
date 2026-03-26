# Milestone 7: E2E Test

## Goal and Scope

Create Playwright E2E tests that exercise the full UI flow from space creation through task creation and workflow execution. These tests simulate real user interactions with the NeoKai UI.

## Tasks

### Task 7.1: Space Happy Path E2E Test

**Description**: Create a Playwright test (`packages/e2e/tests/features/space-happy-path-pipeline.e2e.ts`) that exercises the full UI flow from conversation to completion.

**Subtasks**:
1. Set up test infrastructure:
   - Navigate to the Spaces view
   - Create a new Space with a workspace path
   - Verify preset agents are seeded (Coder, General, Planner, Reviewer, QA)
   - Verify coding workflow V2 is seeded
2. Test flow:
   a. Open the Space chat
   b. Type a task request (e.g., "Add a simple health check endpoint to the API")
   c. Verify the Space Agent responds and creates a task
   d. Verify the Space Agent starts a workflow run
   e. Verify the workflow view shows the Plan node as active
   f. Wait for the planner to complete (mocked or with real API in CI)
   g. Verify the human gate message appears in the chat ("Plan is ready for your review")
   h. Type "approve" in the chat
   i. Verify confirmation message ("Plan approved. Starting coder...")
   j. Verify the Code node becomes active in the workflow view
   k. Wait for the coder to complete
   l. Verify the Review node becomes active
   m. Wait for the reviewer to complete
   n. Verify the QA node becomes active
   o. Wait for QA to complete
   p. Verify the workflow run shows as completed
   q. Verify the completion summary appears in the Space chat

**Acceptance Criteria**:
- E2E test exercises the full happy path through the UI
- All UI transitions are visible and correct
- Human gate approval works via chat message ("approve")
- Completion summary is displayed in chat
- Test runs in CI with the standard E2E setup

**Depends on**: Task 5.4 (full pipeline with human gate UI must work)

**Agent type**: coder

---

### Task 7.2: E2E Test for Reviewer Feedback Loop

**Description**: Add an E2E test scenario where the reviewer rejects the code and the coder fixes it.

**Subtasks**:
1. Create a scenario where the first coder submission has intentional issues (use a task description that's likely to produce imperfect code on first attempt)
2. Verify the reviewer rejects with feedback (visible in the workflow view)
3. Verify the coder receives the feedback and re-activates (visible in task messages)
4. Verify the coder fixes and resubmits
5. Verify the reviewer approves
6. Verify the flow continues to QA and completion

**Acceptance Criteria**:
- Reviewer rejection flow is visible in the UI
- Coder fix cycle is visible
- Final completion is achieved after feedback loop
- Workflow view correctly shows node state transitions

**Depends on**: Task 7.1

**Agent type**: coder

---

### Task 7.3: E2E Test for Human Gate Rejection

**Description**: Add an E2E test for the human rejection flow.

**Subtasks**:
1. Create a task and let the planner complete
2. Type "reject" in the chat when the human gate appears
3. Verify the workflow run transitions to `failed` status with `humanRejected` reason (or `needs_attention` if type not yet expanded — see M5 Task 5.1)
4. Verify a confirmation message appears in the chat
5. Verify the human can create a new task afterward

**Acceptance Criteria**:
- Human can reject a plan via chat message
- Workflow run transitions to failed
- Confirmation message appears
- Space remains usable after rejection

**Depends on**: Task 7.1

**Agent type**: coder
