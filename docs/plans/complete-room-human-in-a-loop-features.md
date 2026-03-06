# Plan: Complete Room Human-in-a-Loop Features

## Goal

Allow humans to interact with room agents during autonomous task execution via two channels:
1. **Task Conversation**: Send messages from TaskView that reach the leader agent, enabling real-time intervention during task execution and approve/reject during human review.
2. **Room Agent Chat**: Conversational interface with a Room Agent that has full room awareness and can orchestrate goals, tasks, approvals, and agent sessions on behalf of the human.

## Current State

- `awaiting_human` group state and `resumeWorkerFromHuman()` exist in `RoomRuntime`
- `goal.approveTask` RPC exists but only handles approval (not rejection with feedback)
- Room chat session (`room:chat:${roomId}`) exists with basic room-agent MCP tools (create_goal, list_goals, update_goal, create_task, list_tasks, update_task, cancel_task, get_room_status)
- `TaskView` calls `request('task.get', ...)` but **no `task.get` RPC handler exists** — it must be added as a prerequisite
- `TaskView` and `TaskConversationRenderer` display group conversation but have no human input
- `Room.tsx` can show `ChatContainer` for any session via `sessionViewId` but there is no dedicated Room Chat tab in the UI
- Group message timeline supports `role: 'human'` with green styling already defined in `TaskConversationRenderer`
- `sessionFactory` on `RoomRuntime` is `private readonly` — external callers must use a dedicated public method to inject messages

## Ordered Task List

---

### Task 1: Backend – `task.get` RPC + `task.sendHumanMessage` RPC + shared routing helper

**Agent:** coder
**Priority:** high

**Description:**

This task has three parts that must all ship together.

**Part A — `task.get` RPC (prerequisite fix)**

`TaskView` already calls `request('task.get', { roomId, taskId })` but no handler exists in `task-handlers.ts`. Add it:
- Look up the task by `roomId` + `taskId` using `TaskManager.getTask()`
- Return `{ task }` or throw if not found
- This unblocks `TaskView` from loading task data at all

**Part B — `RoomRuntime.injectMessageToLeader(taskId, message)` public method**

Add a new `public async injectMessageToLeader(taskId: string, message: string): Promise<boolean>` method to `RoomRuntime` (`packages/daemon/src/lib/room/runtime/room-runtime.ts`). This encapsulates the private `sessionFactory` and `groupRepo` access:
- Look up the group by `taskId`
- If group state is not `awaiting_leader`, return `false`
- Format the message with a `[Human intervention]` header so the leader recognizes it
- Call `this.sessionFactory.injectMessage(group.leaderSessionId, formattedMessage)`
- Return `true` on success

**Part C — shared `routeHumanMessageToGroup()` helper**

Extract a shared helper function in a new file `packages/daemon/src/lib/room/runtime/human-message-routing.ts`:

```ts
export async function routeHumanMessageToGroup(
  taskId: string,
  message: string,
  groupRepo: SessionGroupRepository,
  runtime: RoomRuntime,
): Promise<{ success: boolean; error?: string }>
```

Routing logic:
- `awaiting_human`: Call `runtime.resumeWorkerFromHuman(taskId, message, { approved: false })`. Do NOT call `groupRepo.appendMessage()` — `resumeWorkerFromHuman()` already appends the message internally.
- `awaiting_leader`: Call `runtime.injectMessageToLeader(taskId, message)` (new public method from Part B). Then append to group timeline via `groupRepo.appendMessage({ groupId, role: 'human', messageType: 'human', content: message })`.
- `awaiting_worker`: Return `{ success: false, error: 'Worker is running — wait for leader review before sending messages' }`
- `completed` / `failed` / no group: Return `{ success: false, error: '<appropriate reason>' }`

**Part D — `task.sendHumanMessage` RPC handler**

Add `task.sendHumanMessage { roomId, taskId, message }` to `task-handlers.ts`. It calls `routeHumanMessageToGroup()` using the runtime from `RoomRuntimeService`. Ensure the handler is wired in `packages/daemon/src/app.ts` alongside existing task handlers. Pass `runtimeService` into `setupTaskHandlers()` (same pattern as `goal-handlers.ts`).

