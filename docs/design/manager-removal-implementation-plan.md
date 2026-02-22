# Manager Agent Removal - Implementation Plan

**Version**: 2.0 (Critical Fixes Applied)
**Date**: 2025-02-22
**Status**: Ready for Implementation
**Related Documents**:
- [Manager-less Architecture Design](./manager-less-architecture.md) (v1.1)
- [Room Autonomy Manager Removal Plan](./room-autonomy-manager-removal-plan.md)
- [Critical Fixes Applied](./manager-removal-critical-fixes.md) (THIS DOCUMENT)

**Changes in v2.0**:
- Fixed schema contradictions (task_id FK, room_session_id naming)
- Added session_id column for direct lookup
- Complete migration strategy (orphaned pairs preserved)
- API compatibility/deprecation plan
- Harmonized phase sequence (6 phases, clear dependencies)
- Shared WorkerEventHandler architecture

---

## Executive Summary

This document provides the complete implementation plan for removing the Manager agent layer from NeoKai's room architecture. The removal will:

1. **Simplify architecture**: 3-tier (Room Self → Manager → Worker) → 2-tier (Room Agent → Worker)
2. **Reduce costs**: ~50% reduction in LLM calls per task
3. **Unify room agents**: `room:chat` and `room:self` share orchestration capabilities
4. **Remove complexity**: ~1,060 lines of code eliminated

**Estimated Effort**: 2-3 weeks across 6 phases
**Risk Level**: Medium (mitigated by phased approach with feature flags)

---

## Scope

### In Scope

- Complete removal of Manager agent/session type
- Removal of `session_pairs` database table
- Removal of SessionPairManager and SessionBridge
- Unification of `room:chat` and `room:self` orchestration
- Worker-only execution model with direct completion signaling

### Out of Scope

- Multi-worker coordination (can be added later if needed)
- UI redesign beyond necessary data model changes
- Breaking changes to external APIs (will maintain backward compatibility during transition)

---

## Current State Analysis

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Room Self Agent                           │
│  - Subscribes to events (GitHub, user messages)            │
│  - Creates tasks from events                               │
│  - Spawns Manager-Worker pairs via SessionPairManager     │
│  - Monitors pair.task_completed events                     │
└─────────────────────────────────────────────────────────────┘
                              │
                    SessionPairManager.createPair()
                              │
         ┌────────────────────┴────────────────────┐
         ▼                                         ▼
┌──────────────────┐                     ┌──────────────────┐
│   Manager Agent  │                     │   Worker Agent   │
│  - Coordinates   │◄────────────────────►│ - Executes work  │
│  - Reviews       │    SessionBridge     │ - Has manager_   │
│  - Has manager_  │    (synthetic msg)   │   tools         │
│    tools MCP     │                     │                  │
└──────────────────┘                     └──────────────────┘
```

### room:chat vs room:self Current State

| Aspect | room:chat | room:self |
|--------|-----------|-----------|
| **Purpose** | User interface only | Autonomous orchestration |
| **Worker Mgmt** | None | Spawns Manager-Worker pairs |
| **System Prompt** | Claude Code default | Custom room_agent_system |
| **Triggers** | Manual user messages | Events, idle checks, jobs |
| **Tool Access** | room-agent-tools only | room-agent-tools only |
| **Auto-execution** | No | Yes |

**Key Finding**: Both agents already share the same MCP server (room-agent-tools) and have identical tool restrictions. The main difference is execution model, not capabilities.

### Critical Coupling Points

| Component | File | Lines | Coupling Type |
|-----------|------|-------|---------------|
| SessionType union | `types.ts:537` | - | Type system |
| SessionPair interface | `neo.ts:584-603` | - | Core data structure |
| RPC handlers | `room-handlers.ts:628-701` | ~74 | API interface |
| Database schema | `migrations.ts:886-903` | ~18 | Data persistence |
| SessionPairRepository | `session-pair-repository.ts` | ~153 | Data access |
| SessionPairManager | `session-pair-manager.ts` | ~258 | Business logic |
| SessionBridge | `session-bridge.ts` | ~518 | Communication |
| ManagerTools | `manager-tools.ts` | ~131 | Tooling |
| Manager prompt | `templates.ts:86-142` | ~57 | Behavior definition |

---

## Target Architecture

### Simplified Architecture

```
┌─────────────────────────────────────────────────────────────┐
│         Shared Orchestrator Capability Layer                 │
│  - Same tools: room-agent-tools.ts                         │
│  - Same prompt core: room-agent.ts                         │
│  - Same policy: orchestrate only, never execute directly   │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│   room:chat (Human-Driven)       │  │   room:self (Autonomous)         │
│  Triggers: Human messages        │  │  Triggers: Events, idle, jobs    │
│  Session: room:chat:{roomId}     │  │  Session: room:self:{roomId}     │
│  Response: Interactive           │  │  Response: Proactive             │
└──────────────────────────────────┘  └──────────────────────────────────┘
              │                                   │
              └───────────────┬───────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Worker Agent                              │
