# MessageHub

Unified RPC + pub/sub over WebSocket. Three-layer architecture:

## Layers

```
┌─────────────────────────────────┐
│  MessageHub (protocol layer)    │  Owns Router + Transport
│  - RPC: request/response        │  - handle() / request()
│  - Pub/Sub: emit / on           │  - subscribe() / publish()
├─────────────────────────────────┤
│  MessageHubRouter (routing)     │  Pure routing, no app logic
│  - Route messages to handlers   │  - Client management
│  - Session-scoped subscriptions │
├─────────────────────────────────┤
│  Transport (I/O layer)          │  WebSocket (server or client)
│  - WebSocketServerTransport     │  - Server-side (daemon)
│  - WebSocketClientTransport     │  - Client-side (web)
└─────────────────────────────────┘
```

## Initialization Order

**Server (daemon):** Router → MessageHub → Transport → bind Transport to Hub
**Client (web):** Transport → MessageHub (auto-connects)

## Key Files

| File | Purpose |
|------|---------|
| `message-hub.ts` | Core protocol: RPC handlers, event subscriptions |
| `router.ts` | Message routing, client registry |
| `websocket-server-transport.ts` | Server-side WebSocket transport |
| `websocket-client-transport.ts` | Client-side WebSocket transport |
| `types.ts` | Message types, handler signatures |

## Common Modifications

- **Add RPC endpoint**: Register handler via `hub.handle('name', handler)` in daemon rpc-handlers
- **Subscribe to events**: `hub.on('event', callback)` — supports session-scoped filtering
- **Emit events**: `hub.emit('event', data)` from daemon to broadcast to connected clients
