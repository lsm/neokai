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

// Line ~109: PromptTemplateManager — EVALUATE (may reuse for Craft/Lead prompts)
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
| `room-self-lifecycle-manager.ts` | ~512 | 7-state lifecycle → spec has 5-state pair machine |
| `worker-manager.ts` | ~460 | Worker sessions → replaced by TaskPairManager |
| `recurring-job-scheduler.ts` | ~444 | Not in v0.19 spec |
| `context-manager.ts` | ~193 | Context versioning not in spec |
| `memory-manager.ts` | ~184 | Memory system not in spec |
| `archive/` | entire dir | Already archived old versions |

**KEEP in this directory:**
- `room-manager.ts` (293 lines) — room CRUD, add `config` column
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
| `archive-room-self-handlers.ts.bak` | Already archived |

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
| `archive-room-self-state-repository.ts.bak` | Already archived |

**KEEP in this directory:**
- `room-repository.ts` — room CRUD (add `config` column)
- `goal-repository.ts` — goal CRUD (update states + counters)
- `task-repository.ts` — task CRUD (update states + columns)
- `session-repository.ts`, `sdk-message-repository.ts`, `settings-repository.ts`, etc.

### shared/src/prompts/ — Old Prompts

| File | Why delete |
|---|---|
| `room-agent.ts` (~211 lines) | `buildRoomAgentSystemPrompt()`, `ROOM_AGENT_SYSTEM_TEMPLATE` → replaced by Craft/Lead/Room Agent prompts |

**Also clean up:**
- `templates.ts` — remove `MANAGER_AGENT_*` templates from `BUILTIN_TEMPLATES` array
- `types.ts` — remove `'manager_agent'` from `PromptTemplateCategory`, remove `MANAGER_AGENT_*` from `BUILTIN_TEMPLATE_IDS`

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
| `tests/room-neo-pair.test.ts` | Tests for deleted code |

**Delete entire package** if it only contains room orchestration.

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

### daemon/src/lib/rpc-handlers/room-handlers.ts — Remove agent params

**Current signature** (passes `workerManager`, `roomSelfManager`, `roomMcpServerRegistry`):
- Remove `workerManager` param
- Remove `roomSelfManager` param
- Remove `getOrCreateRoomMcpServer()` export (old MCP registry)
- Remove any `roomAgent.*` or `neo.*` handler registrations that depend on deleted code
- Keep `room.create`, `room.list`, `room.get`, `room.update`, `room.archive`, `room.overview`

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

### daemon/src/lib/daemon-hub.ts — Remove old event types

**Remove event types referencing:**
- `ManagerHookEvent`, `ManagerHookPayload`
- `roomAgent.stateChanged`, `roomAgent.escalated`, `roomAgent.reviewRequested`
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
- DROP `context_id`, `context_version`, `instructions` (context system removed)

**`goals`:**
- ADD `planning_attempts INTEGER NOT NULL DEFAULT 0`
- ADD `goal_review_attempts INTEGER NOT NULL DEFAULT 0`
- UPDATE status CHECK: `'active' | 'needs_human' | 'completed' | 'archived'`

**`tasks`:**
- ADD `task_type TEXT NOT NULL DEFAULT 'coding'`
- ADD `priority INTEGER NOT NULL DEFAULT 0`
- ADD `version INTEGER NOT NULL DEFAULT 0`
- ADD `created_by_task_id TEXT`
- ADD `depends_on TEXT` (JSON array)
- UPDATE status CHECK: `'draft' | 'pending' | 'in_progress' | 'escalated' | 'completed' | 'failed'`
- DROP `session_id`, `session_ids`, `execution_mode`, `sessions`, `recurring_job_id` (old multi-session columns)

### Tables to CREATE

