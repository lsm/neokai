# Milestone 1: Autonomy Level Schema & Types

## Goal

Add the `autonomy_level` concept to the Space system, enabling spaces to be configured as `supervised` (default) or `semi_autonomous`. This provides the foundation for the Space Agent to make different decisions based on the configured autonomy level.

## Scope

- New DB migration adding `autonomy_level` column to `spaces` table
- Updated shared types (`Space`, `CreateSpaceParams`, `UpdateSpaceParams`)
- Updated `SpaceRepository` and `SpaceManager` to read/write the new column
- Updated RPC handlers and global-spaces-tools to expose autonomy level

---

### Task 1.1: Add autonomy_level to shared types and DB schema

**Description:** Add the `SpaceAutonomyLevel` type to `packages/shared/src/types/space.ts`, add the column to the `spaces` table via a new migration, and update the space repository to read/write it.

**Agent type:** coder

**Subtasks:**
1. Define `SpaceAutonomyLevel = 'supervised' | 'semi_autonomous'` in `packages/shared/src/types/space.ts`
2. Add `autonomyLevel?: SpaceAutonomyLevel` field to the `Space` interface (default: `'supervised'`)
3. Add `autonomyLevel?: SpaceAutonomyLevel` to `CreateSpaceParams` and `UpdateSpaceParams`
4. Create a new migration in `packages/daemon/src/storage/schema/migrations.ts` that adds `autonomy_level TEXT NOT NULL DEFAULT 'supervised'` column to the `spaces` table
5. Update `SpaceRepository` (`packages/daemon/src/storage/repositories/space-repository.ts`) to map the new column in read/write operations
6. Write unit tests for the migration (column exists, default value correct) and repository (CRUD with autonomy level)

**Acceptance criteria:**
- `SpaceAutonomyLevel` type exported from shared package
- `Space` interface includes optional `autonomyLevel` field
- New migration adds the column with correct default
- Repository correctly reads/writes autonomy level
- All existing tests continue to pass (default value ensures backward compat)
- New unit tests cover the migration and repository changes

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.2: Update SpaceManager and RPC handlers for autonomy level

**Description:** Update `SpaceManager` to pass through autonomy level in create/update operations, and update RPC handlers and global-spaces-tools to expose it.

**Agent type:** coder

**Subtasks:**
1. Update `SpaceManager.createSpace()` and `SpaceManager.updateSpace()` to accept and pass through `autonomyLevel`
2. Update `global-spaces-tools.ts` `create_space` and `update_space` handlers to accept `autonomy_level` parameter
3. Update `global-spaces-tools.ts` MCP tool definitions to include the new parameter with zod schema
4. Write unit tests for SpaceManager autonomy level handling
5. Write unit tests for the updated tool handlers

**Acceptance criteria:**
- `create_space` and `update_space` tools accept optional `autonomy_level` parameter
- Autonomy level is persisted through the full stack (tool -> manager -> repository -> DB)
- Default autonomy level is `supervised` when not specified
- Unit tests cover create with autonomy level, update autonomy level, and default behavior

**Dependencies:** Task 1.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
