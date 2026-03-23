# Milestone 1: Schema and Type Updates

## Goal

Redesign the `space_session_groups` and `space_session_group_members` DB tables and shared TypeScript types to support flexible multi-agent groups with freeform roles, agent references, and member status tracking.

## Scope

- New DB migration (the next available migration number (determined at implementation time)) adding columns to session group tables
- Updated shared types in `packages/shared/src/types/space.ts`
- Updated repository CRUD in `SpaceSessionGroupRepository`
- Unit tests for all repository operations with new fields

---

### Task 1.1: Add DB Migration for Flexible Session Groups

**Description:** Create the next available migration number (determined at implementation time) that adds new columns to `space_session_groups` and `space_session_group_members` tables. Since Space is pre-production, this migration modifies the existing tables with ALTER TABLE ADD COLUMN statements (idempotent pattern matching existing migrations).

**Subtasks:**
1. Add `task_id TEXT` column to `space_session_groups` (nullable, links group to SpaceTask)
2. Add `agent_id TEXT` column to `space_session_group_members` (nullable, references SpaceAgent config)
3. Add `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed'))` column to `space_session_group_members`
4. Drop the CHECK constraint on `role` in `space_session_group_members` so it accepts any string (not just 'worker'/'leader'). Use the recreate-table pattern from migration 39 (the most recent, well-tested example) since SQLite cannot drop CHECK constraints via ALTER TABLE. Pay careful attention to column ordering, index recreation, and foreign keys.
5. Add `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed'))` column to `space_session_groups` (group-level status)
6. Add index on `space_session_groups(task_id)` for fast lookup by task
7. Register the migration function in the `runMigrations()` function in `migrations.ts`

**Acceptance Criteria:**
- Migration is idempotent (safe to run multiple times)
- Existing data is preserved (the role column retains old values)
- New columns have sensible defaults (`status` defaults to `'active'`, `agent_id` and `task_id` are nullable)
- The migration follows the patterns established by migrations 29-39

**Dependencies:** None

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.2: Update Shared Types for Flexible Groups

**Description:** Update the `SpaceSessionGroupMember` and `SpaceSessionGroup` interfaces in `packages/shared/src/types/space.ts` to reflect the new schema.

**Subtasks:**
1. Change `SpaceSessionGroupMember.role` from `'worker' | 'leader'` to `string` (freeform, matches SpaceAgent.role)
2. Add `agentId?: string` to `SpaceSessionGroupMember` (which SpaceAgent config this session uses)
3. Add `status: 'active' | 'completed' | 'failed'` to `SpaceSessionGroupMember`
4. Add `taskId?: string` to `SpaceSessionGroup` (which task this group serves)
5. Update any TypeScript references that rely on the old `'worker' | 'leader'` literal type for `role` (search codebase for usages)

**Acceptance Criteria:**
- Types compile without errors (`bun run typecheck` passes)
- No existing code breaks due to the type change (role was already typed as string in SpaceAgent, so most consuming code should be compatible)
- Lint and format checks pass

**Dependencies:** None (can be done in parallel with Task 1.1 or combined into same PR)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.3: Update SpaceSessionGroupRepository for New Schema

**Description:** Update the `SpaceSessionGroupRepository` in `packages/daemon/src/storage/repositories/space-session-group-repository.ts` to handle the new columns and freeform roles.

**Subtasks:**
1. Update `CreateSessionGroupParams` to include optional `taskId: string`
2. Update `createGroup()` to persist `task_id`
3. Update `addMember()` signature: change `role` parameter from `'worker' | 'leader'` to `string`, add optional `agentId?: string` and `status?: string` parameters
4. Update `addMember()` SQL to INSERT/UPDATE `agent_id` and `status` columns
5. Add `updateMemberStatus(memberId: string, status: 'active' | 'completed' | 'failed')` method
6. Add `getGroupsByTask(spaceId: string, taskId: string)` -- update existing method to query by `task_id` column instead of name convention
7. Update `rowToGroup()` to include `taskId` field
8. Update `rowToMember()` to include `agentId` and `status` fields

**Acceptance Criteria:**
- All existing functionality continues to work
- New fields are properly persisted and retrieved
- `updateMemberStatus` correctly transitions member status
- TypeScript compiles cleanly

**Dependencies:** Task 1.1, Task 1.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.4: Unit Tests for Updated Repository

**Description:** Write comprehensive unit tests for the updated `SpaceSessionGroupRepository` covering all new fields and operations.

**Subtasks:**
1. Create test file `packages/daemon/tests/unit/space-session-group-repository.test.ts`
2. Test `createGroup()` with `taskId` parameter
3. Test `addMember()` with freeform role string, `agentId`, and `status`
4. Test `updateMemberStatus()` for all valid transitions
5. Test `getGroupsByTask()` using the new `task_id` column
6. Test idempotent `addMember()` updates existing member's role, agentId, and status
7. Test that `rowToGroup()` and `rowToMember()` correctly map all new fields
8. Verify backward compatibility: groups with old-style 'worker'/'leader' roles still work

**Acceptance Criteria:**
- All tests pass with `cd packages/daemon && bun test tests/unit/space-session-group-repository.test.ts`
- Tests cover happy paths and edge cases (null agentId, status transitions)
- Tests follow existing test patterns (use test setup from `tests/unit/setup.ts`)

**Dependencies:** Task 1.3

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
