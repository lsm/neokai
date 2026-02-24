# Room Runtime Implementation Plan — Minimal Core

Status: Draft
Date: 2026-02-24
Related: [Room Runtime Spec v0.21](./room-runtime-spec.md)

## Important: This is NOT a Full Implementation Spec

This document describes the **minimal core** needed to reach a point where the room can operate autonomously and **use itself to continue developing the remaining features**.

Once this core is working, we can ask the room to implement:
- Planning as a (Craft, Lead) pair
- Goal review
- Human message queueing
- Interrupt handling
- Task timeout
- Parallel pairs

**The room builds itself.** This plan just gets us to the starting line.

---

## Goal: Reach Self-Bootstrapping Operation

The minimal viable system needs:
1. Human can create goals/tasks via Room Agent
2. Runtime detects pending tasks and spawns (Craft, Lead) pairs
3. Craft does work, Lead reviews, feedback loop until accepted or escalated
4. Basic recovery from daemon restart

---

## Phase 0: Database Schema (Prerequisite)

**File:** `packages/daemon/src/storage/schema/migrations.ts`

### Existing Columns (DO NOT re-add)

The following columns already exist in the schema:
- `tasks.priority` — TEXT with CHECK constraint (`low`, `normal`, `high`, `urgent`)
- `tasks.depends_on` — TEXT DEFAULT `'[]'`
- `goals.priority` — TEXT with CHECK constraint (`low`, `normal`, `high`, `urgent`)

### New Tables

```sql
-- Task pairs: tracks the (Craft, Lead) sessions for each task
CREATE TABLE task_pairs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    craft_session_id TEXT NOT NULL,
    lead_session_id TEXT NOT NULL,
    pair_state TEXT NOT NULL DEFAULT 'awaiting_craft',
        -- awaiting_craft | awaiting_lead | awaiting_human | hibernated | completed | failed
    feedback_iteration INTEGER NOT NULL DEFAULT 0,
    last_forwarded_message_id TEXT,
    active_work_started_at INTEGER,
    active_work_elapsed INTEGER NOT NULL DEFAULT 0,
    hibernated_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1,  -- starts at 1 for optimistic locking
    tokens_used INTEGER NOT NULL DEFAULT 0,  -- Updated per-turn (mechanism TBD, tracking only for now)
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);

-- Message queue: reliable inter-agent message delivery
-- MVP Note: Table kept for schema compatibility, not used for Lead→Craft routing
-- Will be used when human queueing/interrupts are implemented
CREATE TABLE task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    pair_id TEXT NOT NULL REFERENCES task_pairs(id),
    from_role TEXT NOT NULL,       -- 'craft' | 'lead' | 'human'
    to_role TEXT NOT NULL,         -- 'craft' | 'lead'
    to_session_id TEXT NOT NULL,   -- target session (prevents misdelivery on retry)
    message_type TEXT NOT NULL DEFAULT 'normal',  -- MVP: only 'normal'; future: 'interrupt' | 'escalation_context'
    payload TEXT NOT NULL,         -- JSON message content
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | dead_letter
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
);

-- Audit log: observability for debugging Runtime behavior
-- Retention: 7 days (cleanup job deletes older entries)
CREATE TABLE room_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    event_type TEXT NOT NULL,  -- 'tick' | 'pair_state_change' | 'message_delivery' | 'notification'
    detail TEXT NOT NULL,      -- JSON: what happened, trigger, outcome
    created_at INTEGER NOT NULL
);
```

### Column Additions (only what's missing)

```sql
-- Tasks table: add columns that don't exist yet
ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'coding';
    -- 'planning' | 'coding' | 'research' | 'design' | 'goal_review'
ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 1;
    -- starts at 1 for optimistic locking
ALTER TABLE tasks ADD COLUMN created_by_task_id TEXT;
    -- References the planning task that created this task

-- Goals table: add counters
ALTER TABLE goals ADD COLUMN planning_attempts INTEGER DEFAULT 0;
ALTER TABLE goals ADD COLUMN goal_review_attempts INTEGER DEFAULT 0;

-- Rooms table: add config
ALTER TABLE rooms ADD COLUMN config TEXT;
    -- JSON: { max_feedback_iterations, task_timeout, max_planning_attempts, ... }
```

