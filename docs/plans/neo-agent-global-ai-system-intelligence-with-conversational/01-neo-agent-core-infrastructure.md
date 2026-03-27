# Milestone 1: Neo Agent Core Infrastructure

## Goal

Establish the foundational infrastructure for the Neo agent: session type, DB schema, provisioning logic, and basic session lifecycle that survives app restarts.

## Scope

- Add `'neo'` to `SessionType` union
- Create `neo_activity_log` table and `neo_settings` in the DB schema
- Create `NeoAgentManager` class that owns Neo's lifecycle
- Create provisioning logic following `provisionGlobalSpacesAgent` pattern
- Wire Neo into `DaemonAppContext` and `createDaemonApp`
- Create Neo system prompt

## Tasks

### Task 1.1: Add Neo SessionType and DB Schema

**Description**: Extend the type system and database to support Neo.

**Subtasks**:
1. Add `'neo'` to the `SessionType` union in `packages/shared/src/types.ts`
2. Add `neoId?: string` to `SessionContext` interface
3. Create DB migration in `packages/daemon/src/storage/schema/migrations.ts`:
   - `neo_activity_log` table: `id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, input TEXT, output TEXT, status TEXT NOT NULL DEFAULT 'success', error TEXT, target_type TEXT, target_id TEXT, undoable INTEGER DEFAULT 0, undo_data TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))`
   - Index on `created_at` for activity feed queries
4. Create `NeoActivityLogRepository` in `packages/daemon/src/storage/repositories/neo-activity-log-repository.ts` with CRUD methods: `insert`, `list` (paginated, newest first), `getById`, `getLatestUndoable`
5. Register the repository in the `Database` facade class
6. Add unit tests for the repository

**Acceptance Criteria**:
- `SessionType` includes `'neo'`
- Migration creates `neo_activity_log` table on DB init
- Repository CRUD operations work correctly
- All tests pass

**Dependencies**: None

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.2: Neo System Prompt and NeoAgentManager

**Description**: Create the Neo agent's system prompt and manager class.

**Subtasks**:
1. Create `packages/daemon/src/lib/neo/` directory structure
2. Create `packages/daemon/src/lib/neo/neo-system-prompt.ts`:
   - Define Neo's identity, role, personality
   - Describe available tool categories
   - Include security tier behavior instructions
   - Include activity logging instructions
3. Create `packages/daemon/src/lib/neo/neo-agent-manager.ts`:
   - `NeoAgentManager` class with `provision()`, `getSession()`, `cleanup()` methods
   - Manages the singleton `neo:global` session
   - Handles first-run creation and restart re-attachment
   - Exposes Neo settings (security mode, model) from SettingsManager
4. Create `packages/daemon/src/lib/neo/index.ts` barrel export
5. Add unit tests for `NeoAgentManager` (mock SessionManager)

**Acceptance Criteria**:
- System prompt covers Neo's full role and behavior
- NeoAgentManager can provision the Neo session
- On restart, existing session is re-attached (not duplicated)
- Unit tests verify provision and re-attach flows

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.3: Wire Neo into Daemon App Lifecycle

**Description**: Integrate NeoAgentManager into `createDaemonApp` and `DaemonAppContext`.

**Subtasks**:
1. Add `neoAgentManager: NeoAgentManager` to `DaemonAppContext` interface in `packages/daemon/src/app.ts`
2. Instantiate `NeoAgentManager` in `createDaemonApp()` after SettingsManager and before RPC handler setup
3. Call `neoAgentManager.provision()` after session manager is ready (similar to `provisionGlobalSpacesAgent` placement)
4. Add `neoAgentManager.cleanup()` to the shutdown sequence
5. Skip provisioning in test mode unless `NEOKAI_ENABLE_NEO_AGENT=1` (matching the spaces agent pattern)
6. Return `neoAgentManager` in the context object
7. Add integration test verifying Neo session exists after daemon startup

**Acceptance Criteria**:
- Neo session is created on first daemon start
- Neo session persists and is re-attached on daemon restart
- Cleanup properly shuts down Neo agent
- Test mode skips provisioning by default

**Dependencies**: Task 1.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
