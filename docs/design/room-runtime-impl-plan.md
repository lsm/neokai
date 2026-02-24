# Room Runtime Implementation Plan — Minimal Core

Status: Draft
Date: 2026-02-24
Related: [Room Runtime Spec v0.21](./room-runtime-spec.md)

## Important: This is NOT a Full Implementation Spec

This document describes the **minimal core** needed to reach a point where the room can operate autonomously and **use itself to continue developing the remaining features**.

Once this core is working, we can ask the room to implement:
- Planning as a (Craft, Lead) pair
- Goal review
- Escalation flow
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
3. Craft does work, Lead reviews, feedback loop until accepted
4. Basic recovery from daemon restart

---

## Phase 0: Database Schema (Prerequisite)

**File:** `packages/daemon/src/storage/schema/migrations.ts`

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
    version INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);

-- Message queue: reliable inter-agent message delivery
CREATE TABLE task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    pair_id TEXT NOT NULL REFERENCES task_pairs(id),
    from_role TEXT NOT NULL,       -- 'craft' | 'lead' | 'human'
    to_role TEXT NOT NULL,         -- 'craft' | 'lead'
    to_session_id TEXT NOT NULL,   -- target session (prevents misdelivery on retry)
    message_type TEXT NOT NULL DEFAULT 'normal',  -- 'normal' | 'interrupt' | 'escalation_context'
    payload TEXT NOT NULL,         -- JSON message content
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | dead_letter
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
);
```

### Column Additions

```sql
-- Tasks table
ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'coding';
    -- 'planning' | 'coding' | 'research' | 'design' | 'goal_review'
ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN created_by_task_id TEXT;

-- Goals table
ALTER TABLE goals ADD COLUMN planning_attempts INTEGER DEFAULT 0;
ALTER TABLE goals ADD COLUMN goal_review_attempts INTEGER DEFAULT 0;

