# Milestone 2 — Repository Layer

## Goal

Integrate short ID assignment into the `TaskRepository` and `GoalRepository` create paths, and add `getByShortId` lookup methods. Old records without short IDs get one on first read (lazy backfill).

## Context

- `packages/daemon/src/storage/repositories/task-repository.ts` — `createTask()` generates UUID via `generateUUID()`, writes to `tasks` table. `getTask(id)` and `listTasks(roomId)` are the main read paths.
- `packages/daemon/src/storage/repositories/goal-repository.ts` — same pattern for goals.
- `ShortIdAllocator` from Milestone 1 will be injected into both repositories.
- The `rowToTask()` and `rowToGoal()` methods map DB rows to typed objects — they must include `shortId` in their output.
- The `NeoTask` and `RoomGoal` shared types must gain an optional `shortId?: string` field.

## Tasks

---

### Task 2.1 — Add shortId Field to Shared Types

**Description**: Add `shortId?: string` to `NeoTask` and `RoomGoal` in `packages/shared/src/types/neo.ts`. This is a non-breaking optional field.

**Subtasks**:
1. In `packages/shared/src/types/neo.ts`, add `/** Human-readable short ID (e.g. 't-42'), scoped to parent room */ shortId?: string;` to the `NeoTask` interface (after the `id` field)
2. Add the same `shortId?: string` field to the `RoomGoal` interface
3. Run `bun run typecheck` to confirm no type errors from the addition
4. Run `bun run lint` to confirm no lint violations

**Acceptance Criteria**:
- `NeoTask.shortId` is an optional string field
- `RoomGoal.shortId` is an optional string field
- `bun run typecheck` passes
- `bun run lint` passes

**Depends on**: Milestone 1 complete

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 2.2 — Short ID Assignment in TaskRepository

**Description**: Modify `TaskRepository` to inject `ShortIdAllocator`, assign a short ID on task creation, include `short_id` in row-to-object mapping, and add `getTaskByShortId(roomId, shortId)` lookup.

**Subtasks**:
1. Update `TaskRepository` constructor to accept `ShortIdAllocator` as an optional third parameter (`private shortIdAllocator?: ShortIdAllocator`)
2. In `createTask()`, after generating the UUID, call `this.shortIdAllocator?.allocate('task', params.roomId)` and store the result; include `short_id` in the `INSERT` statement
3. Update `rowToTask()` to include `shortId: (row.short_id as string | null) ?? undefined`
4. Add `getTaskByShortId(roomId: string, shortId: string): NeoTask | null` — queries `SELECT * FROM tasks WHERE room_id = ? AND short_id = ?`
5. Add lazy backfill in `getTask(id)`: if the returned task has no `shortId` and allocator is present, allocate one, update the row, and return the updated object
6. Add lazy backfill in `listTasks(roomId)`: after fetching all rows for the room, for any row where `short_id` is null, call `allocate('task', roomId)`, issue an `UPDATE tasks SET short_id = ? WHERE id = ?`, and return the updated object. This is bounded and safe — rooms have at most hundreds of tasks.
7. Write unit tests:
   - Creating a task with an allocator produces a non-null `shortId`
   - `getTaskByShortId` finds the task by its short ID
   - `getTaskByShortId` returns null for unknown short ID
   - Lazy backfill on `getTask` assigns a short ID to a record that was created without one
   - `listTasks` with a mix of tasks (some with `short_id`, some without) returns all tasks with `shortId` populated after the call

**Acceptance Criteria**:
- New tasks created with `ShortIdAllocator` present have a `shortId` like `t-1`, `t-2`, etc.
- `getTaskByShortId(roomId, 't-1')` returns the correct task
- Tasks created before migration (no `short_id`) get a short ID on first `getTask()` call
- `listTasks` returns all tasks with `shortId` populated (backfilled inline for legacy rows)
- All unit tests pass

**Depends on**: Task 2.1, Milestone 1 complete

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 2.3 — Short ID Assignment in GoalRepository

**Description**: Same pattern as Task 2.2, applied to `GoalRepository` for goals.

**Subtasks**:
1. Update `GoalRepository` constructor to accept `ShortIdAllocator` as an optional parameter
2. In `createGoal()`, allocate a short ID with `allocate('goal', params.roomId)` and include `short_id` in the INSERT
3. Update the row-to-object mapping method to include `shortId: (row.short_id as string | null) ?? undefined`
4. Add `getGoalByShortId(roomId: string, shortId: string): RoomGoal | null`
5. Add lazy backfill in `getGoal(id)` (same pattern as Task 2.2)
6. Add lazy backfill in `listGoals(roomId)` — same pattern as `listTasks` in Task 2.2: for any row without `short_id`, allocate one and update the DB inline
7. Wire `ShortIdAllocator` into `GoalRepository` instantiation in the database layer (`packages/daemon/src/storage/database.ts` or wherever repositories are instantiated)
8. Write unit tests covering the same cases as Task 2.2 for goals (uses `g-` prefix), including a `listGoals` backfill test

**Acceptance Criteria**:
- New goals have `shortId` like `g-1`, `g-2`, per room
- `getGoalByShortId(roomId, 'g-1')` returns the correct goal
- Unit tests pass

**Depends on**: Task 2.2

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 2.4 — Wire ShortIdAllocator into Database and Room Manager

**Description**: Ensure `ShortIdAllocator` is instantiated at the database level and injected into `TaskRepository`, `GoalRepository`, and **all** instantiation sites of `TaskManager` / `GoalManager` so all production code paths use it.

**Critical context**: `TaskManager` creates its own `TaskRepository` internally (`this.taskRepo = new TaskRepository(db, this.reactiveDb)` in `task-manager.ts`). `TaskManager` is instantiated in **four places**:
- `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` (line ~57)
- `packages/daemon/src/lib/rpc-handlers/index.ts` (line ~138)
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` (lines ~426 and ~658 — two separate instantiation points)

`GoalManager` is instantiated in:
- `packages/daemon/src/lib/rpc-handlers/index.ts` (line ~133)
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` (line ~427)

A coder who only looks at `app.ts` or `RoomManager` will miss `room-runtime-service.ts`, causing live room operations (started via the room runtime) to silently skip short ID assignment. **All six instantiation sites must be updated.**

**Subtasks**:
1. Instantiate `ShortIdAllocator` once from the db connection (e.g., in a shared factory or passed through the constructor chain), and pass it into `TaskManager` as a new constructor parameter
2. `TaskManager` should accept `shortIdAllocator?: ShortIdAllocator` and forward it to its internal `TaskRepository` constructor
3. Update **all four** `TaskManager` instantiation sites to pass the allocator:
   - `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`
   - `packages/daemon/src/lib/rpc-handlers/index.ts`
   - `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` (both instantiation points)
4. Update **both** `GoalManager` instantiation sites analogously:
   - `packages/daemon/src/lib/rpc-handlers/index.ts`
   - `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`
5. Run the full daemon unit test suite (`make test-daemon`) to confirm nothing is broken
6. Confirm no circular dependencies are introduced (the allocator is a pure DB utility with no app-layer imports)

**Acceptance Criteria**:
- In ALL production code paths (including live room runtime), `TaskRepository.createTask()` assigns a short ID
- In ALL production code paths, `GoalRepository.createGoal()` assigns a short ID
- All six instantiation sites are updated (verify by searching for `new TaskManager` and `new GoalManager` in the codebase)
- `make test-daemon` passes

**Depends on**: Task 2.3

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.
