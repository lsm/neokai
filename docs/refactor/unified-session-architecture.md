# Unified Session Architecture Refactor

## Overview

Refactor to unify all chat types (worker/room/lobby) under a single `AgentSession` class, with thin wrappers providing type-specific configuration.

## Principles

1. **AgentSession is generic** - doesn't know about room/lobby specifics
2. **Configuration via constructor** - no if/else on type inside AgentSession
3. **Thin wrappers** - RoomAgentService/LobbyAgentService handle events and config
4. **Feature flags** - control UI features via session config

## Phase 1: Shared Types

### 1.1 Add SessionType

**File:** `packages/shared/src/types/session.ts`

```typescript
export type SessionType = 'worker' | 'room' | 'lobby';

export interface SessionContext {
  roomId?: string;
  lobbyId?: string;
}

export interface SessionFeatures {
  rewind: boolean;
  worktree: boolean;
  coordinator: boolean;
  archive: boolean;
  sessionInfo: boolean;
}

export const DEFAULT_WORKER_FEATURES: SessionFeatures = {
  rewind: true,
  worktree: true,
  coordinator: true,
  archive: true,
  sessionInfo: true,
};

export const DEFAULT_ROOM_FEATURES: SessionFeatures = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
};

export const DEFAULT_LOBBY_FEATURES: SessionFeatures = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
};
```

### 1.2 Update SessionConfig

**File:** `packages/shared/src/types/session.ts`

```typescript
export interface SessionConfig extends SDKConfig {
  // ... existing fields

  // NEW: Session type
  type: SessionType;

  // NEW: Context for room/lobby
  context?: SessionContext;

  // NEW: Feature flags (derived from type, but overridable)
  features: SessionFeatures;
}
```

### 1.3 Update Session interface

**File:** `packages/shared/src/types/session.ts`

```typescript
export interface Session {
  id: string;
  // ... existing fields

  // NEW: Add type (default to 'worker' for existing sessions)
  type: SessionType;

  // NEW: Context for room/lobby
  context?: SessionContext;
}
```

---

## Phase 2: Database Schema

### 2.1 Add migration for sessions table

**File:** `packages/daemon/src/storage/migrations/XXX_add_session_type.sql`

```sql
-- Add type column to sessions table
ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'worker';
ALTER TABLE sessions ADD COLUMN context TEXT; -- JSON blob

-- Create index for room sessions
CREATE INDEX idx_sessions_room ON sessions(json_extract(context, '$.roomId')) WHERE type = 'room';
```

### 2.2 Update SessionRepository

**File:** `packages/daemon/src/storage/repositories/session-repository.ts`

- Add `type` and `context` to INSERT/SELECT queries
- Add method `findByRoomId(roomId: string): Session | null`
- Add method `findLobbySession(): Session | null`

---

## Phase 3: Refactor AgentSession

### 3.1 Create AgentSessionInit interface

**File:** `packages/daemon/src/lib/agent/agent-session.ts`

```typescript
export interface AgentSessionInit {
  sessionId: string;
  workspacePath: string;

  // System prompt - provided by caller
  systemPrompt: SystemPromptConfig;

  // MCP servers - provided by caller (merged with user config)
  mcpServers?: McpServersConfig;

  // Feature flags
  features: SessionFeatures;

  // Optional context
  context?: SessionContext;
}
```

### 3.2 Update AgentSession constructor

**File:** `packages/daemon/src/lib/agent/agent-session.ts`

- Accept `AgentSessionInit` instead of just sessionId
- Store `systemPrompt` and `mcpServers` from init
- Store `features` for later use by frontend

### 3.3 Update QueryOptionsBuilder

**File:** `packages/daemon/src/lib/agent/query-options-builder.ts`

- Use `this.ctx.session.config.systemPrompt` directly (no type-checking)
- Merge `this.ctx.session.config.mcpServers` with user's MCP config
- Remove any type-specific logic

---

## Phase 4: Convert RoomAgentSession → RoomAgentService

### 4.1 Create new RoomAgentService

**File:** `packages/daemon/src/lib/room/room-agent-service.ts`