│  Session: ${generated}                                       │
│  Type: worker                                                │
│                                                              │
│  - Executes tasks                                            │
│  - Has worker-tools MCP (completion, review request)        │
│  - Signals completion via worker_complete_task()           │
└─────────────────────────────────────────────────────────────┘
```

### Unified Orchestration Model

**Key Principle**: `room:chat` and `room:self` have **identical orchestration capabilities**, differing only in trigger mode.

| Component | Shared By | Single Source |
|-----------|-----------|---------------|
| Room Agent Tools | Both modes | `agent/room-agent-tools.ts` |
| Room Agent Prompts | Both modes | `shared/prompts/room-agent.ts` |
| WorkerManager | Both modes | `room/worker-manager.ts` |
| Worker Tools | Workers only | `agent/worker-tools.ts` |

### Database Schema Changes

```sql
-- REMOVE: session_pairs table (Migration 16)
-- Will be deprecated after data migration (Migration 19)

-- ADD: worker_sessions table (Migration 18) - WITH CRITICAL FIXES APPLIED
CREATE TABLE worker_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,                    -- FIX 3: Added for direct session lookup
    room_id TEXT NOT NULL,
    room_session_id TEXT NOT NULL,                      -- FIX 2: Mode-agnostic (was room_self_session_id)
    room_session_type TEXT NOT NULL DEFAULT 'room_self' -- FIX 2: Discriminator for room mode
        CHECK(room_session_type IN ('room_chat', 'room_self')),
    task_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting'
        CHECK(status IN ('starting', 'running', 'waiting_for_review', 'completed', 'failed', 'cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (room_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT -- FIX 1: Changed from SET NULL
);

-- Indexes for all query patterns
CREATE INDEX idx_worker_sessions_room ON worker_sessions(room_id);
CREATE INDEX idx_worker_sessions_task ON worker_sessions(task_id);
CREATE INDEX idx_worker_sessions_status ON worker_sessions(status);
CREATE INDEX idx_worker_sessions_session ON worker_sessions(session_id);     -- FIX 3
CREATE INDEX idx_worker_sessions_room_session ON worker_sessions(room_session_id); -- FIX 2

-- FIX 4: Orphaned pairs preservation table
CREATE TABLE worker_sessions_orphaned (
    id TEXT PRIMARY KEY,
    original_pair_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    room_session_id TEXT NOT NULL,
    manager_session_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    original_status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    migrated_at INTEGER NOT NULL,
    notes TEXT
);
```

**Schema Fixes Applied**:
1. **task_id**: `NOT NULL` with `ON DELETE RESTRICT` (was contradictory SET NULL)
2. **room_session_id**: Mode-agnostic column name (was hardcoded room_self_session_id)
3. **session_id**: Added for direct agent session lookup
4. **room_session_type**: Discriminator to track which room mode created the worker
5. **worker_sessions_orphaned**: Preserves session_pairs without tasks (prevents data loss)

---

## Implementation Phases

### Phase 1: Add New Components (Non-Breaking)

**Goal**: Add new functionality without affecting existing code.

**Duration**: 3-4 days

#### Tasks

##### 1.1 Create Worker Tools

**File**: `packages/daemon/src/lib/agent/worker-tools.ts` (NEW)

```typescript
// MCP tools for Worker agents:
// - worker_complete_task(taskId, summary, filesChanged, nextSteps)
// - worker_request_review(reason)
```

**Validation**:
- [ ] File compiles
- [ ] MCP server creates successfully
- [ ] Tool contracts match specification

##### 1.2 Create Worker Session Repository

**File**: `packages/daemon/src/storage/repositories/worker-session-repository.ts` (NEW)

```typescript
class WorkerSessionRepository {
    createWorkerSession(data: CreateWorkerSessionData): WorkerSession
    getWorkerSession(id: string): WorkerSession | null           // By tracking ID
    getWorkerBySessionId(sessionId: string): WorkerSession | null  // FIX 3: By agent session ID
    getWorkerByTask(taskId: string): WorkerSession | null
    getWorkersByRoom(roomId: string): WorkerSession[]
    getWorkersByRoomSession(roomSessionId: string): WorkerSession[]  // FIX 2: By room agent
    updateWorkerStatus(id: string, status: WorkerStatus): WorkerSession | null
    updateWorkerStatusBySessionId(sessionId: string, status: WorkerStatus): WorkerSession | null  // FIX 3
    completeWorkerSession(id: string): WorkerSession | null
    completeWorkerSessionBySessionId(sessionId: string): WorkerSession | null  // FIX 3
    deleteWorkerSession(id: string): boolean
}
```

**Validation**:
- [ ] All methods implemented including FIX 3 methods
- [ ] Repository compiles
- [ ] SQLite queries are valid
- [ ] getWorkerBySessionId() works correctly (not null placeholder)

##### 1.3 Create WorkerManager

**File**: `packages/daemon/src/lib/room/worker-manager.ts` (NEW)

```typescript
class WorkerManager {
    spawnWorker(params: CreateWorkerParams): Promise<string>
    getWorkerByTask(taskId: string): WorkerSession | null
    getWorkersByRoom(roomId: string): WorkerSession[]
    updateWorkerStatus(workerSessionId: string, status: WorkerStatus): void
    completeWorker(workerSessionId: string): void
}
```

**Validation**:
- [ ] Compiles without errors
- [ ] Can spawn worker session
- [ ] Worker receives initial prompt
- [ ] Worker tools MCP server is injected

##### 1.4 Add Shared Types

**File**: `packages/shared/src/types/neo.ts` (MODIFY)

**Add** (WITH FIXES 2 & 3 APPLIED):
```typescript
export type WorkerStatus = 'starting' | 'running' | 'waiting_for_review' | 'completed' | 'failed' | 'cancelled';

export interface WorkerSession {
    id: string;                                          // Tracking record ID
    sessionId: string;                                   // FIX 3: Actual agent session ID
    roomId: string;
    roomSessionId: string;                               // FIX 2: Mode-agnostic (was roomSelfSessionId)
    roomSessionType: 'room_chat' | 'room_self';         // FIX 2: Discriminator
    taskId: string;
    status: WorkerStatus;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface CreateWorkerParams {
    roomId: string;
    roomSessionId: string;                               // FIX 2: Mode-agnostic (was roomSelfSessionId)
    roomSessionType?: 'room_chat' | 'room_self';         // FIX 2: Optional, defaults to room_self
    taskId: string;
    taskTitle: string;
    taskDescription?: string;
    workspacePath?: string;
    model?: string;
}
```

**Validation**:
- [ ] Types compile
- [ ] No duplicate definitions
- [ ] Export statements correct

##### 1.5 Database Migration (WITH FIX 4: Complete Data Migration)

**File**: `packages/daemon/src/storage/schema/migrations.ts` (MODIFY)

**Add Migration 18** (Complete implementation with all fixes):
```typescript
function runMigration18(db: BunDatabase): void {
    // Skip if worker_sessions table already exists
    if (tableExists(db, 'worker_sessions')) {
        return;
    }

    // Step 1: Create worker_sessions table with CORRECTED schema
    db.exec(`
        CREATE TABLE worker_sessions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL UNIQUE,
            room_id TEXT NOT NULL,
            room_session_id TEXT NOT NULL,
            room_session_type TEXT NOT NULL DEFAULT 'room_self'
                CHECK(room_session_type IN ('room_chat', 'room_self')),
            task_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'starting'
                CHECK(status IN ('starting', 'running', 'waiting_for_review', 'completed', 'failed', 'cancelled')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (room_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
        );

        CREATE INDEX idx_worker_sessions_room ON worker_sessions(room_id);
        CREATE INDEX idx_worker_sessions_task ON worker_sessions(task_id);
        CREATE INDEX idx_worker_sessions_status ON worker_sessions(status);
        CREATE INDEX idx_worker_sessions_session ON worker_sessions(session_id);
        CREATE INDEX idx_worker_sessions_room_session ON worker_sessions(room_session_id);
    `);

    // Step 2: Migrate pairs WITH tasks
    db.exec(`
        INSERT INTO worker_sessions (
            id, session_id, room_id, room_session_id, room_session_type,
            task_id, status, created_at, updated_at, completed_at
        )
        SELECT
            lower(hex(randomblob(16))),
            spp.worker_session_id,
            spp.room_id,
            spp.room_session_id,
            'room_self',
            spp.current_task_id,
            CASE spp.status
                WHEN 'completed' THEN 'completed'
                WHEN 'crashed' THEN 'failed'
                WHEN 'idle' THEN 'starting'
                ELSE 'running'
            END,
            spp.created_at,
            spp.updated_at,
            CASE WHEN spp.status = 'completed' THEN spp.updated_at ELSE NULL END
        FROM session_pairs spp
        WHERE spp.current_task_id IS NOT NULL
    `);

    // Step 3: Preserve orphaned pairs (FIX 4: No data loss)
    db.exec(`
        CREATE TABLE IF NOT EXISTS worker_sessions_orphaned (
            id TEXT PRIMARY KEY,
            original_pair_id TEXT NOT NULL,
            room_id TEXT NOT NULL,
            room_session_id TEXT NOT NULL,
            manager_session_id TEXT NOT NULL,
            worker_session_id TEXT NOT NULL,
            original_status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            migrated_at INTEGER NOT NULL,
            notes TEXT
        );

        INSERT INTO worker_sessions_orphaned (
            id, original_pair_id, room_id, room_session_id,
            manager_session_id, worker_session_id, original_status,
            created_at, updated_at, migrated_at, notes
        )
        SELECT
            lower(hex(randomblob(16))),
            spp.id,
            spp.room_id,
            spp.room_session_id,
            spp.manager_session_id,
            spp.worker_session_id,
            spp.status,
            spp.created_at,
            spp.updated_at,
            strftime('%s', 'now') * 1000,
            'Migrated during Migration 18: original pair had no task_id'
        FROM session_pairs spp
        WHERE spp.current_task_id IS NULL
    `);

    // Step 4: Validation queries (run manually to verify)
    // See: manager-removal-critical-fixes.md for complete validation SQL
}
```

**Rollback Script** (included in migration):
```typescript
// To rollback Migration 18:
function rollbackMigration18(db: BunDatabase): void {
    db.exec(`
        DROP INDEX IF EXISTS idx_worker_sessions_room_session;
        DROP INDEX IF EXISTS idx_worker_sessions_session;
        DROP INDEX IF EXISTS idx_worker_sessions_status;
        DROP INDEX IF EXISTS idx_worker_sessions_task;
        DROP INDEX IF EXISTS idx_worker_sessions_room;
        DROP TABLE IF EXISTS worker_sessions;
        DROP TABLE IF EXISTS worker_sessions_orphaned;
    `);
}
```

**Validation**:
- [ ] Migration runs successfully
- [ ] All pairs with tasks migrated
- [ ] Orphaned pairs preserved in separate table
- [ ] Validation queries pass (see critical-fixes.md)
- [ ] Rollback script works
- [ ] No data loss

##### 1.6 Event Definitions

**File**: `packages/daemon/src/lib/daemon-hub.ts` (MODIFY)

**Add events**:
```typescript
'worker.started' -> { sessionId: string, roomId: string, taskId: string }
'worker.task_completed' -> { sessionId: string, taskId: string, summary: string, filesChanged?: string[], nextSteps?: string[] }
'worker.review_requested' -> { sessionId: string, taskId: string, reason: string }
'worker.failed' -> { sessionId: string, taskId: string, error: string }
```

**Validation**:
- [ ] Event types are defined
- [ ] No conflicts with existing events

##### 1.7 Create Shared WorkerEventHandler (FIX 7: Architecture)

**File**: `packages/daemon/src/lib/room/worker-event-handler.ts` (NEW)

```typescript
/**
 * Shared worker event handling for both room:chat and room:self
 *
 * Handles all worker-related events and delegates to appropriate services.
 * Both room modes use this shared handler to ensure consistent worker lifecycle management.
 */
class WorkerEventHandler {
    handleTaskCompleted(event: WorkerTaskCompletedEvent): Promise<void>
    handleReviewRequested(event: WorkerReviewRequestedEvent): Promise<void>
    handleWorkerFailed(event: WorkerFailedEvent): Promise<void>
}
```

**Purpose**:
- Prevents duplication of event handling logic
- Ensures consistent worker lifecycle management across both room modes
- Separates concerns: room-manager.ts handles room lifecycle only

**Validation**:
- [ ] WorkerEventHandler compiles
- [ ] All worker events handled
- [ ] Delegates to TaskManager, GoalManager correctly
- [ ] RoomManager NOT modified (keeps room lifecycle responsibility only)

#### Phase 1 Exit Criteria

- [ ] All new files compile
- [ ] All new tests pass
- [ ] Migration runs forward and backward
- [ ] No existing functionality broken
- [ ] Feature flag ready for Phase 2

---

### Phase 2: Update Room Self (Non-Breaking)

**Goal**: Prepare RoomSelfService to use new components alongside existing code.

**Duration**: 4-5 days

#### Tasks

##### 2.1 Add WorkerManager to Context

**File**: `packages/daemon/src/lib/room/room-self-service.ts` (MODIFY)

**Changes**:
```typescript
// Add to RoomSelfContext
workerManager: WorkerManager;
workerEventHandler: WorkerEventHandler;  // FIX 7: Shared event handling

// Update constructor to accept both
// Initialize WorkerEventHandler with dependencies
```

**Validation**:
- [ ] RoomSelfService compiles
- [ ] WorkerManager is accessible
- [ ] WorkerEventHandler initialized correctly
- [ ] No runtime errors

##### 2.2 Add New Event Handlers (Using WorkerEventHandler)

**File**: `packages/daemon/src/lib/room/room-self-service.ts` (MODIFY)

**Add handlers** (FIX 7: Using shared WorkerEventHandler):
```typescript
// In subscribeToEvents()
// Worker events - delegated to shared event handler
const unsubWorkerComplete = this.ctx.daemonHub.on(
    'worker.task_completed',
    async (event) => await this.workerEventHandler.handleTaskCompleted(event)
);

const unsubWorkerReview = this.ctx.daemonHub.on(
    'worker.review_requested',
    async (event) => await this.workerEventHandler.handleReviewRequested(event)
);

const unsubWorkerFailed = this.ctx.daemonHub.on(
    'worker.failed',
    async (event) => await this.workerEventHandler.handleWorkerFailed(event)
);

const unsubWorkerReview = this.ctx.daemonHub.on(
    'worker.review_requested',
    async (event) => { /* handle review */ }
);
```

**Validation**:
- [ ] Events are received
- [ ] Handlers execute correctly
- [ ] Tasks are updated

##### 2.3 Add Feature Flag

**File**: `packages/daemon/src/lib/room/room-self-service.ts` (MODIFY)

**Add**:
```typescript
// In RoomSelfConfig
useWorkerOnlyFlow?: boolean; // Default: false

// In maybeSpawnWorker()
if (this.config.useWorkerOnlyFlow) {
    return this.spawnWorkerDirect(task);
} else {
    return this.spawnWorkerPair(task);
}
```

**Validation**:
- [ ] Feature flag works
- [ ] Old flow still works when false
- [ ] New flow works when true

##### 2.4 Implement Direct Worker Spawning

**File**: `packages/daemon/src/lib/room/room-self-service.ts` (MODIFY)

**Add method**:
```typescript
private async spawnWorkerDirect(task: NeoTask): Promise<string> {
    const workerSessionId = await this.ctx.workerManager.spawnWorker({
        roomId: this.ctx.room.id,
        roomSelfSessionId: this.sessionId,
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        workspacePath: this.ctx.room.defaultPath,
    });

    // Update state
    if (this.lifecycleManager) {
        this.lifecycleManager.addActiveWorkerSession(workerSessionId);
    }

    // Start task
    await this.taskManager.startTask(task.id, workerSessionId);

    return workerSessionId;
}
```

**Validation**:
- [ ] Worker spawns correctly
- [ ] Task starts successfully
- [ ] State is updated

##### 2.5 Update State Tracking

**File**: `packages/daemon/src/lib/room/room-self-lifecycle-manager.ts` (MODIFY)

**Add methods**:
```typescript
addActiveWorkerSession(workerSessionId: string): void
removeActiveWorkerSession(workerSessionId: string): void
```

**Update RoomSelfState**:
```typescript
// Replace activeSessionPairIds with activeWorkerSessionIds
activeWorkerSessionIds: string[];
```

**Validation**:
- [ ] State updates correctly
- [ ] Lifecycle transitions work
- [ ] State persists to database

#### Phase 2 Exit Criteria

- [ ] Room self compiles with both code paths
- [ ] Feature flag toggles between flows
- [ ] New flow completes tasks end-to-end
- [ ] Old flow still works
- [ ] All tests pass

---

### Phase 3: Enable New Flow (Gradual Rollout)

**Goal**: Test new flow with real workloads.

**Duration**: 3-4 days

#### Tasks

##### 3.1 Enable for Test Rooms

**File**: Room configuration or environment variable

**Set**:
```typescript
// Enable for specific test rooms
const TEST_ROOMS = ['room-id-1', 'room-id-2'];
const useWorkerOnly = TEST_ROOMS.includes(room.id);
```

**Validation**:
- [ ] Test rooms use new flow
- [ ] Other rooms use old flow
- [ ] No cross-contamination

##### 3.2 Monitor Metrics

**Track**:
- Task completion time (old vs new)
- Error rates (old vs new)
- API costs per task (old vs new)
- Worker session lifecycle
- Failure patterns

**Validation**:
- [ ] Metrics collection works
- [ ] New flow shows improvement or parity
- [ ] No critical issues found

##### 3.3 Iterate on Issues

**Fix**:
- Worker completion signaling
- Error handling edge cases
- State synchronization issues
- Race conditions in worker lifecycle

**Validation**:
- [ ] All issues resolved
- [ ] Tests cover edge cases
- [ ] Documentation updated

##### 3.4 Expand Rollout

**Gradually enable**:
- 10% of rooms
- 25% of rooms
- 50% of rooms
- 100% of rooms

**Validation**:
- [ ] Each step successful
- [ ] Metrics remain stable
- [ ] No regression in other areas

#### Phase 3 Exit Criteria

- [ ] New flow handles all task types
- [ ] Metrics show improvement or parity
- [ ] Error rate ≤ old flow
- [ ] All test rooms successful
- [ ] Ready for full rollout

---

### Phase 4: Remove Old Code

**Goal**: Clean up deprecated Manager-related code.

**Duration**: 4-5 days

#### Tasks

##### 4.1 Remove Manager-Worker Pair Creation

**Files**:
- `packages/daemon/src/lib/room/session-pair-manager.ts` (DELETE)
- `packages/daemon/src/lib/room/session-bridge.ts` (DELETE)

**Validation**:
- [ ] Files deleted
- [ ] No remaining imports
- [ ] Clean compile

##### 4.2 Remove Manager Tools

**Files**:
- `packages/daemon/src/lib/agent/manager-tools.ts` (DELETE)

**Validation**:
- [ ] File deleted
- [ ] No references remain

##### 4.3 Remove Session Pair Repository

**Files**:
- `packages/daemon/src/storage/repositories/session-pair-repository.ts` (DELETE)

**Validation**:
- [ ] File deleted
- [ ] No references remain

##### 4.4 Remove Session Pair Types

**Files**:
- `packages/shared/src/types/neo.ts` (MODIFY)

**Remove**:
```typescript
// Remove SessionPair, SessionPairStatus, SessionPairSummary, CreateSessionPairParams
```

**Validation**:
- [ ] Types removed
- [ ] No compile errors

##### 4.5 Remove Manager Session Type

**Files**:
- `packages/shared/src/types.ts` (MODIFY)

**Change**:
```typescript
// Before:
export type SessionType = 'worker' | 'manager' | 'room_chat' | 'room_self' | 'lobby';

// After:
export type SessionType = 'worker' | 'room_chat' | 'room_self' | 'lobby';
```

**Validation**:
- [ ] Type updated
- [ ] All references updated

##### 4.6 Remove RPC Handlers

**Files**:
- `packages/daemon/src/lib/rpc-handlers/room-handlers.ts` (MODIFY)

**Remove handlers**:
- `room.createPair`
- `room.getPair`
- `room.getPairs`
- `room.archivePair`

**Validation**:
- [ ] Handlers removed
- [ ] No RPC calls fail
- [ ] API compatibility maintained

##### 4.7 Update Room Agent Tools (WITH FIX 5: API Compatibility)

**Files**:
- `packages/daemon/src/lib/agent/room-agent-tools.ts` (MODIFY)

**Phase 2-3 (Transitional)** - FIX 5: Backward compatibility:
```typescript
tool('room_spawn_worker', 'Spawn a worker session to execute a task', {
    task_id: z.string().describe('ID of the task to work on'),
}, async (args) => {
    const workerSessionId = await config.onSpawnWorker({
        taskId: args.task_id,
    });

    // FIX 5: Transitional response - supports both old and new callers
    return {
        workerSessionId: workerSessionId,
        pairId: workerSessionId,  // DEPRECATED: Equals workerSessionId for compatibility
        _apiVersion: 'v2-transitional',
        _deprecated: 'pairId is deprecated and will be removed in Phase 4. Use workerSessionId only.'
    };
})
```

**Phase 4 (Final)** - Remove deprecated field:
```typescript
tool('room_spawn_worker', 'Spawn a worker session to execute a task', {
    task_id: z.string().describe('ID of the task to work on'),
}, async (args) => {
    const workerSessionId = await config.onSpawnWorker({
        taskId: args.task_id,
    });

    // Clean response - only workerSessionId
    return { workerSessionId };
})
```

**Caller Migration**:
- **Before**: `const { pairId, workerSessionId } = await spawnWorker(...)`
- **After**: `const { workerSessionId } = await spawnWorker(...)`

**Validation**:
- [ ] Tool works correctly in both phases
- [ ] Transitional response includes deprecation warning
- [ ] All callers updated before Phase 4
- [ ] Deprecated field removed in Phase 4

##### 4.8 Update Room Self State

**Files**:
- `packages/shared/src/types/neo.ts` (MODIFY)

**Change**:
```typescript
// Before:
activeSessionPairIds: string[];

// After:
activeWorkerSessionIds: string[];
```

**Validation**:
- [ ] State updated
- [ ] Database migration handles change
- [ ] Existing state is migrated

##### 4.9 Remove Manager Prompts

**Files**:
- `packages/shared/src/prompts/templates.ts` (MODIFY)
- `packages/shared/src/prompts/types.ts` (MODIFY)

**Remove**:
- `MANAGER_AGENT_SYSTEM` template
- Manager-related template IDs

**Validation**:
- [ ] Templates removed
- [ ] No references remain

##### 4.10 Update Session Lifecycle

**Files**:
- `packages/daemon/src/lib/session/session-lifecycle.ts` (MODIFY)

**Remove**:
- Manager session creation logic
- `pairedSessionId` metadata handling

**Validation**:
- [ ] No manager sessions can be created
- [ ] Worker sessions work correctly

##### 4.11 Remove Tests

**Files**:
- `packages/daemon/tests/unit/session-pair-manager.test.ts` (DELETE)
- `packages/daemon/tests/unit/manager-tools.test.ts` (DELETE)
- Any other manager/pair specific tests (DELETE)

**Add Tests**:
- WorkerManager tests
- WorkerTools tests
- WorkerSessionRepository tests

**Validation**:
- [ ] Old tests deleted
- [ ] New tests pass
- [ ] Coverage maintained

#### Phase 4 Exit Criteria

- [ ] All manager-related code removed
- [ ] No manager symbols remain in codebase
- [ ] All tests pass
- [ ] Clean compile
- [ ] No dead imports

---

### Phase 5: Unify Room Agents

**Goal**: Align `room:chat` with `room:self` capabilities.

**Duration**: 3-4 days

#### Tasks

##### 5.1 Create Shared Orchestration Prompt

**File**: `packages/shared/src/prompts/room-agent.ts` (NEW)

**Create**:
```typescript
// Core orchestration prompt shared by both modes
export function buildRoomAgentSystemPrompt(params: {
    roomName: string;
    background?: string;
    instructions?: string;
    mode: 'chat' | 'self'; // Mode-specific context
}): string
```

**Validation**:
- [ ] Prompt compiles
- [ ] Both modes can use it
- [ ] Mode context is injected correctly

##### 5.2 Update Room Chat to Use Shared Prompt

**Files**:
- `packages/daemon/src/lib/rpc-handlers/room-handlers.ts` (MODIFY)

**Change**:
```typescript
// Use shared prompt instead of Claude Code default
const systemPrompt = buildRoomAgentSystemPrompt({
    roomName: room.name,
    background: room.background,
    instructions: room.instructions,
    mode: 'chat',
});
```

**Validation**:
- [ ] Room chat uses shared prompt
- [ ] UI still works
- [ ] No breaking changes

##### 5.3 Enable Worker Spawning in Room Chat

**Files**:
- `packages/daemon/src/lib/agent/room-agent-tools.ts` (MODIFY)

**Ensure**:
- `room_spawn_worker` tool works in `room:chat` mode
- Worker events are handled by `room:chat`

**Validation**:
- [ ] Room chat can spawn workers
- [ ] Workers complete successfully
- [ ] User is notified of results

##### 5.4 Add Mode-Specific Behaviors

**Files**:
- `packages/daemon/src/lib/agent/room-agent-tools.ts` (MODIFY)

**Implement**:
- Chat mode: Conversational, user-facing responses
- Self mode: Proactive, goal-oriented responses

**Validation**:
- [ ] Behaviors differ appropriately
- [ ] Core capabilities remain identical

##### 5.5 Update Room Chat Lifecycle

**Files**:
- `packages/daemon/src/lib/room/room-manager.ts` (MODIFY)

**Add**:
- Worker management for `room:chat`
- Task tracking for `room:chat`
- Event handling for worker completion

**Validation**:
- [ ] Room chat manages workers
- [ ] Tasks are tracked
- [ ] Events are handled

##### 5.6 Update UI for Both Modes

**Files**:
- `packages/web/src/components/room/` (MODIFY)

**Ensure**:
- UI displays workers (not pairs)
- UI supports both modes appropriately
- No hardcoded references to managers/pairs

**Validation**:
- [ ] UI shows workers correctly
- [ ] Both modes work in UI
- [ ] No breaking changes

#### Phase 5 Exit Criteria

- [ ] `room:chat` and `room:self` share orchestration code
- [ ] Both can spawn workers
- [ ] Behaviors differ only in trigger mode
- [ ] UI supports both modes
- [ ] All tests pass

---

### Phase 6: Database & API Cleanup

**Goal**: Remove all deprecated database artifacts and API compatibility code.

**Duration**: 1-2 days

#### Tasks

##### 6.1 Create Migration to Drop Old Table

**File**: `packages/daemon/src/storage/schema/migrations.ts` (MODIFY)

**Add Migration 19** (Complete cleanup):
```typescript
function runMigration19(db: BunDatabase): void {
    // Step 1: Final backup of session_pairs table
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_pairs_backup_${Date.now()} AS
        SELECT * FROM session_pairs
    `);

    // Step 2: Archive orphaned pairs older than retention period
    db.exec(`
        DELETE FROM worker_sessions_orphaned
        WHERE migrated_at < strftime('%s', 'now') * 1000 - (30 * 24 * 60 * 60 * 1000)
    `);

    // Step 3: Drop session_pairs table and indexes
    db.exec(`
        DROP INDEX IF EXISTS idx_session_pairs_room;
        DROP INDEX IF EXISTS idx_session_pairs_manager;
        DROP INDEX IF EXISTS idx_session_pairs_worker;
        DROP TABLE IF EXISTS session_pairs;
    `);

    // Step 4: Optional - drop orphaned table if empty
    // Only if retention period has passed and table is empty
}
```

**Rollback** (if needed):
```typescript
function rollbackMigration19(db: BunDatabase): void {
    // Restore from backup (if backup table exists)
    // This is emergency-only - normally we don't rollback dropped tables
}
```

**Validation**:
- [ ] Migration runs successfully
- [ ] session_pairs table dropped
- [ ] Indexes dropped
- [ ] Backup created (with timestamp)

##### 6.2 Remove All Deprecated Response Fields

**Files**:
- `packages/daemon/src/lib/agent/room-agent-tools.ts` (MODIFY)

**Remove** (FIX 5: Final cleanup):
```typescript
// Remove all deprecated fields from room_spawn_worker response
// Remove _apiVersion and _deprecated fields
// Clean up any deprecation logging
```

**Validation**:
- [ ] No deprecated fields remain
- [ ] Response is clean: { workerSessionId }
- [ ] All callers updated

##### 6.3 Verify No References

**Search and remove**:
- `session_pairs` in codebase
- `SessionPair` in codebase
- `manager` session type in codebase
- `pairId` in tool responses
- `room_self_session_id` (should be `room_session_id`)
- `activeSessionPairIds` (should be `activeWorkerSessionIds`)

**Validation**:
- [ ] No references remain
- [ ] Database queries work
- [ ] No performance regression
- [ ] Code search returns 0 results for deprecated symbols

##### 6.4 Final Verification

**Run complete audit**:
```bash
# Verify no manager symbols
grep -r "manager" packages/daemon/src/lib/ packages/shared/src/ --exclude-dir=node_modules

# Verify no pair symbols
grep -r "SessionPair" packages/ --exclude-dir=node_modules

# Verify schema is clean
sqlite3 neokai.db ".schema"
# Should show worker_sessions, NOT session_pairs

# Run full test suite
bun test
```

**Validation**:
- [ ] No manager symbols found
- [ ] No pair symbols found
- [ ] Schema shows only worker_sessions
- [ ] All tests pass
- [ ] Integration tests pass
- [ ] E2E tests pass

#### Phase 6 Exit Criteria

- [ ] `session_pairs` table dropped
- [ ] `worker_sessions_orphaned` optionally dropped (after retention)
- [ ] No references to old schema
- [ ] No deprecated API response fields
- [ ] Database is clean
- [ ] All tests pass
- [ ] Documentation complete

---

## Testing Strategy

### Unit Tests

**New Tests Required**:
- WorkerManager: spawn, status updates, completion
- WorkerTools: MCP tool invocation
- WorkerSessionRepository: CRUD operations
- RoomSelfService: direct worker spawning
- Shared prompt builder

**Existing Tests to Update**:
- RoomSelfService: update for new flow
- Room handlers: remove pair-related tests
- Session lifecycle: remove manager tests

**Coverage Target**: >80% for new code

### Integration Tests

**Scenarios**:
1. Room self creates task → spawns worker → completes
2. Room chat receives message → spawns worker → completes
3. Worker requests review → room agent handles → resumes
4. Worker fails → room agent retries or escalates
5. Multiple workers in parallel → all complete
6. Recurring job spawns worker → completes

**Test Files**:
- `packages/daemon/tests/integration/room/worker-lifecycle.test.ts`
- `packages/daemon/tests/integration/room/room-self-worker.test.ts`
- `packages/daemon/tests/integration/room/room-chat-worker.test.ts`

### E2E Tests

**Scenarios**:
1. Create room → enable autonomous → observe task execution
2. User sends room chat message → worker executes → result returned
3. GitHub event → room self spawns worker → task completes

**Test Files**:
- `packages/e2e/tests/room/autonomous-mode.e2e.ts`
- `packages/e2e/tests/room/chat-worker-spawn.e2e.ts`

### Regression Tests

**Verify**:
- No manager-related symbols remain
- All RPC handlers work correctly
- Database queries are efficient
- UI displays correctly
- No performance degradation

---

## Risk Mitigation

### Risk 1: Completion Signaling Breaks

**Risk**: Temporary loss of completion signaling during transition

**Mitigation**:
- Introduce worker completion events before deleting pair events
- Keep both event systems working during Phase 2-3
- Test thoroughly before removing old events

### Risk 2: Duplicated Logic Reappears

**Risk**: room:chat and room:self diverge again

**Mitigation**:
- Enforce shared orchestration module
- Shared tool contract
- Code reviews for any duplication
- Regular audits of both code paths

### Risk 3: Migration Breaks Existing Data

**Risk**: Loss of persisted pair/session data

**Mitigation**:
- Explicit migration adapter
- Compatibility read path during transition
- Backup before migration
- Rollback script ready

### Risk 4: Performance Regression

**Risk**: New implementation is slower

**Mitigation**:
- Benchmark before/after
- Optimize database queries
- Monitor API call patterns
- Load testing before full rollout

### Risk 5: UI Breaks

**Risk**: Web UI depends on pair data structure

**Mitigation**:
- UI updates in Phase 5
- Keep UI backward compatible during transition
- Test UI thoroughly with both modes
- Feature flag for UI changes

---

## Rollback Plan

Each phase is independently reversible:

### Phase 1-2 Rollback
- Remove feature flag
- New code remains but unused
- Zero risk to existing functionality

### Phase 3 Rollback
- Disable feature flag
- All rooms return to old flow
- Clean worker_sessions table if needed

### Phase 4 Rollback
- Restore deleted files from git
- Revert type changes
- Rollback migration
- Redeploy previous version

### Phase 5-6 Rollback
- Revert prompt changes
- Restore old UI if needed
- Recreate session_pairs table from backup

---

## Success Metrics

### Technical Metrics

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| Architecture layers | 3 | 2 | -33% |
| Sessions per task | 2 | 1 | -50% |
| LLM calls per task | ~2 | ~1 | -50% |
| Lines of code (manager-related) | ~1,060 | 0 | -100% |
| Database tables (pairs) | 1 | 0 | -100% |
| Worker spawn time | Baseline | ≤ baseline | No regression |

### Quality Metrics

| Metric | Target |
|--------|--------|
| Test coverage (new code) | >80% |
| Integration tests passing | 100% |
| E2E tests passing | 100% |
| Critical bugs | 0 |
| Performance regression | <5% |

### Cost Metrics

| Metric | Expected Reduction |
|--------|-------------------|
| API costs per task | ~50% |
| Total tokens per task | ~40-60% |
| Average task completion time | ≤ baseline (no increase) |

---

## Definition of Done

- [ ] Manager concept absent from runtime, prompts, APIs, schema, and docs
- [ ] `room:chat` and `room:self` use one orchestration capability set
- [ ] Only behavior difference is working mode (human vs autonomous)
- [ ] Worker orchestration runs reliably end-to-end
- [ ] All tests pass (unit, integration, E2E)
- [ ] No performance regression
- [ ] Documentation updated
- [ ] Code reviews completed
- [ ] Metrics show improvement or parity

---

## Next Steps

1. **Review this plan** with team and stakeholders
2. **Create tracking issues** for each phase
3. **Set up feature flags** and monitoring
4. **Begin Phase 1 implementation**
5. **Weekly checkpoints** to review progress

---

**Document Owner**: Claude (NeoKai Design)
**Last Updated**: 2025-02-22
**Status**: Ready for Implementation
