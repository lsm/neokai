# RPC Handlers

Each file exports a `setup*Handlers(hub, app)` function registered in `index.ts`.

## Pattern

```typescript
// example-handlers.ts
export function setupExampleHandlers(hub: MessageHub, app: DaemonApp) {
  hub.handle('example.action', async (params, context) => {
    // 1. Extract params
    // 2. Call business logic via app managers
    // 3. Return result or emit events
    return { success: true };
  });
}
```

## Handler Files

| File | Domain | Key RPCs |
|------|--------|----------|
| `session-handlers.ts` | Session lifecycle | session.create, session.delete, session.list |
| `message-handlers.ts` | Chat messages | message.send, message.list |
| `file-handlers.ts` | File operations | file.read, file.write, file.list |
| `room-handlers.ts` | Room management | room.create, room.update |
| `goal-handlers.ts` | Room goals | goal.create, goal.list |
| `task-handlers.ts` | Room tasks | task.create, task.retry, task.cancel |
| `config-handlers.ts` | Provider config | config.get, config.update |
| `settings-handlers.ts` | App settings | settings.get, settings.update |
| `rewind-handlers.ts` | Checkpoint/rewind | rewind.create, rewind.restore |
| `template-handlers.ts` | Session/Room templates | template.list, template.create, template.delete |

## Adding a New RPC Endpoint

1. Create or extend a handler file in this directory
2. Register it in `index.ts` by calling `setup*Handlers(hub, app)`
3. Add the RPC type to `@neokai/shared` types (if needed for frontend)
4. Add the frontend call in the web package (via `hub.request(...)`)
