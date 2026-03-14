# Plan: Complete and Adopt Persistent Job Queue for Codebase

## Goal

The database-backed persistent job queue (`JobQueueRepository` + `JobQueueProcessor`) is fully implemented but not wired up or used by any daemon code. The goal is to adopt it across all background/async operations currently using in-memory patterns, replacing them with durable persistent jobs that survive daemon restarts.

## Current State

### Implemented (ready to use)
- `packages/daemon/src/storage/repositories/job-queue-repository.ts` — CRUD on `job_queue` SQLite table
- `packages/daemon/src/storage/job-queue-processor.ts` — background polling loop with handler registry, retry/backoff, stale reclaim
- Comprehensive unit tests in `packages/daemon/tests/unit/storage/`

### Full inventory of in-memory patterns and disposition

| Pattern | File | Disposition |
|---------|------|-------------|
| `pendingBackgroundTasks` Set (title generation + branch rename) | `session-manager.ts` | **Migrate** to `session.title_generation` queue |
| GitHub polling `setInterval` + in-memory etag/repo-list state | `polling-service.ts` | **Migrate** to `github.poll` queue; restore state from DB on startup |
| GitHub event pipeline (event-bus chain, no idempotency) | `github-service.ts`, `webhook-handler.ts` | **Migrate** to `github.event` queue |
| Room runtime `setInterval` heartbeat + `scheduleTick()` (`queueMicrotask`) | `room-runtime.ts` | **Migrate** to `room.tick` queue |
| WebSocket stale connection checker `setInterval` | `websocket-server-transport.ts` | **Intentionally ephemeral** — process-local connection management; no persistence value; keep as-is |
| `triggerBackgroundRefresh` fire-and-forget (model cache) | `model-service.ts` | **Intentionally ephemeral** — best-effort cache warming; keep as-is |
| Event-bus emissions with `.catch(() => {})` in room/message handlers | various `rpc-handlers/` | **Intentionally ephemeral** — in-process fanout; keep as-is |
| `JobQueueProcessor` not wired to `ReactiveDatabase` change notifier | `app.ts` | **Wire up** in Task 1 |

## Idempotency Key Design (cross-cutting, delivered in Task 1)

All queue handlers must be idempotent. Agreed per-queue strategy:

| Queue | Idempotency key | Strategy |
|-------|-----------------|----------|
| `session.title_generation` | `sessionId` | Handler queries DB; skip if `session.metadata.titleGenerated === true` (sessions are always created with a non-null placeholder title; `title !== null` is always true and must NOT be used as the guard) |
| `github.poll` | n/a (singleton, payload `{}`) | Dedup: skip enqueue if a `pending`/`processing` job already exists |
| `github.event` | `eventId` (stable deterministic ID — see Task 3) | INSERT-first: `INSERT OR IGNORE INTO github_processed_events` at job start; if row already existed (affected rows = 0), skip pipeline — DB-level dedup, concurrency-safe with `maxConcurrent: 3` |
| `room.tick` | `roomId` | Dedup: skip enqueue if a `pending`/`processing` job for this `roomId` exists |

## Processor Configuration (reconciled with ADR-0002)

```typescript
new JobQueueProcessor(db.getJobQueueRepo(), {
  pollIntervalMs: 1000,      // 1 second (ADR default)
  maxConcurrent: 3,          // 3 concurrent jobs (ADR default)
  staleThresholdMs: 300_000, // 5 minutes (ADR recommendation; room ticks may take >1s)
})
```

---

## Tasks

### Task 1: Wire Up JobQueueProcessor in DaemonApp (Foundation)

**Agent**: coder
**Dependencies**: none
**Priority**: high

**Description**:
Initialize and start the `JobQueueProcessor` in `packages/daemon/src/app.ts`. This is the foundational plumbing all subsequent tasks depend on.

**Important architectural notes**:

1. **`createDaemonApp` is a factory function, not a class.** There are no `start()`/`stop()` methods. The shutdown entry point is the `cleanup()` closure defined inside the factory (line ~321 of `app.ts`).

2. **`RoomRuntimeService` lives inside `setupRPCHandlers`, not `createDaemonApp` directly.** It is constructed at `packages/daemon/src/lib/rpc-handlers/index.ts` line 105. The plan accounts for this by passing `jobQueueProcessor` and `jobQueueRepo` as additional fields in the `deps` object passed to `setupRPCHandlers`. `setupRPCHandlers` passes them to the `RoomRuntimeService` constructor. No lifting of `RoomRuntimeService` into `createDaemonApp` is required.

3. **Startup ordering**: Handler registration (`start()` methods for `SessionManager`, `RoomRuntimeService`, `GitHubService`) must be called **before** `jobQueueProcessor.start()`, so all handlers are registered before the processor begins dequeuing jobs. `setupRPCHandlers` runs first (constructing `RoomRuntimeService`), then the subsystem `start()` methods register their handlers, then `jobQueueProcessor.start()` begins polling. Note: `roomRuntimeService.start()` is fire-and-forget (called with `.catch()` inside `setupRPCHandlers`) and the recovery pass may not be complete when the processor starts. The tick handler in Task 4 addresses this with a re-enqueue-on-miss strategy (see Task 4).

4. **Shutdown ordering**: In the `cleanup()` closure, add `await jobQueueProcessor.stop()` **before** both `rpcHandlerCleanup()` and `messageHub.cleanup()`. `app.ts` currently calls `messageHub.cleanup()` before `rpcHandlerCleanup()` (line ~369); in-flight job handlers that call `notifyChange()` (which routes through `ReactiveDatabase` → `messageHub`) must complete before `messageHub` is torn down. The corrected cleanup sequence is:
   ```typescript
   await jobQueueProcessor.stop(); // drain all in-flight job handlers first
   messageHub.cleanup();           // safe: no in-flight jobs remain
   rpcHandlerCleanup();            // stops RoomRuntimeService (clears runtimes map)
   await sessionManager.cleanup();
   ```

**API extensions required** (implement alongside wiring):

a. Extend `JobQueueRepository.listJobs()` to accept `status?: JobStatus | JobStatus[]`. When an array is passed, generate `AND status IN (?,?)` SQL. This is needed for the room tick dedup query in Task 4.

