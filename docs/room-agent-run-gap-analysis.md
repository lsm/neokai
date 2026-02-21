# Room Agent "Run" Button — Gap Analysis

> Minimal gaps to achieve: click "Run" → room agent starts working on goals using sessions and manager agents, given room background, instructions, goals, and jobs are configured.

## Current State Summary

The backend infrastructure is ~90% complete. The room agent lifecycle, MCP tools, session pair management, task/goal systems, and RPC handlers are all implemented. The primary gaps are in **UI wiring**, **system prompt completeness**, and **autonomous session execution**.

---

## Gap 1: RoomAgentStatus Not Wired into Dashboard

**Priority: HIGH — No "Run" button visible in UI**

`RoomAgentStatus.tsx` has a fully implemented Start/Pause/Resume button component, but `RoomDashboard.tsx` doesn't import or render it.

**Files:**
- `packages/web/src/components/room/RoomDashboard.tsx` — missing `<RoomAgentStatus>`
- `packages/web/src/components/room/RoomAgentStatus.tsx` — ready to use

**Fix:** Import `RoomAgentStatus` into `RoomDashboard` and render it at the top of the dashboard with the room's agent state and an `onAction` handler.

---

## Gap 2: No Agent State Signal or RPC Wiring in RoomStore

**Priority: HIGH — Button clicks can't reach the daemon**

`RoomStore` has no:
- Signal for `agentState: RoomAgentState | null`
- Methods to call `roomAgent.start`, `roomAgent.stop`, `roomAgent.pause`, `roomAgent.resume`
- Event subscription for `roomAgent.stateChanged`
- Initial fetch of `roomAgent.getState` on room select

The RPC handlers (`roomAgent.start`, `roomAgent.stop`, etc.) are all implemented on the daemon side and ready to be called.

**Files:**
- `packages/web/src/lib/room-store.ts` — needs agent state signal + methods + subscriptions

**Fix:**
1. Add `agentState` signal to `RoomStore`
2. Add `startAgent()`, `stopAgent()`, `pauseAgent()`, `resumeAgent()` methods calling the corresponding RPCs
3. Subscribe to `roomAgent.stateChanged` events in `startSubscriptions()`
4. Fetch initial agent state via `roomAgent.getState` in `fetchInitialState()`

---

## Gap 3: System Prompt Missing Room Context

**Priority: HIGH — Agent doesn't know the room's purpose**

The default system prompt (`room-agent-service.ts:1191-1211`) includes only the room name and generic responsibilities. It does **not** include:
- `room.background` — the project background/purpose
- `room.instructions` — user-defined behavioral instructions

Without this context, the room agent has no awareness of *what* it's supposed to work on.

Goals and recurring jobs should **not** be baked into the system prompt — they change frequently and should be pulled on-demand via tools instead.

> **Note:** The database column is currently named `background_context`. This needs a migration to rename it to `background`, along with updating all references across the codebase (schema, types, room-manager, RPC handlers, frontend components, etc.).

**File:** `packages/daemon/src/lib/room/room-agent-service.ts` — `getDefaultSystemPrompt()`

**Fix:**
1. Include `room.background` and `room.instructions` in the system prompt:
```
## Room Background
{room.background}

## Instructions
{room.instructions}
```
2. Add new MCP tools to `room-agent-tools.ts` so the agent can pull goals and jobs on demand:
   - `room_list_goals()` — returns active goals with title, description, status, progress
   - `room_list_jobs()` — returns recurring jobs with name, schedule, description, enabled status
   - `room_list_tasks(status?)` — returns tasks filtered by status (already partially available via planning prompt, but should be a callable tool)

---

## Gap 4: No Immediate Planning on Start

**Priority: MEDIUM — Up to 60s delay before agent acts**

After `start()`, the agent relies on `setInterval(checkIdleState, 60000)` to trigger the first planning cycle. This means after clicking "Run", the user waits up to 60 seconds before anything happens.