**Acceptance criteria:**
- `task.get { roomId, taskId }` RPC returns `{ task }` or throws if not found
- `RoomRuntime.injectMessageToLeader(taskId, message)` is a public method that injects into the leader session when group is `awaiting_leader`
- `routeHumanMessageToGroup()` helper is in `human-message-routing.ts` and covers all group states
- `task.sendHumanMessage { roomId, taskId, message }` RPC is registered and callable
- `awaiting_human` branch: calls `resumeWorkerFromHuman` with no additional `groupRepo.appendMessage` call
- `awaiting_leader` branch: calls `injectMessageToLeader` + appends to group timeline once
- `awaiting_worker` branch: returns `{ success: false, error: "..." }`
- Unit tests cover all state branches of `routeHumanMessageToGroup()`
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
- Text input + "Send Feedback" button (calls `task.sendHumanMessage` RPC) that resumes worker with rejection feedback

**When `awaiting_leader`:**
- Compact text input area + "Send to Leader" button
- Calls `task.sendHumanMessage` RPC

**When `awaiting_worker`:**
- Text input area, disabled, with tooltip "Worker is running — wait for leader review"

**When `completed`, `failed`, or no group:**
- No input shown

Human messages must render in `TaskConversationRenderer.tsx` with the existing `human` role styling (green left border, already defined). After a human message is sent, trigger a re-fetch of group messages so the new entry appears immediately in the timeline.

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
**Depends on:** Task 1 (for the `routeHumanMessageToGroup` shared helper)

**Description:**

Extend `packages/daemon/src/lib/room/tools/room-agent-tools.ts` with new tools that give the Room Agent full orchestration capabilities for human-in-the-loop flows.

**New tools:**

1. **`approve_task(task_id)`** — Approves a task in `review` status. Calls `runtime.resumeWorkerFromHuman(taskId, approvalMessage, { approved: true })`. Requires `runtimeService: RoomRuntimeService` in `RoomAgentToolsConfig`.

2. **`reject_task(task_id, feedback)`** — Rejects a task with feedback. Calls `runtime.resumeWorkerFromHuman(taskId, feedback, { approved: false })`.

3. **`send_message_to_task(task_id, message)`** — Routes a message to the active session group by importing and calling the shared `routeHumanMessageToGroup()` helper from Task 1 (`human-message-routing.ts`). Do NOT re-implement the routing logic — reuse the shared helper.

4. **`get_task_detail(task_id)`** — Returns full task details including current group state, group ID, worker/leader session IDs, feedback iteration count, and whether it's awaiting human review. Uses `TaskManager.getTask()` + `groupRepo.getGroupByTaskId()`.

**Enhanced existing tool:**

Extend `get_room_status()` to include a `tasksNeedingReview` list: task IDs and titles currently in `review` status or whose group is in `awaiting_human` state.

**Config update:**

Update `RoomAgentToolsConfig` interface to include `runtimeService?: RoomRuntimeService`. Wire the new tools in `createRoomAgentMcpServer()`.

**Acceptance criteria:**
- `approve_task` tool approves tasks in review state
- `reject_task` tool resumes worker with rejection feedback
- `send_message_to_task` uses `routeHumanMessageToGroup()` from `human-message-routing.ts` (no duplicated routing logic)
- `get_task_detail` returns full task + group state info
- `get_room_status` includes `tasksNeedingReview` list
- Tool errors are returned as `{ success: false, error: "..." }`
- Unit tests for all new tool handlers
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Frontend – Room Chat tab

**Agent:** coder
**Priority:** normal

**Description:**

Add a "Chat" tab to the Room island (`packages/web/src/islands/Room.tsx`) that provides a conversational interface with the Room Agent session (`room:chat:${roomId}`).