b. `JobQueueProcessor` has no `getRepo()` accessor. Rather than adding one, inject the repository separately: each subsystem receives both `jobQueueProcessor` (for `register()`) and `jobQueueRepo` (for `enqueue()` and `listJobs()`). Both are available from the `db` facade via `db.getJobQueueRepo()`.

**Steps**:
1. Obtain `jobQueueRepo = db.getJobQueueRepo()` and instantiate:
   ```typescript
   const jobQueueRepo = db.getJobQueueRepo();
   const jobQueueProcessor = new JobQueueProcessor(jobQueueRepo, {
     pollIntervalMs: 1000,
     maxConcurrent: 3,
     staleThresholdMs: 300_000,
   });
   ```
2. Connect change notifier to `ReactiveDatabase`:
   ```typescript
   jobQueueProcessor.setChangeNotifier((table) => reactiveDb.notifyChange(table));
   ```
3. Add `jobQueueProcessor` and `jobQueueRepo` to the `deps` object passed to `setupRPCHandlers`.
4. Call subsystem `start()` methods (`sessionManager.start()`, `roomRuntimeService.start()`, `githubService.start()`) **before** `jobQueueProcessor.start()` — this ensures all handlers are registered before the processor begins dequeuing.
5. Call `jobQueueProcessor.start()` after all subsystem `start()` calls.
6. Add `await jobQueueProcessor.stop()` to the `cleanup()` closure **before both** `messageHub.cleanup()` and `rpcHandlerCleanup()`:
   ```typescript
   // cleanup():
   await jobQueueProcessor.stop(); // drain in-flight jobs first (handlers may call notifyChange)
   messageHub.cleanup();           // safe: no in-flight jobs remain
   rpcHandlerCleanup();            // stops RoomRuntimeService (via rpc-handlers cleanup)
   await sessionManager.cleanup();
   ```
7. Define queue name constants in `packages/daemon/src/lib/job-queue-constants.ts` with the idempotency strategy documented in comments:
   ```typescript
   export const QUEUES = {
     SESSION_TITLE_GENERATION: 'session.title_generation',
     GITHUB_POLL: 'github.poll',
     GITHUB_EVENT: 'github.event',
     ROOM_TICK: 'room.tick',
     JOB_QUEUE_CLEANUP: 'job_queue.cleanup',
   } as const;
   ```
8. Each subsystem registers queue handlers in its own `start()` method. These `start()` calls happen before `jobQueueProcessor.start()` to guarantee handlers are registered before polling begins.

**Acceptance criteria**:
- `JobQueueProcessor` is instantiated; subsystem `start()` methods are called after `setupRPCHandlers` but **before** `jobQueueProcessor.start()` to guarantee all handlers are registered before polling begins.
- `await jobQueueProcessor.stop()` is in the `cleanup()` closure before both `messageHub.cleanup()` and `rpcHandlerCleanup()` — ensures in-flight job handlers that call `notifyChange()` complete before `messageHub` is torn down.
- Change notifier connected to `ReactiveDatabase`.
- `listJobs` extended to accept `status?: JobStatus | JobStatus[]`.
- `jobQueueProcessor` and `jobQueueRepo` injected into `setupRPCHandlers` via the `deps` object; `RPCHandlerDependencies` TypeScript interface updated to include both fields.
- Queue name constants exported from `job-queue-constants.ts`.
- Unit test verifies processor starts and stops correctly; confirms `stop()` is awaited before `rpcHandlerCleanup()`.
- All existing `JobQueueRepository` and `JobQueueProcessor` unit tests still pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Migrate Session Background Tasks to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the fire-and-forget title generation + git branch rename in `SessionManager` with a persistent job on the `session.title_generation` queue.

**Files to modify**:
- `packages/daemon/src/lib/session/session-manager.ts` — add a `start()` lifecycle method (does not currently exist); enqueue a `session.title_generation` job; remove `pendingBackgroundTasks` Set. `createDaemonApp` calls `sessionManager.start()` **before** `jobQueueProcessor.start()` (see Task 1 step 4: all subsystem `start()` methods registered before processor begins polling).
- `packages/daemon/src/lib/session/session-lifecycle.ts` — wrap the existing `generateTitleAndRenameBranch` method (no extraction needed; already a method on `SessionLifecycle`) in the job handler

**Behavioral change**: Currently the `message.persisted` event handler does `await titleGenTask` (line 162 of `session-manager.ts`), blocking until title generation completes. After this migration the handler enqueues a job synchronously and returns immediately. This is the intended change — the handler must NOT await title generation; the job queue provides durability instead.

**Handler registration** via constructor injection (`SessionManager` receives `jobQueueProcessor` and `jobQueueRepo`):
```typescript
// New method added to SessionManager:
start(): void {
  this.jobQueueProcessor.register(QUEUES.SESSION_TITLE_GENERATION, async (job) => {
    const { sessionId, userMessageText } = job.payload as { sessionId: string; userMessageText: string };
    // Idempotency: skip if title was already generated.
    // IMPORTANT: Do NOT use session.title !== null — sessions are always created with a
    // placeholder title ('New Session'), so that check is ALWAYS true and would silently
    // skip every job. The correct flag is session.metadata.titleGenerated (set to true
    // by generateTitleAndRenameBranch / generateTitleOnly on completion).
    // NOTE: this.sessionRepo.getSession() is illustrative pseudocode. SessionManager
    // does not have a sessionRepo field with a getSession() method. The implementor
    // must use the actual SessionManager API to fetch session data (e.g., the session
    // store, cache lookup, or whichever method SessionManager exposes for reading a
    // session by ID). The key requirement is reading session.metadata.titleGenerated.
    const session = /* actual SessionManager session fetch by sessionId */ ...;
    if (!session || session.metadata.titleGenerated) return;
    if (this.sessionCache.has(sessionId)) {
      // Session in cache: full path (title generation + branch rename)
      await this.sessionLifecycle.generateTitleAndRenameBranch(sessionId, ...);
    } else {
      // Cache miss after restart: title-only fallback (no branch rename)
      // userMessageText comes from the job payload — it is the original user message
      // text captured at enqueue time and is the only source available after restart.
      await this.sessionLifecycle.generateTitleOnly(sessionId, userMessageText);
    }
  });
}
```