---

## Phase 1: Core Infrastructure

### 1.1 TaskPairRepository

**File:** `packages/daemon/src/lib/room/task-pair-repository.ts`

CRUD operations for task_pairs table:

```typescript
class TaskPairRepository {
  createPair(taskId: string, craftSessionId: string, leadSessionId: string): TaskPair;
  getPair(pairId: string): TaskPair | null;
  getPairByTaskId(taskId: string): TaskPair | null;
  getActivePairs(roomId: string): TaskPair[];  // JOINs through tasks to get roomId
  updatePairState(pairId: string, newState: PairState, expectedVersion: number): TaskPair | null;
  incrementFeedbackIteration(pairId: string, expectedVersion: number): TaskPair | null;
  completePair(pairId: string, expectedVersion: number): TaskPair | null;
  failPair(pairId: string, expectedVersion: number): TaskPair | null;
}
```

**Version contract:** All update methods use optimistic locking. Pass `expectedVersion` = current version. Method increments to `expectedVersion + 1` on success, returns `null` on version mismatch.

### 1.2 TaskMessageQueue

**File:** `packages/daemon/src/lib/room/task-message-queue.ts`

**MVP Decision:** For the minimal core, we use **direct synchronous routing** for all Lead→Craft messages. The `task_messages` table is kept for schema compatibility but **not used in MVP**. This simplifies the implementation significantly:

- No write-ahead queue semantics needed
- No recovery replay of in-flight messages
- Crash during routing = message lost (acceptable for MVP)

When we add human message queueing and interrupts, we'll implement write-ahead semantics: `enqueue pending → inject → mark delivered`.

```typescript
class TaskMessageQueue {
  // MVP: These methods exist but are not used for Lead→Craft routing
  // They will be used when human queueing/interrupts are implemented

  enqueue(params: {
    pairId: string;
    taskId: string;
    fromRole: 'craft' | 'lead' | 'human';
    toRole: 'craft' | 'lead';
    toSessionId: string;
    payload: string;
    messageType?: 'normal';  // MVP: only 'normal' type needed
  }): TaskMessage;

  dequeuePending(pairId: string, toRole: 'craft' | 'lead'): TaskMessage[];
  markDelivered(messageId: string): void;
  markDeadLetter(messageId: string): void;
  deadLetterAllForPair(pairId: string): void;
}
```

---

## Phase 2: Room Runtime Core

### 2.1 RoomRuntime Class

**File:** `packages/daemon/src/lib/room/room-runtime.ts`

```typescript
import { Mutex } from 'async-mutex';  // npm package

class RoomRuntime {
  private state: 'running' | 'paused' = 'running';
  private tickMutex = new Mutex(); // single-flight
  private timerInterval?: Timer;  // 30-second fallback

  // Lifecycle
  start(): void;   // Starts 30-second timer + subscribes to DaemonHub events
  pause(): void;
  resume(): void;
  getState(): 'running' | 'paused';

  // Main scheduling loop
  tick(): Promise<void>;

  // Event handlers (trigger immediate tick via DaemonHub subscriptions)
  onGoalCreated(goalId: string): void;
  onTaskStatusChanged(taskId: string): void;
  onCraftTerminalState(pairId: string): void;

  // Lead tool handling (called synchronously from MCP tool handlers)
  handleLeadTool(pairId: string, toolName: string, params: any): Promise<ToolResult>;
}
```

### Tick Trigger Matrix