**`task_pairs`:**
```sql
CREATE TABLE task_pairs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    craft_session_id TEXT,
    lead_session_id TEXT,
    pair_state TEXT NOT NULL DEFAULT 'awaiting_craft',
    pair_type TEXT NOT NULL DEFAULT 'coding',
    iteration INTEGER NOT NULL DEFAULT 0,
    lead_failures INTEGER NOT NULL DEFAULT 0,
    active_work_started_at INTEGER,
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

**`room_audit_log`:**
```sql
CREATE TABLE room_audit_log (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details TEXT,
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
- [ ] `room-self-service.ts`
- [ ] `room-self-lifecycle-manager.ts`
- [ ] `worker-manager.ts`
- [ ] `recurring-job-scheduler.ts`
- [ ] `context-manager.ts`
- [ ] `memory-manager.ts`
- [ ] `archive/` (entire directory)

### Step 2: Delete old agent tools (daemon/src/lib/agent/)
- [ ] `room-agent-tools.ts`
- [ ] `worker-tools.ts` (if exists)

### Step 3: Delete old RPC handlers (daemon/src/lib/rpc-handlers/)
- [ ] `room-self-handlers.ts`
- [ ] `room-message-handlers.ts`
- [ ] `recurring-job-handlers.ts`
- [ ] `memory-handlers.ts`
- [ ] `archive-room-self-handlers.ts.bak`

### Step 4: Delete old repositories (daemon/src/storage/repositories/)
- [ ] `room-self-state-repository.ts`
- [ ] `worker-session-repository.ts`
- [ ] `room-context-version-repository.ts`
- [ ] `recurring-job-repository.ts`
- [ ] `context-repository.ts`
- [ ] `memory-repository.ts`
- [ ] `archive-room-self-state-repository.ts.bak`

### Step 5: Delete old prompts (shared/src/)
- [ ] `prompts/room-agent.ts`
- [ ] `neo-prompt/` (entire directory, if only room orchestration)

### Step 6: Delete old UI components (web/src/components/room/)
- [ ] `RoomSelfStatus.tsx` + `RoomSelfStatus.test.tsx`
- [ ] `RoomEscalations.tsx`
- [ ] `TaskSessionView.tsx` + `TaskSessionView.test.tsx`
- [ ] `ContextEditor.tsx`
- [ ] `ContextVersionHistory.tsx`
- [ ] `ContextVersionViewer.tsx`
- [ ] `RecurringJobsConfig.tsx` + `RecurringJobsConfig.test.tsx`

### Step 7: Delete old tests (daemon/tests/)
- [ ] `unit/room/worker-manager.test.ts`
- [ ] `unit/room/memory-manager.test.ts`
- [ ] `unit/room/context-manager.test.ts`
- [ ] `unit/room/recurring-job-scheduler.test.ts`
- [ ] `unit/room/recurring-job-scheduler.guards.test.ts`
- [ ] `unit/room/room-self-state-repository.test.ts`
- [ ] `unit/rpc/room-self-handlers.test.ts`
- [ ] `unit/rpc/room-message-handlers.test.ts`
- [ ] `integration/room/room-self-worker-lifecycle.integration.test.ts`
- [ ] `e2e/tests/smoke/room.e2e.ts`
- [ ] `e2e/tests/helpers/room-helpers.ts`

### Step 8: Update wiring — rpc-handlers/index.ts
- [ ] Remove `WorkerManager` creation
- [ ] Remove `RecurringJobScheduler` creation + `.start()`
- [ ] Remove `RoomSelfManager` creation
- [ ] Remove `setupMemoryHandlers()` call
- [ ] Remove `setupRoomMessageHandlers()` call
- [ ] Remove `setupRecurringJobHandlers()` call
- [ ] Remove `setupRoomSelfHandlers()` call
- [ ] Remove `roomSelfManager.startAgentsWithRunIntent()` call
- [ ] Update cleanup: remove `recurringJobScheduler.stop()`, `roomSelfManager.stopAll()`
- [ ] Update `setupRoomHandlers()` params: remove `workerManager`, `roomSelfManager`
- [ ] Remove imports for all deleted modules

### Step 9: Update wiring — room/index.ts
- [ ] Remove exports for deleted managers and types
- [ ] Remove imports for deleted modules

### Step 10: Update wiring — storage/index.ts (Database facade)
- [ ] Remove memory operation methods
- [ ] Remove context operation methods
- [ ] Remove recurring job operation methods
- [ ] Remove room agent state operation methods
- [ ] Remove worker session operation methods
- [ ] Remove repository imports for deleted repos

### Step 11: Update shared types — neo.ts
- [ ] Delete ~25 old type definitions (see Part 3 list)
- [ ] Update `GoalStatus` enum values
- [ ] Update `TaskStatus` enum values
- [ ] Add new fields to `NeoTask`, `Room`, `RoomGoal`

### Step 12: Update shared types — types.ts
- [ ] Change `SessionType`: remove `room_self`, add `craft` | `lead`
- [ ] Clean up `SessionContext`: remove `selfSessionId`, `chatSessionId`
- [ ] Remove `DEFAULT_ROOM_SELF_FEATURES`

### Step 13: Update shared prompts
- [ ] Remove `MANAGER_AGENT_*` templates from `BUILTIN_TEMPLATES` in `templates.ts`
- [ ] Remove `'manager_agent'` from `PromptTemplateCategory` in `types.ts`
- [ ] Update `prompts/index.ts` to remove `room-agent.ts` re-export

### Step 14: Update room-handlers.ts
- [ ] Remove `workerManager` and `roomSelfManager` from function params
- [ ] Remove `roomMcpServerRegistry` (old MCP server map)
- [ ] Remove `getOrCreateRoomMcpServer()` export
- [ ] Remove handler registrations that depend on deleted code
- [ ] Keep `room.create`, `room.list`, `room.get`, `room.update`, `room.archive`, `room.overview`

### Step 15: Update frontend — Room.tsx
- [ ] Remove "context" and "jobs" tabs
- [ ] Remove "self" chat tab
- [ ] Remove imports: `ContextEditor`, `RecurringJobsConfig`, `CreateJobParams`

### Step 16: Update frontend — RoomDashboard.tsx
- [ ] Remove imports: `RoomSelfStatus`, `RoomEscalations`
- [ ] Remove agent status section
- [ ] Remove escalation section

### Step 17: Update frontend — RoomTasks.tsx
- [ ] Remove `TaskSessionView` import/usage
- [ ] Update task status display for new states

### Step 18: Update frontend — room/index.ts
- [ ] Remove exports for all deleted components

### Step 19: Update frontend — RoomContextPanel.tsx
- [ ] Remove agent status display
- [ ] Remove worker sessions list
- [ ] Remove `roomStore.agentState` / `roomStore.waitingContext` references

### Step 20: Update frontend — room-store.ts
- [ ] Remove signals: `recurringJobs`, `jobsLoading`, `agentState`, `waitingContext`
- [ ] Remove computed: `enabledRecurringJobs`
- [ ] Remove subscriptions: `recurringJob.*`, `roomAgent.*`
- [ ] Remove methods: recurring jobs (5), context versioning (3), room agent (8)

### Step 21: Add database migration
- [ ] Drop 7 old tables
- [ ] Alter `rooms`, `goals`, `tasks`
- [ ] Create `task_pairs`, `task_messages`, `room_audit_log`

### Step 22: Update daemon-hub.ts event types
- [ ] Remove `ManagerHookEvent`/`ManagerHookPayload` references
- [ ] Remove `roomAgent.*` event types
- [ ] Remove worker session event types

### Step 23: Verify
```bash
bun run check          # lint + typecheck + knip
make test:daemon       # non-room tests pass
make test:web          # non-room tests pass
```

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
