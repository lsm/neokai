# Manager Agent Removal - Implementation Plan

**Version**: 1.0
**Date**: 2025-02-22
**Status**: Ready for Implementation
**Related Documents**:
- [Manager-less Architecture Design](./manager-less-architecture.md)
- [Room Autonomy Manager Removal Plan](./room-autonomy-manager-removal-plan.md)

---

## Executive Summary

This document provides the complete implementation plan for removing the Manager agent layer from NeoKai's room architecture. The removal will:

1. **Simplify architecture**: 3-tier (Room Self → Manager → Worker) → 2-tier (Room Agent → Worker)
2. **Reduce costs**: ~50% reduction in LLM calls per task
3. **Unify room agents**: `room:chat` and `room:self` share orchestration capabilities
4. **Remove complexity**: ~1,060 lines of code eliminated

**Estimated Effort**: 2-3 weeks across 5 phases
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
-- Will be deprecated after data migration

-- ADD: worker_sessions table (Migration 18)
CREATE TABLE worker_sessions (
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

CREATE INDEX idx_worker_sessions_room ON worker_sessions(room_id);
CREATE INDEX idx_worker_sessions_task ON worker_sessions(task_id);
CREATE INDEX idx_worker_sessions_status ON worker_sessions(status);
```

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
    getWorkerSession(id: string): WorkerSession | null
    getWorkerByTask(taskId: string): WorkerSession | null
    getWorkersByRoom(roomId: string): WorkerSession[]
    updateWorkerStatus(id: string, status: WorkerStatus): WorkerSession | null
    completeWorkerSession(id: string): WorkerSession | null
    deleteWorkerSession(id: string): boolean
}
```

**Validation**:
- [ ] All methods implemented
- [ ] Repository compiles
- [ ] SQLite queries are valid

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

**Add**:
```typescript
export type WorkerStatus = 'starting' | 'running' | 'waiting_for_review' | 'completed' | 'failed' | 'cancelled';

export interface WorkerSession {
    id: string;
    roomId: string;
    roomSelfSessionId: string;
    taskId: string;
    status: WorkerStatus;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface CreateWorkerParams {
    roomId: string;
    roomSelfSessionId: string;
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

##### 1.5 Database Migration

**File**: `packages/daemon/src/storage/schema/migrations.ts` (MODIFY)

**Add Migration 18**:
```typescript
function runMigration18(db: BunDatabase): void {
    // Create worker_sessions table
    // Migrate existing session_pairs data
    // Keep session_pairs for backward compatibility
}
```

**Validation**:
- [ ] Migration runs successfully
- [ ] Data migrates correctly
- [ ] Rollback script works

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

// Update constructor to accept WorkerManager
// Add to room-self-service.ts initialization
```

**Validation**:
- [ ] RoomSelfService compiles
- [ ] WorkerManager is accessible
- [ ] No runtime errors

##### 2.2 Add New Event Handlers

**File**: `packages/daemon/src/lib/room/room-self-service.ts` (MODIFY)

**Add handlers**:
```typescript
// In subscribeToEvents()
const unsubWorkerComplete = this.ctx.daemonHub.on(
    'worker.task_completed',
    async (event) => { /* handle completion */ }
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

##### 4.7 Update Room Agent Tools

**Files**:
- `packages/daemon/src/lib/agent/room-agent-tools.ts` (MODIFY)

**Update** `room_spawn_worker`:
```typescript
// Return workerSessionId only, not pairId
return { workerSessionId: result.workerSessionId };
```

**Validation**:
- [ ] Tool works correctly
- [ ] All callers updated

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

### Phase 6: Database Cleanup

**Goal**: Remove deprecated database artifacts.

**Duration**: 1-2 days

#### Tasks

##### 6.1 Create Migration to Drop Old Table

**File**: `packages/daemon/src/storage/schema/migrations.ts` (MODIFY)

**Add Migration 19**:
```typescript
function runMigration19(db: BunDatabase): void {
    // Backup session_pairs table
    // Drop session_pairs table
    // Drop indexes on session_pairs
}
```

**Validation**:
- [ ] Migration runs successfully
- [ ] Data is backed up first
- [ ] Rollback script exists

##### 6.2 Verify No References

**Search**:
- `session_pairs` in codebase
- `SessionPair` in codebase
- `manager` session type in codebase

**Validation**:
- [ ] No references remain
- [ ] Database queries work
- [ ] No performance regression

#### Phase 6 Exit Criteria

- [ ] `session_pairs` table dropped
- [ ] No references to old schema
- [ ] Database is clean
- [ ] Migration is reversible

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