Changes:
1. Add `'chat'` to the `RoomTab` type
2. Add a "Chat" tab button in the tab bar, positioned first (before Overview)
3. When `activeTab === 'chat'`, render `<ChatContainer key={chatSessionId} sessionId={chatSessionId} />` where `chatSessionId = 'room:chat:${roomId}'`
4. Add a notification badge on the "Chat" tab button when any task is in `review` status (a red dot or count badge). Subscribe to `room.task.update` events in `roomStore` to track the count; `roomStore.tasks.value` already has the task list.
5. Update router (`packages/web/src/lib/router.ts`) to support a `chat` subpath: `/rooms/${roomId}/chat` navigates to the chat tab. Add `navigateToRoomChat(roomId)` helper.
6. When a room first loads, if there are tasks in `review` status, default to the `'chat'` tab.

**Acceptance criteria:**
- "Chat" tab appears in Room island tab bar
- Clicking "Chat" tab renders the room chat session via `ChatContainer`
- Red notification badge appears on Chat tab when any task is in `review` status
- `/rooms/${roomId}/chat` URL navigates to the chat tab
- `navigateToRoomChat(roomId)` helper is exported from `router.ts`
- Room defaults to Chat tab on load if any task is in `review`
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: Frontend – Review notifications and task list polish

**Agent:** coder
**Priority:** normal
**Depends on:** Task 2, Task 4

**Description:**

Polish the human-in-the-loop UX with review notifications and improved task list interactions.

**1. Toast notification on task entering review**

In `packages/web/src/lib/room-store.ts`, when a `room.task.update` event arrives with `task.status === 'review'` (and the task was not previously in `review`), show a toast notification: "Task ready for review: {task.title}".

**2. Task list review actions in RoomDashboard**

In `packages/web/src/components/room/RoomTasks.tsx`, for tasks in `review` status, show both:
- "Approve" button (existing) — calls `goal.approveTask`
- "View" button — navigates to TaskView so the human can read the conversation before deciding

**3. Review count badge on room list**

In `packages/web/src/islands/RoomList.tsx` (or `RoomGrid.tsx`), show a count badge on room entries when they have tasks in `review` status. The count comes from the task list already fetched in the overview.

**4. TaskView "Awaiting review" indicator**

The `awaiting_human` group state already flows through the existing `room.task.update` event: when `submit_for_review` is called, `emitTaskUpdateById` is already called which sets `task.status = 'review'`. `TaskView` already subscribes to `room.task.update` and re-fetches `group` on change. Therefore:
- In `TaskView`, after `fetchGroup()`, if `group.state === 'awaiting_human'` show a pulsing "Awaiting your review" badge in the header.
- No new daemon event is needed — reuse the existing `room.task.update` subscription that already calls `fetchGroup()`.

**Acceptance criteria:**
- Toast appears when a task first transitions to `review` status
- RoomTasks shows both "Approve" and "View" buttons for review-status tasks
- Room list shows review badge count for rooms with tasks in `review`
- TaskView header shows pulsing indicator when `group.state === 'awaiting_human'`
- No new daemon event types introduced — all handled via existing `room.task.update`
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependencies

```
Task 1 (task.get RPC + sendHumanMessage RPC + shared routing helper)
  ├─> Task 2 (frontend TaskView input)
  │     └─> Task 5 (polish + notifications)
  └─> Task 3 (room agent tools — uses shared routing helper)

Task 4 (room chat tab)  [independent]
  └─> Task 5 (polish + notifications)
```

Tasks 1 and 4 can start immediately in parallel. Task 2 depends on Task 1. Task 3 depends on Task 1 (for the shared helper). Task 5 depends on Tasks 2 and 4.

## Acceptance Criteria (Overall)

- Human can send messages from TaskView that reach the leader/worker
- Human can approve or reject tasks from TaskView
- Room Agent can approve/reject tasks and send messages to active tasks via chat
- Room Chat tab is accessible and shows review notifications
- No routing logic duplication — `routeHumanMessageToGroup()` is the single source of truth
- All changes tested with unit/integration tests
- No regressions in existing room runtime behavior
