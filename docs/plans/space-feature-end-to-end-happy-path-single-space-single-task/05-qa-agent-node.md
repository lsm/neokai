# Milestone 5: QA Agent Node

## Goal and Scope

Wire the QA agent into the V2 workflow pipeline. QA sits between the Aggregate Gate (after 3 reviewers approve) and Done. QA verifies test coverage, CI status, and PR mergeability. On failure, QA feeds back to Coding via a cyclic channel.

## Feedback Topology

```
3 Reviewers ──[Aggregate Gate: 3 yes]──► QA ──[Task Result: pass]──► Done
                                          │
                                          └──[Task Result: fail, cyclic]──► Coding
```

When QA fails, feedback goes **directly to Coding** (not through Review). After the Coder fixes, the full re-review cycle runs: Coding → 3 Reviewers → QA → Done. This ensures reviewers verify the fix.

### Iteration Counter

Both cyclic channels (Reviewer→Coding and QA→Coding) share the same global `maxIterations` counter.

## Tasks

### Task 5.1: Wire QA into V2 Workflow

**Description**: Ensure the QA node is correctly wired into the V2 workflow template (already defined in M3 Task 3.1) and that the QA→Coding feedback loop works.

**Subtasks**:
1. Verify QA node exists in V2 template with correct agent assignment and tool access
2. Verify channels: Aggregate→QA (passes on quorum), QA→Done (passes on 'passed'), QA→Coding (fails on 'failed', cyclic)
3. Test the QA→Coding feedback loop: QA writes `{ result: 'failed', summary: '...' }` to Task Result Gate → cyclic channel activates → Coding node re-activates
4. Verify the full re-review cycle after QA failure: Coding → 3 Reviewers → QA (all 3 reviewers must re-vote)
5. Verify iteration counter increments on QA→Coding cycle
6. Unit tests for QA feedback loop

**Acceptance Criteria**:
- QA node correctly wired in V2 pipeline
- QA failure feeds back to Coding via cyclic channel
- Full re-review cycle runs after Coder fixes QA issues
- Iteration counter is global across all cyclic channels
- Unit tests verify the feedback loop

**Depends on**: Milestone 3 (V2 workflow template)

**Agent type**: coder

---

### Task 5.2: Implement Completion Flow

**Description**: When QA passes and the Done node activates, the Task Agent produces a final summary for the human.

**Subtasks**:
1. Verify `CompletionDetector` correctly detects when all nodes complete (QA passes → Done activates)
2. Ensure `SpaceRuntime` transitions the workflow run to `completed` status
3. Update the Task Agent prompt to produce a human-readable summary:
   - What was implemented (from Coder's result)
   - PR link and status (from Code PR Gate data)
   - Review summary (from Aggregate Gate votes)
   - QA verification status (from Task Result Gate data)
   - Suggested next steps
4. Verify the Space chat agent surfaces the summary to the human
5. Unit tests for completion detection and summary generation

**Acceptance Criteria**:
- Workflow run transitions to `completed` when QA passes
- Task Agent reads gate data to produce comprehensive summary
- Summary is surfaced in Space chat
- Unit tests verify completion flow

**Depends on**: Task 5.1

**Agent type**: coder

---

### Task 5.3: Space Chat Agent Task Creation from Conversation

**Description**: Ensure the Space chat agent can create a task from conversation and start the V2 workflow.

**Subtasks**:
1. Audit Space chat agent's intent recognition in `space-chat-agent.ts`
2. Verify: clear coding request → `create_standalone_task` → `start_workflow_run` with V2
3. Verify: ambiguous request → ask for clarification (don't create task)
4. Verify task creation persists to DB
5. Verify workflow run starts: Planning node activates
6. Unit tests: task creation on clear request, no task on ambiguous request, correct workflow selection

**Acceptance Criteria**:
- Clear coding request creates task and starts V2 workflow
- Ambiguous request triggers clarification
- Planning node activates on workflow start
- Unit tests cover decision logic

**Depends on**: Task 5.1 (full pipeline must work)

**Agent type**: coder