| Event Source | Signal | Runtime Handler | Notes |
|--------------|--------|-----------------|-------|
| Room Agent MCP tools | `goal.created`, `task.created` | `onGoalCreated()`, `onTaskStatusChanged()` | After DB write succeeds |
| TaskManager | `task.status_changed` | `onTaskStatusChanged()` | After status update |
| SessionObserver | `session.terminal_state` | `onCraftTerminalState()` | When Craft reaches result/error |
| `handleLeadTool()` | (internal) | Triggers tick after `complete_task`/`fail_task` | For task completion cleanup |
| Timer | 30s interval | `tick()` | Fallback for missed events |

**Idempotency:** All handlers are idempotent - duplicate events produce same result. Tick mutex prevents concurrent execution.

### Tick Logic

```
1. Check runtime state (paused → exit)
2. Acquire mutex (already locked → queue re-tick, exit)
3. For each room:
   a. Check capacity (maxConcurrentPairs)
   b. Find pending tasks (ordered by priority DESC → created_at ASC → id ASC)
      → spawn (Craft, Lead) pair if below capacity
   c. Find awaiting_craft pairs with terminal Craft → collect messages, forward to Lead
   d. Check feedback_iteration >= max_feedback_iterations → auto-escalate
4. Log tick summary to room_audit_log
5. Release mutex
```

### Loop Termination Guard

Before each Lead→Craft cycle, Runtime checks:
```
if (pair.feedback_iteration >= room.config.max_feedback_iterations) {
  // Auto-escalate instead of another feedback cycle
  await escalatePair(pairId, `Max feedback iterations (${max_feedback_iterations}) reached`);
  await logAudit(roomId, 'auto_escalate', { pairId, reason: 'max_iterations' });
}
```

Default `max_feedback_iterations`: 10 (configurable in `rooms.config`).

### 2.2 Session Observer

**File:** `packages/daemon/src/lib/room/session-observer.ts`

Detects terminal states from AgentSession:

```typescript
class SessionObserver {
  // Subscribe to session state changes via DaemonHub
  observe(sessionId: string, onTerminal: (state: TerminalState) => void): void;

  // Stop observing
  unobserve(sessionId: string): void;

  // Cron safety net (60s): query DB for stuck sessions
  // Stateless - queries DB directly, survives daemon restarts
  checkStuckSessions(): Promise<void>;
}
```

**Terminal state mapping:**
- `result/success` → Craft finished turn
- `result/error` → Craft errored
- `waiting_for_input` → AskUserQuestion

---

## Phase 3: Agent Sessions

### 3.1 Room Agent (Human Interface)

**File:** `packages/daemon/src/lib/room/room-agent.ts`

Persistent AgentSession for human conversation:
- Session ID: `room:chat:${roomId}` (already exists!)
- System prompt: "You are the Room Agent. Help humans manage goals and tasks..."

**MCP Tools:**

| Tool | Purpose |
|------|---------|
| `create_goal(title, description)` | Create a new goal |
| `list_goals()` | List all goals with status |
| `update_goal(goalId, updates)` | Update goal |
| `create_task(goalId, title, description)` | Create a task |
| `list_tasks(goalId?)` | List tasks |
| `update_task(taskId, updates)` | Update task |
| `cancel_task(taskId)` | Cancel a task (marks failed, calls `AgentSession.cleanup()` on both Craft and Lead) |
| `retry_task(taskId)` | Retry a failed task (teardown old pair, create new) |
| `get_room_status()` | Overview of room state |

**Key insight:** Room Agent session already exists (created in `room-handlers.ts`). We just need to add MCP tools.

### 3.2 Craft Agent (Worker)

**File:** `packages/daemon/src/lib/room/craft-agent.ts`

Standard AgentSession with coding tools:

```typescript
class CraftAgentFactory {
  create(task: Task, goal: Goal, room: Room): AgentSession;
}
```

**System prompt includes:**
- Task description and acceptance criteria
- Goal description (broader context)
- Room-level instructions/guidelines
- Previous task summaries for completed tasks in same goal

**Tools:** bash, edit, read, write, glob, grep (standard coding set)

**No special completion tools** - Craft just works until terminal state.

### 3.3 Lead Agent (Reviewer)

