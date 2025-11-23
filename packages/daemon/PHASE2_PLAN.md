# Phase 2: Server MessageHub Integration

## Overview

Migrate the daemon from EventBus RPC to MessageHub while maintaining backward compatibility.

## Current Architecture

```
Client (WebSocketClientTransport + RPCManager)
  ↓ WebSocket
Server (WebSocketServerTransport + EventBus)
  ↓ Events (session.create.request, session.create.response)
WebSocketRPCRouter
  ↓ Calls
SessionManager, AuthManager, FileManager
```

## Target Architecture

```
Client (MessageHub + WebSocketClientTransport)
  ↓ WebSocket (MessageHub protocol)
Server (MessageHub + WebSocketServerTransport + Router)
  ↓ RPC (session.create → response)
WebSocketRPCRouter (refactored to use MessageHub.handle())
  ↓ Calls
SessionManager, AuthManager, FileManager
```

## Migration Strategy: Dual Protocol Support

### Step 1: Extract Business Logic (Service Layer)

Create `SessionService`, `FileService`, `SystemService`, `AuthService` that contain pure business logic:

```typescript
// Example: SessionService
export class SessionService {
  constructor(
    private sessionManager: SessionManager,
    private eventBusManager: EventBusManager
  ) {}

  async createSession(req: CreateSessionRequest): Promise<{ sessionId: string }> {
    const sessionId = await this.sessionManager.createSession({
      workspacePath: req.workspacePath,
      initialTools: req.initialTools,
      config: req.config,
    });
    return { sessionId };
  }

  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    await this.sessionManager.deleteSession(sessionId);

    // Broadcast event to all clients
    await this.eventBusManager.broadcast({
      type: "session.deleted",
      sessionId,
      data: {},
    });

    return { success: true };
  }

  // ... other methods
}
```

### Step 2: Update WebSocketRPCRouter

Refactor handlers to delegate to services:

```typescript
export class WebSocketRPCRouter {
  constructor(
    private sessionService: SessionService,
    private fileService: FileService,
    // ...
  ) {}

  setupHandlers(rpcManager: RPCManager, sessionId: string): void {
    eventBus.on("session.create.request", (event) =>
      this.handleSessionCreate(rpcManager, event)
    );
    // ... keep existing handlers
  }

  private async handleSessionCreate(
    rpcManager: RPCManager,
    event: Event
  ): Promise<void> {
    try {
      const result = await this.sessionService.createSession(event.data);
      await rpcManager.respond(
        event.id,
        "session.create.response",
        event.sessionId,
        result
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "session.create.response",
        event.sessionId,
        undefined,
        error.message
      );
    }
  }
}
```

### Step 3: Add MessageHub Handlers

Create new router for MessageHub:

```typescript
export class MessageHubRouter {
  constructor(
    private sessionService: SessionService,
    private fileService: FileService,
    // ...
  ) {}

  setupHandlers(messageHub: MessageHub): void {
    // Session operations - note the simplified method names (no .request suffix)
    messageHub.handle("session.create", async (data) => {
      return await this.sessionService.createSession(data);
    });

    messageHub.handle("session.delete", async (data) => {
      return await this.sessionService.deleteSession(data.sessionId);
    });

    // ... other handlers
  }
}
```

### Step 4: Enable MessageHub in main.ts

```typescript
import { MessageHub, WebSocketServerTransport } from "@liuboer/shared";

// ... existing setup ...

// Create MessageHub
const messageHub = new MessageHub({
  defaultSessionId: "global",
  debug: true,
});

// Create transport
const hubTransport = new WebSocketServerTransport({
  path: "/hub",
});
messageHub.registerTransport(hubTransport);

// Setup MessageHub router
const messageHubRouter = new MessageHubRouter(
  sessionService,
  fileService,
  systemService,
  authService
);
messageHubRouter.setupHandlers(messageHub);

// Keep existing WebSocketRPCRouter for backward compatibility
const rpcRouter = new WebSocketRPCRouter(sessionService, fileService, ...);
rpcRouter.setupHandlers(globalRPCManager, "global");
```

### Step 5: Update EventBusManager

Add method to broadcast events via both EventBus AND MessageHub:

```typescript
export class EventBusManager {
  private messageHub?: MessageHub;

  setMessageHub(hub: MessageHub): void {
    this.messageHub = hub;
  }

  async broadcast(event: { type: string; sessionId: string; data: any }): Promise<void> {
    // Broadcast via EventBus (old clients)
    const eventBus = this.getEventBus(event.sessionId);
    await eventBus.emit({
      id: crypto.randomUUID(),
      type: event.type,
      sessionId: event.sessionId,
      timestamp: new Date().toISOString(),
      data: event.data,
    });

    // Broadcast via MessageHub (new clients)
    if (this.messageHub) {
      await this.messageHub.publish(event.type, event.data, {
        sessionId: event.sessionId,
      });
    }
  }
}
```

## Implementation Tasks

- [ ] Extract business logic to service classes (SessionService, FileService, SystemService, AuthService)
- [ ] Update WebSocketRPCRouter to use services
- [ ] Create MessageHubRouter with MessageHub.handle() calls
- [ ] Enable MessageHub exports in shared/mod.ts
- [ ] Update main.ts to initialize MessageHub alongside EventBus
- [ ] Add broadcast() method to EventBusManager
- [ ] Create integration tests
- [ ] Update documentation

## Testing Strategy

### Phase 2A: Server-side only
1. Keep all clients using EventBus
2. Enable MessageHub handlers on server
3. Verify both protocols work simultaneously
4. Test with integration tests calling both protocols

### Phase 2B: One client migration
1. Migrate Sidebar component to MessageHub
2. Keep ChatContainer on EventBus
3. Verify mixed protocol usage works

### Phase 2C: Full migration
1. Migrate all clients to MessageHub
2. Remove EventBus handlers
3. Clean up old code

## Benefits

✅ **Zero downtime** - Both protocols work simultaneously
✅ **Gradual migration** - Migrate clients one by one
✅ **Easy rollback** - Can revert to EventBus if issues arise
✅ **Testable** - Can test MessageHub handlers without affecting production
✅ **Clean architecture** - Service layer is protocol-agnostic

## Next Steps

Start with Step 1: Extract business logic to SessionService.