**Cache miss handling**: `generateTitleAndRenameBranch` requires the session in the in-memory cache. After a daemon restart the session may not be cached. The handler checks the cache:
- **Cache hit**: calls the full `generateTitleAndRenameBranch` (title + branch rename)
- **Cache miss**: calls a new `generateTitleOnly` helper on `SessionLifecycle` that sets the title from `userMessageText` without the branch rename. This is safe to retry and does not require the cache.

**`titleGenerated` flag semantics**: Both `generateTitleAndRenameBranch` and `generateTitleOnly` must set `session.metadata.titleGenerated = true` **only on successful AI title generation** — not unconditionally. This is consistent with the existing `titleGenerated: !isFallback` pattern: if the AI generation fails and a fallback title is used, `titleGenerated` remains `false` so the job can be retried with a real AI title later. Do NOT check `session.title !== null` as the idempotency guard — that is always `true` since sessions are created with a placeholder title.

Job payload: `{ sessionId: string, userMessageText: string }`

**Enqueue point** (replaces the `pendingBackgroundTasks` pattern):
```typescript
jobQueueRepo.enqueue({
  queue: QUEUES.SESSION_TITLE_GENERATION,
  payload: { sessionId, userMessageText },
  maxRetries: 2,
});
// Return immediately — no await
```

**Idempotency**: Handler checks `session.metadata.titleGenerated`; if true, returns immediately. **Do not use `session.title !== null`** — every session is created with `title: 'New Session'` (a placeholder, not null), so that check would always be true and silently skip all title generation.

**Acceptance criteria**:
- `pendingBackgroundTasks` Set removed from `SessionManager`.
- `message.persisted` handler returns immediately after enqueue (no `await` on title generation).
- Title generation enqueues a persistent job; handler runs via `JobQueueProcessor`.
- Cache miss fallback: handler completes gracefully even if session is not in memory.
- If daemon restarts after enqueue but before handler runs, job is picked up on next start.
- Idempotency: handler called twice for same session produces correct result (no double-rename).
- Idempotency guard uses `session.metadata.titleGenerated` (not `session.title !== null`); verified by unit test that second handler invocation returns immediately when `titleGenerated` is true.
- `generateTitleOnly` is a new method on `SessionLifecycle` (does not yet exist in codebase); its creation is a required deliverable of this task alongside the handler integration.
- `userMessageText` is destructured from the job payload alongside `sessionId` and forwarded to both `generateTitleAndRenameBranch` (cache hit) and `generateTitleOnly` (cache miss). The `userMessageText` is the only source of the original message text available after a restart.
- Unit tests cover: enqueue on first message, idempotency (`titleGenerated = true` → skip), handler success sets `titleGenerated = true`, cache miss fallback (`generateTitleOnly` called with correct `userMessageText`), `generateTitleOnly` leaves `titleGenerated = false` on AI failure (fallback title used — allows retry), failure + retry (max 2 retries), dead-letter after max retries.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Migrate GitHub Event Processing to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the in-memory GitHub event pipeline with a persistent job queue so events are durable and idempotent across restarts. Persist polling state, restore repository registrations on startup, and assign stable event IDs to polled events.

**Schema additions** (new migration):

1. `github_processed_events` table (idempotency for `github.event` jobs):
   ```sql
   CREATE TABLE github_processed_events (
     event_id TEXT PRIMARY KEY,
     processed_at INTEGER NOT NULL
   );
   CREATE INDEX idx_github_processed_events_at ON github_processed_events(processed_at);
   ```

2. `github_poll_state` table (replaces in-memory etags/timestamps; the existing `global_settings` table is a single JSON blob and is not suitable for per-repo structured state). Note: `polling-service.ts` tracks two separate ETags per repo (`issuesEtag` and `commentsEtag` at lines 26–27), so the schema needs two separate columns:
   ```sql
   CREATE TABLE github_poll_state (
     repo_full_name TEXT PRIMARY KEY,
     issues_etag TEXT,
     comments_etag TEXT,
     last_poll_at INTEGER NOT NULL DEFAULT 0
   );
   ```

**Stable event IDs for polled events**: The current `generateEventId()` in `event-normalizer.ts` produces a UUID, which is non-stable across restarts — the same polled event gets a different ID on re-poll, making `github_processed_events` ineffective. Task 3 must update `normalizePollingEvent` (and the individual `normalizeIssuePolling`, `normalizeCommentPolling`, `normalizePullRequestPolling` functions) to generate deterministic IDs:
- Issues: `{fullName}/issues/{issueNumber}/{updatedAt}`
- Comments: `{fullName}/comments/{commentId}/{updatedAt}`
- Pull requests: `{fullName}/pulls/{prNumber}/{updatedAt}`

Webhook events have a stable `X-GitHub-Delivery` delivery ID available in `webhook-handler.ts` (line ~141), but **the current `normalizeWebhookEvent` in `event-normalizer.ts` calls `generateEventId()` which returns a random UUID — not the delivery ID**. The delivery ID is not forwarded to the normalizer. To fix this, the webhook handler must pass the `X-GitHub-Delivery` header value directly as the `eventId` field in the `github.event` job payload, bypassing the normalizer's `generateEventId()`:
```typescript
// webhook-handler.ts, when enqueueing the github.event job:
const deliveryId = req.header('X-GitHub-Delivery');
if (!deliveryId) {
  // Reject requests without a delivery ID — idempotency is impossible without it.
  // GitHub always sends X-GitHub-Delivery; absence indicates a non-GitHub or malformed request.
  return c.json({ error: 'Missing X-GitHub-Delivery header' }, 400);
}
jobQueueRepo.enqueue({
  queue: QUEUES.GITHUB_EVENT,
  payload: { eventType, eventId: deliveryId, payload: webhookPayload },
  maxRetries: 0,
});
```
The polling path already uses deterministic IDs as described above. `normalizeWebhookEvent` may still be called for in-process pipeline use, but its output `eventId` should NOT be used as the job's `eventId`. Rejecting missing-header requests (HTTP 400) rather than using a fallback UUID is required to maintain idempotency guarantees — a fallback UUID would make the INSERT-first dedup check meaningless for those events.

**Files to modify**:

1. `packages/daemon/src/lib/github/event-normalizer.ts`:
   - Replace UUID generation with deterministic stable IDs for polling normalizers

