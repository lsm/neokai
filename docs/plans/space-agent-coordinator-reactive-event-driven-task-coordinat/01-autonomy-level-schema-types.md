# Milestone 1: Autonomy Level Schema & Types

## Goal

Add the `autonomy_level` concept to the Space system, enabling spaces to be configured as `supervised` (default) or `semi_autonomous`. This provides the foundation for the Space Agent to make different decisions based on the configured autonomy level.

## Scope

- New DB migration adding `autonomy_level` column to `spaces` table
- Updated shared types (`Space`, `CreateSpaceParams`, `UpdateSpaceParams`)
- New typed `SpaceConfig` interface replacing `Record<string, unknown>` for `Space.config`
- Updated `SpaceRepository` and `SpaceManager` to read/write the new column
- Updated RPC handlers, space-handlers, and global-spaces-tools to expose autonomy level

---

### Task 1.1: Add autonomy_level to shared types and DB schema

**Description:** Add the `SpaceAutonomyLevel` type to `packages/shared/src/types/space.ts`, add the column to the `spaces` table via a new migration, and update the space repository to read/write it.

**Agent type:** coder

**Subtasks:**
1. Define `SpaceAutonomyLevel = 'supervised' | 'semi_autonomous'` in `packages/shared/src/types/space.ts`
2. Add `autonomyLevel?: SpaceAutonomyLevel` field to the `Space` interface (default: `'supervised'`)
3. Add `autonomyLevel?: SpaceAutonomyLevel` to `CreateSpaceParams` and `UpdateSpaceParams`
4. Define a typed `SpaceConfig` interface in `packages/shared/src/types/space.ts` with fields: `taskTimeoutMs?: number`, `maxConcurrentTasks?: number`. Replace the current `config?: Record<string, unknown>` on the `Space` interface with `config?: SpaceConfig`. This provides type-safe access for timeout detection in Milestone 2 and future runtime config.
5. Create a new migration in `packages/daemon/src/storage/schema/migrations.ts` that adds `autonomy_level TEXT NOT NULL DEFAULT 'supervised'` column to the `spaces` table
6. Update `SpaceRepository` (`packages/daemon/src/storage/repositories/space-repository.ts`) to map the new column in read/write operations
7. Write unit tests for the migration (column exists, default value correct) and repository (CRUD with autonomy level)

**Acceptance criteria:**
- `SpaceAutonomyLevel` type exported from shared package
- `SpaceConfig` interface exported with typed fields (`taskTimeoutMs`, `maxConcurrentTasks`)
- `Space` interface includes optional `autonomyLevel` field and typed `config` field
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
4. Audit and update any RPC handlers that proxy space CRUD (check `space-handlers.ts` and `global-spaces-handlers.ts`) to also pass through autonomy level. Note: `global-spaces-handlers.ts` currently only has `spaces.global.setActiveSpace` -- no space CRUD handlers there. Check `space-handlers.ts` for `space.create`/`space.update` handlers that may need updating.
5. Write unit tests for SpaceManager autonomy level handling
6. Write unit tests for the updated tool and RPC handlers

**Acceptance criteria:**
- `create_space` and `update_space` tools accept optional `autonomy_level` parameter
- Any space CRUD RPC handlers also pass through autonomy level
- Autonomy level is persisted through the full stack (tool -> manager -> repository -> DB)
- Default autonomy level is `supervised` when not specified
- Unit tests cover create with autonomy level, update autonomy level, and default behavior

**Dependencies:** Task 1.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
