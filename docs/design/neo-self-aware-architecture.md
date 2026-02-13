# Neo Self-Aware Architecture Design

> Design document for making NeoKai self-aware and self-controllable through "Neo" - an AI host that manages rooms and sessions.

## Overview

Neo is an AI orchestrator that manages multiple "rooms" - conceptual workspaces for long-running tasks. **Neo is a client of the daemon**, using MessageHub RPCs just like the web UI, but with in-process transport for efficiency.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DAEMON                                        │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     MessageHub Server                            │   │
│  │   RPCs: session.*, room.*, task.*, memory.*, message.*          │   │
│  └───────────────────────────┬─────────────────────────────────────┘   │
│                              │                                          │
│  ┌───────────────────────────┼─────────────────────────────────────┐   │
│  │                      Storage Layer                               │   │
│  │   Rooms DB │ Tasks DB │ Memories DB │ Contexts DB │ Sessions    │   │
│  └───────────────────────────┴─────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        ┌──────────┐    ┌───────────┐    ┌──────────┐
        │   WEB    │    │    NEO    │    │   CLI    │
        │ (WS)     │    │(in-proc)  │    │  (WS)    │
        │          │    │           │    │          │
        │ UI client│    │AI client  │    │User client│
        └──────────┘    └───────────┘    └──────────┘
```

## Key Architectural Decision

**Neo as Daemon Client** (not internal module):

| Aspect | Decision |
|--------|----------|
| **Communication** | Uses MessageHub RPC interface |
| **Transport** | In-process (same process, no network) |
| **Dependencies** | Only `@neokai/shared` types, Claude SDK |
| **Location** | Separate `packages/neo/` |
| **Relationship** | Peer to web UI and CLI, just smarter |

This means Neo:
- ✅ Calls `session.create` to make worker sessions
- ✅ Calls `message.send` to give instructions
- ✅ Calls `room.*`, `task.*`, `memory.*` RPCs
- ✅ Subscribes to state channels for events
- ❌ Does NOT import DaemonHub, BunDatabase, or daemon internals

## Package Structure

```
packages/
├── shared/                    # Shared types and utilities
│   └── src/
│       ├── types/
│       │   ├── room.ts        # Room, NeoTask, NeoMemory types
│       │   └── neo.ts         # Neo-specific types
│       └── message-hub/
│           └── transports/
│               └── in-process.ts  # In-process MessageHub transport
│
├── daemon/                    # Core daemon (server)
│   └── src/
│       ├── storage/
│       │   └── repositories/
│       │       ├── room-repository.ts
│       │       ├── task-repository.ts
│       │       └── memory-repository.ts
│       └── rpc-handlers/
│           ├── room-handlers.ts    # room.* RPCs
│           ├── task-handlers.ts    # task.* RPCs
│           └── memory-handlers.ts  # memory.* RPCs
│
├── neo/                       # AI orchestrator (daemon client)
│   └── src/
│       ├── room-neo.ts        # Per-room Neo instance
│       ├── lobby-neo.ts       # Meta-Neo for lobby
│       ├── neo-context.ts     # Conversation context management
│       ├── neo-prompt.ts      # System prompts, action parsing
│       ├── neo-session-watcher.ts  # Monitor session events
│       └── index.ts
│
├── web/                       # UI client
├── cli/                       # CLI client
└── e2e/                       # E2E tests
```

## Data Models

### Room

A conceptual workspace for long-running work.

```typescript
interface Room {
  id: string;
  name: string;                        // "Website Development", "Bug Fixes"
  description?: string;

  // Configuration
  defaultWorkspace?: string;           // Optional default workspace path
  defaultModel?: string;               // Optional default model for sessions

  // Session management
  sessionIds: string[];                // Sessions in this room

  // State
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}
```

### Task

A task within a room.

```typescript
interface Task {
  id: string;
  roomId: string;

  // Task definition
  title: string;
  description: string;

  // Assignment
  sessionId?: string;                  // Which session is working on it
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';
  priority: 'low' | 'normal' | 'high' | 'urgent';