2. `packages/daemon/src/lib/github/polling-service.ts`:
   - Replace in-memory etag/timestamp state with reads/writes to `github_poll_state` table
   - **Injection**: `GitHubPollingService` currently receives only `PollingConfig` in its constructor. The migration adds `jobQueueProcessor`, `jobQueueRepo`, `githubPollStateRepo` (or equivalent DB accessor), and `githubMappingRepo` as constructor dependencies, injected by `GitHubService` (which already receives `jobQueueProcessor`/`jobQueueRepo` from Task 1 and the DB instance).
   - In `start()`, restore repo registrations by reading from `GitHubMappingRepository` (`room_github_mappings` table)
   - Replace `setInterval` with a self-rescheduling `github.poll` job (singleton dedup)
   - Re-scheduling uses a `finally` block with dedup to guarantee next poll is always enqueued but never doubled:
     ```typescript
     handler = async (job) => {
       try {
         await runPollCycle();
       } finally {
         // Schedule next poll only if no future-scheduled poll already exists.
         // Dedup prevents poll chain multiplication if two github.poll jobs are ever
         // simultaneously present (e.g., crash during startup before dedup check runs).
         // Without dedup, each job's finally would create another, doubling the chain.
         //
         // Accepted race: this is a check-then-enqueue sequence. Two workers could both
         // observe "no future job exists" and both enqueue, momentarily doubling the chain.
         // This is an accepted risk (same as the room tick dedup path): the duplicate is
         // idempotent (extra poll cycle causes no harm), true atomic dedup would require a
         // DB-level UNIQUE constraint, and the `github.poll` singleton is recovered by the
         // dedup guard on the next finally.
         const now = Date.now();
         const existingPoll = jobQueueRepo.listJobs({
           queue: QUEUES.GITHUB_POLL,
           status: ['pending'],
           limit: 1, // existence check only — limit:1 is sufficient and semantically clearer
         }).find(j => j.runAt !== null && j.runAt > now);
         if (!existingPoll) {
           jobQueueRepo.enqueue({
             queue: QUEUES.GITHUB_POLL,
             payload: {},
             runAt: now + POLL_INTERVAL_MS,
             maxRetries: 0,
           });
         }
       }
     };
     ```
   - On daemon startup, enqueue first `github.poll` job with `runAt = now` if none pending/processing

3. `packages/daemon/src/lib/github/github-service.ts`:
   - Register `github.event` handler in `GitHubService.start()` (receives `jobQueueProcessor` and `jobQueueRepo` via constructor)
   - Handler uses INSERT-first idempotency: attempt `INSERT OR IGNORE INTO github_processed_events(event_id, processed_at) VALUES (?, ?)` at job start
   - If the row already existed (affected rows = 0): return immediately — event was already processed. This check is concurrency-safe because SQLite serializes writes; two concurrent workers cannot both get `affected rows = 1` for the same `event_id`.
   - If insert succeeded (affected rows = 1): run existing filter→security→route pipeline

4. `packages/daemon/src/lib/github/webhook-handler.ts`:
   - Update webhook path to enqueue a `github.event` job instead of calling the pipeline directly
   - Use the `X-GitHub-Delivery` header value (parsed at line ~141) as the `eventId` in the job payload — NOT `normalizeWebhookEvent`'s output `eventId` (which calls `generateEventId()` → random UUID, defeating idempotency)

Job payloads:
- `github.poll`: `{}` (singleton sentinel)
- `github.event`: `{ eventType: string, eventId: string, payload: Record<string, unknown> }`

**Retry behavior**: `maxRetries: 0` for **both** `github.event` and `github.poll`.

For `github.poll`: re-scheduling handled in `finally` block; processor retry not needed.

For `github.event`: INSERT-first idempotency requires `maxRetries: 0`. With `maxRetries > 0`, if the pipeline fails after the INSERT succeeds (e.g. transient network error, agent crash), any retry sees the existing row (affected rows = 0) and permanently skips the pipeline — a **silent event drop**. Setting `maxRetries: 0` accepts at-most-once delivery for individual events. This is acceptable because:
- GitHub webhooks have their own retry mechanism (3 delivery attempts with exponential backoff)
- Polling events are re-polled on the next poll cycle; stable deterministic IDs prevent duplicate processing of successfully processed events
- The alternative (insert-on-success + per-job in-flight concurrency key) adds significant complexity for marginal gain

**Residual risk**: If `jobQueueRepo.enqueue()` inside the `finally` block throws (e.g., SQLite disk failure), the next poll will not be scheduled. This is an accepted risk: SQLite write failures at this level typically indicate a fatal daemon condition (disk full, WAL corruption) and the daemon will crash and restart, re-enqueuing the poll on startup. No additional fallback is specified.

**Acceptance criteria**:
- Polled events use deterministic stable IDs (verified by unit test: normalizing same data twice produces same ID).
- Per-repo poll state (`issues_etag`, `comments_etag`, `last_poll_at`) stored in `github_poll_state` table, survives restart.
- Repository registrations restored from `GitHubMappingRepository` on `start()`.
- Same event cannot be processed twice: INSERT-first strategy (`INSERT OR IGNORE` at job start, skip pipeline if row already existed) is concurrency-safe with `maxConcurrent: 3`.
- `github.event` jobs use `maxRetries: 0` (at-most-once delivery). This is required because INSERT-first + retry would cause permanent silent event drops: a retry sees the existing row and skips the pipeline. GitHub webhooks retry on their own; polled events reappear on next poll cycle.
- `github.poll` re-scheduling uses `finally` block with dedup (only enqueues if no future-scheduled poll already exists) — polling never permanently stalls after handler error, and the poll chain never multiplies if duplicate `github.poll` jobs are ever present (modulo fatal SQLite failure, accepted risk).
- Enqueued `github.event` jobs survive daemon restart.
- DB migration for `github_processed_events` and `github_poll_state` tables is included and applied at daemon startup.
- Webhook requests missing `X-GitHub-Delivery` header are rejected with HTTP 400 (fallback UUID would disable idempotency).
- Webhook `github.event` jobs use `X-GitHub-Delivery` header value as `eventId` (not `generateEventId()` which produces random UUIDs); verified by unit test that re-delivering the same webhook with same delivery ID is idempotent.
- Unit tests cover: stable ID generation for polled events, stable delivery ID for webhooks, INSERT-first idempotency (first insert succeeds, second is no-op), poll re-scheduling on success and on error, webhook path enqueues job, two-ETag persistence per repo.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Migrate Room Runtime Tick to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace **both** the `setInterval` heartbeat and the `scheduleTick()` (`queueMicrotask`) immediate-trigger in `RoomRuntime` with persistent `room.tick` jobs.