**File:** `packages/daemon/src/lib/room/lead-agent.ts`

AgentSession with review-specific tools:

```typescript
class LeadAgentFactory {
  create(task: Task, goal: Goal, room: Room): AgentSession;
}
```

**System prompt includes:**
- Goal description
- Task description and acceptance criteria
- Room-level review policy
- Activity-specific review instructions (coding, planning, etc.)
- **Tool contract:** Must call exactly one terminal tool per turn
- **Escalation policy:** Use `escalate` when uncertain or blocked

**MCP Tools (routed through Runtime):**

| Tool | Purpose |
|------|---------|
| `send_to_craft(message)` | Send feedback to Craft |
| `complete_task(summary)` | Accept work, mark done |
| `fail_task(reason)` | Task not achievable |
| `escalate(reason)` | Flag for human attention |

**Lead Tool Contract (CRITICAL):**

Lead Agent must call **exactly one terminal tool** per turn: `complete_task`, `fail_task`, `escalate`, or `send_to_craft`.

- If Lead emits text with no tool call, or calls multiple conflicting tools → Runtime retries once with system nudge: "You must call exactly one of: send_to_craft, complete_task, fail_task, or escalate"
- If second attempt also fails → Runtime auto-escalates to human

**Lead Tool Routing (MCP Callback Pattern):**

Lead MCP tools are defined with callback functions that call into Runtime methods directly (same pattern as `lobby-agent-tools.ts`):

```typescript
// In lead-agent-tools.ts
tool('send_to_craft', 'Send feedback to Craft', { message: z.string() }, async (params) => {
  return runtime.handleLeadTool(pairId, 'send_to_craft', params);
});

// In RoomRuntime
handleLeadTool(pairId: string, toolName: string, params: any): Promise<ToolResult> {
  // 1. Validate pair_state == 'awaiting_lead'
  // 2. Validate task version matches expected
  // 3. Validate no queued interrupts for this pair
  // 4. Execute the action
  // 5. Return tool result to Lead
}
```

This is **synchronous** — the tool handler calls Runtime directly, Runtime validates and executes, then returns the result. No DaemonHub events involved.

---

## Phase 4: Task Pair Manager

**File:** `packages/daemon/src/lib/room/task-pair-manager.ts`

Creates and manages (Craft, Lead) pairs:

```typescript
class TaskPairManager {
  // Spawn a new pair for a task
  async spawnPair(task: Task, goal: Goal, room: Room): Promise<TaskPair>;

  // Route Craft terminal state to Lead
  async routeCraftToLead(pairId: string, terminalState: TerminalState): Promise<void>;

  // Route Lead feedback to Craft
  async routeLeadToCraft(pairId: string, message: string): Promise<void>;

  // Handle pair completion
  async completePair(pairId: string, summary: string): Promise<void>;

  // Handle pair failure
  async failPair(pairId: string, reason: string): Promise<void>;

  // Cancel pair (urgent control)
  async cancelPair(pairId: string): Promise<void>;

  // Handle escalation
  async escalatePair(pairId: string, reason: string): Promise<void>;
}
```

### Pair Creation Flow

1. Create Craft session with task context in system prompt
2. Create Lead session with review context in system prompt
3. Create task_pairs record (state: `awaiting_craft`, version: 1)
4. Set task status to `in_progress`
5. **Send initial task instruction to Craft as first user message** — this triggers Craft to begin working
6. Start observing Craft session

**Why step 5 is needed:** The system prompt provides context but doesn't trigger action. Craft needs an explicit user message (e.g., "Please implement the task: {title}. {description}") to start working.

---

## Phase 5: Message Routing

### 5.1 Craft → Lead Routing

When Craft reaches terminal state:

1. Runtime detects via session observer
2. Collect all assistant messages since `last_forwarded_message_id`
3. Format as structured envelope:
   ```
   [CRAFT OUTPUT] Iteration: {n}
   Task: {task_title}
   Task type: {task_type}
   Terminal state: {success|error|question}
   Tool calls: ["Edit src/auth.ts (+42 lines)", ...]
   ---
   {craft_assistant_messages}
   ```
