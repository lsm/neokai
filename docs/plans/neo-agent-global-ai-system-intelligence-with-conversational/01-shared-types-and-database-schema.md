# Milestone 1: Shared Types, Database Schema, and Origin Metadata

## Goal

Define all Neo-related shared types, extend existing types with Neo support, create the database migration for Neo's action log table, and implement origin metadata propagation in the message pipeline. Origin metadata is placed here (not in a later milestone) because write tools in Milestone 4 depend on it.

## Tasks

### Task 1.1: Define Neo Shared Types

- **Description**: Add Neo-specific types to `packages/shared/src/types/` covering security modes, action logging, origin metadata, and Neo settings.
- **Agent type**: coder
- **Depends on**: (none)
- **Subtasks**:
  1. Create `packages/shared/src/types/neo.ts` with:
     - `NeoSecurityMode = 'conservative' | 'balanced' | 'autonomous'`
     - `NeoActionRiskLevel = 'low' | 'medium' | 'high'`
     - `NeoActionStatus = 'pending_confirmation' | 'confirmed' | 'auto_executed' | 'cancelled' | 'failed' | 'undone'`
     - `NeoActionLog` interface: `id`, `actionType`, `toolName`, `toolInput` (JSON), `toolOutput` (JSON), `riskLevel`, `status`, `targetType` (room/space/goal/task/skill/mcp/settings), `targetId`, `undoData` (JSON, nullable -- stores reversal info), `createdAt`, `completedAt`
     - `NeoMessage` interface: `id`, `role` ('user' | 'assistant'), `content` (string), `toolCalls` (optional array), `createdAt`. **Note**: This is a frontend projection type — Neo messages are stored in the `sdk_messages` table (same as all sessions) and projected via row mappers. `NeoMessage` is NOT a DB table.
     - `NeoSettings` interface: `securityMode` (default 'balanced'), `model` (optional), `sessionId` (optional -- stored after first creation)
     - `MessageOrigin = 'human' | 'neo' | 'system'`
  2. Export all new types from `packages/shared/src/mod.ts`
  3. Add `'neo'` to the `SessionType` union in `packages/shared/src/types.ts`
  4. Add `'neo'` to the `CreateSessionParams.sessionType` union in `packages/daemon/src/lib/session/session-lifecycle.ts` (this has its own narrower union separate from `SessionType`)
  5. Add optional `origin?: MessageOrigin` field to the message content types used in `MessageContent` or the message metadata interfaces (check `packages/shared/src/types.ts` for the right location)
  6. Extend `GlobalSettings` in `packages/shared/src/types/settings.ts` with `neo?: NeoSettings`
  7. Add `DEFAULT_NEO_SETTINGS` constant: `{ securityMode: 'balanced' }`
- **Acceptance criteria**:
  - All types compile without errors (`bun run typecheck`)
  - Types are exported from `@neokai/shared`
  - `SessionType` includes `'neo'` in both `packages/shared` and `CreateSessionParams` in `session-lifecycle.ts`
  - `GlobalSettings` has optional `neo` field
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 1.2: Database Migration for Neo Action Log

- **Description**: Add a new SQLite migration for the `neo_action_log` table that stores Neo's action history for the activity feed and undo functionality.
- **Agent type**: coder
- **Depends on**: Task 1.1
- **Subtasks**:
  1. Identify the next available migration number in `packages/daemon/src/storage/schema/migrations.ts` at implementation time (do NOT hardcode — other PRs may have added migrations)
  2. Add migration function `runMigrationNN` (where NN is the next available number) that creates the `neo_action_log` table:
     ```sql
     CREATE TABLE IF NOT EXISTS neo_action_log (
       id TEXT PRIMARY KEY,
       action_type TEXT NOT NULL,
       tool_name TEXT NOT NULL,
       tool_input TEXT NOT NULL DEFAULT '{}',
       tool_output TEXT,
       risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high')),
       status TEXT NOT NULL CHECK(status IN ('pending_confirmation', 'confirmed', 'auto_executed', 'cancelled', 'failed', 'undone')),
       target_type TEXT,
       target_id TEXT,
       undo_data TEXT,
       created_at TEXT NOT NULL,
       completed_at TEXT
     )
     ```
  3. Add index on `created_at` for activity feed queries (descending order)
  4. Add index on `status` for pending confirmation lookups
  5. Check if the `sessions` table has a CHECK constraint on the `type` column. If so, add an ALTER or migration step to extend it to include `'neo'`. (Pattern: check existing migrations for how `spaces_global` was added.)
  6. Register the migration in `runMigrations()` function
  7. Export the migration function following the existing `knip-ignore-next-line` pattern in `schema/index.ts`
- **Acceptance criteria**:
  - Migration runs without errors on a fresh database
  - Migration is idempotent (safe to run twice)
  - Table schema matches the `NeoActionLog` type from Task 1.1
  - Indexes exist for `created_at` and `status`
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 1.3: Neo Action Log Repository

- **Description**: Create a repository class for CRUD operations on the `neo_action_log` table, following the existing repository pattern in `packages/daemon/src/storage/repositories/`.
- **Agent type**: coder
- **Depends on**: Task 1.2
- **Subtasks**:
  1. Create `packages/daemon/src/storage/repositories/neo-action-log-repository.ts`
  2. Implement `NeoActionLogRepository` class with methods:
     - `create(action: Omit<NeoActionLog, 'id'>): NeoActionLog` -- insert with generated UUID
     - `updateStatus(id: string, status: NeoActionStatus, output?: string): void`
     - `getById(id: string): NeoActionLog | null`
     - `getRecent(limit?: number, offset?: number): NeoActionLog[]` -- ordered by `created_at` DESC
     - `getPendingConfirmations(): NeoActionLog[]` -- status = 'pending_confirmation'
     - `getLastAction(): NeoActionLog | null` -- most recent completed action (for undo)
     - `markUndone(id: string): void`
  3. Add row mapper to convert snake_case DB rows to camelCase `NeoActionLog` objects
  4. Write unit tests in `packages/daemon/tests/unit/storage/neo-action-log-repository.test.ts`
- **Acceptance criteria**:
  - All repository methods work correctly against an in-memory SQLite database
  - Row mapping correctly converts between DB format and TypeScript types
  - Unit tests cover all CRUD operations, edge cases (empty results, not found)
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 1.4: Origin Metadata Propagation

- **Description**: Add `origin` field support to the message system so messages sent by Neo are properly attributed. This is placed in Milestone 1 (not later) because write tools in Milestone 4 depend on origin metadata for `send_message_to_room` and gate operations.
- **Agent type**: coder
- **Depends on**: Task 1.1
- **Subtasks**:
  1. Add optional `origin?: MessageOrigin` field to the message content type in `packages/shared/src/types.ts` (verify the exact type to extend — likely `MessageContent` or the message metadata)
  2. Update `MessagePersistence` in `packages/daemon/src/lib/session/message-persistence.ts` to persist and retrieve the origin field
  3. Update the message sending flow to accept and propagate origin:
     - `SessionManager.sendMessage()` accepts optional `origin` parameter
     - Origin is stored in message metadata
  4. Default to `'human'` for backward compatibility when `origin` is not specified
  5. Write unit tests verifying origin propagation through the message pipeline
- **Acceptance criteria**:
  - Messages sent with `origin: 'neo'` persist the origin in metadata
  - Messages sent by humans default to `origin: 'human'` (or undefined for backward compat)
  - Origin field persists through DB storage and retrieval
  - Existing message flows are not broken (origin is optional)
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