**`RoomRuntime` has two tick trigger paths** — both must be migrated:
1. `setInterval(() => this.tick(), this.tickInterval)` (~line 205) — periodic heartbeat
2. `scheduleTick()` (~line 1550): `queueMicrotask(() => this.tick())` — event-driven immediate trigger with 9+ call sites (goal created, task updated, worker/leader terminal states, leader tool calls, etc.)
3. Recovery paths via `runtime-recovery.ts`: that file calls `runtime.onWorkerTerminalState()` (line 153) and `runtime.onLeaderTerminalState()` (line 194), which internally call `this.scheduleTick()`. No changes are needed to `runtime-recovery.ts` itself — replacing `scheduleTick()` in `room-runtime.ts` automatically covers the recovery paths.

**`jobQueueProcessor` and `jobQueueRepo` injection**: `RoomRuntimeService` receives them via the `deps` object passed to `setupRPCHandlers` (wired in Task 1). No refactoring of `RoomRuntimeService` out of `setupRPCHandlers` is required. `RoomRuntime` instances (created by `RoomRuntimeService`) need `jobQueueRepo` to call `enqueueRoomTick()` from within instance methods; add `jobQueueRepo: JobQueueRepository` to the `RoomRuntimeConfig` interface (defined at `room-runtime.ts` line ~76).

**Migration approach**:
- Remove `setInterval`, `tickTimer` field, `scheduleTick()` method, and all `queueMicrotask` calls from `RoomRuntime`. This includes the main `scheduleTick()` at line ~1550 **and** an additional `queueMicrotask(() => this.tick())` at line ~954 inside the tick mutex path — both must be replaced with `enqueueRoomTick(this.jobQueueRepo, this.roomId, priority)`. **IMPORTANT: the `tickLocked` and `tickQueued` mutex fields must be RETAINED.** With `maxConcurrent: 3`, two `room.tick` jobs for the same `roomId` can run concurrently (dedup is check-then-act, documented as an accepted race); the mutex prevents concurrent `executeTick()` calls within a single runtime. Only the scheduling mechanism (`queueMicrotask`, `setInterval`) is replaced — the in-process tick mutex stays.
- Remove the `scheduleHeartbeat()` method (if present) from `RoomRuntimeService` — it uses `setInterval`/`setTimeout` internally and is superseded by the `finally`-based heartbeat in the tick handler.
- **Fix `stopRuntime()` and add `stoppedRooms` tracking**: The current `stopRuntime()` in `room-runtime-service.ts` (line 83) does NOT call `this.runtimes.delete(roomId)`. This means `this.runtimes.has(roomId)` returns `true` even after an individual room stop, making the heartbeat liveness check in the `finally` block ineffective for individual room stops (only effective on full shutdown via `runtimes.clear()`). Required changes to `RoomRuntimeService`:
  1. Add `private stoppedRooms: Set<string> = new Set()` field.
  2. `stopRuntime(roomId)` must call `this.runtimes.delete(roomId)` AND `this.stoppedRooms.add(roomId)`.
  3. **`startRuntime(roomId)` (at `room-runtime-service.ts:94`) must call `this.stoppedRooms.delete(roomId)` before creating the new runtime** — this clears the stopped marker when a room is restarted. Without this, a stop-then-restart sequence leaves `stoppedRooms` containing the `roomId`; any subsequent tick job hits `stoppedRooms.has(roomId) → true` and returns immediately, permanently preventing the restarted room from ever ticking. Also prevents `stoppedRooms` from growing unbounded across the daemon lifetime.
  4. The tick handler's `!runtime` branch must check `this.stoppedRooms.has(roomId)` as the **first** check and return without re-enqueueing. Without this, when a tick job fires after `stopRuntime()` was called, the `!runtime` branch sees the room exists in DB and re-enqueues indefinitely (the perpetual churn loop).
  5. After `stopRuntime()` deletes from the map, `this.runtimes.has(roomId)` in the heartbeat `finally` block correctly returns `false` for stopped rooms, making the liveness check effective for both individual stops and full shutdown.
- Add an `enqueueRoomTick(repo: JobQueueRepository, roomId: string, priority = 0)` helper function:
  ```typescript
  function enqueueRoomTick(repo: JobQueueRepository, roomId: string, priority = 0): void {
    const now = Date.now();
    // Dedup: skip if an immediate (near-future) pending or processing job exists for this room.
    // IMPORTANT: only dedup against jobs with runAt <= now (immediate/due jobs).
    // Heartbeat jobs have runAt = now + 30_000 and must NOT suppress event-driven immediate
    // ticks — otherwise rooms would be delayed up to 30 seconds between event-driven ticks.
    // listJobs now supports status array (extended in Task 1).
    // limit: 1000 overrides the default cap of 100 to avoid missed dedup under high job volume.
    const existing = repo.listJobs({
      queue: QUEUES.ROOM_TICK,
      status: ['pending', 'processing'],
      limit: 1000,
    }).find(j =>
      (j.payload as any).roomId === roomId &&
      (j.runAt === null || j.runAt <= now)
    );
    if (!existing) {
      repo.enqueue({ queue: QUEUES.ROOM_TICK, payload: { roomId }, priority, maxRetries: 0 });
    }
    // Note: listJobs is an O(n) scan with no index on payload contents.
    // Acceptable at current scale (tens of rooms). Future optimization:
    // add unique constraint or dedicated column if room count grows significantly.
    //
    // Known trade-off: dedup checks against `processing` status means event-driven
    // ticks are suppressed while a tick is already executing. New state changes during
    // a long-running tick will not trigger an immediate re-tick; they will be picked up
    // by the heartbeat (30s). This is an accepted trade-off: removing `processing` from
    // dedup would allow concurrent tick execution for the same room, which could cause
    // inconsistent state; separate per-room queuing would add significant complexity.
    //
    // Check-then-act race: with maxConcurrent: 3, two concurrent handlers could both
    // pass this dedup check for the same room before either enqueue commits. SQLite
    // serializes writes, so both will succeed and produce a duplicate. This is an
    // accepted risk: the extra job is idempotent (tick handles duplicate execution),
    // and true atomic dedup would require a DB-level UNIQUE constraint which adds
    // complexity not warranted at current scale.
  }
  ```
