# Milestone 1 — Backend Plumbing: Wire `notifyChange` into Table Writers

**Agent:** coder
**Depends on:** nothing

## Overview

Four tables are written via raw `BunDatabase` and never trigger `ReactiveDatabase` events. Any
LiveQuery subscription on these tables silently never fires until `notifyChange` is called. This
milestone injects `ReactiveDatabase` into all four writer classes and calls `notifyChange` after
every durable write.

## Design Constraints

- **Required injection:** `ReactiveDatabase` must be **required** (not optional) in all four classes.
  Do not use an optional no-op fallback — a missed injection silently suppresses all LiveQuery events.
- **Post-commit only:** `notifyChange` must be called **only after a write has been durably committed**.
- **One canonical layer per table:** Prevent double-fire by calling `notifyChange` at exactly one layer:
  - `tasks` → `TaskManager` (not `TaskRepository`)
  - `goals` → `GoalRepository` (not `GoalManager`)
  - `session_groups` / `session_group_messages` → `SessionGroupRepository`
- **Transaction safety:** Every `beginTransaction()` must be paired with `try/catch` + `abortTransaction()`:
  ```ts
  reactiveDb.beginTransaction();
  try {
    // ... all writes ...
  } catch (e) {
    reactiveDb.abortTransaction();
    throw e;
  }
  reactiveDb.commitTransaction();
  ```

---

## Task 1.1 — Thread `reactiveDb` through dependency interfaces

**Agent:** coder

Add `ReactiveDatabase` to the dependency plumbing so all downstream classes can receive it.

- [ ] Add `reactiveDb: ReactiveDatabase` to `RPCHandlerDependencies` interface
  (in `packages/daemon/src/lib/rpc-handlers/index.ts`)
- [ ] Add `reactiveDb: ReactiveDatabase` to `RoomRuntimeServiceConfig` interface
  (in `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`)
- [ ] Update `packages/daemon/src/app.ts` to pass `reactiveDb` in the `setupRPCHandlers` call
  (`reactiveDb` is already available on `DaemonAppContext`)
- [ ] Inside `setupRPCHandlers`, pass `deps.reactiveDb` to the `new RoomRuntimeService({...})` constructor
  (`RoomRuntimeService` is constructed inside `setupRPCHandlers`, not in `app.ts`)
- [ ] All existing tests still pass after plumbing changes

**Acceptance criteria:**
- `reactiveDb` flows from `app.ts` → `setupRPCHandlers` → `RoomRuntimeService` without errors
- No functional change yet — just plumbing

---

## Task 1.2 — Add `notifyChange` to `TaskManager`

**Agent:** coder

- [ ] Inject `ReactiveDatabase` as a required constructor parameter in `TaskManager`
- [ ] Call `reactiveDb.notifyChange('tasks')` after every write method:
  - After `updateDraftTask` raw `db.prepare` call (where `assigned_agent` is set via raw statement)
  - After `promoteDraftTasks()` (delegates to `TaskRepository.promoteDraftTasksByCreator`)
  - After `removeDraftTask()` (delegates to `TaskRepository.deleteTask`)
  - After any other write methods that modify the `tasks` table
- [ ] Update all `TaskManager` construction sites to pass `reactiveDb`
  (search for `new TaskManager` across the codebase)
- [ ] Update test construction sites
- [ ] Unit test: `LiveQueryEngine` subscription on `tasks` fires after writes through `TaskManager`

**Acceptance criteria:**
- LiveQuery subscriptions on `tasks` fire after every `TaskManager` write
- `notifyChange` called only after durable commit, never before

---

## Task 1.3 — Add `notifyChange` to `SessionGroupRepository`

**Agent:** coder

- [ ] Inject `ReactiveDatabase` as a required constructor parameter in `SessionGroupRepository`
- [ ] Wrap multi-step writes (e.g., `createGroup` which writes to both `session_groups` and
  `session_group_members`) in `beginTransaction()`/`commitTransaction()` with `try/catch` +
  `abortTransaction()` error handling
- [ ] Call `reactiveDb.notifyChange('session_groups')` after writes to `session_groups` rows
- [ ] Call `reactiveDb.notifyChange('session_group_messages')` after `appendMessage()` and any
  other `session_group_messages` writes
- [ ] Update all `SessionGroupRepository` construction sites to pass `reactiveDb`
- [ ] Update test construction sites
- [ ] Unit test: `LiveQueryEngine` subscription on `session_groups` fires after writes
- [ ] Unit test: `LiveQueryEngine` subscription on `session_group_messages` fires after `appendMessage()`
- [ ] Unit test: `abortTransaction()` is called on error; `transactionDepth` doesn't get stuck

**Acceptance criteria:**
- LiveQuery subscriptions on both tables fire after respective writes
- Multi-step writes are transactional with proper error handling
- `transactionDepth` never gets stuck above zero after an error

---

## Task 1.4 — Add `notifyChange` to `GoalRepository` and wire through `GoalManager`

**Agent:** coder

- [ ] Inject `ReactiveDatabase` as a required constructor parameter in `GoalRepository`
- [ ] Call `reactiveDb.notifyChange('goals')` after every write in `GoalRepository`:
  create, update, delete, link, unlink
- [ ] Inject `ReactiveDatabase` into `GoalManager` constructor; pass it to `GoalRepository`
  (`GoalManager` internally creates a `GoalRepository` in its constructor)
- [ ] Do **not** call `notifyChange` in `GoalManager` itself (repository is the canonical layer)
- [ ] Update all `GoalManager` construction sites to pass `reactiveDb`:
  - `packages/daemon/src/lib/rpc-handlers/index.ts`
  - `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`
  - `packages/daemon/src/storage/index.ts` (direct `GoalRepository` construction; also needs updating)
  - All test construction sites
- [ ] Unit test: `LiveQueryEngine` subscription on `goals` fires after writes through `GoalRepository`

**Acceptance criteria:**
- LiveQuery subscriptions on `goals` fire after every `GoalRepository` write
- `GoalManager` passes `reactiveDb` through but does not call `notifyChange` itself
- All existing tests still pass
