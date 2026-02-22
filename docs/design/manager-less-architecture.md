# Manager-less Room Architecture Design

## Executive Summary

**Current State**: 3-tier architecture (Room Self → Manager → Worker)
**Proposed State**: 2-tier architecture (Room Agent → Worker)

**Key Changes**:
1. Remove Manager agent layer completely
2. Workers directly signal task completion to Room Agent
3. Remove `SessionPair` abstraction
4. Simplify session types and lifecycle
5. **Unify `room:chat` and `room:self` orchestration capabilities** - they differ only in trigger mode (human vs autonomous)
6. **Single-source ownership**: Shared tools (`room-agent-tools.ts`) and prompts (`room-agent.ts`) for both room modes

**Status**: v1.1 (Critical Fixes Applied)
**Related Documents**:
- [Room Autonomy Manager Removal Plan](./room-autonomy-manager-removal-plan.md) - Original plan with focus on unifying room agents
- [Manager Removal Implementation Plan](./manager-removal-implementation-plan.md) - v2.0 with all critical fixes applied
- [Critical Fixes Applied](./manager-removal-critical-fixes.md) - Detailed breakdown of all 7 fixes

**Changes in v1.1**:
- Fixed schema contradictions (task_id FK, room_session_id naming)
- Added session_id column for direct lookup
- Complete migration strategy (orphaned pairs preserved)
- Harmonized phase sequence with implementation plan (6 phases)
- Shared WorkerEventHandler architecture

**Status**: Design phase - awaiting approval

**Related Documents**:
- [Room Autonomy Manager Removal Plan](./room-autonomy-manager-removal-plan.md) - Original plan with focus on unifying room agents

---

## Table of Contents

