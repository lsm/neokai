# Plan: Complete Room Human-in-a-Loop Features

## Goal

Allow humans to interact with room agents during autonomous task execution via two channels:
1. **Task Conversation**: Send messages from TaskView that reach the leader agent, enabling real-time intervention during task execution and approve/reject during human review.
2. **Room Agent Chat**: Conversational interface with a Room Agent that has full room awareness and can orchestrate goals, tasks, approvals, and agent sessions on behalf of the human.

## Current State

- `awaiting_human` group state and `resumeWorkerFromHuman()` exist in `RoomRuntime`
- `goal.approveTask` RPC exists but only handles approval (not rejection with feedback)
- Room chat session (`room:chat:${roomId}`) exists with basic room-agent MCP tools (create_goal, list_goals, update_goal, create_task, list_tasks, update_task, cancel_task, get_room_status)
- `TaskView` and `TaskConversationRenderer` display group conversation but have no human input
- `Room.tsx` can show `ChatContainer` for any session via `sessionViewId` but there is no dedicated Room Chat tab in the UI
- Group message timeline supports `role: 'human'` with green styling already defined in `TaskConversationRenderer`

## Ordered Task List

---

### Task 1: Backend – `task.sendHumanMessage` RPC handler

**Agent:** coder
**Priority:** high

**Description:**

Add a new `task.sendHumanMessage` RPC handler to `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` that routes human messages into the active session group of a task.

Routing logic based on current group state:
- `awaiting_human`: Call `runtime.resumeWorkerFromHuman(taskId, message, { approved: false })` — resumes the worker with human feedback but without approval flag
- `awaiting_leader`: Inject message into the leader session via `sessionFactory.injectMessage(group.leaderSessionId, formattedMessage)` where `formattedMessage` wraps the text with a clear `[Human intervention]` header so the leader recognizes it as coming from a human
- `awaiting_worker`: Return error — worker is running, message cannot be delivered yet (tell human to wait)
- `completed` / `failed` / no group: Return error with appropriate reason

In all success cases, append the message to the group timeline via `groupRepo.appendMessage({ groupId, role: 'human', messageType: 'human', content: message })` so it shows up in `TaskConversationRenderer`.

The RPC also needs access to `RoomRuntimeService` (same as `goal-handlers.ts`) to call `runtime.resumeWorkerFromHuman` and `runtime.taskGroupManager.sessionFactory.injectMessage`. Ensure the handler is wired up in `packages/daemon/src/app.ts` alongside the existing task handlers.

**Acceptance criteria:**
- `task.sendHumanMessage { roomId, taskId, message }` RPC is registered and callable
- When task group is `awaiting_human`, returns `{ success: true }` and resumes worker
- When task group is `awaiting_leader`, returns `{ success: true }` and injects message into leader session
- When task group is `awaiting_worker`, returns `{ success: false, error: "..." }`
- Human message is appended to group timeline in all success cases
- Unit tests cover all state branches
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2: Frontend – Human message input in TaskView

**Agent:** coder
**Priority:** high
**Depends on:** Task 1

**Description:**

Add a message composition area at the bottom of `packages/web/src/components/room/TaskView.tsx` that lets humans interact with the active session group. The UI is context-sensitive based on `group.state`:

**When `awaiting_human`:**
- Prominent "Awaiting your review" banner
- "Approve" button (calls existing `goal.approveTask` RPC) with green styling
- Text input + "Send Feedback" button (calls new `task.sendHumanMessage` RPC) that resumes worker with rejection feedback

**When `awaiting_leader` or `awaiting_worker`:**
- Compact text input area + "Send to Leader" button
- Calls `task.sendHumanMessage` RPC
- Disabled with tooltip "Worker is running, wait for leader review" when `awaiting_worker`

**When `completed`, `failed`, or no group:**
- No input shown

Human messages must render in `TaskConversationRenderer.tsx` with the existing `human` role styling (green left border, already defined). Ensure the component re-fetches group messages after a human message is sent so it appears immediately.

**Acceptance criteria:**
- TaskView shows Approve + feedback input when `awaiting_human`
- Approve button calls `goal.approveTask` successfully
- Feedback input calls `task.sendHumanMessage` and the message appears in the conversation timeline
- TaskView shows a generic "Send to Leader" input for `awaiting_leader` state
- Input is disabled (with tooltip) for `awaiting_worker` state
- No input shown for `completed`, `failed`, or no group
- Human messages appear in conversation timeline with green styling
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3: Backend – Enhanced Room Agent tools

**Agent:** coder
**Priority:** normal

**Description:**

Extend `packages/daemon/src/lib/room/tools/room-agent-tools.ts` with new tools that give the Room Agent full orchestration capabilities for human-in-the-loop flows:

1. **`approve_task(task_id)`** — Approves a task in `review` status. Calls `runtime.resumeWorkerFromHuman(taskId, approvalMessage, { approved: true })`. Requires `RoomRuntimeService` reference in `RoomAgentToolsConfig`.

2. **`reject_task(task_id, feedback)`** — Rejects a task with feedback. Calls `runtime.resumeWorkerFromHuman(taskId, feedback, { approved: false })`.

