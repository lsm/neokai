# Milestone 6: Approval Gate Canvas UI

## Goal and Scope

Build a live workflow canvas visualization where humans can see the running workflow instance, interact with approval gates, and review artifacts. This is the primary way humans approve/reject at gates — not just chat-based, but a visual canvas similar to GitHub Actions workflow visualization but with human-in-the-loop nodes.

## UX Specification

### Canvas Visualization

The workflow runs as a live instance on a **canvas/visualization**:
- **Nodes** are the primary visual elements showing agent status (pending, active, completed, failed)
- **Channels** are rendered as directional lines/arrows between nodes (with arrowheads showing direction)
- **Gates** are visual elements rendered ON the channel line (not as separate nodes) — like a valve on a pipe
  - Gate states: blocked (red/gray lock icon), open (green check), waiting for human (amber pulsing)
  - Channels without a gate show as plain directional arrows (always open)
- Active nodes pulse or animate to indicate work in progress
- Completed nodes show a checkmark with elapsed time
- Failed nodes show an error indicator
- **Gate editing (workflow template mode)**: User can drag a gate onto a channel line or click a "+" button on the line to add a gate. Removing a gate from a channel makes it always open.

### Approval Gate Interaction

When the workflow reaches an approval gate (`plan-approval-gate` with `check: approved == true`):
1. The gate node on the canvas highlights (pulsing, distinct color)
2. **Clicking the approval gate opens an artifacts view** showing all changes in the worktree
3. The artifacts view lists all changed files (like a PR diff view)
4. **Clicking individual changes renders the file or code diff** (side-by-side or unified diff view)
5. Approve/Reject buttons are prominently displayed in the artifacts view
6. The human can also approve via chat as a secondary mechanism

### Artifacts View Detail

The artifacts view is essentially an embedded PR review interface:
- File tree showing all changed files (added, modified, deleted)
- Click a file → shows the diff (syntax highlighted, line numbers)
- Summary section: number of files changed, lines added/removed
- Context from the agent: what was done and why (read from gate data)
- For `plan-pr-gate`: shows the plan document diff
- For `code-pr-gate`: shows the code changes diff

## Tasks

### Task 6.1: Implement Approval Gate Backend

**Description**: Implement the backend for the approval gate (`plan-approval-gate`): blocking, state persistence, approval RPC, and notification.

**Subtasks**:
1. Implement `spaceWorkflowRun.approveGate` RPC handler:
   - Accepts `{ runId, gateId, decision: 'approve' | 'reject' }`
   - Writes to gate data store: `{ approved: true, approvedBy, approvedAt }` or `{ rejected: true, rejectedBy, reason }`
   - **Idempotency**: If the gate is already approved/rejected (e.g., two humans click simultaneously), return success without re-writing. Use optimistic locking: read current gate data, check if already decided, only write if still `{ waiting: true }`.
   - Triggers gate re-evaluation (which unblocks the channel)
2. Implement `spaceWorkflowRun.getGateArtifacts` RPC handler:
   - Accepts `{ runId, gateId }`
   - **Worktree path lookup**: Queries the `space_worktrees` table (M4) using the workflow run's task ID to find the worktree path. Falls back to workflow run metadata if the worktree table lookup fails.
   - Returns: list of changed files in the task worktree, git diff summary, gate context data
   - Uses `git diff` and `git status` in the task worktree to get changes
   - **Guard**: If the worktree no longer exists (cleaned up), return an error with the PR URL from gate data so the human can review on GitHub instead
3. Implement `spaceWorkflowRun.getFileDiff` RPC handler:
   - Accepts `{ runId, gateId, filePath }`
   - Returns: unified diff for the specified file
4. Add workflow run status: when approval gate blocks → run stays `in_progress` but gate data shows `{ waiting: true }`
   - No need for a new `waiting_for_approval` status — the gate data IS the state. The workflow run is `in_progress`, and the gate's data tells you it's waiting.
5. Handle rejection: gate data gets `{ rejected: true, reason }`. The workflow run transitions to `needs_attention` with `failureReason: 'humanRejected'`. (Uses existing `needs_attention` status, not a new `failed` status — see overview WorkflowRunStatus Strategy.)
6. Add `failureReason` field to `SpaceWorkflowRun` interface (if not already added in M1 Task 1.1): `failureReason?: 'humanRejected' | 'maxIterationsReached' | 'nodeTimeout' | 'agentCrash'`
7. Implement post-rejection recovery via `spaceWorkflowRun.restart` RPC
8. Ensure gate data (including waiting/approved/rejected state) persists across daemon restart
9. Unit tests: approval, rejection, concurrent approval idempotency, artifacts retrieval (with and without worktree), file diff, restart, persistence

**Acceptance Criteria**:
- Approval gate blocks workflow and gate data shows `{ waiting: true }`
- Approval writes to gate data and unblocks downstream channel
- Concurrent approvals are idempotent (no double-write)
- Rejection transitions run to `needs_attention` with `failureReason: 'humanRejected'`
- Artifacts RPC returns changed files and diffs from task worktree (or error + PR URL if worktree gone)
- State persists across daemon restart
- Unit tests cover all flows including concurrent approval edge case

