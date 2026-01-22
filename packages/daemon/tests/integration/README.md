# Daemon Integration Tests

This directory contains comprehensive integration tests for the Liuboer daemon. These tests verify that multiple components work together correctly.

## Test Files

### Core Session & State Tests

#### `session-rpc.test.ts` - Session Management RPC Integration

Tests all session-related RPC handlers:

- `session.create` - Creating sessions with default and custom config
- `session.list` - Listing all sessions
- `session.get` - Retrieving session details
- `session.update` - Updating session metadata
- `session.delete` - Deleting sessions and cascade cleanup
- EventBus integration - Verifies events are emitted correctly

#### `state-sync.test.ts` - State Synchronization Integration

Tests state management and broadcasting:

- Global state snapshots (sessions, auth, config, health)
- Session-specific state snapshots
- EventBus → StateManager → MessageHub flow
- Per-channel versioning
- Delta updates for efficient state sync
- State channel subscriptions

### WebSocket & Protocol Tests

#### `websocket-messagehub.test.ts` - WebSocket Transport Integration

Tests full WebSocket stack:

- WebSocket connection establishment
- RPC calls over WebSocket
- Error handling over WebSocket
- Pub/Sub event delivery
- Session-based message routing
- Multiple concurrent clients
- Client disconnection handling

#### `messagehub-protocol.test.ts` - MessageHub Protocol Tests

Tests the MessageHub protocol layer:

- RPC request/response handling
- Subscription management
- Event publishing and routing
- Error handling and timeouts

### SDK Integration Tests (Require API Credentials)

These tests require `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and are skipped if credentials are unavailable.

#### `sdk-basic.test.ts` - Basic SDK Functionality

Tests raw Claude Agent SDK functionality:

- Direct SDK query execution
- Message streaming
- Response parsing

#### `agent-session-sdk.test.ts` - AgentSession + SDK Integration

Tests AgentSession's integration with the real Claude Agent SDK:

- Message sending and receiving
- Session state management (idle → queued → processing → idle)
- WebSocket SDK message event broadcasting
- Image handling
- Interrupt handling
- Sequential message processing

#### `message-persistence.test.ts` - Message Persistence

Tests the message persistence bug fix ensuring messages survive crashes:

- WAL mode configuration
- DB write error handling (returns boolean, doesn't crash stream)
- Persist-before-broadcast ordering
- Message order preservation across errors
- Session reload message recovery
- Concurrent read/write handling

### Other Tests

#### `auth.test.ts` - Authentication Integration

Tests authentication system:

- Auth status reporting
- Authentication method detection (API key vs OAuth)
- Auth state broadcasting
- Environment variable credential loading

#### `model-switching.test.ts` - Model Configuration

Tests model selection and switching:

- Default model configuration
- Session-specific model overrides
- Model validation

#### `e2e-workflow.test.ts` - End-to-End Workflows

Tests complete user workflows:

- Full session lifecycle (create → message → update → delete)
- Multi-session independence and isolation
- Multi-tab state synchronization
- Concurrent operations (parallel creates, updates, deletes)
- State snapshot consistency
- Error recovery and rapid create/delete cycles

## Running Tests

```bash
# Run all integration tests (from repo root)
bun test packages/daemon/tests/integration/

# Run specific test file
bun test packages/daemon/tests/integration/session-rpc.test.ts

# Run with verbose output
bun test packages/daemon/tests/integration/ --verbose
```

**Note**: Tests should be run from the repository root, not from `packages/daemon`.

## Test Utilities

The `test-utils.ts` file provides:

- `createTestApp()` - Creates a full daemon instance with in-memory database
- `createWebSocket()` / `createWebSocketWithFirstMessage()` - WebSocket helpers
- `waitForWebSocketMessage()` - Promise-based WebSocket message waiting
- `waitForWebSocketState()` - Wait for WebSocket state changes
- Credential checking: `hasApiKey()`, `hasOAuthToken()`, `hasAnyCredentials()`
- `createMockMessageHub()` - Mock for unit tests

## Test Philosophy

These integration tests focus on:

1. **Component Integration** - Testing how multiple components work together (MessageHub + SessionManager + StateManager + Database)
2. **Event Flow** - Verifying EventBus mediates between components correctly
3. **State Consistency** - Ensuring state stays synchronized across all layers
4. **Real Transport** - WebSocket tests use actual WebSocket connections (not mocked)
5. **Real SDK** - SDK integration tests use real Claude API calls (when credentials available)

## Test Configuration

Tests use special configuration for fast, reliable execution:

- In-memory SQLite database with WAL mode
- Worktrees disabled by default (`disableWorktrees: true`)
- Haiku model for SDK tests (faster, cheaper)
- 15 second timeout for `waitForIdle()` (SDK init + API call)
- `mock.restore()` in SDK tests to prevent mock leakage from unit tests

## Test Coverage (108 tests)

These integration tests cover:

- ✅ Session CRUD operations (create, read, update, delete)
- ✅ Message management and persistence
- ✅ State channel broadcasting
- ✅ EventBus event propagation
- ✅ Database cascade deletes and WAL mode
- ✅ Per-channel versioning
- ✅ WebSocket RPC calls
- ✅ WebSocket pub/sub
- ✅ Multi-client scenarios
- ✅ Concurrent operations
- ✅ Error handling and recovery
- ✅ Authentication status
- ✅ Real SDK message streaming
- ✅ Session state machine transitions
- ✅ Interrupt handling
- ✅ Model configuration

## Architecture Tested

```
┌─────────────────────────────────────────────────┐
│             Integration Test Layer              │
├─────────────────────────────────────────────────┤
│  WebSocket  │  MessageHub  │   EventBus         │
├─────────────┼──────────────┼────────────────────┤
│  RPC        │ StateManager │  SessionManager    │
│  Handlers   │              │  AgentSession      │
├─────────────┼──────────────┼────────────────────┤
│   Claude Agent SDK         │    MessageQueue    │
├─────────────┴──────────────┴────────────────────┤
│         Database (in-memory SQLite + WAL)       │
└─────────────────────────────────────────────────┘
```

Each test file focuses on different horizontal or vertical slices of this architecture, ensuring all integration points work correctly.