4. Send to Lead session as user message
5. Update `last_forwarded_message_id` to latest Craft message
6. Update pair state to `awaiting_lead`

### 5.2 Lead → Craft Routing

When Lead calls `send_to_craft(feedback)`:

1. Runtime method called directly by MCP tool handler (see Lead Tool Routing below)
2. Validate pair state and version
3. **Synchronously** inject message into Craft session as user message (no queue delay)
4. Update pair state to `awaiting_craft`
5. Increment feedback_iteration

**Note:** For MVP, Lead→Craft is synchronous (direct injection). The `task_messages` queue is used for recovery only, not for routing delays.

### 5.3 Escalation Return Path

When Lead calls `escalate(reason)`:

1. Runtime sets pair state to `awaiting_human`
2. Runtime sets task status to `escalated`
3. Runtime notifies human (via Room Agent message + UI event)
4. **Human responds directly to Lead session** — sends message via UI
5. Runtime detects human message to Lead session → transitions pair back to `awaiting_lead`
6. Lead re-evaluates with human guidance and calls a terminal tool

**Why this works:** Lead session is a standard AgentSession. Human messages to Lead are just user messages in that session. Runtime observes all sessions and transitions pair state when it sees human activity on a Lead session that's in `awaiting_human`.

### 5.4 Task Selection Ordering

When multiple pending tasks exist, Runtime selects by:
1. `priority` TEXT sort: `urgent` > `high` > `normal` > `low` (mapped in code)
2. `created_at` ASC (oldest first)
3. `id` ASC (deterministic tiebreaker)

---

## Phase 6: Recovery

**File:** `packages/daemon/src/lib/room/runtime-recovery.ts`

On daemon startup:

```typescript
async function recoverRuntime(db: Database, runtime: RoomRuntime): Promise<void> {
  // 1. Find all active pairs (in_progress OR escalated tasks)
  const activePairs = db.query(`
    SELECT tp.* FROM task_pairs tp
    JOIN tasks t ON tp.task_id = t.id
    WHERE t.status IN ('in_progress', 'escalated')
    AND tp.pair_state NOT IN ('completed', 'failed')
  `);

  // 2. For each pair, re-attach observers and handle edge cases
  for (const pair of activePairs) {
    switch (pair.pair_state) {
      case 'awaiting_craft':
        // Check if Craft session still exists
        if (!sessionExists(pair.craft_session_id)) {
          // Session lost - mark task failed
          await failTask(pair.task_id, 'session_lost');
          await logAudit(pair.room_id, 'session_lost', { pairId: pair.id });
        } else {
          // Re-observe Craft session
          sessionObserver.observe(pair.craft_session_id, onTerminal);
        }
        break;
      case 'awaiting_lead':
        // Check if Lead session still exists
        if (!sessionExists(pair.lead_session_id)) {
          // Session lost - mark task failed
          await failTask(pair.task_id, 'session_lost');
        } else {
          // Re-observe Lead session
          sessionObserver.observe(pair.lead_session_id, onTerminal);
        }
        break;
      case 'awaiting_human':
      case 'hibernated':
        // No action needed - waiting for human
        break;
    }

    // 3. Reset active_work_started_at (crash downtime not counted)
    if (pair.active_work_started_at) {
      db.exec(`UPDATE task_pairs SET active_work_started_at = ? WHERE id = ?`,
        [Date.now(), pair.id]);
    }
  }

  // 4. MVP: No queue recovery needed (direct synchronous routing)
  // When human queueing is implemented, reprocess pending messages here

  // 5. Resume tick loop
  runtime.start();
}
```

