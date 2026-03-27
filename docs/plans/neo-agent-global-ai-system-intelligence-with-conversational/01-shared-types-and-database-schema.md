# Milestone 1: Shared Types and Database Schema

## Goal

Define all Neo-related shared types, extend existing types with Neo support, and create the database migration for Neo's action log table.

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
     - `NeoMessage` interface: `id`, `role` ('user' | 'assistant'), `content` (string), `toolCalls` (optional array), `createdAt`
     - `NeoSettings` interface: `securityMode` (default 'balanced'), `model` (optional), `sessionId` (optional -- stored after first creation)
     - `MessageOrigin = 'human' | 'neo' | 'system'`
  2. Export all new types from `packages/shared/src/mod.ts`
  3. Add `'neo'` to the `SessionType` union in `packages/shared/src/types.ts`
  4. Add optional `origin?: MessageOrigin` field to the message content types used in `MessageContent` or the message metadata interfaces (check `packages/shared/src/types.ts` for the right location)
  5. Extend `GlobalSettings` in `packages/shared/src/types/settings.ts` with `neo?: NeoSettings`
  6. Add `DEFAULT_NEO_SETTINGS` constant: `{ securityMode: 'balanced' }`
- **Acceptance criteria**:
  - All types compile without errors (`bun run typecheck`)
  - Types are exported from `@neokai/shared`
  - `SessionType` includes `'neo'`
  - `GlobalSettings` has optional `neo` field
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 1.2: Database Migration for Neo Action Log

- **Description**: Add a new SQLite migration for the `neo_action_log` table that stores Neo's action history for the activity feed and undo functionality.
- **Agent type**: coder
- **Depends on**: Task 1.1
- **Subtasks**:
  1. Identify the next migration number in `packages/daemon/src/storage/schema/migrations.ts` (currently at 65)
  2. Add migration function `runMigration66` that creates the `neo_action_log` table:
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
  5. Register the migration in `runMigrations()` function
  6. Export the migration function following the existing `knip-ignore-next-line` pattern in `schema/index.ts`
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
