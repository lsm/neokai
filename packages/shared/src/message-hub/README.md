# MessageHub - Unified Messaging System

> WAMP-inspired unified messaging protocol for bidirectional RPC and Pub/Sub

## Overview

MessageHub is a unified messaging system that combines **Request/Response (RPC)** and **Publish/Subscribe** patterns into a single, elegant API. Inspired by the WAMP (Web Application Messaging Protocol), it provides:

- ✅ **Bidirectional RPC** - Both client and server can initiate calls
- ✅ **Pub/Sub messaging** - Event-based communication
- ✅ **Session-based routing** - `sessionId` in messages, not URLs
- ✅ **Single WebSocket connection** - One connection serves all sessions
- ✅ **Hybrid patterns** - `callAndPublish()` for reactive mutations
- ✅ **Type-safe** - Full TypeScript support

## Architecture

### Message Flow

```
┌─────────────────────────────────────────────────────┐
│                  Single WebSocket                    │
│            ws://host/ws (no sessionId!)              │
└─────────────────┬───────────────────────────────────┘
                  │
        ┌─────────┴─────────┐
        │   MessageHub      │
        │   Router          │
        └─────────┬─────────┘
                  │
    ┌─────────────┼─────────────┐
    │             │             │
┌───▼────┐  ┌────▼────┐  ┌─────▼────┐
│ global │  │session-1│  │session-2 │
│ session│  │ session │  │ session  │
└────────┘  └─────────┘  └──────────┘

Routes by sessionId in each message!
```

### Key Differences from Old Architecture

| Aspect | Old (EventBus + RPC) | New (MessageHub) |
|--------|---------------------|------------------|
| **Connections** | Multiple (`/ws/{sessionId}`) | Single (`/ws`) |
| **Session Routing** | URL path | Message field |
| **RPC Direction** | Client → Server only | Bidirectional ↔ |
| **API** | 2 separate clients | 1 unified client |
| **Message Format** | Inconsistent | Unified `HubMessage` |

## Message Protocol

### Message Types

```typescript
enum MessageType {
  // RPC
  CALL = "CALL",           // RPC request
  RESULT = "RESULT",       // RPC success response
  ERROR = "ERROR",         // RPC error response

  // Pub/Sub
  PUBLISH = "PUBLISH",     // Publish event
  EVENT = "EVENT",         // Event delivery
  SUBSCRIBE = "SUBSCRIBE", // Subscribe (optional)
  UNSUBSCRIBE = "UNSUBSCRIBE",

  // Utilities
  PING = "PING",
  PONG = "PONG"
}
```

### Message Structure

```typescript
interface HubMessage {
  id: string;              // Unique message UUID
  type: MessageType;       // Message type
  sessionId: string;       // "global" or specific session
  method: string;          // e.g., "session.create", "sdk.message"
  data?: unknown;          // Payload
  requestId?: string;      // For RPC responses
  error?: string;          // For ERROR type
  timestamp: string;       // ISO 8601
}
```

### Message Examples

**Client RPC call:**
```json
{
  "id": "msg-001",
  "type": "CALL",
  "sessionId": "global",
  "method": "session.create",
  "data": { "workspacePath": "/path" },
  "timestamp": "2025-01-23T10:00:00Z"
}
```

**Server response:**
```json
{
  "id": "msg-002",
  "type": "RESULT",
  "sessionId": "global",
  "method": "session.create",
  "requestId": "msg-001",
  "data": { "sessionId": "abc-123" },
  "timestamp": "2025-01-23T10:00:01Z"
}
```

**Event broadcast:**
```json
{
  "id": "msg-003",
  "type": "EVENT",
  "sessionId": "global",
  "method": "session.created",
  "data": { "sessionId": "abc-123" },
  "timestamp": "2025-01-23T10:00:01Z"
}
```

