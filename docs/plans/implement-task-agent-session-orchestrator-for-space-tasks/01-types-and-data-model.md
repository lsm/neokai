# Milestone 1: Types and Data Model

## Goal

Extend the shared types, database schema, and repositories to support Task Agent sessions. This provides the foundation that all subsequent milestones build upon.

## Tasks

### Task 1.1: Add `space_task_agent` Session Type and Extend SpaceTask Type

**Description:** Add the new `space_task_agent` value to the `SessionType` union in shared types, and add a `taskAgentSessionId` field to `SpaceTask` so each task can reference its orchestrating Task Agent session.

**Subtasks:**
1. In `packages/shared/src/types.ts`, add `'space_task_agent'` to the `SessionType` union
2. In `packages/shared/src/types/space.ts`, add `taskAgentSessionId?: string | null` field to the `SpaceTask` interface with a doc comment explaining it references the Task Agent session that orchestrates this task
3. In `packages/shared/src/types/space.ts`, add `taskAgentSessionId?: string | null` to `CreateSpaceTaskParams` and `UpdateSpaceTaskParams` interfaces
4. Run `bun run typecheck` to verify no type errors

**Acceptance Criteria:**
- `SessionType` includes `'space_task_agent'`
- `SpaceTask` has `taskAgentSessionId` optional field
- All existing type checks pass

**Dependencies:** None

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.2: Update SpaceTask Database Schema and Repository

**Description:** Add the `task_agent_session_id` column to the `space_tasks` table and update the SpaceTaskRepository to handle the new field in CRUD operations.

**Subtasks:**
1. In `packages/daemon/src/storage/migrations/`, add a migration that adds `task_agent_session_id TEXT` column to the `space_tasks` table
2. In `packages/daemon/src/storage/repositories/space-task-repository.ts`, update the `createTask()` method to accept and persist `taskAgentSessionId`
3. Update `updateTask()` to allow setting/clearing `taskAgentSessionId`
4. Update `getTask()` and list methods to include `taskAgentSessionId` in the returned `SpaceTask` object
5. Add a `getTaskBySessionId(sessionId: string)` method that looks up a SpaceTask by its `taskAgentSessionId` -- this is needed by the Task Agent to find its own task record
6. Write unit tests in `packages/daemon/tests/unit/space/` covering the new field in create, update, get, and the new lookup method
7. Run `bun run typecheck` and `make test-daemon` to verify

**Acceptance Criteria:**
- Migration adds the column without breaking existing data
- `createTask` persists `taskAgentSessionId` when provided
- `updateTask` can set/clear `taskAgentSessionId`
- `getTaskBySessionId` returns the correct task or null
- All existing tests continue to pass
- New unit tests cover the added functionality

**Dependencies:** Task 1.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.3: Define Task Agent MCP Tool Schemas

**Description:** Create a TypeScript file defining the Zod schemas and types for all 5 Task Agent MCP tools. This file will be consumed by the MCP server factory in Milestone 3.

**Subtasks:**
1. Create `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts`
2. Define Zod schemas for each tool's input parameters:
   - `spawn_step_agent`: `{ step_id: string, instructions?: string }` -- spawns a sub-session for a specific workflow step
   - `check_step_status`: `{ step_id?: string }` -- checks the status of current or specific step's sub-session (returns processing state, whether completed, any errors)
   - `advance_workflow`: `{ step_result?: string }` -- advances the workflow to the next step after current step completes
   - `report_result`: `{ status: 'completed' | 'needs_attention' | 'cancelled', summary: string, error?: string }` -- reports the final task result
   - `request_human_input`: `{ question: string, context?: string }` -- pauses execution and surfaces a question to the human user
3. Export TypeScript types derived from the schemas
4. Write unit tests verifying the schemas validate correct inputs and reject invalid ones

**Acceptance Criteria:**
- All 5 tool schemas are defined with proper Zod types
- TypeScript types are exported for use by tool handlers
- Schema validation tests pass for valid and invalid inputs
- File follows the same patterns as `space-agent-tools.ts` for consistency

**Dependencies:** None (can be done in parallel with Tasks 1.1 and 1.2)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