  // Progress tracking
  progress?: number;                   // 0-100
  currentStep?: string;

  // Results
  result?: string;
  error?: string;

  // Timestamps
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

### Memory

Room-tagged memory for Neo.

```typescript
interface Memory {
  id: string;
  roomId: string;

  // Memory content
  type: 'conversation' | 'task_result' | 'preference' | 'pattern' | 'note';
  content: string;

  // Metadata
  tags: string[];
  importance: 'low' | 'normal' | 'high';

  // Context
  sessionId?: string;
  taskId?: string;

  // Timestamps
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}
```

### NeoContext

Conversation context for a room's Neo.

```typescript
interface NeoContext {
  id: string;
  roomId: string;

  // Conversation state
  messages: NeoContextMessage[];

  // Token tracking
  totalTokens: number;
  lastCompactedAt?: number;

  // State
  status: 'idle' | 'thinking' | 'waiting_for_input';

  // Current focus
  currentTaskId?: string;
  currentSessionId?: string;
}
```

## RPC Methods (Daemon Side)

### Room Management

```typescript
// Create a new room
'room.create': {
  params: { name: string; description?: string; defaultWorkspace?: string };
  result: Room;
}

// List all rooms
'room.list': {
  params?: { includeArchived?: boolean };
  result: Room[];
}

// Get room details
'room.get': {
  params: { roomId: string };
  result: Room;
}

// Update room
'room.update': {
  params: { roomId: string; updates: Partial<Room> };
  result: Room;
}

// Archive room
'room.archive': {
  params: { roomId: string };
  result: void;
}

// Assign session to room
'room.assignSession': {
  params: { sessionId: string; roomId: string };
  result: void;
}

// Unassign session from room
'room.unassignSession': {
  params: { sessionId: string };
  result: void;
}

// Get room overview (sessions, tasks, status)
'room.overview': {
  params: { roomId: string };
  result: RoomOverview;
}
```

### Task Management

```typescript
'task.create': { params: { roomId: string; title: string; description: string; priority?: string }; result: Task; }
'task.list': { params: { roomId: string; status?: string[] }; result: Task[]; }
'task.get': { params: { taskId: string }; result: Task; }
'task.update': { params: { taskId: string; updates: Partial<Task> }; result: Task; }
'task.delete': { params: { taskId: string }; result: void; }
'task.start': { params: { taskId: string; sessionId: string }; result: Task; }
'task.complete': { params: { taskId: string; result: string }; result: Task; }
'task.fail': { params: { taskId: string; error: string }; result: Task; }
```

### Memory Management

```typescript
'memory.add': { params: { roomId: string; type: string; content: string; tags?: string[] }; result: Memory; }
'memory.list': { params: { roomId: string; type?: string; limit?: number }; result: Memory[]; }
'memory.search': { params: { roomId: string; query: string; limit?: number }; result: Memory[]; }
'memory.delete': { params: { memoryId: string }; result: void; }
```

### Global Status

```typescript
'status.global': {
  params: {};
  result: GlobalStatus;
}

interface GlobalStatus {
  totalRooms: number;
  activeRooms: number;
  totalSessions: number;
  activeSessions: number;
  totalTasks: number;
  pendingTasks: number;
  inProgressTasks: number;
}
```

## Neo Client Implementation

### RoomNeo Class

```typescript
// packages/neo/src/room-neo.ts
export class RoomNeo {
  private hub: MessageHub;           // In-process connection to daemon
  private roomId: string;
  private context: NeoContext;

  constructor(roomId: string, hub: MessageHub) {
    this.roomId = roomId;
    this.hub = hub;
  }

  // Send message to this room's Neo
  async sendMessage(content: string): Promise<void> {
    // 1. Add user message to context
    // 2. Build prompt with room state
    // 3. Call Claude SDK
    // 4. Parse response for actions
    // 5. Execute actions via RPC
    // 6. Add assistant message to context
    // 7. Broadcast update
  }

  // Execute parsed actions
  private async executeAction(action: NeoAction): Promise<void> {
    switch (action.type) {
      case 'create_task':
        await this.hub.request('task.create', { roomId: this.roomId, ...action.params });
        break;
      case 'create_session':
        const { sessionId } = await this.hub.request('session.create', action.params);
        await this.hub.request('room.assignSession', { sessionId, roomId: this.roomId });
        break;
      case 'send_message':
        await this.hub.request('message.send', { sessionId: action.params.sessionId, content: action.params.content });
        break;
      // ... more actions
    }
  }

  // Subscribe to session events in this room
  async subscribeToSessions(): Promise<void> {
    const overview = await this.hub.request('room.overview', { roomId: this.roomId });

    for (const session of overview.sessions) {
      // Subscribe to session state channel
      this.hub.subscribe(`session:${session.id}.state`, (state) => {
        this.handleSessionEvent(session.id, state);
      });
    }
  }

  // Handle session events reactively
  private async handleSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (event.type === 'turn_completed') {
      // Neo might want to react
      await this.onSessionTurnComplete(sessionId, event.data);
    } else if (event.type === 'waiting_for_input') {
      // Notify human or let Neo respond
      await this.onSessionNeedsInput(sessionId, event.data.question);
    }
  }
}
```

### Neo Actions (Parsed from Responses)

```typescript
// packages/shared/src/types/neo.ts
type NeoAction =
  | { type: 'create_task'; params: { title: string; description: string; priority?: string } }
  | { type: 'assign_task'; params: { taskId: string; sessionId: string } }
  | { type: 'create_session'; params: { workspacePath?: string; model?: string } }
  | { type: 'send_message'; params: { sessionId: string; content: string } }
  | { type: 'add_memory'; params: { type: string; content: string; tags?: string[] } }
  | { type: 'complete_task'; params: { taskId: string; result: string } }
  | { type: 'report_status'; params: { message: string } };
```

### System Prompt

```typescript
// packages/neo/src/neo-prompt.ts
export const ROOM_NEO_SYSTEM_PROMPT = `
You are Neo, an AI orchestrator managing a workspace room.

## Your Role

You help humans by:
1. Understanding their requests
2. Breaking them into tasks
3. Delegating to worker sessions
4. Monitoring progress
5. Reporting back

## Your Tools

Respond with structured commands:

\`\`\`neo
ACTION: create_task
title: "Task title"
description: "Full description"
priority: normal|high|urgent
\`\`\`

\`\`\`neo
ACTION: create_session
workspace: "/path/to/workspace"
\`\`\`

\`\`\`neo
ACTION: send_message
session_id: "session-id"
content: "Instructions for the worker"
\`\`\`

\`\`\`neo
ACTION: complete_task
task_id: "task-id"
result: "What was accomplished"
\`\`\`

## Current Room

Room: {roomName}
Sessions: {sessionCount}
Pending Tasks: {pendingTasks}
Active Tasks: {activeTasks}

Be proactive, helpful, and keep humans informed.
`;
```

## Database Schema

```sql
-- Rooms
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  default_workspace TEXT,
  default_model TEXT,
  session_ids TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'blocked', 'completed', 'failed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
  progress INTEGER,
  current_step TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

-- Memories
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('conversation', 'task_result', 'preference', 'pattern', 'note')),
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  importance TEXT NOT NULL DEFAULT 'normal' CHECK(importance IN ('low', 'normal', 'high')),
  session_id TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER DEFAULT 0,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