- [Current Architecture](#current-architecture)
- [Proposed Architecture](#proposed-architecture)
- [Critical Analysis](#critical-analysis)
- [File-by-File Changes](#file-by-file-changes)
- [New Components](#new-components)
- [Event Flow Changes](#event-flow-changes)
- [Migration Plan](#migration-plan)
- [Benefits Summary](#benefits-summary)

---

## Current Architecture

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Room Self Agent                           │
│  Session ID: room:self:${roomId}                             │
│  Type: room_self                                             │
│                                                              │
│  Responsibilities:                                           │
│  - Subscribe to events (GitHub, user messages)              │
│  - Create tasks from events                                  │
│  - Spawn Manager-Worker pairs via SessionPairManager        │
│  - Monitor task completion via pair.task_completed event    │
│  - Manage goals, recurring jobs                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ room_spawn_worker(taskId)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  SessionPairManager                          │
│  - Creates Manager + Worker sessions                        │
│  - Links sessions with pairedSessionId                      │
│  - Creates manager-tools MCP server                         │
│  - Returns SessionPair                                      │
└─────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┴────────────────────┐
         ▼                                         ▼
┌──────────────────┐                     ┌──────────────────┐
│   Manager Agent  │                     │   Worker Agent   │
│                  │                     │                  │
│  - Coordinates   │◄────────────────────►│ - Executes work  │
│  - Reviews       │    SessionBridge     │ - File ops, bash │
│  - Has manager_  │    (synthetic        │ - Standard tools │
│    tools MCP     │     messages)        │                  │
│  - Calls         │                     │                  │
│    manager_      │                     │                  │
│    complete_task │                     │                  │
└──────────────────┘                     └──────────────────┘
```

### Database Schema

```sql
-- session_pairs table (Migration 16)
CREATE TABLE session_pairs (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    room_session_id TEXT NOT NULL,
    manager_session_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'idle', 'crashed', 'completed')),
    current_task_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_pairs_room ON session_pairs(room_id);
CREATE INDEX idx_session_pairs_manager ON session_pairs(manager_session_id);
CREATE INDEX idx_session_pairs_worker ON session_pairs(worker_session_id);
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| RoomSelfService | `room/room-self-service.ts` | Orchestrates room automation |
| SessionPairManager | `room/session-pair-manager.ts` | Creates manager-worker pairs |
| SessionBridge | `room/session-bridge.ts` | Bridges manager-worker communication |
| ManagerTools | `agent/manager-tools.ts` | MCP server for task completion |
| SessionPairRepository | `storage/repositories/session-pair-repository.ts` | Database operations for pairs |

---

## Proposed Architecture

### Unified Orchestrator Architecture

The key insight from the original plan is that **both `room:chat` and `room:self` should share the same orchestration capabilities**, differing only in their trigger sources:

```
┌─────────────────────────────────────────────────────────────┐
│         Shared Orchestrator Capability Layer                 │
│  - Same tools: room-agent-tools.ts                          │
│  - Same prompt core: room-agent.ts                          │
│  - Same policy: orchestrate only, never execute directly    │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│   room:chat (Human-Driven Mode)  │  │   room:self (Autonomous Mode)    │
│                                  │  │                                  │
│  Triggers:                       │  │  Triggers:                       │
│  - Human messages                │  │  - Idle checks                   │
│  - Explicit commands             │  │  - Recurring jobs                │
│  - User-invoked planning         │  │  - Task/goal transitions         │
│                                  │  │  - Room/session events           │
│  Session: room:chat:{roomId}     │  │  - GitHub/webhook events         │
│                                  │  │                                  │
│  Responsiveness:                 │  │  Session: room:self:{roomId}     │
│  Interactive, conversational     │  │                                  │
│  Responds to user input          │  │  Responsiveness:                 │
│                                  │  │  Proactive, goal-oriented        │
│                                  │  │  Acts on planned work            │
└──────────────────────────────────┘  └──────────────────────────────────┘
              │                                   │
              └───────────────┬───────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Worker Agent                              │
│  Session ID: ${generated}                                    │
│  Type: worker                                               │
│                                                              │
│  - Executes tasks                                           │
│  - Has worker-tools MCP (completion, review request)        │
│  - Signals completion via worker_complete_task()           │
│  - Can request review via worker_request_review()          │
└─────────────────────────────────────────────────────────────┘
```

### Key Principle: Single-Source Ownership

| Component | Single Source | Used By |
|-----------|---------------|----------|
| **Room Agent Tools** | `packages/daemon/src/lib/agent/room-agent-tools.ts` | Both `room:chat` and `room:self` |
| **Room Agent Prompts** | `packages/shared/src/prompts/room-agent.ts` | Both `room:chat` and `room:self` |
| **Worker Tools** | `packages/daemon/src/lib/agent/worker-tools.ts` | Worker sessions only |
| **WorkerManager** | `packages/daemon/src/lib/room/worker-manager.ts` | Both `room:chat` and `room:self` |

### Architecture Diagram (Simplified)

### Database Schema (WITH CRITICAL FIXES APPLIED)

```sql
-- worker_sessions table (new) - ALL FIXES APPLIED
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
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT -- FIX 1: Was SET NULL (contradiction)
);

CREATE INDEX idx_worker_sessions_room ON worker_sessions(room_id);
CREATE INDEX idx_worker_sessions_task ON worker_sessions(task_id);
CREATE INDEX idx_worker_sessions_status ON worker_sessions(status);
CREATE INDEX idx_worker_sessions_session ON worker_sessions(session_id);     -- FIX 3
CREATE INDEX idx_worker_sessions_room_session ON worker_sessions(room_session_id); -- FIX 2

-- FIX 4: Orphaned pairs preservation (prevents data loss)
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
1. **FIX 1**: `task_id NOT NULL` with `ON DELETE RESTRICT` (was contradictory SET NULL)
2. **FIX 2**: `room_session_id` is mode-agnostic (supports both room:chat and room:self)
3. **FIX 3**: `session_id` column added for direct agent session lookup
4. **FIX 4**: `worker_sessions_orphaned` table preserves session_pairs without tasks

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| RoomSelfService | `room/room-self-service.ts` | Orchestrates room automation (updated) |
| WorkerManager | `room/worker-manager.ts` | **NEW** - Direct worker creation |
| WorkerTools | `agent/worker-tools.ts` | **NEW** - MCP server for workers |
| WorkerSessionRepository | `storage/repositories/worker-session-repository.ts` | **NEW** - Worker database operations |

---

## Critical Analysis

### What the Manager Agent Currently Does

1. **Receives task delegation** from Room Self agent
2. **Coordinates** the Worker agent via SessionBridge
3. **Reviews** Worker's output when it reaches terminal states
4. **Calls `manager_complete_task()`** when satisfied
5. **Has access to `manager-tools` MCP server** (single tool)

### Arguments FOR Keeping the Manager

1. **Separation of Concerns**: Worker focuses on execution, Manager focuses on coordination/review
2. **Quality Control**: Manager can review Worker output before marking complete
3. **Iterative Refinement**: Manager can ask Worker to retry with feedback
4. **Parallel Task Potential**: Architecture supports multiple workers per manager (though not fully utilized)

### Arguments AGAINST Keeping the Manager

1. **Redundant Layer**: Room Self agent already orchestrates and could review completed work
2. **Message Forwarding Overhead**: SessionBridge adds complexity (synthetic messages, state monitoring)
3. **Limited Manager Tools**: Only `manager_complete_task()` - not substantial decision-making
4. **Single Worker per Manager**: Currently 1:1 pairing, no multi-worker coordination benefit
5. **Added State Complexity**: Two sessions to manage per task instead of one
6. **Cost**: Two LLM calls per task instead of one

### The Core Question

> **Is the review/coordination layer valuable enough to justify the complexity?**

Looking at the actual manager prompt (session-pair-manager.ts:179):
```
"You are the manager for this task. You must coordinate and review; do not implement code changes directly.
...
1. Delegate concrete implementation to the worker session.
2. Review worker updates and request corrections when needed.
3. Do NOT run direct code-editing or shell execution yourself.
4. When work is complete, call manager_complete_task..."
```

The manager is essentially a **pass-through wrapper** with minimal decision logic.

### Assessment: The Manager Agent Is Redundant

**Why Room Self Can Handle This Directly:**

1. **Room Self already has MCP tools** for task management, spawning workers, reviews, escalation
2. **Room Self already monitors task completion** via `pair.task_completed` events (room-self-service.ts:403)
3. **Room Self has lifecycle state management** - can review/decide without manager layer
4. **SessionBridge exists only to bridge two agents** - if direct, it's not needed

### What You'd Lose

1. **"Manager" as a distinct role** - but Room Self can fill this
2. **Multi-worker coordination potential** - but this isn't implemented anyway

### What You'd Gain

1. **Simpler architecture**: 2 agents instead of 3
2. **Less message passing**: No SessionBridge complexity
3. **Lower cost**: 1 LLM call per task instead of 2
4. **Clearer responsibility**: Room Self orchestrates AND reviews

### Exception

If you plan to implement **true multi-worker coordination** (one Manager coordinating multiple Workers in parallel/serial), then the Manager layer makes sense. But for 1:1 pairing, it's redundant.

---

## Additional Insights from Existing Plan

The original [Room Autonomy Manager Removal Plan](./room-autonomy-manager-removal-plan.md) identifies several critical issues that reinforce the need to remove the Manager layer:

### 1. Duplication of Orchestration Logic

The current architecture **duplicates orchestration** across:
- `room:self` agent logic
- Manager session logic

This creates two places where orchestration decisions are made, increasing complexity and potential for inconsistencies.

### 2. Inconsistent Bridge Wiring

The bridge between Manager and Worker is created through **inconsistent paths**:
- `room.createPair` RPC starts `SessionBridge`
- Direct `SessionPairManager.createPair()` usage from room-self flow uses a different path

This inconsistency makes the system less deterministic and harder to debug.

### 3. The Real Opportunity: Unify Room Agents

The original plan identifies a broader opportunity that my initial design missed:

> **`room:chat` and `room:self` should have IDENTICAL orchestration capabilities.**
> The only difference should be **operating mode**:
> - `room:chat`: reacts to human messages/commands
> - `room:self`: reacts to goals, tasks, events, idle/proactive checks, and session updates

This means:
- **Shared tool contract** for both modes
- **Shared orchestration prompt core**
- **Mode-specific behavior as lightweight runtime context** (not separate prompt/tool stacks)

### 4. Single-Source Ownership

The original plan advocates for:
- **Prompt core**: `packages/shared/src/prompts/room-agent.ts` (single source)
- **Tools**: `packages/daemon/src/lib/agent/room-agent-tools.ts` (single source)

This ensures that both `room:chat` and `room:self` use the same orchestration capabilities, preventing code duplication and drift.

### 5. Unified Trigger Model

```
┌─────────────────────────────────────────────────────────────┐
│              Shared Orchestrator Capability Layer           │
│  - Same tools (read state, create/update tasks/goals/jobs) │
│  - Same prompt core                                         │
│  - Same policy (orchestrate only, never execute directly)  │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│   room:chat mode         │      │   room:self mode         │
│  Triggers:               │      │  Triggers:               │
│  - Human messages        │      │  - Idle checks           │
│  - Explicit commands     │      │  - Recurring jobs        │
│  - User-invoked planning │      │  - Task/goal transitions  │
│                          │      │  - Room/session events   │
└──────────────────────────┘      └──────────────────────────┘
```

### Implications for This Design

These insights mean the WorkerManager I've designed should:
1. Be usable by **both** `room:chat` and `room:self` agents
2. Not contain any mode-specific logic
3. Support the same worker lifecycle for both human-triggered and autonomous tasks
4. Use the same `room-agent-tools` MCP server (which already exists)

The implementation I've designed aligns well with this vision - the `WorkerManager` is a pure service that can be called from either room agent mode.

---

## File-by-File Changes

### Files to Remove

| File | Lines | Reason |
|------|-------|--------|
| `packages/daemon/src/lib/room/session-pair-manager.ts` | ~258 | Replaced by WorkerManager |
| `packages/daemon/src/lib/room/session-bridge.ts` | ~518 | No longer needed without pairs |
| `packages/daemon/src/lib/agent/manager-tools.ts` | ~131 | Functionality moves to worker-tools |
| `packages/daemon/src/storage/repositories/session-pair-repository.ts` | ~153 | Replaced by worker session tracking |

**Total**: ~1,060 lines removed

### Files to Create

| File | Purpose | Estimated Lines |
|------|---------|-----------------|
| `packages/daemon/src/lib/room/worker-manager.ts` | Direct worker creation and lifecycle | ~200 |
| `packages/daemon/src/lib/agent/worker-tools.ts` | Worker completion and review tools | ~100 |
| `packages/daemon/src/storage/repositories/worker-session-repository.ts` | Worker session CRUD | ~150 |

**Total**: ~450 lines added

### Files to Modify

#### 1. `packages/daemon/src/lib/room/room-self-service.ts`

**Changes:**
- Replace `SessionPairManager` dependency with `WorkerManager`
- Update `maybeSpawnWorker()` to call `workerManager.spawnWorker()`
- Change state tracking from `activeSessionPairIds` to `activeWorkerSessionIds`
- Update event subscriptions from `pair.task_completed` to `worker.task_completed`
- Add `worker.review_requested` event handler

**Before:**
```typescript
const result = await this.ctx.sessionPairManager.createPair({
    roomId: this.ctx.room.id,
    roomSessionId: this.sessionId,
    taskId: task.id,
    taskTitle: task.title,
    taskDescription: task.description,
    workspacePath: ...,
});
```

**After:**
```typescript
const workerSessionId = await this.ctx.workerManager.spawnWorker({
    roomId: this.ctx.room.id,
    roomSelfSessionId: this.sessionId,
    taskId: task.id,
    taskTitle: task.title,
    taskDescription: task.description,
    workspacePath: ...,
});
```

#### 2. `packages/daemon/src/lib/agent/room-agent-tools.ts`

**Changes:**
- Update `room_spawn_worker` tool to return only `workerSessionId`
- Remove `mode` parameter (single/parallel/serial not needed)
- Update return type

**Before:**
```typescript
tool('room_spawn_worker', 'Spawn a worker session...', {
    task_id: z.string(),
    mode: z.enum(['single', 'parallel', 'serial']),
}, async (args) => {
    const result = await config.onSpawnWorker({
        taskId: args.task_id,
        mode: args.mode,
    });
    return { pairId: result.pairId, workerSessionId: result.workerSessionId };
})
```

**After:**
```typescript
tool('room_spawn_worker', 'Spawn a worker session...', {
    task_id: z.string(),
}, async (args) => {
    const workerSessionId = await config.onSpawnWorker({
        taskId: args.task_id,
    });
    return { workerSessionId };
})
```

#### 3. `packages/shared/src/types/neo.ts`

**Remove:**
- `SessionPair` interface
- `SessionPairStatus` type (`'active' | 'idle' | 'crashed' | 'completed'`)
- `SessionPairSummary` interface
- `CreateSessionPairParams` interface
- `activeSessionPairIds` from `RoomSelfState`

**Add:**
```typescript
/**
 * Worker session status
 */
export type WorkerStatus = 'starting' | 'running' | 'waiting_for_review' | 'completed' | 'failed' | 'cancelled';

/**
 * Worker session tracking
 */
export interface WorkerSession {
    /** Unique identifier for this worker session tracking record */
    id: string;
    /** Room this worker belongs to */
    roomId: string;
    /** Room agent session that created this worker (mode-agnostic) - FIX 2 */
    roomSessionId: string;  // Changed from: roomSelfSessionId
    /** The actual agent session ID - FIX 3 */
    sessionId: string;
    /** Room agent type (discriminator) - FIX 2 */
    roomSessionType: 'room_chat' | 'room_self';
    /** Task this worker is executing */
    taskId: string;
    /** Current status of the worker */
    status: WorkerStatus;
    /** Creation timestamp (milliseconds since epoch) */
    createdAt: number;
    /** Last update timestamp (milliseconds since epoch) */
    updatedAt: number;
    /** Completion timestamp (milliseconds since epoch) */
    completedAt?: number;
}

/**
 * Update RoomSelfState to track workers instead of pairs
 */
export interface RoomSelfState {
    // ... existing fields ...
    /** Active worker session IDs (was activeSessionPairIds) */
    activeWorkerSessionIds: string[];
    // ... rest of fields ...
}
```

#### 4. `packages/shared/src/types.ts`

**Changes:**
- Remove `'manager'` from `SessionType` union

**Before:**
```typescript
export type SessionType = 'worker' | 'manager' | 'room_chat' | 'room_self' | 'lobby';
```

**After:**
```typescript
export type SessionType = 'worker' | 'room_chat' | 'room_self' | 'lobby';
```

#### 5. `packages/daemon/src/storage/schema/migrations.ts`

**Add new migration:**

```typescript
/**
 * Migration 18: Create worker_sessions table and deprecate session_pairs
 */
function runMigration18(db: BunDatabase): void {
    // Skip if worker_sessions table already exists
    if (tableExists(db, 'worker_sessions')) {
        return;
    }

    // Create new worker_sessions table
    db.exec(`
        CREATE TABLE IF NOT EXISTS worker_sessions (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            room_self_session_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'starting'
                CHECK(status IN ('starting', 'running', 'waiting_for_review', 'completed', 'failed', 'cancelled')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_worker_sessions_room ON worker_sessions(room_id);
        CREATE INDEX IF NOT EXISTS idx_worker_sessions_task ON worker_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_worker_sessions_status ON worker_sessions(status);
    `);

    // Migrate existing data from session_pairs
    // Only migrate pairs that have a current task
    db.exec(`
        INSERT INTO worker_sessions (id, room_id, room_self_session_id, task_id, status, created_at, updated_at, completed_at)
        SELECT
            lower(hex(randomblob(16))),
            spp.room_id,
            spp.room_session_id,
            spp.current_task_id,
            CASE spp.status
                WHEN 'completed' THEN 'completed'
                WHEN 'crashed' THEN 'failed'
                ELSE 'running'
            END,
            spp.created_at,
            spp.updated_at,
            CASE WHEN spp.status = 'completed' THEN spp.updated_at ELSE NULL END
        FROM session_pairs spp
        WHERE spp.current_task_id IS NOT NULL;
    `);

    // Note: We keep session_pairs table for now for backward compatibility
    // Can be dropped in a future migration after verification
}
```

#### 6. `packages/daemon/src/lib/room/room-manager.ts`

**Changes:**
- Remove methods that reference session pairs
- Update room overview to show workers instead of pairs
- Update task session mapping

#### 7. `packages/daemon/src/lib/session/session-lifecycle.ts`

**Changes:**
- Simplify session creation to remove manager-specific logic
- Remove `pairedSessionId` from session metadata
- Update session type handling to reject `'manager'`

#### 8. RPC Handlers

**Remove:**
- `room.createPair` - Replaced with direct worker spawning via room-agent-tools
- `room.getPair` - No longer needed
- `room.getPairs` - Replace with worker listing
- `room.archivePair` - Replace with worker session archival

**Add/Modify:**
- Update room handlers to support worker-listing endpoints
- Add worker status tracking endpoints
- Update room overview to show active workers instead of pairs

**RPC Migration Mapping:**

| Old RPC | New Approach | Notes |
|---------|--------------|-------|
| `room.createPair` | Call `room_spawn_worker` tool from room agent | Direct orchestration |
| `room.getPair(pairId)` | `room.getWorker(taskId)` | Query by task instead of pair |
| `room.getPairs(roomId)` | `room.listWorkers(roomId)` | Simpler listing |
| `room.archivePair(pairId)` | `session.archive(workerSessionId)` | Use standard session archival |

---

---

## New Components

### 1. WorkerManager

**File:** `packages/daemon/src/lib/room/worker-manager.ts`

```typescript
/**
 * WorkerManager - Direct worker session creation and lifecycle
 *
 * Replaces SessionPairManager with simpler worker-only approach.
 * Room Self creates workers directly; workers signal completion back.
 *
 * Key responsibilities:
 * - Spawn worker sessions for tasks
 * - Create worker-tools MCP server for each worker
 * - Track worker session status
 * - Handle task completion events
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type {
    CreateWorkerParams,
    WorkerSession,
    WorkerStatus,
    McpServerConfig,
} from '@neokai/shared';
import type { McpSdkServerConfigWithInstance } from '@neokai/shared/sdk';
import type { SessionLifecycle } from '../session/session-lifecycle';
import type { RoomManager } from './room-manager';
import { WorkerSessionRepository } from '../../storage/repositories/worker-session-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import {
    createWorkerToolsMcpServer,
    type WorkerCompleteTaskParams,
} from '../agent/worker-tools';

export class WorkerManager {
    private workerSessionRepo: WorkerSessionRepository;
    private taskRepo: TaskRepository;
    /** Worker tools MCP servers indexed by worker session ID */
    private workerTools: Map<string, McpSdkServerConfigWithInstance> = new Map();

    constructor(
        private db: BunDatabase,
        private sessionLifecycle: SessionLifecycle,
        private roomManager: RoomManager,
        private daemonHub: DaemonHub
    ) {
        this.workerSessionRepo = new WorkerSessionRepository(db);
        this.taskRepo = new TaskRepository(db);
    }

    /**
     * Spawn a new worker for a task
     *
     * Creates:
     * 1. A worker session with full Claude Code capabilities
     * 2. Worker tools MCP server for completion signaling
     * 3. Worker session tracking record
     *
     * Returns the worker session ID
     */
    async spawnWorker(params: CreateWorkerParams): Promise<string> {
        const { roomId, roomSessionId, taskId, taskTitle, taskDescription, workspacePath, model } = params;  // FIX 2: roomSessionId

        // 1. Validate room exists
        const room = this.roomManager.getRoom(roomId);
        if (!room) {
            throw new Error(`Room not found: ${roomId}`);
        }

        // 2. Validate task exists
        const task = this.taskRepo.getTask(taskId);
        if (!task) {
            throw new Error(`Task not found: ${taskId}`);
        }

        // 3. Determine workspace path and model
        const workerPath = workspacePath ?? room.defaultPath ?? room.allowedPaths[0]?.path;
        if (!workerPath) {
            throw new Error('No workspace path available for worker');
        }
        const workerModel = model ?? room.defaultModel;

        // 4. Create worker session
        const workerSessionId = await this.sessionLifecycle.create({
            workspacePath: workerPath,
            title: `Worker: ${taskTitle}`,
            config: workerModel ? { model: workerModel } : undefined,
            roomId: roomId,
            sessionType: 'worker',
            currentTaskId: taskId,
            parentSessionId: roomSelfSessionId,
        });

        // 5. Assign to room
        this.roomManager.assignSession(roomId, workerSessionId);

        // 6. Track worker session
        this.workerSessionRepo.createWorkerSession({
            id: generateUUID(),
            roomId,
            roomSelfSessionId,
            taskId,
            status: 'starting',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });

        // 7. Create worker tools MCP server
        const workerToolsMcp = this.createWorkerToolsMcp(workerSessionId, taskId);
        this.workerTools.set(workerSessionId, workerToolsMcp);

        // 8. Get agent session and inject tools
        const agentSession = this.sessionLifecycle.getAgentSession(workerSessionId);
        if (agentSession) {
            // Inject worker tools into the agent session's runtime config (not persisted to DB)
            agentSession.session.config.mcpServers = {
                ...agentSession.session.config.mcpServers,
                'worker-tools': workerToolsMcp as unknown as McpServerConfig,
            };

            // Start the SDK streaming query loop
            await agentSession.startStreamingQuery();

            // Send initial task prompt
            const workerPrompt = this.buildWorkerPrompt(taskTitle, taskDescription);
            await agentSession.messageQueue.enqueue(workerPrompt, true);
        }

        // 9. Emit event
        await this.daemonHub.emit('worker.started', {
            sessionId: workerSessionId,
            roomId,
            taskId,
        });

        return workerSessionId;
    }

    /**
     * Get worker session tracking record by task ID
     */
    getWorkerByTask(taskId: string): WorkerSession | null {
        return this.workerSessionRepo.getWorkerByTask(taskId);
    }

    /**
     * Get all worker sessions for a room
     */
    getWorkersByRoom(roomId: string): WorkerSession[] {
        return this.workerSessionRepo.getWorkersByRoom(roomId);
    }

    /**
     * Update worker status
     */
    updateWorkerStatus(workerSessionId: string, status: WorkerStatus): void {
        this.workerSessionRepo.updateWorkerStatus(workerSessionId, status);
    }

    /**
     * Complete a worker session
     */
    completeWorker(workerSessionId: string): void {
        this.workerSessionRepo.completeWorkerSession(workerSessionId);
    }

    /**
     * Get the worker tools MCP server for a worker session
     */
    getWorkerTools(sessionId: string): McpSdkServerConfigWithInstance | undefined {
        return this.workerTools.get(sessionId);
    }

    /**
     * Build the initial prompt for a worker session
     */
    private buildWorkerPrompt(taskTitle: string, taskDescription?: string): string {
        const parts: string[] = [];

        parts.push('You have been assigned the following task:\n\n');
        parts.push(`**${taskTitle}**\n\n`);

        if (taskDescription) {
            parts.push(`${taskDescription}\n\n`);
        }

        parts.push('Please complete this task using the available tools.\n\n');
        parts.push('When you have finished:\n');
        parts.push('1. Call `worker_complete_task` with a summary of what you accomplished\n');
        parts.push('2. If you need human review or approval at any point, call `worker_request_review`\n\n');
        parts.push('Available worker-specific tools:\n');
        parts.push('- `worker_complete_task`: Mark your task as complete\n');
        parts.push('- `worker_request_review`: Request human review before proceeding');

        return parts.join('');
    }

    /**
     * Create worker tools MCP server for a specific worker session
     */
    private createWorkerToolsMcp(workerSessionId: string, taskId: string) {
        return createWorkerToolsMcpServer({
            sessionId: workerSessionId,
            taskId,
            onCompleteTask: async (params: WorkerCompleteTaskParams) => {
                // Update task status
                this.taskRepo.updateTask(params.taskId, {
                    status: 'completed',
                    progress: 100,
                    result: params.summary,
                });

                // Complete worker session
                this.completeWorker(workerSessionId);

                // Emit event for Room Self to handle
                await this.daemonHub.emit('worker.task_completed', {
                    sessionId: workerSessionId,
                    taskId: params.taskId,
                    summary: params.summary,
                    filesChanged: params.filesChanged,
                    nextSteps: params.nextSteps,
                });
            },
            onRequestReview: async (reason: string) => {
                // Update worker status
                this.updateWorkerStatus(workerSessionId, 'waiting_for_review');

                // Emit event for Room Self to handle
                await this.daemonHub.emit('worker.review_requested', {
                    sessionId: workerSessionId,
                    taskId,
                    reason,
                });
            },
        });
    }
}
```

### 2. Worker Tools

**File:** `packages/daemon/src/lib/agent/worker-tools.ts`

```typescript
/**
 * Worker Tools - MCP tools for Worker agents
 *
 * These tools are exposed to Worker agents, allowing them to:
 * - Signal task completion to Room Self
 * - Request human review when needed
 *
 * Replaces manager-tools with direct completion signaling.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Parameters for the worker_complete_task tool
 */
export interface WorkerCompleteTaskParams {
    taskId: string;
    summary: string;
    filesChanged?: string[];
    nextSteps?: string[];
}

/**
 * Configuration for creating the Worker Tools MCP server
 */
export interface WorkerToolsConfig {
    /** ID of the worker session using these tools */
    sessionId: string;
    /** Task ID this worker is executing */
    taskId: string;
    /** Callback when task is completed */
    onCompleteTask: (params: WorkerCompleteTaskParams) => Promise<void>;
    /** Callback to request human review */
    onRequestReview: (reason: string) => Promise<void>;
}

/**
 * Create an MCP server with worker tools
 *
 * This server provides tools that allow the WorkerAgent to:
 * - Signal task completion to Room Self
 * - Request human review when needed
 */
export function createWorkerToolsMcpServer(config: WorkerToolsConfig) {
    return createSdkMcpServer({
        name: `worker-tools-${config.sessionId.slice(0, 8)}`,
        tools: [
            tool(
                'worker_complete_task',
                'Complete your task and report results to the Room Agent. Call this when you have successfully completed your assigned work.',
                {
                    task_id: z.string().describe('ID of the task you completed'),
                    summary: z.string().describe('Summary of what you accomplished'),
                    files_changed: z
                        .array(z.string())
                        .optional()
                        .describe('List of files that were modified'),
                    next_steps: z
                        .array(z.string())
                        .optional()
                        .describe('Suggested follow-up actions'),
                },
                async (args) => {
                    await config.onCompleteTask({
                        taskId: args.task_id,
                        summary: args.summary,
                        filesChanged: args.files_changed,
                        nextSteps: args.next_steps,
                    });

                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: true,
                                    message: 'Task completed successfully',
                                }),
                            },
                        ],
                    };
                }
            ),
            tool(
                'worker_request_review',
                'Request human review before proceeding. Use this when you are unsure about something or need approval before making changes.',
                {
                    reason: z
                        .string()
                        .describe('Why you need review - be specific about what you want reviewed'),
                },
                async (args) => {
                    await config.onRequestReview(args.reason);

                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: true,
                                    message: 'Review requested. Waiting for human input.',
                                }),
                            },
                        ],
                    };
                }
            ),
        ],
    });
}