**Server→Client RPC (bidirectional!):**
```json
{
  "id": "msg-004",
  "type": "CALL",
  "sessionId": "abc-123",
  "method": "client.getViewportInfo",
  "data": {},
  "timestamp": "2025-01-23T10:00:02Z"
}
```

## API Usage

### Client-Side

```typescript
import { MessageHub, WebSocketClientTransport } from "@liuboer/shared";

// Create MessageHub
const hub = new MessageHub({
  defaultSessionId: "global",
  debug: true
});

// Register transport (single connection!)
const transport = new WebSocketClientTransport({
  url: "ws://localhost:8283/ws",  // NO sessionId in URL!
  autoReconnect: true
});

hub.registerTransport(transport);
await transport.initialize();

// === RPC Calls ===

// Client → Server
const { sessionId } = await hub.call("session.create", {
  workspacePath: "/path"
}, { sessionId: "global" });

// Handle Server → Client calls (bidirectional!)
hub.handle("client.getViewportInfo", async () => {
  return {
    width: window.innerWidth,
    height: window.innerHeight
  };
});

// === Pub/Sub ===

// Subscribe to events
hub.subscribe("session.deleted", ({ sessionId }) => {
  console.log("Session deleted:", sessionId);
  // Auto-update UI
}, { sessionId: "global" });

// Publish events
await hub.publish("custom.event", { data: "test" });

// === Hybrid Pattern (callAndPublish) ===

// Perfect for mutations that should notify all UIs!
await hub.callAndPublish(
  "session.delete",     // RPC: get confirmation
  "session.deleted",    // Event: broadcast to all clients
  { sessionId: "abc-123" },
  { sessionId: "global" }
);
```

### Server-Side

```typescript
import { MessageHub, MessageHubRouter, WebSocketServerTransport } from "@liuboer/shared";

// Create MessageHub
const hub = new MessageHub({ defaultSessionId: "global" });
const router = new MessageHubRouter();

// Register transport
const transport = new WebSocketServerTransport();
hub.registerTransport(transport);
await transport.initialize();

// === Handle RPC Calls ===

hub.handle("session.create", async (data, context) => {
  const sessionId = await sessionManager.createSession(data);

  // Auto-publish event to all clients
  await hub.publish("session.created", {
    sessionId,
    title: data.title || "New Session"
  }, { sessionId: "global" });

  return { sessionId };
});

hub.handle("session.delete", async (data) => {
  await sessionManager.deleteSession(data.sessionId);

  // Event broadcast handled by client's callAndPublish()
  return { success: true };
});

// === Server→Client RPC ===

// Ask client for viewport info
const viewport = await hub.call("client.getViewportInfo", {}, {
  sessionId: "abc-123"
});

console.log("Client viewport:", viewport);

// === WebSocket Handling ===

handleWebSocket(ws: WebSocket) {
  const clientId = router.registerClient(ws);
  transport.subscribeWebSocket(ws);

  // Auto-subscribe to common events
  router.autoSubscribe(ws, "global");

  ws.on("close", () => {
    router.unregisterClient(ws);
    transport.unsubscribeWebSocket(ws);
  });
}
```

## Session Routing

### Global Session

```typescript
sessionId: "global"
```

Used for:
- Session management: `session.create`, `session.list`, `session.delete`
- System operations: `system.health`, `system.config`
- Authentication: `auth.status`
- Settings: `settings.update`

### Specific Sessions

```typescript
sessionId: "abc-123"  // Actual session ID
```

Used for:
- Messages: `message.send`, `message.list`
- SDK events: `sdk.message`
- Context: `context.updated`
- Files: `file.read`, `file.list`

## Method Naming Convention

Format: `<domain>.<action>[.<type>]`

Examples:
- **RPC methods**: `session.create`, `message.send`, `file.read`
- **Events**: `session.created`, `session.deleted`, `sdk.message`
- **Client methods** (server→client RPC): `client.getViewportInfo`, `client.confirmAction`

## Features

### 1. Bidirectional RPC