- Replace all `this.scheduleTick()` call sites in `room-runtime.ts` with `enqueueRoomTick(this.jobQueueRepo, this.roomId, priority)`
- After each tick handler attempt (success or failure), attempt to schedule a heartbeat in a `try/finally` block. The `finally` block must first check `this.runtimes.has(roomId)` — if the runtime was stopped while the tick was in-flight, do NOT enqueue a heartbeat (otherwise the chain loops indefinitely via re-enqueue-on-miss). The heartbeat enqueue deduplicates against existing pending future-scheduled jobs (`runAt > now`) to prevent heartbeat chain multiplication. All `room.tick` jobs must use `maxRetries: 0` because the `finally` pattern self-reschedules — with `maxRetries > 0`, each processor retry also fires `finally`, creating duplicate heartbeat jobs.
- Register handler in `RoomRuntimeService.start()`:
  ```typescript
  this.jobQueueProcessor.register(QUEUES.ROOM_TICK, async (job) => {
    const { roomId } = job.payload as { roomId: string };
    const runtime = this.runtimes.get(roomId);
    if (!runtime) {
      // Runtime not found: three possible reasons —
      //   (a) runtime was explicitly stopped (check stoppedRooms first)
      //   (b) recovery still in progress after restart
      //   (c) room was deleted from DB
      // Check (a) first to avoid an expensive DB read for stopped rooms.
      if (this.stoppedRooms.has(roomId)) return; // Explicitly stopped — do not re-enqueue
      const roomExists = this.ctx.roomManager.getRoom(roomId) !== null;
      if (roomExists) {
        // Recovery still in progress — re-enqueue with delay, but only if no pending
        // job for this room already exists. Dedup prevents multiple concurrent workers
        // (maxConcurrent: 3) from each enqueueing an independent 5s delayed job when
        // all arrive at this branch simultaneously.
        const anyPending = this.jobQueueRepo.listJobs({
          queue: QUEUES.ROOM_TICK,
          status: ['pending'],
          limit: 1000,
        }).find(j => (j.payload as any).roomId === roomId);
        if (!anyPending) {
          this.jobQueueRepo.enqueue({
            queue: QUEUES.ROOM_TICK,
            payload: { roomId },
            runAt: Date.now() + 5_000,
            maxRetries: 0,
          });
        }
      }
      // Room deleted: do not re-enqueue (prevents perpetual churn)
      return;
    }
    try {
      await runtime.tick();
    } finally {
      // Heartbeat: schedule a future tick if (a) runtime is still tracked AND
      // (b) no future-scheduled heartbeat already exists.
      //
      // CRITICAL: Check this.runtimes.has(roomId) first. stopRuntime() must call
      // this.runtimes.delete(roomId) (see migration approach above — this is a required
      // fix to the existing stopRuntime() implementation at room-runtime-service.ts:83).
      // After that fix, this.runtimes.has(roomId) correctly returns false for stopped
      // rooms, making this liveness check effective for individual room stops as well as
      // full shutdown (runtimes.clear()). Without stopRuntime() deleting from the map,
      // this check would always be true for stopped rooms and the heartbeat would chain
      // indefinitely. The stoppedRooms check in the !runtime branch above handles the
      // symmetric case where the tick handler fires after stopRuntime() but the finally
      // block hasn't been reached yet.
      //
      // maxRetries: 0 is required: with the finally pattern, processor retries would
      // each also fire finally, creating duplicate heartbeat jobs (job multiplication).
      //
      // Dedup against future-scheduled jobs: if a pending heartbeat already exists
      // (runAt > now), skip — prevents heartbeat chain multiplication when event-driven
      // ticks fire frequently (each event-driven tick's finally would otherwise create
      // an additional parallel heartbeat chain).
      if (this.runtimes.has(roomId)) {
        const now = Date.now();
        const existingHeartbeat = this.jobQueueRepo.listJobs({
          queue: QUEUES.ROOM_TICK,
          status: ['pending'],
          limit: 1000,
        }).find(j =>
          (j.payload as any).roomId === roomId &&
          j.runAt !== null && j.runAt > now
        );
        if (!existingHeartbeat) {
          this.jobQueueRepo.enqueue({
            queue: QUEUES.ROOM_TICK,
            payload: { roomId },
            runAt: now + 30_000,
            maxRetries: 0,
          });
        }
      }
    }
  });
  ```

**Startup and recovery ordering**: `roomRuntimeService.start()` is called with `.catch()` (fire-and-forget) inside `setupRPCHandlers`. Because recovery may not be complete when the first tick jobs fire, the handler uses re-enqueue-on-miss (above) rather than silent drop. This ensures rooms always receive their tick once recovery completes, without requiring strict startup sequencing between the processor and recovery.

**Shutdown ordering** (in `app.ts` cleanup closure — see Task 1 step 6):
1. `await jobQueueProcessor.stop()` — drains in-flight tick jobs (handlers may emit notifyChange)
2. `messageHub.cleanup()` — safe: no in-flight jobs remain
3. `rpcHandlerCleanup()` — stops `RoomRuntimeService` (clears `runtimes` map)
4. `await sessionManager.cleanup()`

The re-enqueue-on-miss tick handler avoids the risk of processing a tick after `runtimes` is cleared, because `jobQueueProcessor.stop()` drains all in-flight jobs before `rpcHandlerCleanup()` runs.