```typescript
/**
 * RoomAgentService - Thin wrapper around AgentSession for room agents
 *
 * Responsibilities:
 * - Create AgentSession with room-specific config
 * - Handle room events and convert to messages
 * - Manage lifecycle state (idle/planning/reviewing/waiting)
 */
export class RoomAgentService {
  private agentSession: AgentSession;
  private lifecycleState: RoomAgentLifecycleState = 'idle';

  constructor(private ctx: RoomAgentServiceContext) {
    const sessionId = `room:${ctx.room.id}`;

    this.agentSession = new AgentSession({
      sessionId,
      workspacePath: ctx.room.defaultPath ?? ctx.room.allowedPaths[0],

      // Room-specific system prompt
      systemPrompt: this.getSystemPrompt(),

      // Room-specific MCP tools
      mcpServers: this.getMcpServers(),

      // Room features (disabled list)
      features: DEFAULT_ROOM_FEATURES,

      // Context for lookups
      context: { roomId: ctx.room.id },
    });
  }

  // Event handling - enqueues to AgentSession
  async handleEvent(event: RoomEvent): Promise<void> {
    const prompt = this.buildEventPrompt(event);
    await this.agentSession.enqueueMessage(prompt);
  }

  async handleHumanInput(input: RoomAgentHumanInput): Promise<void> {
    // Handle commands locally, pass messages to AgentSession
    if (input.type === 'command') {
      await this.handleCommand(input.content);
    } else {
      await this.agentSession.enqueueMessage(input.content);
    }
  }

  // ... rest of event handling logic
}
```

### 4.2 Update imports

**File:** `packages/daemon/src/lib/room/index.ts`

- Export `RoomAgentService` instead of `RoomAgentSession`
- Keep type exports for backwards compatibility during migration

### 4.3 Update RoomAgentLifecycleManager

**File:** `packages/daemon/src/lib/room/room-agent-lifecycle-manager.ts`

- Use `RoomAgentService` instead of `RoomAgentSession`

---

## Phase 5: Create LobbyAgentService

### 5.1 Create LobbyAgentService

**File:** `packages/daemon/src/lib/lobby/lobby-agent-service.ts`

```typescript
/**
 * LobbyAgentService - Thin wrapper around AgentSession for lobby agent
 *
 * Responsibilities:
 * - Create AgentSession with lobby-specific config
 * - Handle system-wide events (GitHub, room events)
 * - Provide single entry point for human interaction
 */
export class LobbyAgentService {
  private agentSession: AgentSession;

  constructor(private ctx: LobbyAgentServiceContext) {
    const sessionId = 'lobby:default';

    this.agentSession = new AgentSession({
      sessionId,
      workspacePath: ctx.defaultWorkspacePath,

      // Lobby-specific system prompt
      systemPrompt: this.getSystemPrompt(),

      // Lobby-specific MCP tools (if any)
      mcpServers: {},

      // Lobby features (disabled list)
      features: DEFAULT_LOBBY_FEATURES,

      // Context
      context: { lobbyId: 'default' },
    });
  }

  async handleEvent(event: LobbyEvent): Promise<void> {
    const prompt = this.buildEventPrompt(event);
    await this.agentSession.enqueueMessage(prompt);
  }

  // ... rest of event handling logic
}
```

---

## Phase 6: Update ChatContainer

### 6.1 Add feature flags to sessionStore

**File:** `packages/web/src/lib/session-store.ts`

- Expose `features` from session config

### 6.2 Update ChatContainer

**File:** `packages/web/src/islands/ChatContainer.tsx`

```typescript
// Get features from session config
const features = sessionStore.sessionInfo.value?.config?.features ?? DEFAULT_WORKER_FEATURES;

// Conditional rendering
{features.rewind && (
  <RewindButton onClick={enterRewindMode} />
)}

{features.worktree && session.workspacePath && (
  <WorktreeModeToggle
    enabled={worktreeMode}
    onChange={handleWorktreeModeChange}
  />
)}

{features.coordinator && (
  <CoordinatorModeToggle
    enabled={coordinatorMode}
    onChange={handleCoordinatorModeChange}
  />
)}

{features.archive && (
  <ArchiveButton onClick={handleArchive} />
)}

{features.sessionInfo && (
  <SessionInfoButton onClick={openSessionInfo} />
)}
```

---

## Phase 7: Wire Up RoomChat

### 7.1 Create room session on room creation/entry

**File:** `packages/daemon/src/lib/room/room-agent-service.ts`

- When room is entered, create/find room session in sessions table
- Session ID format: `room:{roomId}`

### 7.2 Add RPC handlers for room session

**File:** `packages/daemon/src/lib/rpc-handlers/session-rpc.ts`

- Add handlers for room session operations
- Route based on session type