-- Neo Contexts (per-room conversation)
CREATE TABLE neo_contexts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  total_tokens INTEGER DEFAULT 0,
  last_compacted_at INTEGER,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'thinking', 'waiting_for_input')),
  current_task_id TEXT,
  current_session_id TEXT,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE neo_context_messages (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  session_id TEXT,
  task_id TEXT,
  FOREIGN KEY (context_id) REFERENCES neo_contexts(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_tasks_room ON tasks(room_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_memories_room ON memories(room_id);
CREATE INDEX idx_context_messages_context ON neo_context_messages(context_id);
```

## State Channels

```typescript
// Subscribe to room state
'room:{roomId}:state' → RoomOverview

// Subscribe to all rooms (lobby)
'lobby:rooms' → Room[]

// Subscribe to Neo conversation
'room:{roomId}:neo' → NeoContextMessage[]
```

## Frontend Components

### Page Structure

```
/                    → Lobby (overview of all rooms)
/room/:roomId        → Room page (dashboard + Neo chat)
/session/:sessionId  → Direct session view (existing)
```

### New Components

```
packages/web/src/
├── islands/
│   ├── Lobby.tsx              # Lobby page
│   └── Room.tsx               # Room page
├── components/
│   ├── room/
│   │   ├── RoomCard.tsx       # Room card for lobby
│   │   ├── RoomDashboard.tsx  # Dashboard panel
│   │   ├── RoomSessions.tsx   # Sessions list
│   │   ├── RoomTasks.tsx      # Tasks list
│   │   └── NeoChat.tsx        # Chat with Neo
│   └── lobby/
│       ├── GlobalStatus.tsx   # Global stats
│       └── RoomGrid.tsx       # Grid of room cards
└── lib/
    └── room-store.ts          # Room state management
```

## Implementation Phases

### Phase 1: Refactor Current Implementation

**Goal**: Move Neo to separate package, make it a daemon client

- [ ] Create `packages/neo/` directory
- [ ] Move Neo types to `packages/shared/src/types/`
- [ ] Create in-process transport in shared
- [ ] Refactor RoomNeo to use MessageHub RPC
- [ ] Keep repositories in daemon
- [ ] Rename RPCs to `room.*`, `task.*`, `memory.*`

### Phase 2: Session Integration

**Goal**: Neo can create/monitor sessions

- [ ] Neo calls `session.create` via RPC
- [ ] Neo subscribes to session state channels
- [ ] Neo reacts to `turn_completed`, `waiting_for_input` events
- [ ] Neo can send messages to sessions

### Phase 3: Frontend Room Page

**Goal**: Users can view and interact with rooms

- [ ] Create `/room/:roomId` route
- [ ] Create Room.tsx island
- [ ] Create RoomDashboard, RoomSessions, RoomTasks
- [ ] Create NeoChat component
- [ ] Real-time updates via state channels

### Phase 4: Frontend Lobby Page

**Goal**: Users can see all rooms

- [ ] Update `/` route to show Lobby
- [ ] Create Lobby.tsx island
- [ ] Create RoomGrid, GlobalStatus
- [ ] Lobby-Neo chat
- [ ] Create Room modal

### Phase 5: Polish

**Goal**: Production-ready

- [ ] Error handling
- [ ] Context compaction
- [ ] Tests
- [ ] Documentation

## Decisions Log

| # | Topic | Decision |
|---|-------|----------|
| 1 | Deployment | Daemon mode + CLI |
| 2 | Transport | In-process MessageHub, extendable to WS/stdio |
| 3 | Events | High-level: turn completions, questions, errors |
| 4 | Memory | Persistent with DB |
| 5 | Architecture | Room-based |
| 6 | Room Scope | Conceptual bucket (sessions span workspaces) |
| 7 | Neo Instances | One Neo per room, Lobby has Meta-Neo |
| 8 | Sessions | Neo-driven via RPC |
| 9 | Progress | Dashboard + Neo chat |
| 10 | Context | Shared memory, tagged by room |
| 11 | Workers | Reuse existing sessions via RPC |
| 12 | **Package** | Neo is separate `packages/neo/`, uses MessageHub as client |
| 13 | **RPC namespace** | `room.*`, `task.*`, `memory.*` (not `neo.*` prefix) |

## Success Metrics

- [ ] Neo creates sessions via `session.create` RPC
- [ ] Neo monitors sessions via state channels
- [ ] Neo delegates tasks to worker sessions
- [ ] Room dashboard shows accurate real-time status
- [ ] Users complete multi-session tasks via Neo conversation
