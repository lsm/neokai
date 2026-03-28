# Plan: Write the First Task Through Space Agent

## Objective

Test the Space Agent task/agent surfaces by creating and executing the first task through conversational interaction, then observe how the task progresses through the Coding Workflow. This plan focuses on experiencing the system from a human user's perspective to validate the UI/UX flow documented in `docs/ux-flows/first-space-task-flow.md`.

**Success criteria:**
1. Space Agent successfully creates a task from natural language input
2. Task appears in SpaceDetailPanel with correct metadata
3. Task can be started via Space Agent or workflow trigger
4. Task progresses through workflow steps (Plan → Code → Verify & Test → Done)
5. Human gates (approval points) work correctly
6. Task completion is properly detected and reported
7. All real-time updates (LiveQuery) work without manual refresh

## Current State

### What Already Exists

The Space system is fully implemented with the following components:

#### Backend Infrastructure
- **Space Core** (`packages/daemon/src/lib/space/`)
  - `SpaceRuntime` — workflow orchestration engine
  - `SpaceRuntimeService` — runtime lifecycle management
  - `SpaceTaskManager` — task CRUD and status management
  - `SpaceWorkflowManager` — workflow definition and execution
  - `TaskAgentManager` — agent session orchestration for tasks

- **Built-in Workflows** (`packages/daemon/src/lib/space/workflows/built-in-workflows.ts`)
  - **Coding Workflow**: Plan → Code → Verify & Test → Done (with cyclic feedback loop)
  - Human gate between Plan and Code steps
  - Task result gates for Verify step (pass/fail routing)
  - Maximum 3 iterations to prevent infinite loops

- **Space Agent Tools** (`packages/daemon/src/lib/space/tools/space-agent-tools.ts`)
  - `space_task_create` — create tasks from conversational input
  - `space_task_list` — query task status
  - `space_task_update` — modify task metadata
  - `space_workflow_start` — initiate workflow execution
  - Other task/workflow management tools

- **Channel & Gate System** (`packages/daemon/src/lib/space/runtime/channel-router.ts`)
  - Unidirectional channels between workflow nodes
  - Gates with composable conditions (`check`, `count`, `all`, `any`)
  - `human` gates for approval checkpoints
  - `task_result` gates for conditional routing
  - `write_gate` tool for agents to update gate data

#### Frontend Components
- **Space Dashboard** (`packages/web/src/islands/SpaceIsland.tsx`)
  - Three-column layout: NavRail → SpaceDetailPanel → ContentPanel
  - Task statistics strip (active/pending/done counts)
  - Quick action buttons for creating tasks and starting workflows

- **SpaceDetailPanel** (`packages/web/src/islands/SpaceDetailPanel.tsx`)
  - Pinned items: Dashboard, Space Agent
  - Real-time task list with status filtering
  - Workflow runs section
  - Sessions list

- **SpaceTaskPane** (`packages/web/src/components/space/SpaceTaskPane.tsx`)
  - Full-width task detail view
  - Activity section showing agent progress
  - Agent activity feed (conversation-style updates)
  - Human input section for gate interactions
  - Links to agent sessions and Space Agent

- **Space Agent Chat** (`packages/web/src/islands/SpaceIsland.tsx`, route: `/space/:id/agent`)
  - ChatContainer with Space Agent session
  - Conversational interface for task creation and workflow control

#### LiveQuery Subscriptions
- `space-store.ts` subscribes to:
  - `spaces.detail` — space metadata updates
  - `spaces.tasks` — task list changes
  - `spaces.agents` — agent list updates
  - `spaces.workflows` — workflow definitions
  - `spaces.workflowRuns` — workflow execution state

### Key UX Flows (Already Documented)

The intended user journey is fully documented in `docs/ux-flows/first-space-task-flow.md`:

1. **Task Creation** (two paths)
   - Path A: Via Space Agent (conversational) — recommended for first-time users
   - Path B: Via "Create Task" quick action (direct)

