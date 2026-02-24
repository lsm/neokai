# Old Room Implementation Cleanup Plan

> Preparing the codebase for Room Runtime v0.19 implementation.
>
> Contributors: `claude-opus-4-6`, `gpt-5-codex`, `glm-5`
> Consolidated by: `claude-opus-4-6`

## Problem

The existing room implementation (~85 files) uses a fundamentally different architecture than the Room Runtime spec v0.19. The old code uses an AI-based `RoomNeo` orchestrator with MCP tools and worker sessions. The new spec uses a deterministic `Runtime` scheduler with (Craft, Lead) pair pattern and DB-backed message routing.

## Strategy: Surgical Removal

Remove the old orchestration layer. Keep the CRUD foundation (managers, repositories, handlers) and modify it for the new spec. No feature flags, no strangler pattern — the old autonomy doesn't work and isn't in production.

**Infrastructure to reuse:**
- `AgentSession.fromInit()` — factory pattern for Craft/Lead sessions
- `ProcessingStateManager` — state machine foundation
- `DaemonHub` events — observation layer for session terminal states
- Room/Lobby tools pattern — template for Lead Agent tools

---

## Part 1: Wiring Hub — `rpc-handlers/index.ts`

> All room managers are created in `packages/daemon/src/lib/rpc-handlers/index.ts`. This is the critical file.

### Current wiring (to remove)

```typescript
// Line ~85: RoomManager — KEEP
const roomManager = new RoomManager(deps.db.getDatabase());

// Lines ~88-93: WorkerManager — DELETE (replaced by TaskPairManager)
const workerManager = new WorkerManager(...);

// Lines ~96-102: Factories — KEEP (update signatures later)
const taskManagerFactory = ...;
const goalManagerFactory = ...;

// Lines ~105-106: RecurringJobScheduler — DELETE (not in spec)
const recurringJobScheduler = new RecurringJobScheduler(...);
recurringJobScheduler.start();

// Line ~109: PromptTemplateManager — DELETE creation (only consumer is RoomSelfManager)
// KEEP the class definition + DB tables for future Craft/Lead prompt management
// Remove creation here until Phase 1 needs it
const promptTemplateManager = new PromptTemplateManager(...);

// Lines ~112-126: RoomSelfManager — DELETE (replaced by RoomRuntime)
const roomSelfManager = new RoomSelfManager({...});
```

### Current handler registrations (keep/remove)

```typescript
setupSessionHandlers(...)           // KEEP — session lifecycle
setupRoomHandlers(...)              // KEEP — room CRUD (remove agent params)
setupTaskHandlers(...)              // KEEP — task CRUD (update for new states)
setupMemoryHandlers(...)            // DELETE — not in spec
setupRoomMessageHandlers(...)       // DELETE — replaced by task_messages queue
setupGoalHandlers(...)              // KEEP — goal CRUD (update for new states)
setupRecurringJobHandlers(...)      // DELETE — not in spec
setupRoomSelfHandlers(...)          // DELETE — replaced by RoomRuntime handlers
roomSelfManager.startAgentsWithRunIntent()  // DELETE
```

### Current cleanup function (to update)

```typescript
return () => {
  recurringJobScheduler.stop();     // DELETE
  roomSelfManager.stopAll();        // DELETE → replace with roomRuntime.stop()
};
```

---

## Part 2: Files to DELETE

### daemon/src/lib/room/ — Old Orchestration