Both client and server can initiate calls:

```typescript
// Client → Server
const result = await hub.call("session.create", data);

// Server → Client
const viewport = await hub.call("client.getViewportInfo", {}, {
  sessionId: "abc-123"
});
```

### 2. Reactive Updates with callAndPublish

Perfect for mutations that should update all UIs automatically:

```typescript
// Client side
await hub.callAndPublish(
  "session.delete",
  "session.deleted",
  { sessionId }
);

// All components automatically react:
hub.subscribe("session.deleted", ({ sessionId }) => {
  setSessions(prev => prev.filter(s => s.id !== sessionId));
});
```

### 3. Session-Based Routing

Messages are routed by `sessionId` in the message, not URL:

- Single WebSocket connection per client
- Instant session switching (no reconnection!)
- URL reserved for future namespacing

### 4. Auto-Subscriptions

Server can auto-subscribe clients to common events:

```typescript
// Global session → session management events
router.autoSubscribe(ws, "global");
// Subscribes to: session.created, session.updated, session.deleted

// Specific session → session-specific events
router.autoSubscribe(ws, "session-123");
// Subscribes to: sdk.message, context.updated, message.queued
```

### 5. Message Inspection

Debug and log all messages:

```typescript
hub.onMessage((message, direction) => {
  console.log(`[${direction}] ${message.type} ${message.method}`, message);
});
```

## File Structure

```
packages/shared/src/message-hub/
├── protocol.ts                      # Message types and protocol
├── types.ts                         # TypeScript types
├── message-hub.ts                   # Core MessageHub class
├── router.ts                        # Server-side routing
├── transport-websocket-client.ts    # Client transport
├── transport-websocket-server.ts    # Server transport
├── index.ts                         # Public API
├── README.md                        # This file
└── __tests__/
    ├── protocol.test.ts             # Protocol tests
    ├── message-hub.test.ts          # Core tests
    └── router.test.ts               # Router tests
```

## Migration from EventBus + RPC

### Before

```typescript
import { websocketApiClient } from "../lib/websocket-api-client";
import { eventBusClient } from "../lib/event-bus-client";

// Two clients, manual reload
await websocketApiClient.deleteSession(sessionId);
const sessions = await websocketApiClient.listSessions();
setSessions(sessions);
```

### After

```typescript
import { messageHub } from "../lib/message-hub-client";

// One client, auto-reactive
await messageHub.callAndPublish(
  "session.delete",
  "session.deleted",
  { sessionId }
);

// UI updates automatically via subscription:
useEffect(() => {
  return messageHub.subscribe("session.deleted", ({ sessionId }) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId));
  });
}, []);
```

## Benefits

### For Developers
- ✅ Single API instead of two
- ✅ Auto-reactive components
- ✅ Type-safe method registry
- ✅ Cleaner, less boilerplate
- ✅ Better debugging (unified message inspection)

### For Users
- ✅ Faster UI (instant session switching)
- ✅ Real-time updates across all components
- ✅ Multi-tab support (changes sync automatically)
- ✅ Better UX (server can proactively communicate)

### For Architecture
- ✅ Scalable (1 WebSocket per client, not per session)
- ✅ Flexible (sessionId in messages, URL for namespaces)
- ✅ Extensible (easy to add new methods/events)
- ✅ Standard (follows WAMP protocol patterns)
- ✅ Future-proof (ready for multi-tenant)

## Next Steps (Phase 2)

1. **Server Integration**
   - Create `MessageHubRouter` in daemon
   - Migrate RPC handlers
   - Support both protocols during migration

2. **Client Integration**
   - Create unified client wrapper
   - Migrate components one by one
   - Start with Sidebar, then ChatContainer

3. **Testing**
   - Integration tests
   - End-to-end tests
   - Performance benchmarks

4. **Documentation**
   - Usage guides
   - Migration guide
   - API reference

## License

Part of the Liuboer project.