**Acceptance criteria**:
- `setInterval`, `tickTimer`, `scheduleTick()`, and all `queueMicrotask` calls (including the one at line ~954 in the tick mutex path) removed from `RoomRuntime`. `tickLocked` and `tickQueued` mutex fields are **retained** — they prevent concurrent `executeTick()` under `maxConcurrent: 3` when the check-then-enqueue race allows two `room.tick` jobs for the same room to run simultaneously.
- All `scheduleTick()` call sites in `room-runtime.ts` replaced with `enqueueRoomTick()` (recovery paths in `runtime-recovery.ts` are automatically covered since they call `onWorkerTerminalState`/`onLeaderTerminalState` which call `scheduleTick()`).
- `scheduleHeartbeat()` method (if present) removed from `RoomRuntimeService` — replaced by the `finally`-based heartbeat in the tick handler.
- `jobQueueRepo` added to `RoomRuntimeConfig` interface.
- All `room.tick` jobs enqueued with `maxRetries: 0` (both `enqueueRoomTick` helper and direct enqueues): prevents job multiplication from retry + finally interaction.
- Heartbeat enqueue is inside a `try/finally` block so it fires even if `runtime.tick()` throws — no room permanently stops ticking on handler error. The `finally` block checks `this.runtimes.has(roomId)` before enqueueing: if the runtime was stopped while the tick was in-flight, skip re-enqueue to prevent the indefinite re-enqueue-on-miss loop.
- `stopRuntime()` in `RoomRuntimeService` (line 83) calls `this.runtimes.delete(roomId)` AND `this.stoppedRooms.add(roomId)`. Without `runtimes.delete()`, `this.runtimes.has(roomId)` returns `true` for stopped rooms and the heartbeat liveness check is ineffective for individual room stops.
- `startRuntime()` in `RoomRuntimeService` (at line 94) calls `this.stoppedRooms.delete(roomId)` before creating the new runtime. Without this, a stop-then-restart sequence permanently suppresses ticking for the restarted room (stale `stoppedRooms` entry causes the tick handler to return early indefinitely).
- `private stoppedRooms: Set<string> = new Set()` field added to `RoomRuntimeService`.
- Tick handler's `!runtime` branch checks `this.stoppedRooms.has(roomId)` as the first check and returns without re-enqueueing for explicitly stopped rooms (prevents perpetual churn when a tick fires after `stopRuntime()`).
- Handler distinguishes "room deleted" from "runtime loading" via `ctx.roomManager.getRoom(roomId)`; no re-enqueue for deleted rooms.
- Re-enqueue-on-miss: single delayed job (`runAt = now + 5_000`, `maxRetries: 0`) when room exists but runtime not found; dedup against existing pending jobs prevents multiple concurrent workers (maxConcurrent: 3) from each enqueueing an independent delayed job.
- Dedup: `enqueueRoomTick` uses `limit: 1000` on `listJobs` and filters by `runAt === null || runAt <= now` — heartbeat jobs (future `runAt`) do NOT suppress event-driven immediate ticks.
- Heartbeat dedup: `finally` block checks for existing pending future-scheduled job (`runAt > now`) before enqueuing, preventing heartbeat chain multiplication when event-driven ticks fire frequently.
- Check-then-act race documented as accepted risk (for both `enqueueRoomTick` and heartbeat dedup path).
- Shutdown ordering enforced in `app.ts` cleanup closure.
- Unit tests cover: enqueue on event, dedup, heartbeat re-schedule (fires even on tick() throw), heartbeat NOT scheduled when runtime stopped during tick (liveness check), re-enqueue-on-miss (single delayed job), no-re-enqueue for deleted room, no-re-enqueue for explicitly stopped room (stoppedRooms membership), stop-then-restart resumes ticking normally (stoppedRooms.delete on startRuntime), graceful tick execution.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5: Integration Tests, Cleanup, and Scheduled Maintenance

**Agent**: coder
**Dependencies**: Tasks 2, 3, 4
**Priority**: normal

**Description**:
Add integration/online tests validating job persistence and idempotency, add a scheduled DB maintenance job, add an E2E test for UI-observable reconnection, and clean up remaining stale patterns.

**Online/integration tests** (`packages/daemon/tests/online/`):

Note: `packages/daemon/tests/helpers/daemon-server.ts` has a `spawnDaemonServer()` function (lines 78–189) that spawns a real child process, selectable via `DAEMON_TEST_SPAWN=true`. However, the crash-recovery scenarios below use in-process processor stop/start rather than real process kill, which is sufficient to verify SQLite job persistence (persistence is process-independent) and avoids the complexity of spawned-process lifecycle in test setup.

1. **Session title generation persistence**: enqueue a `session.title_generation` job, stop and restart the processor in-process, verify the job is picked up and the title is set exactly once.
2. **GitHub event idempotency**: enqueue the same `github.event` job payload twice (same `eventId`); verify it is processed exactly once (check `github_processed_events` table has one row).
3. **Room tick re-enqueue-on-miss**: enqueue a `room.tick` job for a roomId not in the `runtimes` map; verify the job is re-enqueued with a 5-second delay and not silently dropped.

**E2E test** (`packages/e2e/tests/`):
- Verify UI reconnects and displays correct state after WebSocket close and restore, using `closeWebSocket()` / `restoreWebSocket()` helpers from `connection-helpers.ts`.
- This is the correct E2E-compliant mechanism (pure browser-based, no RPC/internal state access).
- Server-restart crash-recovery is covered by online tests above, not E2E.

**Scheduled DB maintenance job** (`QUEUES.JOB_QUEUE_CLEANUP`):
- Register handler in `createDaemonApp` **before** `jobQueueProcessor.start()` — the cleanup handler registration is inline in `createDaemonApp` (not in a subsystem `start()` method), but must still follow the same ordering rule: all `jobQueueProcessor.register()` calls complete before `jobQueueProcessor.start()` begins polling.
- Handler: (1) calls `jobQueueRepo.cleanup(Date.now() - 7 * 24 * 60 * 60 * 1000)` to prune old `job_queue` rows; (2) deletes `github_processed_events` rows older than 30 days
- Self-rescheduling `finally` block (same pattern as `github.poll`). Must include dedup to prevent cleanup chain multiplication if two `job_queue.cleanup` jobs are ever simultaneously present:
  ```typescript
  finally {
    // Dedup: only enqueue next cleanup if no future-scheduled one already exists.
    // Without dedup, if two cleanup jobs somehow run concurrently (e.g., crash during
    // startup before dedup check), each job's finally would create an extra next-day
    // cleanup, doubling the chain — same pattern as github.poll (now fixed).
    //
    // Accepted race: this is a check-then-enqueue sequence (not atomic). Two concurrent
    // workers could both observe "no future cleanup" and both enqueue. The duplicate is
    // harmless (idempotent cleanup), and the dedup guard on the next finally re-collapses
    // to a singleton. True atomic dedup would require a DB-level UNIQUE constraint.
    const now = Date.now();
    const existingCleanup = jobQueueRepo.listJobs({
      queue: QUEUES.JOB_QUEUE_CLEANUP,
      status: ['pending'],
      limit: 1, // existence check only — limit:1 is sufficient and semantically clearer
    }).find(j => j.runAt !== null && j.runAt > now);
    if (!existingCleanup) {
      jobQueueRepo.enqueue({
        queue: QUEUES.JOB_QUEUE_CLEANUP,
        payload: {},
        runAt: now + 24 * 60 * 60 * 1000,
        maxRetries: 0, // finally pattern self-reschedules; maxRetries > 0 causes job multiplication
                       // (each retry also runs finally, creating an extra next-day cleanup job)
      });
    }
  }
  ```
