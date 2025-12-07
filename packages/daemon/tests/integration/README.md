# Daemon Integration Tests

This directory contains comprehensive integration tests for the Liuboer daemon. These tests verify that multiple components work together correctly.

## Test Files

### 1. `session-rpc.test.ts` - Session Management RPC Integration

Tests all session-related RPC handlers:

- `session.create` - Creating sessions with default and custom config
- `session.list` - Listing all sessions
- `session.get` - Retrieving session details
- `session.update` - Updating session metadata
- `session.delete` - Deleting sessions and cascade cleanup
- EventBus integration - Verifies events are emitted correctly

### 2. `state-sync.test.ts` - State Synchronization Integration

Tests state management and broadcasting:

- Global state snapshots (sessions, auth, config, health)
- Session-specific state snapshots
- EventBus → StateManager → MessageHub flow
- Per-channel versioning
- Delta updates for efficient state sync
- State channel subscriptions

### 3. `websocket-messagehub.test.ts` - WebSocket Transport Integration

Tests full WebSocket stack:

- WebSocket connection establishment
- RPC calls over WebSocket
- Error handling over WebSocket
- Pub/Sub event delivery
- Session-based message routing
- Multiple concurrent clients
- Client disconnection handling

### 4. `auth.test.ts` - Authentication Integration

Tests authentication system:

- Auth status reporting
- Authentication method detection (API key vs OAuth)
- Auth state broadcasting
- Environment variable credential loading
- Auth manager initialization

### 5. `e2e-workflow.test.ts` - End-to-End Workflows

Tests complete user workflows:

- Full session lifecycle (create → message → update → delete)
- Multi-session independence and isolation
- Multi-tab state synchronization
- Concurrent operations (parallel creates, updates, deletes)
- State snapshot consistency
- Error recovery and rapid create/delete cycles

## Test Philosophy

These integration tests focus on:

1. **Component Integration** - Testing how multiple components work together (MessageHub + SessionManager + StateManager + Database)
2. **Event Flow** - Verifying EventBus mediates between components correctly
3. **State Consistency** - Ensuring state stays synchronized across all layers
4. **No External APIs** - Tests use in-memory database and don't make real Claude API calls for speed
5. **Real Transport** - WebSocket tests use actual WebSocket connections (not mocked)

## Test Utilities

The `test-utils.ts` file provides:

- `createTestApp()` - Creates a full daemon instance with in-memory database
- `callRPCHandler()` - Directly invokes RPC handlers for testing
- `createWebSocket()` - Helper for WebSocket connection creation
- `waitForWebSocketMessage()` - Promise-based WebSocket message waiting
- Credential checking utilities (`hasApiKey()`, `hasOAuthToken()`, etc.)

## Current Status

⚠️ **Note**: These tests need refinement in the test infrastructure:

1. MessageHub's `publish()` method currently requires a connected transport
2. For server-side testing, we need either:
   - A local/null transport that doesn't throw
   - MessageHub should gracefully handle no-transport scenarios
   - Or use direct manager calls instead of going through MessageHub

The test structure and coverage are comprehensive, but the execution layer needs adjustment to work without requiring WebSocket clients to be connected for pub/sub operations.

## Running Tests

```bash
# Run all integration tests
cd packages/daemon
bun test tests/integration/

# Run specific test file
bun test tests/integration/session-rpc.test.ts

# Run with verbose output
bun test tests/integration/ --verbose
```

## Test Coverage

These integration tests cover:

- ✅ Session CRUD operations (create, read, update, delete)
- ✅ Message management
- ✅ State channel broadcasting
- ✅ EventBus event propagation
- ✅ Database cascade deletes
- ✅ Per-channel versioning
- ✅ WebSocket RPC calls
- ✅ WebSocket pub/sub
- ✅ Multi-client scenarios
- ✅ Concurrent operations
- ✅ Error handling and recovery
- ✅ Authentication status

## Next Steps

To make these tests fully functional:

1. Add a `LocalTransport` or `NullTransport` for server-side testing
2. Or modify `MessageHub.publish()` to not throw when no transport is connected
3. Update `SessionManager` to handle publish failures gracefully in test mode
4. Consider adding a test mode flag that bypasses transport requirements

## Architecture Tested

```
┌─────────────────────────────────────────────┐
│           Integration Test Layer             │
├─────────────────────────────────────────────┤
│  WebSocket  │  MessageHub  │   EventBus     │
├─────────────┼──────────────┼────────────────┤
│  RPC        │  StateManager│   Session      │
│  Handlers   │              │   Manager      │
├─────────────┼──────────────┼────────────────┤
│         Database (in-memory SQLite)          │
└─────────────────────────────────────────────┘
```

Each test file focuses on different horizontal or vertical slices of this architecture, ensuring all integration points work correctly.