export type WorkerToolsMcpServer = ReturnType<typeof createWorkerToolsMcpServer>;
```

### 3. Worker Session Repository

**File:** `packages/daemon/src/storage/repositories/worker-session-repository.ts`

```typescript
/**
 * Worker Session Repository
 *
 * Repository for worker session tracking CRUD operations.
 * Manages the relationship between workers and tasks within rooms.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { WorkerSession, WorkerStatus } from '@neokai/shared';

export interface CreateWorkerSessionData {
    id: string;
    roomId: string;
    roomSessionId: string;      // FIX 2: Mode-agnostic (was roomSelfSessionId)
    sessionId: string;          // FIX 3: Added actual agent session ID
    roomSessionType: 'room_chat' | 'room_self';  // FIX 2: Discriminator
    taskId: string;
    status: WorkerStatus;
    createdAt: number;
    updatedAt: number;
}

export class WorkerSessionRepository {
    constructor(private db: BunDatabase) {}

    /**
     * Create a new worker session tracking record
     */
    createWorkerSession(data: CreateWorkerSessionData): WorkerSession {
        const stmt = this.db.prepare(`
            INSERT INTO worker_sessions (id, session_id, room_id, room_session_id, room_session_type, task_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            data.id,
            data.sessionId,       // FIX 3
            data.roomId,
            data.roomSessionId,   // FIX 2
            data.roomSessionType,  // FIX 2
            data.taskId,
            data.status,
            data.createdAt,
            data.updatedAt
        );
        return this.getWorkerSession(data.id)!;
    }

    /**
     * Get a worker session by tracking ID
     */
    getWorkerSession(id: string): WorkerSession | null {
        const stmt = this.db.prepare(`SELECT * FROM worker_sessions WHERE id = ?`);
        const row = stmt.get(id) as Record<string, unknown> | undefined;
        return row ? this.rowToWorker(row) : null;
    }

    /**
     * Get a worker session by agent session ID - FIX 3: Fully implemented
     */
    getWorkerBySessionId(sessionId: string): WorkerSession | null {
        const stmt = this.db.prepare(`SELECT * FROM worker_sessions WHERE session_id = ?`);
        const row = stmt.get(sessionId) as Record<string, unknown> | undefined;
        return row ? this.rowToWorker(row) : null;
    }
        return null;
    }

    /**
     * Get a worker session by task ID
     */
    getWorkerByTask(taskId: string): WorkerSession | null {
        const stmt = this.db.prepare(`SELECT * FROM worker_sessions WHERE task_id = ?`);
        const row = stmt.get(taskId) as Record<string, unknown> | undefined;
        return row ? this.rowToWorker(row) : null;
    }

    /**
     * Get all worker sessions for a room
     */
    getWorkersByRoom(roomId: string): WorkerSession[] {
        const stmt = this.db.prepare(
            `SELECT * FROM worker_sessions WHERE room_id = ? ORDER BY created_at DESC`
        );
        const rows = stmt.all(roomId) as Record<string, unknown>[];
        return rows.map((row) => this.rowToWorker(row));
    }

    /**
     * Get all worker sessions for a specific room agent session - FIX 2
     */
    getWorkersByRoomSession(roomSessionId: string): WorkerSession[] {
        const stmt = this.db.prepare(
            `SELECT * FROM worker_sessions WHERE room_session_id = ? ORDER BY created_at DESC`
        );
        const rows = stmt.all(roomSessionId) as Record<string, unknown>[];
        return rows.map((row) => this.rowToWorker(row));
    }

    /**
     * Update worker status by session ID - FIX 3
     */
    updateWorkerStatusBySessionId(sessionId: string, status: WorkerStatus): WorkerSession | null {
        const now = Date.now();
        const stmt = this.db.prepare(
            `UPDATE worker_sessions SET status = ?, updated_at = ? WHERE session_id = ?`
        );
        const result = stmt.run(status, now, sessionId);
        if (result.changes === 0) return null;
        return this.getWorkerBySessionId(sessionId);
    }

    /**
     * Complete worker session by session ID - FIX 3
     */
    completeWorkerSessionBySessionId(sessionId: string): WorkerSession | null {
        const now = Date.now();
        const stmt = this.db.prepare(
            `UPDATE worker_sessions SET status = 'completed', updated_at = ?, completed_at = ? WHERE session_id = ?`
        );
        const result = stmt.run(now, now, sessionId);
        if (result.changes === 0) return null;
        return this.getWorkerBySessionId(sessionId);
    }

    /**
     * Update the status of a worker session
     */
    updateWorkerStatus(id: string, status: WorkerStatus): WorkerSession | null {
        const now = Date.now();
        const stmt = this.db.prepare(
            `UPDATE worker_sessions SET status = ?, updated_at = ? WHERE id = ?`
        );
        const result = stmt.run(status, now, id);
        if (result.changes === 0) return null;
        return this.getWorkerSession(id);
    }

    /**
     * Complete a worker session
     */
    completeWorkerSession(id: string): WorkerSession | null {
        const now = Date.now();
        const stmt = this.db.prepare(
            `UPDATE worker_sessions SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?`
        );
        const result = stmt.run(now, now, id);
        if (result.changes === 0) return null;
        return this.getWorkerSession(id);
    }

    /**
     * Delete a worker session tracking record
     */
    deleteWorkerSession(id: string): boolean {
        const stmt = this.db.prepare(`DELETE FROM worker_sessions WHERE id = ?`);
        return stmt.run(id).changes > 0;
    }

    /**
     * Convert a database row to a WorkerSession object - FIX 2 & 3 applied
     */
    private rowToWorker(row: Record<string, unknown>): WorkerSession {
        return {
            id: row.id as string,
            roomId: row.room_id as string,
            roomSessionId: row.room_session_id as string,      // FIX 2
            sessionId: row.session_id as string,             // FIX 3
            roomSessionType: row.room_session_type as 'room_chat' | 'room_self',  // FIX 2
            taskId: row.task_id as string,
            status: row.status as WorkerStatus,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
            completedAt: row.completed_at as number | undefined,
        };
    }
}
```

---

## Event Flow Changes

### Before: Manager-Worker Flow

```
1. Room Self creates Manager-Worker pair
   ├─ Creates Manager session
   ├─ Creates Worker session
   └─ Links with pairedSessionId

2. Manager and Worker sessions start
   ├─ Manager receives coordination prompt
   └─ Worker receives task prompt

3. Worker executes task
   ├─ Uses file editing tools
   ├─ Runs bash commands
   └─ Makes changes

4. Worker reaches terminal state (idle/waiting_for_input)

5. SessionBridge detects terminal state
   ├─ Monitors both sessions
   └─ Detects state change

6. SessionBridge forwards Worker messages to Manager
   ├─ Collects assistant messages
   └─ Creates synthetic user message

7. Manager reviews and calls manager_complete_task()
   ├─ Reviews worker output
   └─ Calls completion tool

8. Manager tools emit pair.task_completed event
   └─ Room Self handles event

9. Room Self updates task and goals
```

### After: Direct Worker Flow

```
1. Room Self spawns Worker
   └─ Creates Worker session with worker-tools MCP

2. Worker session starts
   └─ Receives task prompt

3. Worker executes task
   ├─ Uses file editing tools
   ├─ Runs bash commands
   └─ Makes changes

4. Worker calls worker_complete_task()
   └─ Signals completion directly

5. Worker tools emit worker.task_completed event
   └─ Room Self handles event directly

6. Room Self updates task and goals
```

### Event Mapping

| Old Event | New Event | Source |
|-----------|-----------|--------|
| `pair.task_completed` | `worker.task_completed` | Worker tools |
| N/A | `worker.review_requested` | Worker tools |
| `bridge.workerTerminal` | N/A | No longer needed |
| `bridge.managerTerminal` | N/A | No longer needed |
| `bridge.messagesForwarded` | N/A | No longer needed |

---

## Migration Plan

### Phase 1: Add New Components (Non-Breaking)

**Goal**: Add new functionality without affecting existing code.

**Tasks**:
1. Create `WorkerManager` class
2. Create `worker-tools.ts` MCP server
3. Create `WorkerSessionRepository`
4. Add shared types (`WorkerStatus`, `WorkerSession`, `CreateWorkerParams`)
5. Add database migration for `worker_sessions` table
6. Add new event types to `DaemonHub`

**Validation**:
- All new files compile
- Migration runs successfully
- No existing tests fail

### Phase 2: Update Room Self (Non-Breaking)

**Goal**: Prepare RoomSelfService to use new components.

**Tasks**:
1. Add `WorkerManager` to `RoomSelfContext`
2. Add new event handlers (`worker.task_completed`, `worker.review_requested`)
3. Add feature flag for using new flow
4. Keep existing `SessionPairManager` code path working

**Validation**:
- Room Self still works with old flow
- Feature flag can be toggled
- Both code paths coexist

### Phase 3: Gradual Migration

**Goal**: Test new flow with real workloads.

**Tasks**:
1. Enable feature flag for test rooms
2. Monitor worker lifecycle
3. Compare task completion rates
4. Gather metrics on:
   - Task completion time
   - Error rates
   - API costs
5. Iterate on any issues found

**Validation**:
- New flow completes tasks successfully
- Metrics show improvement or parity
- No critical issues found

### Phase 4: Full Rollout

**Goal**: Migrate all rooms to new flow.

**Tasks**:
1. Enable feature flag for all rooms
2. Monitor for issues
3. Fix any edge cases

**Validation**:
- All rooms using new flow
- No increase in error rates
- Performance metrics acceptable

### Phase 5: Remove Old Code

**Goal**: Clean up deprecated code.

**Tasks**:
1. Remove `SessionPairManager`
2. Remove `SessionBridge`
3. Remove `manager-tools.ts`
4. Remove `SessionPairRepository`
5. Remove `SessionPair` types from shared
6. Remove `'manager'` from `SessionType`
7. Deprecate `session_pairs` table (can drop after backup period)

**Validation**:
- All references removed
- No dead imports
- Clean compile

### Phase 6: Database Cleanup

**Goal**: Remove deprecated tables.

**Tasks**:
1. Verify all data migrated
2. Create backup of `session_pairs` table
3. Drop `session_pairs` table
4. Drop indexes on `session_pairs`

**Validation**:
- Database queries no longer reference old table
- Storage freed up

---

## Benefits Summary

| Aspect | Before (Manager-Worker) | After (Worker Only) | Improvement |
|--------|------------------------|---------------------|-------------|
| **Architecture Layers** | 3 (Room Self → Manager → Worker) | 2 (Room Self → Worker) | -33% complexity |
| **Sessions per Task** | 2 | 1 | -50% sessions |
| **LLM Calls per Task** | ~2 (Manager + Worker) | ~1 (Worker) | -50% API cost |
| **Message Passing** | Via SessionBridge | Direct events | Simpler flow |
| **State Complexity** | Pair state + session state | Worker state only | Easier to debug |
| **Database Tables** | session_pairs | worker_sessions | Simpler schema |
| **Lines of Code** | ~1,060 (pairs, bridge, manager-tools) | ~450 (worker manager, tools) | -58% code |
| **Conceptual Complexity** | High (synthetic messages, bridging) | Low (direct events) | Easier to understand |

### Additional Benefits

1. **Faster Task Completion**: Eliminates manager pass-through layer
2. **Lower API Costs**: Fewer LLM calls per task
3. **Simpler Debugging**: Fewer moving parts to troubleshoot
4. **Easier Testing**: Direct worker-to-room communication
5. **Better Observability**: Clear event flow without bridging
6. **Reduced Latency**: No message forwarding overhead

### Potential Risks

1. **Loss of Multi-Worker Coordination**: If needed later, would require re-adding manager layer
2. **Migration Complexity**: Need to carefully handle existing sessions
3. **Room Self Complexity**: Room Self now handles both orchestration and review

### Mitigation

1. Keep database migration reversible
2. Feature flag allows quick rollback
3. Monitor metrics closely during rollout
4. Keep old code in VCS history for reference if needed

---

## Appendix

### Manager Tools (Current)

The current `manager-tools` MCP server provides only one tool:

- `manager_complete_task(task_id, summary, files_changed, next_steps)`
- `manager_fetch_context(message_limit)` - rarely used

### Worker Tools (Proposed)

The new `worker-tools` MCP server provides:

- `worker_complete_task(task_id, summary, files_changed, next_steps)`
- `worker_request_review(reason)` - NEW: Workers can ask for human input

### Session Types

**Before:**
```typescript
export type SessionType = 'worker' | 'manager' | 'room_chat' | 'room_self' | 'lobby';
```

**After:**
```typescript
export type SessionType = 'worker' | 'room_chat' | 'room_self' | 'lobby';
```

### Related Documents

- [Room Autonomy Manager Removal Plan](./room-autonomy-manager-removal-plan.md) - Original plan with focus on unifying room agents
- [Room Architecture Overview](./room-architecture.md)
- [Agent Orchestration](./agent-orchestration.md)
- [Database Schema](./database-schema.md)

---

## Design Comparison: My Plan vs Original Plan

| Aspect | My Plan (This Document) | Original Plan | Synthesis |
|--------|------------------------|---------------|-----------|
| **Scope** | Remove Manager, simplify to Room Self → Worker | Remove Manager, unify room:chat and room:self | Both agree on Manager removal |
| **room:chat** | Not addressed in detail | Should have same capabilities as room:self | **Key insight**: Both room agents should share orchestration |
| **Orchestration** | Room Self handles orchestration | Single shared orchestration layer for both modes | **Adopt**: Shared tools/prompts |
| **Triggers** | Event-driven for room:self | Unified trigger model (human vs autonomous) | **Adopt**: Trigger separation concept |
| **Implementation** | Direct WorkerManager | Phase 1: Unified orchestration core first | **Adopt**: Phased approach |
| **Worker Tools** | New worker-tools MCP server | Use existing room-agent-tools | **Adopt**: Room agents use room-agent-tools, Workers get worker-tools |
| **RPC Changes** | Not detailed | Replace room.createPair with worker-run APIs | **Add**: RPC migration details |

### Key Takeaways from the Original Plan

1. **Unification Opportunity**: The biggest opportunity isn't just removing Manager - it's unifying `room:chat` and `room:self` so they share the same orchestration capabilities.

2. **Single-Source Ownership**: Prompts and tools should have single sources:
   - `packages/shared/src/prompts/room-agent.ts`
   - `packages/daemon/src/lib/agent/room-agent-tools.ts`

3. **Mode as Context**: The difference between `room:chat` and `room:self` should be a lightweight runtime context parameter, not separate prompt/tool stacks.

4. **Phased Rollout**: The original plan's 5-phase approach is more comprehensive:
   - Phase 1: Unified orchestration core
   - Phase 2: Worker-only orchestration path
   - Phase 3: Remove manager runtime and bridge
   - Phase 4: Align room:chat with room:self
   - Phase 5: Cleanup + migrations + docs

### Revised Approach

Based on the original plan, I recommend:

1. **Expand scope** to include `room:chat` agent alignment
2. **Adopt phased approach** from original plan
3. **Add RPC migration details** (room.createPair → worker-run APIs)
4. **Emphasize shared orchestration** as a key design principle

The technical implementation I've designed (WorkerManager, worker-tools, etc.) remains valid, but should be positioned within the broader unification effort.

---

**Document Version:** 1.1
**Last Updated:** 2025-02-22
**Author:** Claude (NeoKai Design)
**Status:** Proposal - Awaiting Review
**Changes in v1.1**: Added insights from room-autonomy-manager-removal-plan.md