2. **Task Visibility**
   - Task appears in SpaceDetailPanel immediately (LiveQuery)
   - Clicking task navigates to `/space/:id/task/:taskId` (SpaceTaskPane)

3. **Task Execution**
   - Start via Space Agent: "Start the [task name] task"
   - Start via workflow: "Start Workflow Run" quick action
   - Auto-start (if configured)

4. **Workflow Progression**
   - Status changes: `pending` → `in_progress` → `needs_attention` → `completed`
   - Activity section shows current step and agent status
   - Agent activity feed shows conversation-style updates

5. **Human Gates**
   - Task status changes to `needs_attention`
   - "Human Input Required" section appears in SpaceTaskPane
   - User types response and submits
   - Task resumes execution

6. **Completion**
   - Task status changes to `completed`
   - Completion summary shows files changed, tests passed, etc.
   - SpaceDetailPanel stats update

## Approach

This plan takes a **human-centric testing approach** rather than writing automated tests. The goal is to experience the system as a real user would and document the findings.

### Test Scenario

Create a simple, realistic task that exercises the full workflow:

**Task**: "Add a new utility function to calculate the Fibonacci sequence"

**Why this task?**
- Simple enough to complete quickly (5-10 minutes)
- Requires all workflow steps (Plan → Code → Verify)
- Easy to verify correctness (test the function)
- Minimal dependencies (pure function)

### Execution Steps

1. **Setup Phase**
   - Start NeoKai dev server with a test workspace
   - Create a new Space or use an existing test Space
   - Ensure the Coding Workflow is available

2. **Task Creation Phase**
   - Navigate to Space Dashboard (`/space/:id`)
   - Click "Space Agent" in SpaceDetailPanel
   - Send message: "Create a task to add a fibonacci function to utils"
   - Observe task creation in SpaceDetailPanel

3. **Task Execution Phase**
   - Start workflow via Space Agent: "Start the fibonacci task using the coding workflow"
   - Watch task progress through Plan step
   - Review plan and approve (human gate)
   - Watch Code step execute
   - Watch Verify step run tests

4. **Observation Phase**
   - Monitor real-time updates in SpaceDetailPanel
   - Check SpaceTaskPane activity section
   - View agent session for full conversation
   - Verify task completion summary

5. **Documentation Phase**
   - Screenshot key UI states
   - Note any UX gaps or confusing elements
   - Record time to completion
   - Document any errors or unexpected behavior

### Validation Checklist

During execution, verify:

- [ ] Space Agent successfully parses natural language task description
- [ ] Task appears in SpaceDetailPanel with correct title, priority, assigned agent
- [ ] Task number is auto-incremented (e.g., #1, #2, #3)
- [ ] Clicking task navigates to correct URL (`/space/:id/task/:taskId`)
- [ ] SpaceTaskPane shows task metadata, status, activity
- [ ] Workflow start command is recognized by Space Agent
- [ ] Task status changes to `in_progress` when workflow starts
- [ ] Plan agent creates a plan document on a feature branch
- [ ] Plan PR is opened and visible in activity section
- [ ] Human gate appears with clear approval UI
- [ ] Submitting approval unblocks Code step
- [ ] Code agent implements the function and creates PR
- [ ] Verify agent runs tests and reports result
- [ ] Task status changes to `completed` on success
- [ ] Completion summary shows files changed, tests passed
- [ ] SpaceDetailPanel stats update (e.g., "1 active" → "1 done")

### Edge Cases to Test

If time permits, test these scenarios:

1. **Task Creation Variations**
   - Create task via "Create Task" quick action button (Path B)
   - Create multiple tasks in quick succession
   - Create task with explicit priority: "Create a high-priority task to..."

2. **Gate Interactions**
   - Reject plan at human gate (verify loop back to Plan step)
   - Provide feedback in approval message
   - Leave task at gate for extended period (verify no timeout)

3. **Verification Failures**
   - Trigger test failure in Verify step (verify loop back to Plan)
   - Max out iteration count (verify task marked as failed after 3 loops)

4. **UI Robustness**
   - Refresh page mid-execution (verify state persists)
   - Open task in multiple browser tabs (verify LiveQuery syncs)
   - Navigate away and back (verify no data loss)

## Milestones / Subtasks

### Milestone 1: Environment Setup
**Goal**: Prepare test environment and create a test Space

- [ ] Start NeoKai dev server: `make dev WORKSPACE=/path/to/test/workspace`
- [ ] Create or identify test workspace (must be a git repository)
- [ ] Navigate to Spaces section in UI
- [ ] Create new Space with:
  - Name: "Fibonacci Test Space"
  - Description: "Testing first task flow with Space Agent"
  - Workspace: `/path/to/test/workspace`
  - Default model: Sonnet
- [ ] Verify Space appears in NavRail
- [ ] Verify Space Agent session is created automatically

### Milestone 2: Task Creation via Space Agent
**Goal**: Create the fibonacci task through conversational interaction

- [ ] Click "Space Agent" in SpaceDetailPanel
- [ ] Navigate to `/space/:id/agent`
- [ ] Send message: "Create a task to add a fibonacci function to utils. The function should take an integer n and return the nth Fibonacci number. Include tests."
- [ ] Wait for Space Agent response
- [ ] Verify task creation confirmation message
- [ ] Navigate back to Dashboard
- [ ] Verify task appears in "Tasks" section of SpaceDetailPanel with:
  - Title: "Add fibonacci function to utils" (or similar)
  - Status: `pending`
  - Priority: `normal` (default)
  - Agent: `coder` or `planner` (depending on workflow selection)
- [ ] Click task to open SpaceTaskPane
- [ ] Verify task metadata is correct
- [ ] Take screenshot of initial task state

### Milestone 3: Workflow Execution Start
**Goal**: Start the Coding Workflow for the fibonacci task

- [ ] Return to Space Agent chat (`/space/:id/agent`)
- [ ] Send message: "Start the fibonacci task using the coding workflow"
- [ ] Wait for Space Agent acknowledgment
- [ ] Navigate to task pane (`/space/:id/task/:taskId`)
- [ ] Verify task status changed to `in_progress`
- [ ] Verify activity section shows:
  - "Task agent is working" or similar status message
  - Current step: "Plan" or "Planning"
  - Agent label: "TASK AGENT" or "PLANNER"
- [ ] Verify SpaceDetailPanel stats updated (e.g., "1 active · 0 pending")
- [ ] Take screenshot of in-progress state

### Milestone 4: Plan Step Execution
**Goal**: Observe the Plan agent creating the plan document and PR

- [ ] Monitor SpaceTaskPane activity section for updates
- [ ] Wait for Plan agent to complete (typically 2-5 minutes)
- [ ] Verify activity section shows:
  - Plan document created (path visible)
  - PR opened (URL visible)
  - Status: "Waiting on your input" or "Human approval required"
- [ ] Verify task status changed to `needs_attention`
- [ ] Verify "Human Input Required" section appears
- [ ] Click "View Agent Session" link
- [ ] Verify full conversation history is visible
- [ ] Verify plan document is readable (not corrupted)
- [ ] Take screenshot of plan approval state

### Milestone 5: Human Gate Approval
**Goal**: Approve the plan and unblock the Code step

- [ ] Return to task pane (`/space/:id/task/:taskId`)
- [ ] Review plan document (optional: open PR link)
- [ ] Type approval message in "Human Input Required" textarea: "Approved. Looks good, please proceed with implementation."
- [ ] Click "Submit Response" button
- [ ] Verify immediate feedback (e.g., "Your response was submitted")
- [ ] Verify task status changed from `needs_attention` to `in_progress`
- [ ] Verify activity section updated:
  - Human approval recorded
  - Code agent started
  - Current step: "Code" or "Coding"
- [ ] Take screenshot of code-in-progress state

### Milestone 6: Code Step Execution
**Goal**: Observe the Code agent implementing the function

- [ ] Monitor SpaceTaskPane for Code agent progress
- [ ] Wait for Code agent to complete (typically 3-7 minutes)
- [ ] Verify activity section shows:
  - Code implementation completed
  - Files changed (e.g., "src/utils/fibonacci.ts", "tests/fibonacci.test.ts")
  - PR opened or updated
- [ ] Verify task is still `in_progress` (transitioning to Verify step)
- [ ] Take screenshot of code completion state

### Milestone 7: Verify Step Execution
**Goal**: Observe the Verify agent running tests

- [ ] Monitor SpaceTaskPane for Verify agent activity
- [ ] Wait for Verify agent to complete (typically 1-3 minutes)
- [ ] Verify activity section shows:
  - Tests running
  - Test results (e.g., "12 passing", "All tests passed")
  - Verification outcome: "passed" or "failed"
- [ ] If **passed**:
  - Verify task status changed to `completed`
  - Verify completion summary appears with:
    - Files changed
    - Tests passed count
    - Success message
  - Proceed to Milestone 8
- [ ] If **failed**:
  - Verify task status changed to `in_progress` (looping back to Plan)
  - Verify activity section shows "Looping back to planning due to verification failure"
  - Repeat Milestones 4-6 (with updated plan)
  - Max 3 iterations before marking task as failed
- [ ] Take screenshot of verify completion state

### Milestone 8: Task Completion Verification
**Goal**: Verify all completion indicators are correct

- [ ] Verify task status is `completed`
- [ ] Verify SpaceTaskPane shows:
  - Green checkmark or "Completed" badge
  - Completion timestamp
  - Summary of work done
  - Links to PRs and agent sessions
- [ ] Navigate to SpaceDetailPanel
- [ ] Verify task stats updated (e.g., "0 active · 1 done")
- [ ] Verify completed task appears in "done" filter tab
- [ ] Click "View Agent Session" link
- [ ] Verify full conversation history is preserved
- [ ] Take screenshot of final completed state

### Milestone 9: Documentation and Findings
**Goal**: Summarize the experience and identify improvements

- [ ] Compile all screenshots into a findings document
- [ ] Document time to completion (from task creation to completion)
- [ ] List any UX gaps or confusing elements observed:
  - Unclear status messages
  - Missing visual indicators
  - Slow or missing real-time updates
  - Confusing navigation patterns
  - Unexpected errors or warnings
- [ ] Cross-reference findings with `docs/ux-flows/space-agent-ux-recommendations.md`
- [ ] Identify which recommendations would address observed gaps
- [ ] Create issues or follow-up tasks for critical UX improvements
- [ ] Update `docs/ux-flows/first-space-task-flow.md` if actual behavior differs from documented flow

## Test Strategy

### Manual Testing Approach

This task uses **manual exploratory testing** rather than automated tests for the following reasons:

1. **Human-Centric Validation**: The goal is to experience the UI/UX as a real user would, which cannot be captured by automated tests
2. **Subjective Assessment**: Many success criteria involve subjective evaluation (e.g., "Is this status message clear?", "Is the navigation intuitive?")
3. **Discovery-Oriented**: Exploratory testing often reveals unexpected issues that scripted tests miss
4. **Rapid Iteration**: Manual testing allows for real-time adjustments to the test scenario based on observations

### Test Environment

- **Server**: Dev mode (`make dev`) with hot reload enabled
- **Workspace**: Clean git repository with basic project structure (e.g., TypeScript/Bun project)
- **Browser**: Chrome or Safari with DevTools open (Console tab for errors)
- **Network**: Monitor WebSocket messages for LiveQuery updates
- **Screen Recording**: Optional but recommended for detailed review

### Success Metrics

Quantitative:
- **Time to Task Creation**: <60 seconds from "Create a task..." message to task visible in panel
- **Time to Workflow Start**: <30 seconds from "Start workflow" message to status change
- **Time to Plan Completion**: <5 minutes (depends on API response times)
- **Time to Code Completion**: <7 minutes
- **Time to Verify Completion**: <3 minutes
- **Total End-to-End Time**: <15 minutes (excluding human approval wait time)
- **Zero Errors**: No JavaScript errors in browser console
- **Zero UI Glitches**: No missing data, blank screens, or incorrect status badges

Qualitative:
- **Clarity**: Every status message should be self-explanatory
- **Feedback**: Every action should have immediate visible feedback
- **Guidance**: User should always know what to do next
- **Transparency**: User should understand why the system is waiting or what it's doing
- **Control**: User should feel in control (ability to pause, inspect, or intervene)

### Edge Cases (Optional)

If the happy path succeeds, test these edge cases:

1. **Multi-task Concurrent Execution**
   - Create 2-3 tasks simultaneously
   - Start workflows for all tasks
   - Verify SpaceDetailPanel correctly shows all active tasks
   - Verify no task state interference

2. **Browser Refresh Mid-Execution**
   - Start a task
   - Wait until mid-Plan step
   - Hard refresh the page (Cmd+R)
   - Verify task state is restored
   - Verify agent continues execution

3. **WebSocket Reconnection**
   - Start a task
   - Disconnect Wi-Fi or simulate network interruption
   - Wait 10 seconds
   - Reconnect network
   - Verify LiveQuery reconnects and syncs state

4. **Human Gate Timeout**
   - Start a task and reach human gate
   - Leave task at `needs_attention` for 10+ minutes
   - Return and approve
   - Verify workflow resumes correctly

### Documentation Artifacts

Produce the following artifacts:

1. **Findings Report**: `docs/testing/first-task-findings-YYYY-MM-DD.md`
   - Overview of test execution
   - Success/failure summary
   - Screenshots with annotations
   - Detailed observations
   - Recommendations for improvements

2. **UX Gap Issues**: Create GitHub issues for critical gaps found
   - Title format: `[Space UX] <concise description>`
   - Labels: `space`, `ux`, `enhancement`
   - Reference relevant findings from report

3. **Updated Flow Docs**: If actual behavior differs from `docs/ux-flows/first-space-task-flow.md`, update the doc to reflect reality

## Out of Scope

The following are explicitly **not** included in this plan:

### Features Not Tested
- **Custom Agents**: Only built-in agents (planner, coder, general) are used
- **Custom Workflows**: Only the built-in Coding Workflow is tested
- **Multi-Agent Collaboration**: Tasks with multiple agents in a single step are not tested
- **Workflow Rules**: No workflow-level rules are configured or tested
- **Task Dependencies**: No testing of tasks that depend on other tasks
- **Recurring Tasks**: No scheduled or recurring task execution
- **Task Templates**: No pre-defined task templates are used
- **Mobile/Tablet**: Testing is desktop-only
- **Accessibility**: No screen reader or keyboard-only navigation testing

### Edge Cases Not Covered
- **Agent Crashes**: No simulation of agent process crashes or API failures
- **Rate Limiting**: No testing of API rate limit handling
- **Quota Exhaustion**: No testing of token quota exhaustion mid-task
- **Concurrent Human Edits**: No testing of multiple users editing the same task
- **Workspace Conflicts**: No testing of two spaces sharing the same workspace path
- **Git Conflicts**: No testing of merge conflicts in PRs
- **Large Task Volume**: No stress testing with 100+ tasks

### Implementation Work
- **No Code Changes**: This is purely a testing/observation task
- **No Bug Fixes**: Any bugs found are documented but not fixed in this plan
- **No UX Improvements**: Recommendations are documented but not implemented

### Future Enhancements
- Automated E2E tests for the happy path (separate task)
- Performance benchmarks for workflow execution (separate task)
- A/B testing of different task creation flows (separate task)
- Analytics instrumentation for UX metrics (separate task)

---

**Plan Status**: Ready for execution
**Estimated Effort**: 2-3 hours (including documentation)
**Dependencies**: None (all required features already implemented)
**Success Definition**: Complete all milestones and produce findings report with actionable recommendations