### 7.3 Update room-store to use session infrastructure

**File:** `packages/web/src/lib/room-store.ts`

- Use `sessionStore` pattern for room session messages
- Keep `roomStore` for room-specific data (tasks, goals, etc.)

### 7.4 Add RoomChat to room view

**File:** `packages/web/src/islands/Room.tsx`

```typescript
// Add tab state
const [activeTab, setActiveTab] = useState<'dashboard' | 'chat'>('dashboard');

// In render
<div class="flex-1 overflow-hidden">
  {/* Tab bar */}
  <div class="flex border-b border-dark-700">
    <button onClick={() => setActiveTab('dashboard')}>Dashboard</button>
    <button onClick={() => setActiveTab('chat')}>Chat</button>
  </div>

  {/* Tab content */}
  {activeTab === 'dashboard' && <RoomDashboard />}
  {activeTab === 'chat' && (
    <ChatContainer sessionId={`room:${roomId}`} />
  )}
</div>
```

---

## Phase 8: Wire Up LobbyChat

### 8.1 Create lobby session on app start

**File:** `packages/daemon/src/lib/lobby/lobby-agent-service.ts`

- Create lobby session on daemon start
- Session ID: `lobby:default`

### 8.2 Add LobbyChat to lobby view

**File:** `packages/web/src/islands/Lobby.tsx`

```typescript
// Add lobby chat panel
{lobbyChatOpen && (
  <ChatContainer sessionId="lobby:default" />
)}
```

### 8.3 Rename NeoChatPanel → LobbyChatPanel

**File:** `packages/web/src/islands/NeoChatPanel.tsx` → `LobbyChatPanel.tsx`

- Update references in App.tsx
- Keep NeoChatPanel as alias during migration

---

## Phase 9: Tests

### 9.1 Update existing tests

- Update AgentSession tests for new constructor
- Update RoomAgentSession tests → RoomAgentService tests

### 9.2 Add new tests

- Test session type persistence
- Test feature flag handling
- Test room session creation
- Test lobby session creation

---

## Migration Strategy

### Step 1: Backwards Compatibility

- Existing sessions default to `type: 'worker'`
- `features` defaults to `DEFAULT_WORKER_FEATURES`
- RoomAgentSession continues to work during transition

### Step 2: Parallel Implementation

- Create new AgentSessionInit interface
- Create RoomAgentService alongside RoomAgentSession
- Both can coexist during testing

### Step 3: Cutover

- Switch RoomAgentLifecycleManager to use RoomAgentService
- Update frontend to use new session pattern
- Remove RoomAgentSession after verification

---

## Files Changed Summary

### Shared
- `packages/shared/src/types/session.ts` - Add SessionType, SessionFeatures, update SessionConfig

### Daemon
- `packages/daemon/src/storage/migrations/` - New migration
- `packages/daemon/src/storage/repositories/session-repository.ts` - Add type/context
- `packages/daemon/src/lib/agent/agent-session.ts` - Accept init config
- `packages/daemon/src/lib/agent/query-options-builder.ts` - Use config directly
- `packages/daemon/src/lib/room/room-agent-service.ts` - NEW (replaces RoomAgentSession)
- `packages/daemon/src/lib/room/room-agent-session.ts` - DEPRECATE
- `packages/daemon/src/lib/room/room-agent-lifecycle-manager.ts` - Use RoomAgentService
- `packages/daemon/src/lib/lobby/lobby-agent-service.ts` - NEW
- `packages/daemon/src/lib/rpc-handlers/session-rpc.ts` - Handle room/lobby sessions

### Web
- `packages/web/src/lib/session-store.ts` - Expose features
- `packages/web/src/islands/ChatContainer.tsx` - Respect feature flags
- `packages/web/src/islands/Room.tsx` - Add ChatContainer tab
- `packages/web/src/islands/Lobby.tsx` - Add LobbyChat
- `packages/web/src/islands/NeoChatPanel.tsx` - Rename to LobbyChatPanel

---

## Timeline

| Phase | Description | Priority |
|-------|-------------|----------|
| 1 | Shared types | High |
| 2 | Database schema | High |
| 3 | Refactor AgentSession | High |
| 4 | RoomAgentService | High |
| 5 | LobbyAgentService | Medium |
| 6 | ChatContainer features | Medium |
| 7 | Wire RoomChat | High |
| 8 | Wire LobbyChat | Medium |
| 9 | Tests | High |