**File:** `packages/daemon/src/lib/room/room-agent-service.ts` — `start()` method (line 232)

**Fix:** Call `checkIdleState()` immediately after `startIdleCheck()` in the `start()` method, or schedule an immediate `setTimeout(checkIdleState, 0)`.

---

## Gap 5: Worker Sessions Don't Auto-Execute

**Priority: HIGH — Spawned workers sit idle**

When `SessionPairManager.createPair()` runs, it:
1. Creates worker session via `sessionLifecycle.create()` — session saved to DB ✓
2. Creates manager session similarly ✓
3. Creates MCP tools for manager ✓

But neither session actually **starts running**. `SessionLifecycle.create()` stores the session and creates an `AgentSession` instance, but doesn't start the SDK query loop. Sessions currently wait for a WebSocket client to connect and send a message.

For autonomous room agent workers, sessions need to start executing their task immediately without a human client.

**Files:**
- `packages/daemon/src/lib/room/session-pair-manager.ts` — `createPair()` (lines 78-101)
- `packages/daemon/src/lib/session/session-lifecycle.ts` — `create()`
- `packages/daemon/src/lib/agent/agent-session.ts` — needs auto-start capability

**Fix options:**
1. **Auto-start in createPair**: After creating both sessions, inject the task description as an initial message into the worker's `AgentSession.messageQueue` and the manager's queue. This would kick off the SDK query loop.
2. **Background execution mode**: Add a flag to `SessionLifecycle.create()` that auto-starts the session with a given initial prompt, bypassing the need for a WebSocket client.

---

## Gap 6: Room Agent Missing Read Tools for Goals/Jobs/Tasks

**Priority: HIGH — Agent can't discover what to work on**

The room agent has tools to *create* tasks, *spawn* workers, and *complete* goals, but has no tools to *read* current goals, jobs, or tasks. The planning prompt (`buildPlanningPrompt`) injects some of this data, but only during idle checks — the agent cannot pull this information on demand.

**Files:**
- `packages/daemon/src/lib/agent/room-agent-tools.ts` — needs read tools

**Fix:** Add MCP tools to `room-agent-tools.ts`:
- `room_list_goals()` — returns all goals with title, description, status, progress, priority
- `room_list_jobs()` — returns recurring jobs with name, schedule, description, enabled status
- `room_list_tasks(status?)` — returns tasks with title, description, status, priority, progress

---

## Summary

| # | Gap | Priority | Effort | Area |
|---|-----|----------|--------|------|
| 1 | RoomAgentStatus not in Dashboard | HIGH | Small | Web |
| 2 | No agent state signal/RPC in RoomStore | HIGH | Medium | Web |
| 3 | System prompt missing room background & instructions | HIGH | Small | Daemon |
| 4 | No immediate planning on start | MEDIUM | Tiny | Daemon |
| 5 | Worker sessions don't auto-execute | HIGH | Medium | Daemon |
| 6 | No read tools for goals/jobs/tasks | HIGH | Small | Daemon |

## Suggested Implementation Order

1. **Gap 3** — Add `room.background` and `room.instructions` to system prompt (daemon, small)
2. **Gap 6** — Add `room_list_goals`, `room_list_jobs`, `room_list_tasks` MCP tools (daemon, small)
3. **Gap 4** — Immediate planning on start (daemon, tiny)
4. **Gap 5** — Worker session auto-execution (daemon, medium — the core blocker)
5. **Gap 2** — RoomStore agent state + RPC methods (web, medium)
6. **Gap 1** — Wire RoomAgentStatus into Dashboard (web, small)

After these 6 fixes, clicking "Run" will:
1. Call `roomAgent.start` RPC
2. Agent starts with system prompt containing room background & instructions
3. Immediately checks idle state → injects planning prompt
4. AI calls `room_list_goals` / `room_list_tasks` to understand current state
5. AI creates tasks and calls `room_spawn_worker`
6. Worker sessions auto-start and execute tasks
7. UI shows agent state transitions in real-time