-- Rooms table
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
  getActivePairs(roomId: string): TaskPair[];
  updatePairState(pairId: string, newState: PairState, version: number): TaskPair | null;
  incrementFeedbackIteration(pairId: string, version: number): TaskPair | null;
  completePair(pairId: string, version: number): TaskPair | null;
  failPair(pairId: string, version: number): TaskPair | null;
}
```

### 1.2 TaskMessageQueue

**File:** `packages/daemon/src/lib/room/task-message-queue.ts`

DB-backed message queue:

```typescript
class TaskMessageQueue {
  enqueue(params: {
    pairId: string;
    taskId: string;
    fromRole: 'craft' | 'lead' | 'human';
    toRole: 'craft' | 'lead';
    toSessionId: string;
    payload: string;
    messageType?: 'normal' | 'interrupt' | 'escalation_context';
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
class RoomRuntime {
  private state: 'running' | 'paused' = 'running';
  private tickMutex = new Mutex(); // single-flight

  // Lifecycle
  start(): void;
  pause(): void;
  resume(): void;
  getState(): 'running' | 'paused';

  // Main scheduling loop
  tick(): Promise<void>;

  // Event handlers (trigger immediate tick)
  onGoalCreated(goalId: string): void;
  onTaskStatusChanged(taskId: string): void;
  onCraftTerminalState(pairId: string): void;
  onLeadToolExecuted(pairId: string, tool: string): void;
}
```

### Tick Logic

```
1. Check runtime state (paused → exit)
2. Acquire mutex (already locked → queue re-tick, exit)
3. For each room:
   a. Check capacity (maxConcurrentPairs)
   b. Find pending tasks → spawn (Craft, Lead) pair if below capacity
   c. Find awaiting_craft pairs with terminal Craft → collect messages, forward to Lead
   d. Find pending messages in queue → deliver to appropriate agent
4. Release mutex
```

### 2.2 Session Observer

**File:** `packages/daemon/src/lib/room/session-observer.ts`

Detects terminal states from AgentSession:

```typescript
class SessionObserver {
  // Subscribe to session state changes
  observe(sessionId: string, onTerminal: (state: TerminalState) => void): void;

  // Stop observing
  unobserve(sessionId: string): void;

  // Cron safety net (60s): query DB for stuck sessions
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
| `cancel_task(taskId)` | Cancel a task |
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
- Verification requirements

**MCP Tools (routed through Runtime):**

| Tool | Purpose |
|------|---------|
| `send_to_craft(message)` | Send feedback to Craft |
| `complete_task(summary)` | Accept work, mark done |
| `fail_task(reason)` | Task not achievable |

**Lead Tool Routing:**
All Lead tool calls are intercepted by Runtime:
1. Tool call detected → Runtime receives via DaemonHub event
2. Runtime validates (pair state, version, no queued interrupts)
3. Runtime executes the action
4. Result returned to Lead

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
}
```

### Pair Creation Flow

1. Create Craft session with task context
2. Create Lead session with review context
3. Create task_pairs record (state: `awaiting_craft`)
4. Set task status to `in_progress`
5. Start observing Craft session

---

## Phase 5: Message Routing

### 5.1 Craft → Lead Routing

When Craft reaches terminal state:

1. Runtime detects via session observer
2. Collect all assistant messages since last user message
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
5. Update pair state to `awaiting_lead`

### 5.2 Lead → Craft Routing

When Lead calls `send_to_craft(feedback)`:

1. Runtime intercepts tool call
2. Enqueue message in task_messages
3. Inject message into Craft session as user message
4. Update pair state to `awaiting_craft`
5. Increment feedback_iteration

---

## Phase 6: Recovery

**File:** `packages/daemon/src/lib/room/runtime-recovery.ts`

On daemon startup:

```typescript
async function recoverRuntime(db: Database, runtime: RoomRuntime): Promise<void> {
  // 1. Find all in_progress tasks with active pairs
  const activePairs = db.query(`
    SELECT tp.* FROM task_pairs tp
    JOIN tasks t ON tp.task_id = t.id
    WHERE t.status = 'in_progress'
    AND tp.pair_state NOT IN ('completed', 'failed')
  `);

  // 2. For each pair, re-attach observers
  for (const pair of activePairs) {
    switch (pair.pair_state) {
      case 'awaiting_craft':
        // Re-observe Craft session
        sessionObserver.observe(pair.craft_session_id, onTerminal);
        break;
      case 'awaiting_lead':
        // Re-observe Lead session
        sessionObserver.observe(pair.lead_session_id, onTerminal);
        break;
      case 'awaiting_human':
      case 'hibernated':
        // No action needed - waiting for human
        break;
    }
  }

  // 3. Resume tick loop
  runtime.start();
}
```

---

## Implementation Order

```
Phase 0: Database Schema          [Prerequisite]
    ↓
Phase 1.1: TaskPairRepository
    ↓
Phase 1.2: TaskMessageQueue
    ↓
Phase 3.1: Room Agent Tools       ← Human can create tasks
    ↓
Phase 3.2: Craft Agent
    ↓
Phase 3.3: Lead Agent
    ↓
Phase 4: TaskPairManager
    ↓
Phase 2.1: RoomRuntime Tick       ← Autonomous operation!
    ↓
Phase 2.2: Session Observer
    ↓
Phase 5: Message Routing
    ↓
Phase 6: Recovery
```

---

## Minimal Viable Feature Set (The Core)

These are the features we implement in this plan. Everything else is deferred.

### Included

- ✅ Human creates goals/tasks via Room Agent
- ✅ Runtime detects pending tasks
- ✅ Runtime spawns (Craft, Lead) pairs
- ✅ Craft works, Lead reviews
- ✅ Feedback loop until accepted
- ✅ Basic daemon restart recovery

### Deferred (the room builds these after core works)

Once the core is operational, we can use the room itself to implement:

- ⏳ Planning as (Craft, Lead) pair (for now: human creates tasks manually)
- ⏳ Goal review (for now: human marks complete)
- ⏳ Escalation flow (for now: Lead can fail_task)
- ⏳ Human message queueing during Lead review
- ⏳ Interrupt handling
- ⏳ Task timeout
- ⏳ Goal completion detection
- ⏳ Parallel pairs (maxConcurrentPairs > 1)
- ⏳ Escalation SLA / hibernation
- ⏳ `run_verification` tool for Lead

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
10. Loop until Lead calls `complete_task`

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
