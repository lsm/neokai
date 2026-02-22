# Room Autonomous Features - Future Work

This document tracks remaining improvements and technical debt identified during the room-auto refactor deep dive (February 2026).

## High Priority

### 1. Worker Timeout/Crash Detection

**Status**: Not implemented
**Location**: `packages/daemon/src/lib/room/worker-manager.ts`

Currently, workers are spawned and tracked but there's no:
- Heartbeat mechanism
- Timeout detection
- Crash recovery
- Stuck worker cleanup

**Scenario**: A worker starts with status='starting', the SDK crashes, and the task remains in 'in_progress' forever.

**Recommendation**: Implement a heartbeat mechanism with configurable timeout. Workers should ping periodically, and if no heartbeat is received within the timeout window, mark the worker as failed.

```typescript
// Example implementation
interface WorkerHeartbeatConfig {
  intervalMs: 30000;      // Heartbeat every 30 seconds
  timeoutMs: 120000;      // Consider failed after 2 minutes of silence
  maxMissedHeartbeats: 4; // Allow 4 missed heartbeats before marking failed
}
```

### 2. Stuck Worker Wake-up

**Status**: TODO acknowledged
**Location**: `packages/daemon/src/lib/room/room-self-service.ts:1236`

```typescript
const existingWorker = this.ctx.workerManager.getWorkerByTask(params.taskId);
if (existingWorker) {
    log.info(`Task ${params.taskId} already has a worker, reusing it`);
    // TODO: Wake up stuck worker session
    return { workerSessionId: existingWorker.sessionId };
}
```

**Recommendation**: Implement a mechanism to "wake up" a stuck worker by:
1. Checking if the worker session is still processing
2. If stuck (no activity for N minutes), either restart or prompt the worker
3. Consider interrupting and respawning if truly stuck

## Medium Priority

### 3. Shared WorkerEventHandler

**Status**: Not implemented (was specified in design)
**Location**: `docs/design/manager-removal-critical-fixes.md:598-723`

The design specified a `WorkerEventHandler` shared service to be used by both `RoomSelfService` and `RoomChatService`. This was never created - each service handles worker events inline.

**Impact**: Code duplication, inconsistent handling.

**Recommendation**: Extract worker event handling into a shared class:

```typescript
class WorkerEventHandler {
  constructor(
    private daemonHub: DaemonHub,
    private workerManager: WorkerManager,
    private taskManager: TaskManager
  ) {}

  subscribeToWorkerEvents(roomId: string, handlers: WorkerEventHandlers): Unsubscribe[] {
    // Centralized subscription logic
  }
}
```

### 4. RoomChatService Implementation

**Status**: Missing
**Location**: Should be `packages/daemon/src/lib/room/room-chat-service.ts`

Phase 5 was supposed to unify room:chat and room:self orchestration. While both can use `WorkerManager`, there's no `RoomChatService` class analogous to `RoomSelfService`. The room:chat mode may not have proper worker event handling.

**Recommendation**: Create `RoomChatService` or ensure room:chat properly delegates to shared worker handling code.

### 5. Feature Flag Persistence

**Status**: In-memory only
**Location**: `packages/daemon/src/lib/config/feature-flags.ts:75`

```typescript
constructor(_db?: Database) {
    this.initializeFlags();
    // TODO: Load persisted flag values from database if provided
}
```

**Impact**: Feature flag changes are lost on daemon restart.

**Recommendation**: Add database persistence for feature flags, including:
- Flag value storage
- Room whitelist/blacklist persistence
- Rollout percentage settings

## Low Priority

### 6. Orphaned Data Cleanup

**Status**: Never cleaned
**Location**: `packages/daemon/src/storage/schema/migrations.ts:1512`

```typescript
// Note: We keep worker_sessions_orphaned for audit purposes
```

The `worker_sessions_orphaned` table is kept forever with no cleanup mechanism. Over time this could grow unbounded.

**Recommendation**: Implement a retention policy:
- Keep orphaned records for 30 days
- Add a cleanup job that runs on daemon startup or periodically
- Provide a CLI command to manually purge old orphaned records

### 7. Hardcoded Model in RoomSelfService

**Status**: Hardcoded
**Location**: `packages/daemon/src/lib/room/room-self-service.ts:149`

```typescript
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
```

**Recommendation**: Make this configurable via:
- Room-specific model setting
- Global settings default
- Per-task model override capability

## Testing Gaps

### 8. Integration Tests for Worker Lifecycle

**Status**: Missing
**Location**: `packages/daemon/tests/`

There don't appear to be comprehensive integration tests for:
- Worker lifecycle (spawn → execute → complete)
- Worker failure scenarios
- Room agent state transitions during worker execution
- Concurrent worker limits

**Recommendation**: Add integration tests covering:
- [ ] Happy path: spawn worker, complete task
- [ ] Worker failure: SDK crashes during execution
- [ ] Worker timeout: worker stops responding
- [ ] Concurrent limits: respect maxConcurrentWorkers
- [ ] State transitions: verify room agent state changes correctly

---

## Completed Items

These items were addressed during the February 2026 deep dive:

- [x] Fix column name mismatch in RoomSelfStateRepository (`active_session_pair_ids` → `active_worker_session_ids`)
- [x] Add warning logging to Migration 29 when skipping due to active pairs
- [x] Implement worker failure event emission (`worker.failed` event)
- [x] Remove deprecated `pairId` from room_spawn_worker response
- [x] Remove deprecated bridge/pair events from DaemonHub
- [x] Update outdated comments referencing manager-worker architecture