- On daemon startup: enqueue first run with `runAt = Date.now() + 24 * 60 * 60 * 1000` (now + 24 hours) if no pending/processing cleanup job exists. **Do NOT use `runAt = now`**: the cleanup job deletes `github_processed_events` rows older than 30 days; if a daemon was offline for 31–89 days, an immediate first run would delete dedup rows for jobs whose stale reclaim (5-minute threshold) has not yet completed, causing duplicate event processing. Delaying the first run by 24 hours ensures the processor has fully completed stale job reclaim before cleanup runs.
- On daemon startup: run a synchronous one-time prune of `github_processed_events` rows older than **90 days** (not 30 days) to bound table size after extended offline periods. This prune must run **before** `jobQueueProcessor.start()`.

  **Dedup gap and accepted risk**: If the daemon was offline for > 90 days AND had `github.event` jobs stuck in `processing` state at shutdown, the startup prune could delete those jobs' dedup rows. On restart, the processor reclaims those stale jobs and re-runs the pipeline (duplicate event processing). This is an accepted risk:
  - The stale reclaim threshold is 5 minutes — any job stuck for > 5 minutes is reclaimed. For a dedup row to be pruned, the daemon must have been offline for > 90 days with those 5-minute-old processing jobs.
  - Even in that scenario, at-most-once delivery is already the documented guarantee for `github.event` (maxRetries: 0).
  - The 90-day window was chosen to provide a practical safety margin well beyond normal daemon restart scenarios (typical offline < hours). The ongoing scheduled cleanup prunes rows older than 30 days.

**Cleanup scope** — patterns explicitly removed by this task:
- `pendingBackgroundTasks` Set in `session-manager.ts` (removed in Task 2; confirm no remaining references)
- `scheduleTick()` method and `tickTimer` field in `room-runtime.ts` (removed in Task 4)
- Any `void somePromise` usages replaced by queue jobs in Tasks 2–4

**Intentionally kept** (not in cleanup scope):
- `triggerBackgroundRefresh` in `model-service.ts` — cache warming, ephemeral by design
- WebSocket stale checker `setInterval` in `websocket-server-transport.ts` — process-local connection management
- Event-bus `.catch(() => {})` emissions in `rpc-handlers/` — in-process fanout

**Acceptance criteria**:
- At least 3 online tests covering job persistence and idempotency across processor restart.
- E2E test verifies UI recovers after WebSocket close/restore using `closeWebSocket()` / `restoreWebSocket()`.
- Scheduled cleanup job self-reschedules via `finally` block with dedup (only enqueues if no future-scheduled cleanup already exists) and `maxRetries: 0` (prevents job multiplication: with `maxRetries > 0`, each retry also fires `finally`, creating extra next-day cleanup jobs); dedup prevents cleanup chain multiplication if duplicate `job_queue.cleanup` jobs are ever present; verified by unit test.
- Startup-time synchronous prune of `github_processed_events` rows older than **90 days** runs on daemon start **before** `jobQueueProcessor.start()`; verified by unit test. (90-day window provides safety margin; ongoing cleanup job prunes at 30 days. Risk of dedup gap for daemon offline > 90 days is accepted — at-most-once delivery is already the guarantee.)
- No stale `pendingBackgroundTasks`, `scheduleTick()`, or `setInterval`-based tick patterns remain in production code.
- `bun run check` passes (lint + typecheck + knip).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Dependency Graph

```
Task 1 (Foundation — wiring, DI, constants, API extensions, idempotency design)
  ├── Task 2 (Session title generation)  ──┐
  ├── Task 3 (GitHub events + polling)   ──┼── Task 5 (Integration tests + cleanup)
  └── Task 4 (Room runtime tick)         ──┘
```

Tasks 2, 3, and 4 are independent and can run in parallel after Task 1 is merged. Task 5 waits for all three.

---

## Key Files Reference

| File | Relevance |
|------|-----------|
| `packages/daemon/src/app.ts` | Factory function with cleanup closure — Task 1 |
| `packages/daemon/src/lib/rpc-handlers/index.ts` | `setupRPCHandlers` — where `RoomRuntimeService` is created; Task 1 adds `jobQueueProcessor`/`jobQueueRepo` to deps |
| `packages/daemon/src/storage/job-queue-processor.ts` | Existing processor — all tasks |
| `packages/daemon/src/storage/repositories/job-queue-repository.ts` | Existing repository; `listJobs` extended for array status — Task 1 |
| `packages/daemon/src/lib/job-queue-constants.ts` | New queue name constants — Task 1 |
| `packages/daemon/src/lib/session/session-manager.ts` | Task 2 |
| `packages/daemon/src/lib/session/session-lifecycle.ts` | Task 2 |
| `packages/daemon/src/lib/github/event-normalizer.ts` | Deterministic stable IDs for polled events — Task 3 |
| `packages/daemon/src/lib/github/polling-service.ts` | Task 3 |
| `packages/daemon/src/lib/github/github-service.ts` | Task 3 |
| `packages/daemon/src/lib/github/webhook-handler.ts` | Task 3 |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | Task 4 |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | Task 4 |
| `packages/daemon/src/lib/room/runtime/runtime-recovery.ts` | Task 4 — no direct changes; covered by `scheduleTick()` replacement in `room-runtime.ts` |
| `docs/adr/0002-job-queue-migration.md` | Reference ADR |
