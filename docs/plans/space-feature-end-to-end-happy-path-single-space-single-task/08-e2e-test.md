# Milestone 8: E2E Test

## Goal and Scope

Create Playwright E2E tests that exercise the full UI flow including the workflow canvas visualization, human gate artifacts view, and diff rendering.

## Tasks

### Task 8.1: Space Happy Path E2E Test

**Description**: Create `packages/e2e/tests/features/space-happy-path-pipeline.e2e.ts` exercising the full UI flow.

**Subtasks**:
1. Set up test infrastructure:
   - Navigate to Spaces view, create new Space
   - Verify preset agents seeded (Coder, General, Planner, Reviewer, QA)
   - Verify V2 workflow seeded
2. Test flow:
   a. Open Space chat
   b. Type a task request
   c. Verify Space Agent creates task and starts workflow
   d. **Verify workflow canvas appears** with Planning node active
   e. Wait for planner to complete
   f. **Verify human gate highlights on canvas** (amber pulsing)
   g. **Click the human gate on canvas** → verify artifacts view opens
   h. **Verify artifacts view shows plan PR changes** (file list, diff summary)
   i. **Click a file** → verify diff renders with syntax highlighting
   j. **Click "Approve" button** in artifacts view
   k. Verify canvas updates: human gate opens, Coding node activates
   l. Wait for coder to complete
   m. Verify 3 Reviewer nodes activate on canvas (parallel)
   n. Wait for reviewers to complete
   o. Verify QA node activates
   p. Wait for QA to complete
   q. Verify canvas shows all nodes completed
   r. Verify completion summary in Space chat

**Acceptance Criteria**:
- E2E test exercises the full happy path through canvas UI
- Human gate interaction via canvas + artifacts view works
- Diff rendering is visible and correct
- Parallel reviewer nodes visible on canvas
- Completion summary displayed

**Depends on**: Milestone 6 (canvas UI), Milestone 5 (pipeline)

**Agent type**: coder

---

### Task 8.2: E2E Test for Reviewer Feedback Loop

**Description**: E2E test where a reviewer rejects and the coder fixes.

**Subtasks**:
1. Proceed through pipeline to reviewer phase
2. Verify one reviewer rejects (visible on canvas — Aggregate Gate shows votes)
3. Verify Coding node re-activates on canvas
4. Wait for coder fix + re-review
5. Verify all 3 reviewers approve
6. Verify flow continues to QA and completion

**Acceptance Criteria**:
- Reviewer rejection visible on canvas
- Coder re-activation visible
- Aggregate Gate vote display works
- Final completion achieved

**Depends on**: Task 8.1

**Agent type**: coder

---

### Task 8.3: E2E Test for Human Gate Rejection

**Description**: E2E test for human rejection via artifacts view.

**Subtasks**:
1. Proceed to human gate
2. Click human gate on canvas → artifacts view opens
3. Click "Reject" button
4. Verify workflow run transitions to failed (visible on canvas)
5. Verify confirmation message in chat
6. Verify space remains usable after rejection

**Acceptance Criteria**:
- Rejection via artifacts view works
- Canvas shows failed state
- Space remains usable

**Depends on**: Task 8.1

**Agent type**: coder