| File | Lines | Why delete |
|---|---|---|
| `room-self-service.ts` | ~1,909 | LLM orchestrator → replaced by RoomRuntime |
| `room-self-lifecycle-manager.ts` | ~512 | 7-state lifecycle → spec has 6-state pair machine (`awaiting_craft`, `awaiting_lead`, `awaiting_human`, `hibernated`, `completed`, `failed`) |
| `worker-manager.ts` | ~460 | Worker sessions → replaced by TaskPairManager |
| `recurring-job-scheduler.ts` | ~444 | Not in v0.19 spec |
| `context-manager.ts` | ~193 | Context versioning not in spec |
| `memory-manager.ts` | ~184 | Memory system not in spec |
| `archive/` | entire dir | Already archived old versions _(directory doesn't exist — skip)_ |

**KEEP in this directory:**
- `room-manager.ts` (293 lines) — room CRUD, add `config` column (**MODIFY**: strip `MemoryRepository`/`ContextRepository` imports, fields, constructor init; rewrite `getRoomStatus()`/`getRoomOverview()` to not use context/memory; remove `getContextVersions()`/`getContextVersion()`/`rollbackContext()`)
- `goal-manager.ts` (365 lines) — goal CRUD, update states
- `task-manager.ts` (276 lines) — task CRUD, update states + add columns
- `index.ts` (78 lines) — update exports (remove deleted managers)

### daemon/src/lib/rpc-handlers/ — Old Handlers

| File | Why delete |
|---|---|
| `room-self-handlers.ts` | Contains `RoomSelfManager` class + `roomAgent.*` RPC handlers → replaced by Runtime |
| `room-message-handlers.ts` | `room.message.send/history` → replaced by task_messages queue |
| `recurring-job-handlers.ts` | `recurringJob.*` handlers → not in spec |
| `memory-handlers.ts` | `memory.*` handlers → not in spec |
| ~~`archive-room-self-handlers.ts.bak`~~ | ~~Already archived~~ _(doesn't exist — removed)_ |

**KEEP in this directory:**
- `room-handlers.ts` — room CRUD RPCs (remove `workerManager`, `roomSelfManager` params)
- `goal-handlers.ts` — goal CRUD RPCs (update states)
- `task-handlers.ts` — task CRUD RPCs (update states + columns)
- `index.ts` — update imports/registrations

### daemon/src/lib/agent/ — Old Agent Tools

| File | Why delete |
|---|---|
| `room-agent-tools.ts` (~743 lines) | 17 MCP tools for old room agent → replaced by Lead tool contract (4 tools) |

**Also check for:** `worker-tools.ts` — if it exists, delete (Craft has no completion tools)

### daemon/src/storage/repositories/ — Old Repositories

| File | Why delete |
|---|---|
| `room-self-state-repository.ts` | `room_agent_states` table → replaced by `task_pairs` state |
| `worker-session-repository.ts` | `worker_sessions` table → replaced by `task_pairs` |
| `room-context-version-repository.ts` | Context versioning not in spec |
| `recurring-job-repository.ts` | Not in spec |
| `context-repository.ts` | Context/conversation system not in spec |
| `memory-repository.ts` | Memory system not in spec |
| ~~`archive-room-self-state-repository.ts.bak`~~ | ~~Already archived~~ _(doesn't exist — removed)_ |

**KEEP in this directory:**
- `room-repository.ts` — room CRUD (add `config` column) (**MODIFY**: strip `getContextVersions()`/`getContextVersion()`/`rollbackContext()` which delegate to `RoomContextVersionRepository` and reference the dropped `room_context_versions` table)
- `goal-repository.ts` — goal CRUD (update states + counters)
- `task-repository.ts` — task CRUD (update states + columns)
- `session-repository.ts`, `sdk-message-repository.ts`, `settings-repository.ts`, etc.

### shared/src/prompts/ — Old Prompts

| File | Why delete |
|---|---|
| `room-agent.ts` (~211 lines) | `buildRoomAgentSystemPrompt()`, `ROOM_AGENT_SYSTEM_TEMPLATE` → replaced by Craft/Lead/Room Agent prompts |

**Also clean up:**
- `templates.ts` — remove `ROOM_AGENT_SYSTEM_TEMPLATE` import (line 10) and the room_agent template entry from `BUILTIN_TEMPLATES` array; also remove `MANAGER_AGENT_*` templates
- `types.ts` — remove `'manager_agent'` and `'room_agent'` from `PromptTemplateCategory`, remove `MANAGER_AGENT_*` and `ROOM_AGENT_*` from `BUILTIN_TEMPLATE_IDS`

### shared/src/neo-prompt/ — Legacy Package

| File | Why delete |
|---|---|
| `index.ts` | Legacy exports |
| `actions.ts` | `buildRoomPrompt()` — old utility |
| `prompt.ts` | `_ROOM_NEO_SYSTEM_PROMPT` — references manager-worker pairs |

**Delete entire directory** if nothing else imports from it.

### packages/neo/ — Old AI Orchestrator

| File | Why delete |
|---|---|
| `room-neo.ts` | `RoomNeo` class — entirely replaced by deterministic Runtime |
| `neo-session-watcher.ts` | Session watching → replaced by Runtime event loop |
| `neo-client.ts` | Client for old orchestrator — no longer needed |
| `tests/room-neo-pair.test.ts` | Tests for deleted code |

**Delete entire package** if it only contains room orchestration.

**If deleting `packages/neo`, also update workspace references:**
- `tsconfig.json` (root): remove `{ "path": "./packages/neo" }` from references array
- `packages/cli/package.json`: remove `"@neokai/neo": "workspace:*"` dependency
- Root `package.json` workspaces uses `"packages/*"` glob — no change needed (auto-excludes deleted dir)

---

## Part 3: Files to MODIFY

### daemon/src/lib/room/index.ts — Remove deleted exports

**Remove exports for:**
- `ContextManager`
- `MemoryManager`
- `WorkerManager`
- `RecurringJobScheduler`
- `RoomSelfService`, `RoomSelfContext`, `RoomSelfConfig`, `DEFAULT_ROOM_SELF_CONFIG`
- `RoomSelfLifecycleManager`
- All `NeoContext*`, `NeoMemory*`, `RecurringJob*`, `RoomSelf*`, `WorkerSession*`, `SessionPair*`, `ManagerHook*` type re-exports

**Keep exports for:**
- `RoomManager`
- `GoalManager`
- `TaskManager`
- `Room`, `RoomStatus`, `CreateRoomParams`, `UpdateRoomParams`
- `RoomGoal`, `GoalStatus`, `GoalPriority`
- `NeoTask`, `TaskStatus`, `TaskPriority`, `TaskFilter`, `CreateTaskParams`, `UpdateTaskParams`

### daemon/src/lib/rpc-handlers/room-handlers.ts — Remove agent params + context RPCs + MCP registry

**Current signature** (passes `workerManager`, `roomSelfManager`, `roomMcpServerRegistry`):
- Remove `workerManager` param
- Remove `roomSelfManager` param
- Remove `roomMcpServerRegistry` Map (line 42)
- Remove `getOrCreateRoomMcpServer()` export (line 50)
- Remove `getRoomMcpServer()` export (line 176)
- Remove `setRoomMcpServer()` export (line 188)
- Remove `deleteRoomMcpServer()` export (line 467)
- Remove `createRoomAgentMcpServer` import from deleted `room-agent-tools.ts` (line 30)
- Remove 4 context versioning handlers (lines 711-816): `room.updateContext`, `room.getContextVersions`, `room.getContextVersion`, `room.rollbackContext`
- Update `neo.status` handler (line 852): `roomManager.getGlobalStatus()` depends on `memoryRepo` — rewrite to not use memory/context data
- Remove any `roomAgent.*` handler registrations that depend on deleted code
- Keep `room.create`, `room.list`, `room.get`, `room.update`, `room.archive`, `room.overview`

### daemon/src/lib/agent/query-options-builder.ts — Remove room_self MCP handling

- Remove dynamic `getRoomMcpServer` import block (lines 25-34) — requires deleted `room-handlers.ts` exports
- Remove `room_self` session type check (line 210): `session.type === 'room_self'` branch
- Remove `__IN_PROCESS_ROOM_AGENT_TOOLS__` marker handling in `getMcpServers()` (lines 546-568)
- Add `craft`/`lead` session type handling if needed (evaluate during implementation)

### daemon/src/lib/agent/agent-session.ts — Update session type branching

- Line 451: references `type === 'room_self'` in session title formatting
- Update to handle new `craft`/`lead` session types instead (e.g., `'Craft Agent'`, `'Lead Agent'`)

### daemon/src/lib/session/session-lifecycle.ts — Remove room_self references

- Lines 45-48: comments document `room_self` type and include it in type union — update for `craft`/`lead`
- Line 159: comment mentions `room_self` as valid session type — update
- Line 181: MCP server comment references "room chat sessions" — review for accuracy

### daemon/src/storage/index.ts (Database facade) — Remove delegated methods

**Remove method groups:**
- Memory operations: `addMemory()`, `listMemories()`, `searchMemories()`, `recallMemories()`, `deleteMemory()`
- Context operations: `updateRoomContext()`, `getContextVersions()`, `rollbackContext()`
- Recurring job operations: `createRecurringJob()`, `getRecurringJob()`, `listRecurringJobs()`, `updateRecurringJob()`, `getDueRecurringJobs()`, `markRecurringJobRun()`, `enableRecurringJob()`, `disableRecurringJob()`, `deleteRecurringJob()`
- Room agent state operations: `createRoomSelfState()`, `getRoomSelfState()`, `updateRoomSelfState()`, `transitionRoomSelfState()`, `recordRoomSelfError()`, `clearRoomSelfError()`, `addActiveWorkerSession()`, `removeActiveWorkerSession()`

**Keep method groups:**
- Room CRUD: `createRoom()`, `getRoom()`, `listRooms()`, `updateRoom()`, `archiveRoom()`
- Task CRUD: `createTask()`, `getTask()`, `listTasks()`, `updateTaskStatus()`
- Goal CRUD: `createGoal()`, `getGoal()`, `listGoals()`, `updateGoal()`, `deleteGoal()`, `linkTaskToGoal()`, `unlinkTaskFromGoal()`, `getGoalsForTask()`

### shared/src/types/neo.ts — Remove old types, update enums

**DELETE these types:**
- `SessionPairStatus`, `SessionPair`, `SessionPairSummary`, `CreateSessionPairParams` (deprecated)
- `ManagerHookEvent`, `ManagerHookPayload` (deprecated)
- `WorkerStatus`, `WorkerSession`, `CreateWorkerParams`, `WorkerCompleteTaskParams` (replaced by task_pairs)
- `RoomSelfLifecycleState`, `RoomSelfState`, `RoomSelfSessionMetadata`, `RoomSelfPlanningContext`, `RoomSelfReviewContext`, `RoomSelfHumanInput`, `RoomSelfWaitingContext`, `RoomSelfConfig`, `DEFAULT_ROOM_SELF_CONFIG`
- `NeoContextStatus`, `NeoContext`, `NeoContextMessage`, `ContextMessageRole` (context system removed)
- `NeoMemory`, `MemoryType`, `MemoryImportance`, `CreateMemoryParams` (memory system removed)
- `RecurringJobSchedule`, `RecurringTaskTemplate`, `RecurringJob`, `CreateRecurringJobParams` (not in spec)
- `ContextChangedBy`, `RoomContextVersion` (context versioning removed)
- `TaskExecutionMode`, `TaskSession` (multi-session model replaced by pairs)
- `SessionEventType`, `SessionEvent` (evaluate — may still be useful)

**UPDATE these types:**
- `GoalStatus`: `'pending' | 'in_progress' | 'completed' | 'blocked'` → `'active' | 'needs_human' | 'completed' | 'archived'`
- `TaskStatus`: `'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled'` → `'draft' | 'pending' | 'in_progress' | 'escalated' | 'completed' | 'failed'`
- `NeoTask`: add `task_type`, `priority` (INTEGER), `version`, `created_by_task_id`, `depends_on`
- `Room`: add `config` (JSON)
- `RoomGoal`: add `planning_attempts`, `goal_review_attempts`

**KEEP these types:**
- `Room`, `RoomStatus`, `CreateRoomParams`, `UpdateRoomParams`, `WorkspacePath`
- `RoomGoal`, `GoalPriority`
- `NeoTask`, `TaskPriority`, `TaskFilter`, `CreateTaskParams`, `UpdateTaskParams`
- `SessionSummary`, `TaskSummary`, `RoomOverview`, `NeoStatus`, `GlobalStatus`

### shared/src/types.ts — Update session types

**Change:**
```typescript
// OLD
export type SessionType = 'worker' | 'room_chat' | 'room_self' | 'lobby';

// NEW
export type SessionType = 'worker' | 'room_chat' | 'craft' | 'lead' | 'lobby';
```

**Also update:**
- `SessionContext`: remove `selfSessionId`, `chatSessionId` (old room_self ↔ room_chat linking)
- `SessionMetadata.sessionType`: remove `'manager'` from union
- Feature defaults: remove `DEFAULT_ROOM_SELF_FEATURES`, rename for new types

### daemon/src/storage/schema/index.ts — Update session type CHECK constraint

- Line 46: `CHECK(type IN ('worker', 'manager', 'room_chat', 'room_self', 'lobby'))` → drop both `'manager'` (stale — already removed from `SessionType` but never cleaned from schema) and `'room_self'`, add `'craft'`, `'lead'` → `CHECK(type IN ('worker', 'room_chat', 'craft', 'lead', 'lobby'))`

### daemon/src/storage/schema/migrations.ts — Update session type references

- Multiple references to `room_self` in migration comments and CHECK constraints (lines 95, 1260, 1313, 1382, 1397-1398, 1430)
- These are in historical migrations — **do NOT modify old migrations**. The new migration (Step 21) will ALTER the CHECK constraint on the `sessions` table

> **WARNING**: `providers/context-manager.ts` handles AI provider context switching and is **unrelated** to room context. Do NOT delete it or its test.

### daemon/src/lib/daemon-hub.ts — Remove old event types

**Remove ~22 events across 5 groups:**
- `ManagerHookEvent`, `ManagerHookPayload`
- 9 `roomAgent.*` events: `stateChanged` (399), `hook` (406), `error` (412), `idle` (418), `reviewRequested` (424), `reviewReceived` (431), `escalated` (438), `escalationResolved` (445), `questionAnswered` (451)
- 2 `room.context*` events: `contextUpdated` (185), `contextRolledBack` (193)
- 1 `room.message` event (225) — message system replaced by `task_messages`
- 7 `recurringJob.*` events: `created` (357), `updated` (363), `triggered` (369), `completed` (376), `enabled` (382), `disabled` (387), `deleted` (392)
- 3 dead `task.session*` events: `sessionStarted` (459), `sessionCompleted` (466), `allSessionsCompleted` (474) — zero emitters
- Any worker session events

---

## Part 4: Frontend Changes

### web/src/components/room/ — Delete old components

| File | Why delete |
|---|---|
| `RoomSelfStatus.tsx` + `RoomSelfStatus.test.tsx` | Old agent lifecycle display — no more room_self |
| `RoomEscalations.tsx` | Old escalation model — redesigned in spec |
| `TaskSessionView.tsx` + `TaskSessionView.test.tsx` | Old task execution view — replaced by Task Chat View |
| `ContextEditor.tsx` | Context versioning system removed |
| `ContextVersionHistory.tsx` | Context versioning system removed |
| `ContextVersionViewer.tsx` | Context versioning system removed |
| `RecurringJobsConfig.tsx` + `RecurringJobsConfig.test.tsx` | Not in spec |

**KEEP:**
- `RoomDashboard.tsx` — modify (remove RoomSelfStatus, RoomEscalations imports)
- `GoalsEditor.tsx` + test — modify (update state options)
- `RoomTasks.tsx` — modify (remove TaskSessionView, update states)
- `RoomSessions.tsx` — modify (show Craft/Lead instead of workers)
- `RoomSettings.tsx` — keep as-is
- `index.ts` — update exports

### web/src/components/room/index.ts — Remove deleted exports

**Remove:**
- `RoomSelfStatus`
- `RoomEscalations`
- `TaskSessionView`
- `ContextEditor`, `ContextVersionHistory`, `ContextVersionViewer`
- `RecurringJobsConfig`

### web/src/islands/ChatContainer.tsx — Remove room_self feature branch

- Remove `DEFAULT_ROOM_SELF_FEATURES` import (line 23) — being deleted from `types.ts`
- Remove `room:self:` branch (lines 291-292): `if (sessionId.startsWith('room:self:')) { return DEFAULT_ROOM_SELF_FEATURES; }`
- Keep `DEFAULT_ROOM_CHAT_FEATURES` import and `room:chat:` branch (still used)

### web/src/islands/Room.tsx — Remove deleted tabs

**Current tabs:** overview, context, goals, jobs, settings
**New tabs:** overview, goals, settings (remove context, jobs)

**Remove imports:** `ContextEditor`, `RecurringJobsConfig`, `CreateJobParams`
**Remove:** "self" chat tab (ChatContainer for `room:self:{roomId}`)

### web/src/islands/RoomContextPanel.tsx — Simplify

**Remove:**
- Agent status display with color coding (RoomSelfState)
- Worker sessions list
- References to `roomStore.agentState`, `roomStore.waitingContext`

### web/src/lib/room-store.ts — Remove old state and methods

**Remove signals:**
- `recurringJobs`, `jobsLoading`
- `agentState`, `waitingContext`

**Remove computed accessors:**
- `enabledRecurringJobs`

**Remove subscription event listeners:**
- `recurringJob.created/updated/deleted/triggered`
- `roomAgent.stateChanged`
- `roomAgent.escalated`
- `roomAgent.reviewRequested`

**Remove methods:**
- Recurring jobs: `fetchRecurringJobs()`, `createRecurringJob()`, `updateRecurringJob()`, `deleteRecurringJob()`, `triggerRecurringJob()`
- Context versioning: `updateContext()`, `fetchContextVersions()`, `rollbackContext()`
- Room agent: `fetchAgentState()`, `startAgent()`, `stopAgent()`, `pauseAgent()`, `resumeAgent()`, `fetchWaitingContext()`, `sendHumanInput()`, `respondToReview()`, `respondToEscalation()`

**Keep methods:**
- Room selection: `select()`, `doSelect()`
- Tasks: `createTask()`
- Sessions: `createSession()`
- Goals: `fetchGoals()`, `createGoal()`, `updateGoal()`, `deleteGoal()`, `linkTaskToGoal()`
- Room management: `updateSettings()`, `archiveRoom()`, `deleteRoom()`
- Lifecycle: `refresh()`

---

## Part 5: Test Files

### DELETE (test deleted code)

| File | Tests for |
|---|---|
| `tests/unit/room/worker-manager.test.ts` | WorkerManager (deleted) |
| `tests/unit/room/memory-manager.test.ts` | MemoryManager (deleted) |
| `tests/unit/room/context-manager.test.ts` | ContextManager (deleted) |
| `tests/unit/room/recurring-job-scheduler.test.ts` | RecurringJobScheduler (deleted) |
| `tests/unit/room/recurring-job-scheduler.guards.test.ts` | RecurringJobScheduler (deleted) |
| `tests/unit/room/room-self-state-repository.test.ts` | RoomSelfStateRepository (deleted) |
| `tests/unit/rpc/room-self-handlers.test.ts` | RoomSelfHandlers (deleted) |
| `tests/unit/rpc/room-message-handlers.test.ts` | RoomMessageHandlers (deleted) |
| `tests/integration/room/room-self-worker-lifecycle.integration.test.ts` | Old orchestration lifecycle (deleted) |
| `tests/integration/neo-in-process.test.ts` | Imports `@neokai/neo` (deleted in Step 5) |
| `e2e/tests/smoke/room.e2e.ts` | Tests old room UI — will need rewrite for new UI |
| `e2e/tests/helpers/room-helpers.ts` | Helpers for old room E2E — will need rewrite |

### KEEP (test surviving code)

| File | Tests for |
|---|---|
| `tests/unit/room/room-manager.test.ts` | RoomManager CRUD (kept) |
| `tests/unit/room/goal-manager.test.ts` | GoalManager CRUD (kept, update states) |
| `tests/unit/room/task-manager.test.ts` | TaskManager CRUD (kept, update states) |
| `tests/unit/room/room-repository.test.ts` | RoomRepository (kept) |
| `tests/unit/rpc/room-handlers.test.ts` | Room RPC handlers (kept, update) |
| `tests/unit/rpc/goal-handlers.test.ts` | Goal RPC handlers (kept, update) |
| `tests/unit/rpc/task-handlers.test.ts` | Task RPC handlers (kept, update) |
| `tests/unit/storage/task-repository.test.ts` | TaskRepository (kept, update) |

---

## Part 6: Database Migration

### Tables to DROP

| Table | Replacement |
|---|---|
| `room_agent_states` | Pair state lives in `task_pairs` |
| `worker_sessions` | Replaced by `task_pairs` |
| `contexts` | Not in spec |
| `context_messages` | Not in spec |
| `memories` | Not in spec |
| `recurring_jobs` | Not in spec |
| `room_context_versions` | Not in spec |

### Tables to ALTER

**`rooms`:**
- ADD `config TEXT` (JSON — `maxConcurrentPairs`, `taskTimeout`, `maxFeedbackIterations`, etc.)
- DROP `context_id`, `context_version` (context system removed)
- KEEP `instructions` — runtime spec depends on room instructions for Craft/Lead system prompts

**`goals`:**
- ADD `planning_attempts INTEGER NOT NULL DEFAULT 0`
- ADD `goal_review_attempts INTEGER NOT NULL DEFAULT 0`
- UPDATE status CHECK: `'active' | 'needs_human' | 'completed' | 'archived'`
- Data mapping: `'pending'` → `'active'`, `'in_progress'` → `'active'`, `'blocked'` → `'needs_human'`, `'completed'` → `'completed'`, others → `'archived'`

**`tasks`:**
- ADD `task_type TEXT NOT NULL DEFAULT 'coding'`
- CHANGE `priority` from TEXT enum (`low/normal/high/urgent`) to INTEGER (mapping: `low`→0, `normal`→1, `high`→2, `urgent`→3)
- ADD `version INTEGER NOT NULL DEFAULT 0`
- ADD `created_by_task_id TEXT`
- KEEP `depends_on TEXT DEFAULT '[]'` (already exists in schema baseline)
- UPDATE status CHECK: `'draft' | 'pending' | 'in_progress' | 'escalated' | 'completed' | 'failed'`
- Data mapping: `'blocked'` → `'escalated'`, `'cancelled'` → `'failed'`, others carry over
- DROP `session_id` (in schema baseline), `session_ids`, `execution_mode`, `sessions`, `recurring_job_id` (last 4 exist only via migrations — omit from table rebuild, no change needed in schema baseline)

> **Note**: SQLite does not support ALTER COLUMN or ALTER CHECK. Status/priority/type constraint changes require table rebuild:
> `CREATE TABLE tasks_new(...)` → `INSERT INTO tasks_new SELECT ... FROM tasks` (with value mapping) → `DROP TABLE tasks` → `ALTER TABLE tasks_new RENAME TO tasks`
> Same rebuild pattern needed for `goals` table and `sessions` table (CHECK constraint change).

### Tables to CREATE

**`task_pairs`:**
```sql
CREATE TABLE task_pairs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    craft_session_id TEXT NOT NULL,
    lead_session_id TEXT NOT NULL,
    pair_state TEXT NOT NULL DEFAULT 'awaiting_craft'
        CHECK(pair_state IN ('awaiting_craft', 'awaiting_lead', 'awaiting_human', 'hibernated', 'completed', 'failed')),
    pair_type TEXT NOT NULL DEFAULT 'coding',
    iteration INTEGER NOT NULL DEFAULT 0,
    lead_failures INTEGER NOT NULL DEFAULT 0,
    last_forwarded_message_id TEXT,
    feedback_iteration INTEGER NOT NULL DEFAULT 0,
    active_work_started_at INTEGER,
    active_work_elapsed INTEGER NOT NULL DEFAULT 0,
    hibernated_at INTEGER,
    completed_at INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

**`task_messages`:**
```sql
CREATE TABLE task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    pair_id TEXT NOT NULL REFERENCES task_pairs(id),
    from_role TEXT NOT NULL,
    to_role TEXT NOT NULL,
    to_session_id TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'normal',
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
);
```

**`room_audit_log`:** (aligned with runtime spec §DDL)
```sql
CREATE TABLE room_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    event_type TEXT NOT NULL,  -- 'tick' | 'pair_state_change' | 'message_delivery' | 'notification'
    detail TEXT NOT NULL,      -- JSON: what happened, trigger, outcome
    created_at INTEGER NOT NULL
);
```

---

## Part 7: Execution Checklist

### Prerequisite: Verify baseline
```bash
bun run check    # must pass before starting
```

### Step 1: Delete old orchestration (daemon/src/lib/room/)
- [x] `room-self-service.ts`
- [x] `room-self-lifecycle-manager.ts`
- [x] `worker-manager.ts`
- [x] `recurring-job-scheduler.ts`
- [x] `context-manager.ts`
- [x] `memory-manager.ts`
- [x] `archive/` (entire directory) _(skip if doesn't exist)_

### Step 2: Delete old agent tools (daemon/src/lib/agent/)
- [x] `room-agent-tools.ts`
- [x] `worker-tools.ts` (if exists)

### Step 3: Delete old RPC handlers (daemon/src/lib/rpc-handlers/)
- [x] `room-self-handlers.ts`
- [x] `room-message-handlers.ts`
- [x] `recurring-job-handlers.ts`
- [x] `memory-handlers.ts`
~~- [ ] `archive-room-self-handlers.ts.bak`~~ _(doesn't exist — removed)_

### Step 4: Delete old repositories (daemon/src/storage/repositories/)
- [x] `room-self-state-repository.ts`
- [x] `worker-session-repository.ts`
- [x] `room-context-version-repository.ts`
- [x] `recurring-job-repository.ts`
- [x] `context-repository.ts`
- [x] `memory-repository.ts`
~~- [ ] `archive-room-self-state-repository.ts.bak`~~ _(doesn't exist — removed)_

### Step 5: Delete old prompts (shared/src/) + neo package
- [x] `prompts/room-agent.ts`
- [x] `neo-prompt/` (entire directory, if only room orchestration)
- [x] `packages/neo/` (entire package, if only room orchestration)
- [x] If deleting `packages/neo`: remove from `tsconfig.json` references + remove `@neokai/neo` from `packages/cli/package.json`
- [x] `daemon/src/lib/prompts/` deleted (PromptTemplateManager + builtin templates — only consumers were deleted handlers)

### Step 6: Delete old UI components (web/src/components/room/)
- [x] `RoomSelfStatus.tsx` + `RoomSelfStatus.test.tsx`
- [x] `RoomEscalations.tsx`
- [x] `TaskSessionView.tsx` + `TaskSessionView.test.tsx`
- [x] `ContextEditor.tsx`
- [x] `ContextVersionHistory.tsx`
- [x] `ContextVersionViewer.tsx`
- [x] `RecurringJobsConfig.tsx` + `RecurringJobsConfig.test.tsx`

### Step 7: Delete old tests (daemon/tests/)
- [x] `unit/room/worker-manager.test.ts`
- [x] `unit/room/memory-manager.test.ts`
- [x] `unit/room/context-manager.test.ts` (**NOT** `providers/context-manager.test.ts` — that tests AI provider context, unrelated)
- [x] `unit/room/recurring-job-scheduler.test.ts`
- [x] `unit/room/recurring-job-scheduler.guards.test.ts`
- [x] `unit/room/room-self-state-repository.test.ts`
- [x] `unit/rpc/room-self-handlers.test.ts`
- [x] `unit/rpc/room-message-handlers.test.ts`
- [x] `unit/rpc/memory-handlers.test.ts`
- [x] `unit/rpc-handlers/recurring-job-handlers.test.ts`
- [x] `integration/room/room-self-worker-lifecycle.integration.test.ts`
- [x] `e2e/tests/smoke/room.e2e.ts`
- [x] `e2e/tests/helpers/room-helpers.ts`
- [x] `integration/neo-in-process.test.ts` — imports `@neokai/neo` (deleted in Step 5)

### Step 8: Update wiring — rpc-handlers/index.ts
- [x] Remove `WorkerManager` creation
- [x] Remove `RecurringJobScheduler` creation + `.start()`
- [x] Remove `PromptTemplateManager` creation (line 109) — only consumer was `RoomSelfManager`
- [x] Remove `RoomSelfManager` creation
- [x] Remove `setupMemoryHandlers()` call
- [x] Remove `setupRoomMessageHandlers()` call
- [x] Remove `setupRecurringJobHandlers()` call
- [x] Remove `setupRoomSelfHandlers()` call
- [x] Remove `roomSelfManager.startAgentsWithRunIntent()` call
- [x] Update cleanup: remove `recurringJobScheduler.stop()`, `roomSelfManager.stopAll()`
- [x] Update `setupRoomHandlers()` params: remove `workerManager`, `roomSelfManager`
- [x] Relocate `TaskManagerFactory` type import (currently from deleted `room-self-handlers.ts`). Note: `task-handlers.ts` already has its own `TaskManagerFactory` with a different signature — `(db: Database, roomId: string) => TaskManagerLike` vs the deleted `(roomId: string) => TaskManager`. Use the surviving `task-handlers.ts` definition; do NOT create a third definition. Same applies to `GoalManagerFactory`.
- [x] Remove imports for all deleted modules

### Step 9: Update wiring — room/index.ts
- [x] Remove exports for deleted managers and types
- [x] Remove imports for deleted modules

### Step 10: Update wiring — storage/index.ts (Database facade)
- [x] Remove memory operation methods
- [x] Remove context operation methods
- [x] Remove recurring job operation methods
- [x] Remove room agent state operation methods
- [x] Remove worker session operation methods
- [x] Remove repository imports for deleted repos

### Step 11: Update shared types — neo.ts
- [x] Delete ~25 old type definitions (see Part 3 list)
- [x] Update `GoalStatus` enum values
- [x] Update `TaskStatus` enum values
- [ ] Add new fields to `NeoTask`, `Room`, `RoomGoal` _(deferred to Phase 0 — new columns added in runtime migration)_

### Step 12: Update shared types — types.ts
- [x] Change `SessionType`: remove `room_self`, add `craft` | `lead`
- [x] Clean up `SessionContext`: remove `selfSessionId`, `chatSessionId`
- [x] Remove `DEFAULT_ROOM_SELF_FEATURES`
- [x] KEEP `DEFAULT_ROOM_CHAT_FEATURES` (room_chat sessions still exist in new spec)
- [x] Relocate `TaskManagerFactory` type — currently exported from `room-self-handlers.ts` (being deleted), imported by `rpc-handlers/index.ts`. `task-handlers.ts` already exports its own `TaskManagerFactory` with signature `(db: Database, roomId: string) => TaskManagerLike` — switch `index.ts` import to use that one. Do NOT create a third definition

### Step 13: Update shared prompts
- [x] Remove `ROOM_AGENT_SYSTEM_TEMPLATE` import (line 10) and room_agent template entry from `BUILTIN_TEMPLATES` in `templates.ts`
- [x] Remove `MANAGER_AGENT_*` templates from `BUILTIN_TEMPLATES` in `templates.ts`
- [x] Remove `'manager_agent'` and `'room_agent'` from `PromptTemplateCategory` in `types.ts`
- [x] Remove `MANAGER_AGENT_*` and `ROOM_AGENT_*` from `BUILTIN_TEMPLATE_IDS` in `types.ts`
- [x] Update `prompts/index.ts` to remove `room-agent.ts` re-export
- [x] Update `tests/unit/prompts/prompt-template-manager.test.ts` — remove/update assertions on `manager_agent` category (line 39), `MANAGER_AGENT_SYSTEM` ID (lines 157, 878), and manager agent template retrieval test (lines 794-799)

### Step 14: Update room-handlers.ts
- [x] Remove `workerManager` and `roomSelfManager` from function params
- [x] Remove `createRoomAgentMcpServer` import (line 30) — from deleted `room-agent-tools.ts`
- [x] Remove `roomMcpServerRegistry` Map + all exports: `getOrCreateRoomMcpServer()`, `getRoomMcpServer()`, `setRoomMcpServer()`, `deleteRoomMcpServer()`
- [x] Remove 4 context versioning handlers (lines 711-816): `room.updateContext`, `room.getContextVersions`, `room.getContextVersion`, `room.rollbackContext`
- [x] Update `neo.status` handler (line 852): rewrite `roomManager.getGlobalStatus()` to not use memory/context
- [x] Remove handler registrations that depend on deleted code
- [x] Keep `room.create`, `room.list`, `room.get`, `room.update`, `room.archive`, `room.overview`

### Step 14a: Update query-options-builder.ts
- [x] Remove dynamic `getRoomMcpServer` import block (lines 25-34)
- [x] Remove `room_self` session type check (line 210)
- [x] Remove `__IN_PROCESS_ROOM_AGENT_TOOLS__` marker handling (lines 546-568)

### Step 14b: Update agent-session.ts
- [x] Update session title formatting (line 451): replace `room_self` → `craft`/`lead` types

### Step 14c: Update session-lifecycle.ts
- [x] Update comments and type union: replace `room_self` with `craft`/`lead` (lines 45-48, 159)

### Step 14d: Update room-manager.ts
- [x] Strip `MemoryRepository`/`ContextRepository` imports, fields, constructor init
- [x] Rewrite `getRoomStatus()` and `getRoomOverview()` to not use context/memory
- [x] Remove `getContextVersions()`/`getContextVersion()`/`rollbackContext()` methods
- [x] Update `createRoom()` (lines 55-70): remove context creation (`contextRepo.createContext()` line 61) and linking (`roomRepo.setRoomContextId()` line 64)

### Step 14e: Update room-repository.ts
- [x] Strip `getContextVersions()`/`getContextVersion()`/`rollbackContext()` methods (delegate to dropped `room_context_versions` table)
- [x] Remove `context_id` from `createRoom()` INSERT statement (line 45) and null value (line 59) — column being dropped
- [x] Remove `setRoomContextId()` helper (lines 309-312) — no longer needed

### Step 14f: Update frontend — ChatContainer.tsx
- [x] Remove `DEFAULT_ROOM_SELF_FEATURES` import (line 23)
- [x] Remove `room:self:` session ID branch (lines 291-292)
- [x] Keep `DEFAULT_ROOM_CHAT_FEATURES` import and `room:chat:` branch

### Step 15: Update frontend — Room.tsx
- [x] Remove "context" and "jobs" tabs
- [x] Remove "self" chat tab
- [x] Remove imports: `ContextEditor`, `RecurringJobsConfig`, `CreateJobParams`

### Step 16: Update frontend — RoomDashboard.tsx
- [x] Remove imports: `RoomSelfStatus`, `RoomEscalations`
- [x] Remove agent status section
- [x] Remove escalation section

### Step 17: Update frontend — RoomTasks.tsx
- [x] Remove `TaskSessionView` import/usage
- [x] Update task status display for new states

### Step 18: Update frontend — room/index.ts
- [x] Remove exports for all deleted components

### Step 19: Update frontend — RoomContextPanel.tsx
- [x] Remove agent status display
- [x] Remove worker sessions list
- [x] Remove `roomStore.agentState` / `roomStore.waitingContext` references

### Step 20: Update frontend — room-store.ts
- [x] Remove signals: `recurringJobs`, `jobsLoading`, `agentState`, `waitingContext`
- [x] Remove computed: `enabledRecurringJobs`
- [x] Remove subscriptions: `recurringJob.*`, `roomAgent.*`
- [x] Remove methods: recurring jobs (5), context versioning (3), room agent (8)

### Step 21: Add database migration + update schema baseline
- [x] Drop 7 old tables (migration 32: room_agent_states, worker_sessions, recurring_jobs, room_context_versions, context_messages, contexts, memories)
- [x] Migrate task statuses: `blocked`→`escalated`, `cancelled`→`failed`
- [x] Migrate goal statuses: `pending`/`in_progress`→`active`, `blocked`→`needs_human`
- [x] Migrate session types: `room_self`→`craft`, `manager`→`lead`
- [x] Update `sessions` CHECK constraint in schema baseline
- [x] Update `schema/index.ts`: removed `memories`/`contexts`/`context_messages` table defs + 3 stale indexes
- [ ] Alter `rooms` (add `config` column), `goals` (add `planning_attempts`/`goal_review_attempts`), `tasks` (add `task_type`/`version`/`created_by_task_id`, change `priority` to INTEGER) _(deferred to Phase 0 — needed for Runtime, not cleanup)_
- [ ] Create `task_pairs`, `task_messages`, `room_audit_log` _(deferred to Phase 0 — Runtime tables)_

### Step 22: Update daemon-hub.ts event types (~22 events across 5 groups)
- [x] Remove `ManagerHookEvent`/`ManagerHookPayload` references
- [x] Remove 9 `roomAgent.*` events: `stateChanged`, `hook`, `error`, `idle`, `reviewRequested`, `reviewReceived`, `escalated`, `escalationResolved`, `questionAnswered`
- [x] Remove 2 `room.context*` events: `room.contextUpdated`, `room.contextRolledBack`
- [x] Remove 7 `recurringJob.*` events: `created`, `updated`, `triggered`, `completed`, `enabled`, `disabled`, `deleted`
- [x] Remove 3 dead `task.session*` events: `sessionStarted`, `sessionCompleted`, `allSessionsCompleted`

### Step 22a: Clean up feature-flags.ts
- [x] Remove stale flag registrations `WORKER_ONLY_ORCHESTRATION` and `ROOM_CHAT_WORKER_SPAWNING` from `initializeFlags()`

### Step 22b: Resolve telemetry subsystem (hard decision — pick A or B)
- `WorkerTelemetry` in `rpc-handlers/index.ts` (lines 231-240) tracks `worker-only` vs `manager-worker` modes
- `telemetry/worker-telemetry.ts` and `rpc-handlers/telemetry-handlers.ts` have worker/manager-specific semantics
- These are wired to worker session events being removed in Step 22
- **Option A**: Remove telemetry together with events (clean cut, rebuild in Phase 1 with runtime metrics)
- **Option B**: Keep telemetry, migrate to runtime event model (more work now, continuity of metrics)
- [ ] Pick option and execute accordingly _(deferred — telemetry still compiles; resolve in Phase 0)_

### Step 23: Verify ✅ COMPLETE
```bash
bun run check          # lint + typecheck + knip  ✓ PASSES
make test-daemon       # 3012 pass, 0 fail  ✓
make test-web          # non-room tests pass
```

Fixed during verify:
- `migrations.ts:runMigration32`: Added `PRAGMA foreign_keys = OFF/ON` around table rebuilds to fix "no such table: main.rooms" on fresh databases (rooms only created by `createTables()` which runs after migrations)
- `migrations.ts:runMigration14`: Added `tableHasColumn(db, 'tasks', 'session_id')` guard to skip tasks rebuild when column doesn't exist (already rebuilt to new schema by migration 32)
- `tests/unit/rpc/room-handlers.test.ts`: Removed stale `WorkerManager` references (module deleted); fixed `RoomOverview` mock (removed `status`/`recentActivity`, added `activeTasks`); replaced `NeoStatus` return type for `room.status`
- `tests/unit/agent/query-options-builder.test.ts`: Changed `'room_self'` → `'room_chat'` in room session restriction tests (type was renamed in migration 32)
- `tests/unit/room/task-manager.test.ts`: Removed `sessionId` from `startTask` calls; replaced `blockTask`/`unblockTask` with `escalateTask`/`deescalateTask`; updated `'blocked'` → `'escalated'` status
- `tests/unit/room/room-manager.test.ts`: Removed `contextId`, `contextStatus`, `memoryCount`, `totalMemories` assertions (fields removed from types)
- `tests/unit/rpc/task-handlers.test.ts`: Removed `sessionId` from `startTask` mock; updated call expectations
- `shared/types/neo.ts`: Added `| null` to clearable `UpdateRoomParams` fields

### Step 24: Commit
```
refactor: remove old room orchestration, prepare for Room Runtime v0.19
```

---

## After Cleanup: Build Phase 0

With old orchestration removed and CRUD foundation intact:
- `RoomManager`, `GoalManager`, `TaskManager` ready with updated states
- New `task_pairs`, `task_messages`, `room_audit_log` tables created
- Ready to build `RoomRuntime` scheduler as new file at `daemon/src/lib/room/runtime/`

Follow spec's 7-phase implementation plan:
- **Phase 0**: Message queue helpers, session type registration
- **Phase 1**: Runtime Core (tick loop, mutex, pair state machine)
- **Phase 2**: Craft Agent integration
- **Phase 3**: Lead Agent integration
- **Phase 4**: Human Intervention (interrupts, escalation SLA)
- **Phase 5**: Recovery & Robustness
- **Phase 6**: Task Chat View UI
