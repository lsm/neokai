# Milestone 8: E2E Test

## Goal and Scope

Create Playwright E2E tests that exercise the full UI flow including the workflow canvas visualization, human gate artifacts view, and diff rendering.

**Testing strategy**: E2E tests use real agent execution via dev proxy (mocked LLM responses). To manage timing, tests wait for **visible UI state changes** on the canvas (e.g., node status indicators, gate highlights) rather than polling internal state. Each "wait for X to complete" step uses `page.waitForSelector()` on the canvas node's status indicator. The dev proxy returns fast, deterministic responses so tests complete in seconds, not minutes.

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
2. **Wait for Aggregate Gate vote display** on canvas (use `page.waitForSelector` on vote indicator elements). Verify one reviewer rejects (visible rejection indicator on canvas)
3. **Wait for Coding node status change** to "active" on canvas. Verify Coding node re-activates.
4. **Wait for Aggregate Gate to show reset** (votes cleared after cyclic traversal)
5. Wait for coder fix + re-review (wait for all 3 reviewer node statuses to change to "completed")
6. Verify all 3 reviewers approve (Aggregate Gate shows 3/3)
7. Verify flow continues to QA and completion

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
4. Verify workflow run transitions to `needs_attention` state (visible on canvas as error/attention indicator)
5. Verify confirmation message in chat
6. Verify space remains usable after rejection

**Acceptance Criteria**:
- Rejection via artifacts view works
- Canvas shows needs_attention/error state
- Space remains usable

**Depends on**: Task 8.1

**Agent type**: coder