3. **`send_message_to_task(task_id, message)`** — Routes a message to the active session group. Delegates to the same routing logic as `task.sendHumanMessage` (awaiting_human → resume worker, awaiting_leader → inject to leader). Appends message to group timeline.

4. **`get_task_detail(task_id)`** — Returns full task details including current group state, group ID, worker/leader session IDs, feedback iteration count, and whether it's awaiting human review. Useful for the Room Agent to understand what's happening in a task before taking action.

Also enhance `get_room_status()` to include a `tasksNeedingReview` list with task IDs and titles that are currently in `review` status or `awaiting_human` group state.

Update `RoomAgentToolsConfig` interface to include optional `runtimeService: RoomRuntimeService` and `groupRepo: SessionGroupRepository` (already present). Wire the new tools up in `createRoomAgentMcpServer()`.

**Acceptance criteria:**
- `approve_task` tool correctly approves tasks in review state
- `reject_task` tool resumes worker with rejection feedback
- `send_message_to_task` routes based on group state with same logic as Task 1
- `get_task_detail` returns full task + group state info
- `get_room_status` includes `tasksNeedingReview` list
- Tool errors are returned as structured `{ success: false, error: "..." }` responses
- Unit tests for all new tool handlers
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Frontend – Room Chat tab

**Agent:** coder
**Priority:** normal

**Description:**

Add a "Chat" tab to the Room island (`packages/web/src/islands/Room.tsx`) that provides a conversational interface with the Room Agent session (`room:chat:${roomId}`).

Changes:
1. Add a `'chat'` value to the `RoomTab` type
2. Add a "Chat" tab button in the tab bar, positioned first (before Overview)
3. When `activeTab === 'chat'`, render `<ChatContainer key={chatSessionId} sessionId={chatSessionId} />` where `chatSessionId = 'room:chat:${roomId}'`
4. Add a notification badge on the "Chat" tab button when any task is in `review` status (a red dot or count badge). Subscribe to `room.task.update` events in `roomStore` to track review-status task count.
5. Update router (`packages/web/src/lib/router.ts`) to support a `chat` subpath: `/rooms/${roomId}/chat` navigates to the chat tab. Add `navigateToRoomChat(roomId)` helper.
6. When a room first loads, if there are tasks in `review` status, default to the `'chat'` tab (or show a banner prompting the human to check the chat tab).

**Acceptance criteria:**
- "Chat" tab appears in Room island tab bar
- Clicking "Chat" tab renders the room chat session via `ChatContainer`
- Red notification badge appears on Chat tab when any task is in `review` status
- `/rooms/${roomId}/chat` URL navigates to the chat tab
- `navigateToRoomChat(roomId)` helper is exported from `router.ts`
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: Frontend – Review notification + Room overview review actions

**Agent:** coder
**Priority:** normal
**Depends on:** Task 2, Task 4

**Description:**

Polish the human-in-the-loop UX with review notifications and improved task list interactions.

1. **Toast notification on task entering review**: In `packages/web/src/lib/room-store.ts`, when a `room.task.update` event arrives with `task.status === 'review'`, show a toast notification ("Task ready for review: {task.title}") and optionally navigate to the task or chat tab.

2. **Task list review actions in RoomDashboard**: In `packages/web/src/components/room/RoomTasks.tsx`, for tasks in `review` status:
   - Show both "Approve" and "Review" (navigate to TaskView) buttons
   - The current "Approve" button should remain but also show a "View" button to navigate to the task conversation

3. **Review count badge on room list**: In `packages/web/src/islands/RoomList.tsx` (or `RoomGrid.tsx`), show a count badge on room entries when they have tasks in `review` or `awaiting_human` group state.

4. **TaskView "Awaiting review" indicator**: Emit `room.task.groupState.update` event from daemon when a group transitions to `awaiting_human` state. Subscribe in `TaskView` and show a pulsing "Awaiting your review" badge in the task header.

For item 4, add the event emission in `RoomRuntime.submitForReview` handler (after `taskGroupManager.submitForReview` succeeds): emit `room.task.groupUpdate` with `{ roomId, taskId, groupId, state: 'awaiting_human' }` via `daemonHub`. Subscribe to this in the frontend `TaskView` component.

**Acceptance criteria:**
- Toast appears when a task transitions to `review` status
- RoomTasks shows both "Approve" and "View" buttons for review-status tasks
- Room list shows review badge count for rooms with pending reviews
- TaskView header shows pulsing indicator when group state is `awaiting_human`
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependencies

```
Task 1 (backend sendHumanMessage RPC)
  └─> Task 2 (frontend TaskView input)
        └─> Task 5 (polish + notifications)

Task 3 (room agent tools)  [independent]

Task 4 (room chat tab)
  └─> Task 5 (polish + notifications)
```

Tasks 1 and 3 can run in parallel. Task 4 can start immediately. Task 2 depends on Task 1. Task 5 depends on Tasks 2 and 4.

## Acceptance Criteria (Overall)

- Human can send messages from TaskView that reach the leader/worker
- Human can approve or reject tasks from TaskView
- Room Agent can approve/reject tasks and send messages to active tasks via chat
- Room Chat tab is accessible and shows review notifications
- All changes tested with unit/integration tests
- No regressions in existing room runtime behavior