**Depends on**: Milestone 1 (gate data store), Milestone 4 (worktree for diff access)

**Agent type**: coder

---

### Task 6.2: Implement Workflow Canvas Component

**Description**: Create the live workflow canvas visualization that shows the running workflow instance with node statuses and gate states.

**Subtasks**:
1. Create `packages/web/src/components/space/WorkflowCanvas.tsx`:
   - Renders the workflow graph as a visual canvas with three visual element types:
     - **Nodes**: boxes showing name, agent role, status (pending/active/completed/failed), elapsed time
     - **Channels**: directional lines/arrows between nodes (with arrowheads). Plain lines for gateless channels.
     - **Gates**: visual elements rendered ON the channel line (icon/indicator on the line, not a separate node). Gate states: blocked (lock icon, gray), open (check, green), waiting for human (amber, pulsing).
   - Active nodes have animation/pulse effect
2. Subscribe to `workflow_run_status_changed` and `gate_data_changed` live queries for real-time updates
3. On initial load, query current workflow run state, channels, and gate data to render correct initial state
4. Layout algorithm: horizontal pipeline layout (left to right), with parallel nodes stacked vertically
5. Handle the 3 parallel reviewer nodes: show them stacked vertically, sharing the same `review-votes-gate` indicator on their converging channel to QA
6. **Gate editing in template mode**: When viewing a workflow template (not a running instance), allow:
   - Click "+" button on any channel line to add a new gate
   - Drag a gate from a palette onto a channel line
   - Click a gate indicator to edit its condition config
   - Remove a gate from a channel (making it always open)
7. Style with Tailwind CSS, consistent with existing Space UI

**Acceptance Criteria**:
- Canvas renders nodes, channels (directional arrows), and gates (on channel lines) as distinct visual elements
- Gates render ON the channel line, not as separate nodes
- Gateless channels render as plain arrows (always open)
- Real-time updates as nodes activate/complete and gates open/close
- Approval gates are visually distinct (amber, pulsing)
- Parallel reviewer nodes displayed correctly
- Gate editing works in template mode (add/remove/configure gates on channels)
- Works on initial load (not just live updates)

**Depends on**: Task 6.1 (backend RPCs for state)

**Agent type**: coder

---

### Task 6.3: Implement Artifacts View and Diff Rendering

**Description**: Build the artifacts view that opens when a human clicks a gate on the canvas. Shows changed files and renders diffs.

**Subtasks**:
1. Create `packages/web/src/components/space/GateArtifactsView.tsx`:
   - Opens as a panel/overlay when approval gate is clicked on canvas
   - Calls `spaceWorkflowRun.getGateArtifacts` RPC to get changed files
   - Shows file tree: added (green), modified (yellow), deleted (red)
   - Shows summary: N files changed, +X / -Y lines
   - Shows gate context: what agent did and why (from gate data)
2. Create `packages/web/src/components/space/FileDiffView.tsx`:
   - Clicking a file in the artifacts view opens the diff
   - Calls `spaceWorkflowRun.getFileDiff` RPC
   - Renders unified diff with syntax highlighting and line numbers
   - Supports scroll through long diffs
3. Add Approve / Reject buttons at the top of the artifacts view:
   - "Approve" calls `spaceWorkflowRun.approveGate` with `decision: 'approve'`
   - "Reject" calls `spaceWorkflowRun.approveGate` with `decision: 'reject'`
   - After action, close the artifacts view and update canvas
4. Also support chat-based approval as secondary mechanism (parse "approve"/"reject" in Space chat)
5. Style: clean diff view similar to GitHub PR review interface

**Acceptance Criteria**:
- Clicking approval gate on canvas opens artifacts view
- Changed files listed with add/modify/delete indicators
- Clicking a file shows syntax-highlighted diff
- Approve/Reject buttons work and update workflow state
- Chat-based approval also works as fallback
- Vitest tests for approval parsing logic

**Depends on**: Task 6.1 (backend RPCs), Task 6.2 (canvas component)

**Agent type**: coder

---

### Task 6.4: Integrate Canvas into Space View

**Description**: Wire the workflow canvas into the existing Space UI, replacing or augmenting the current workflow view.

**Subtasks**:
1. Add the `WorkflowCanvas` component to the Space view when a workflow run is active
2. Show the canvas below the Space chat (or in a split view / tab)
3. When no workflow run is active, show the workflow template editor (existing behavior)
4. When a workflow run completes, show the final state (all nodes completed) with summary
5. Ensure the canvas works alongside the Space chat (both visible)
6. Handle responsive layout for different screen sizes

**Acceptance Criteria**:
- Workflow canvas appears when a run is active
- Canvas and chat work together (both visible)
- Canvas shows final state on completion
- Responsive layout works

**Depends on**: Task 6.2, Task 6.3

**Agent type**: coder