**MVP Recovery Limitations:**
- In-flight Lead→Craft messages are lost on crash (acceptable - Lead can resend)
- Human messages to escalated pairs are lost (will be fixed with queue implementation)
  }

  // 5. Resume tick loop
  runtime.start();
}
```

---

## Implementation Order

Phases are numbered for document organization, but **implementation must follow this dependency order**:

```
Phase 0: Database Schema                    [Prerequisite - blocks everything]
    ↓
Phase 1.1: TaskPairRepository               [Needs schema]
Phase 1.2: TaskMessageQueue                 [Needs schema]
    ↓
Phase 3.1: Room Agent Tools                 [Human can create tasks]
Phase 3.2: Craft Agent Factory              [Needs nothing]
Phase 3.3: Lead Agent Factory               [Needs nothing]
    ↓
Phase 2.2: Session Observer                 [Needs agent factories]
Phase 4: TaskPairManager                    [Needs repos + agents + observer]
Phase 5: Message Routing                    [Needs TaskPairManager]
    ↓
Phase 2.1: RoomRuntime Tick                 [Needs ALL above - autonomous operation!]
    ↓
Phase 6: Recovery                           [Needs Runtime]
```

**Critical path to first integration test:** Phases 0 → 1 → 3 → 2.2 → 4 → 5 → 2.1

---

## Minimal Viable Feature Set (The Core)

These are the features we implement in this plan. Everything else is deferred.

### Included

- ✅ Human creates goals/tasks via Room Agent
- ✅ Runtime detects pending tasks
- ✅ Runtime spawns (Craft, Lead) pairs
- ✅ Craft works, Lead reviews
- ✅ Feedback loop until accepted or escalated
- ✅ Lead escalation to human
- ✅ Basic daemon restart recovery
- ✅ Audit logging for debugging

### Deferred (the room builds these after core works)

Once the core is operational, we can use the room itself to implement:

- ⏳ Planning as (Craft, Lead) pair (for now: human creates tasks manually)
- ⏳ Goal review (for now: human marks complete)
- ⏳ Human message queueing during Lead review
- ⏳ Interrupt handling
- ⏳ Task timeout
- ⏳ Goal completion detection
- ⏳ Parallel pairs (maxConcurrentPairs > 1)
- ⏳ Escalation SLA / hibernation
- ⏳ `run_verification` tool for Lead
- ⏳ `read_craft_messages` tool for Lead

---

## Unit Test Plan

Each component needs tests before integration:

| Component | Test File | Key Test Cases |
|-----------|-----------|----------------|
| TaskPairRepository | `task-pair-repository.test.ts` | CRUD, optimistic locking, version conflicts |
| TaskMessageQueue | `task-message-queue.test.ts` | Enqueue/dequeue, ordering, dead-letter |
| RoomRuntime | `room-runtime.test.ts` | Tick logic, mutex, capacity checks |
| SessionObserver | `session-observer.test.ts` | Terminal state detection, stuck session recovery |
| TaskPairManager | `task-pair-manager.test.ts` | Pair creation, routing, completion |

---

## First Test Scenario

1. Start daemon, open NeoKai UI
2. Navigate to a room
3. Send message to Room Agent: "Create a goal to add a health check endpoint"
4. Room Agent creates goal via tool
5. Send message: "Create a task for the health check goal"
6. Room Agent creates task
7. Runtime tick detects pending task → spawns (Craft, Lead)
8. Watch Craft work in UI
9. Watch Lead review in UI
10. Loop until Lead calls `complete_task` or `escalate`

**This is the minimal autonomous loop.** Once this works, the room can help implement the deferred features.

---

## File Structure

```
packages/daemon/src/lib/room/
├── room-manager.ts          # Existing
├── goal-manager.ts          # Existing
├── task-manager.ts          # Existing
├── task-pair-repository.ts  # NEW
├── task-message-queue.ts    # NEW
├── room-runtime.ts          # NEW
├── session-observer.ts      # NEW
├── task-pair-manager.ts     # NEW
├── runtime-recovery.ts      # NEW
├── room-agent.ts            # NEW
├── craft-agent.ts           # NEW
└── lead-agent.ts            # NEW
```
