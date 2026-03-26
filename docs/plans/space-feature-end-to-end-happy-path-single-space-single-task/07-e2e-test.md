# Milestone 7: E2E Test

## Goal and Scope

Create a Playwright E2E test that exercises the full UI flow from space creation through task creation and workflow execution. This test simulates a real user interacting with the NeoKai UI.

## Tasks

### Task 7.1: Space Happy Path E2E Test

**Description**: Create a Playwright test (`packages/e2e/tests/features/space-happy-path-pipeline.e2e.ts`) that exercises the full UI flow.

**Subtasks**:
1. Set up test infrastructure:
   - Navigate to the Spaces view
   - Create a new Space with a workspace path
   - Verify preset agents are seeded (Coder, General, Planner, Reviewer, QA)
   - Verify coding workflow is seeded
2. Test flow:
   a. Open the Space chat
   b. Type a task request (e.g., "Add a simple health check endpoint to the API")
   c. Verify the Space Agent responds and creates a task
   d. Verify the Space Agent starts a workflow run
   e. Verify the workflow view shows the Plan node as active
   f. Wait for the planner to complete (mocked or with real API in CI)
   g. Verify the human gate appears in the UI
   h. Click "Approve" to approve the plan
   i. Verify the Code node becomes active
   j. Wait for the coder to complete
   k. Verify the Review node becomes active
   l. Wait for the reviewer to complete
   m. Verify the QA node becomes active
   n. Wait for QA to complete
   o. Verify the workflow run shows as completed
   p. Verify the completion summary appears in the Space chat

**Acceptance Criteria**:
- E2E test exercises the full happy path through the UI
- All UI transitions are visible and correct
- Human gate approval works via UI
- Completion summary is displayed
- Test runs in CI with the standard E2E setup

**Depends on**: Task 5.3 (full pipeline must work in the backend)

**Agent type**: coder

---

### Task 7.2: E2E Test for Reviewer Feedback Loop

**Description**: Add an E2E test scenario where the reviewer rejects the code and the coder fixes it.

**Subtasks**:
1. Create a scenario where the first coder submission has intentional issues
2. Verify the reviewer rejects with feedback
3. Verify the coder receives the feedback (visible in task messages)
4. Verify the coder fixes and resubmits
5. Verify the reviewer approves
6. Verify the flow continues to QA and completion

**Acceptance Criteria**:
- Reviewer rejection flow is visible in the UI
- Coder fix cycle is visible
- Final completion is achieved after feedback loop

**Depends on**: Task 7.1

**Agent type**: coder
