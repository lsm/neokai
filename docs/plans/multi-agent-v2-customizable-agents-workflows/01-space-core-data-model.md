# Milestone 1: Space Core Data Model & Infrastructure

## Goal

Define the core data model, database schema, repositories, managers, and RPC handlers for the Space container and its supporting entities (tasks, goals, session groups). This is the foundation that all other milestones build upon.

## Isolation Principle

**No existing tables or code are modified.** All entities are new:
- `spaces` table (not `rooms`)
- `space_tasks` table (not modifications to `tasks`)
- `space_goals` table (not modifications to `goals`)
- `space_session_groups` / `space_session_group_members` (not modifications to existing session group tables)

Existing repository/manager patterns are used as reference but new files are created.

## Scope

- New shared types in `packages/shared/src/types/space.ts`
- Single DB migration creating all Space tables
- New repositories: `SpaceRepository`, `SpaceTaskRepository`, `SpaceGoalRepository`, `SpaceSessionGroupRepository`
- New managers: `SpaceManager`, `SpaceTaskManager`, `SpaceGoalManager`
- New RPC handlers for space CRUD operations
- New `DaemonEventMap` entries for Space events
- Unit tests

---

### Task 1.1: Define Space Shared Types

**Agent:** coder
**Priority:** high
**Depends on:** (none)

**Description:**

Create a new shared types file for all Space-related types. These are distinct from the existing room/task/goal types and live in their own module.

**Subtasks:**

1. Create `packages/shared/src/types/space.ts` with:

   ```typescript
   /** A Space — the multi-agent workflow container */
   interface Space {
     id: string;
     name: string;
     description: string;
     /** Required: the workspace directory where agents operate */
     workspacePath: string;
     /** Background context injected into all agent prompts */
     backgroundContext: string;
     /** Custom instructions for agents */
     instructions: string;
     /** Default model for agents in this space */
     defaultModel: string;
     /** Allowed models (empty = all available) */
     allowedModels: string[];
     /** Associated session IDs */
     sessionIds: string[];
     status: 'active' | 'archived';
     config?: Record<string, unknown>;
     createdAt: number;
     updatedAt: number;
   }

   interface CreateSpaceParams {
     name: string;
     workspacePath: string; // Required
     description?: string;
     backgroundContext?: string;
     instructions?: string;
     defaultModel?: string;
     allowedModels?: string[];
     config?: Record<string, unknown>;
   }

   interface UpdateSpaceParams {
     name?: string;
     description?: string;
     backgroundContext?: string;
     instructions?: string;
     defaultModel?: string;
     allowedModels?: string[];
     config?: Record<string, unknown>;
   }
   ```

2. Add `SpaceTask` interface (mirrors `NeoTask` structure but with Space-specific fields built in):
   - All existing task fields: `id`, `spaceId`, `goalId`, `title`, `description`, `status`, `priority`, `assignedAgent`, `taskType`, `progress`, `dependencies`, etc.
   - **Built-in from the start**: `customAgentId?: string`, `workflowId?: string`, `workflowStepId?: string`
   - `CreateSpaceTaskParams` and `UpdateSpaceTaskParams`

3. Add `SpaceGoal` interface (mirrors `RoomGoal` structure but with Space-specific fields):
   - Fields: `id`, `spaceId`, `title`, `description`, `status`, `priority`, `workflowId?: string`, `metrics`, etc.
   - `CreateSpaceGoalParams` and `UpdateSpaceGoalParams`

4. Add `SpaceSessionGroup` and `SpaceSessionGroupMember` interfaces for multi-agent session tracking

5. Export all types from `packages/shared/src/types/space.ts` and from the shared package barrel (`packages/shared/src/mod.ts`)

**Acceptance criteria:**
- All Space types are defined and exported from `@neokai/shared`
- Types include JSDoc documentation
- `Space` has `workspacePath` as a required field
- `SpaceTask` has `customAgentId`, `workflowId`, `workflowStepId` built in (not added via migration later)
- `SpaceGoal` has `workflowId` built in
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.2: Database Migration for All Space Tables

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.1

**Description:**

Create a single DB migration that creates ALL Space-related tables. Since these are entirely new tables (no ALTER TABLE on existing tables), they can all go in one migration.

**Subtasks:**

1. Determine the next migration version number by reading `packages/daemon/src/storage/schema/migrations.ts`

2. Add a single migration that creates all tables:

   ```sql
   -- Space container
   CREATE TABLE IF NOT EXISTS spaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     workspace_path TEXT NOT NULL,
     background_context TEXT NOT NULL DEFAULT '',
     instructions TEXT NOT NULL DEFAULT '',
     default_model TEXT NOT NULL DEFAULT '',
     allowed_models TEXT NOT NULL DEFAULT '[]',
     session_ids TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     config TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );

   -- Custom agents within a space
   CREATE TABLE IF NOT EXISTS space_agents (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL,
     provider TEXT,
     tools TEXT NOT NULL DEFAULT '[]',
     system_prompt TEXT NOT NULL DEFAULT '',
     role TEXT NOT NULL DEFAULT 'worker' CHECK(role IN ('worker', 'reviewer', 'orchestrator')),
     config TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
   );

   -- Workflow definitions
   CREATE TABLE IF NOT EXISTS space_workflows (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     rules TEXT NOT NULL DEFAULT '[]',
     is_default INTEGER NOT NULL DEFAULT 0,
     tags TEXT NOT NULL DEFAULT '[]',
     config TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
   );

   -- Workflow step definitions
   CREATE TABLE IF NOT EXISTS space_workflow_steps (
     id TEXT PRIMARY KEY,
     workflow_id TEXT NOT NULL,
     name TEXT NOT NULL,
     agent_ref TEXT NOT NULL,
     agent_ref_type TEXT NOT NULL DEFAULT 'builtin' CHECK(agent_ref_type IN ('builtin', 'custom')),
     entry_gate TEXT,
     exit_gate TEXT,
     instructions TEXT,
     step_order INTEGER NOT NULL,
     FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
   );

   -- Tasks within a space (custom_agent_id, workflow columns built in from start)
   CREATE TABLE IF NOT EXISTS space_tasks (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     goal_id TEXT,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'needs_attention', 'completed', 'cancelled')),
     priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'critical')),
     assigned_agent TEXT NOT NULL DEFAULT 'coder',
     custom_agent_id TEXT,
     task_type TEXT NOT NULL DEFAULT 'coding',
     workflow_id TEXT,
     workflow_step_id TEXT,
     progress TEXT,
     dependencies TEXT NOT NULL DEFAULT '[]',
     parent_task_id TEXT,
     config TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
     FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE SET NULL
   );

   -- Goals within a space (workflow_id built in from start)
   CREATE TABLE IF NOT EXISTS space_goals (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
     priority TEXT NOT NULL DEFAULT 'normal',
     workflow_id TEXT,
     metrics TEXT,
     config TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
   );

   -- Session groups for multi-agent collaboration within spaces
   CREATE TABLE IF NOT EXISTS space_session_groups (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     task_id TEXT,
     goal_id TEXT,
     status TEXT NOT NULL DEFAULT 'active',
     metadata TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
   );

   CREATE TABLE IF NOT EXISTS space_session_group_members (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     role TEXT NOT NULL CHECK(role IN ('worker', 'leader')),
     created_at INTEGER NOT NULL,
     FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE
   );
   ```

3. Add indexes:
   ```sql
   CREATE INDEX idx_space_agents_space_id ON space_agents(space_id);
   CREATE INDEX idx_space_workflows_space_id ON space_workflows(space_id);
   CREATE INDEX idx_space_workflow_steps_workflow_id ON space_workflow_steps(workflow_id);
   CREATE INDEX idx_space_tasks_space_id ON space_tasks(space_id);
   CREATE INDEX idx_space_tasks_goal_id ON space_tasks(goal_id);
   CREATE INDEX idx_space_tasks_status ON space_tasks(status);
   CREATE INDEX idx_space_goals_space_id ON space_goals(space_id);
   CREATE INDEX idx_space_session_groups_space_id ON space_session_groups(space_id);
   CREATE INDEX idx_space_session_groups_task_id ON space_session_groups(task_id);
   ```

4. Write migration tests verifying:
   - All tables are created correctly
   - Foreign key cascades work (delete space → everything deleted)
   - `space_tasks` has `custom_agent_id`, `workflow_id`, `workflow_step_id` columns from the start
   - `space_goals` has `workflow_id` column from the start
   - No existing tables are affected

**Acceptance criteria:**
- Single migration creates all Space tables
- CASCADE deletes work correctly for the full entity hierarchy
- All workflow/agent columns are built into tables from the start (no ALTER TABLE)
- Migration test passes
- No modifications to any existing tables
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.3: Space Repositories and Managers

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.2

**Description:**

Create the data access (repositories) and business logic (managers) layers for Spaces, SpaceTasks, and SpaceGoals. Follow existing repository/manager patterns but create entirely new files.

**Subtasks:**

1. Create `packages/daemon/src/storage/repositories/space-repository.ts`:
   - `createSpace(params: CreateSpaceParams): Space`
   - `getSpace(id: string): Space | null`
   - `listSpaces(includeArchived?: boolean): Space[]`
   - `updateSpace(id: string, params: UpdateSpaceParams): Space | null`
   - `archiveSpace(id: string): boolean`
   - `deleteSpace(id: string): boolean`
   - Handle JSON serialization for `allowedModels`, `sessionIds`, `config`
   - Implement `rowToSpace()` mapping function

2. Create `packages/daemon/src/storage/repositories/space-task-repository.ts`:
   - Full CRUD operations following `TaskRepository` patterns
   - `rowToSpaceTask()` handles `customAgentId`, `workflowId`, `workflowStepId` fields
   - Batch operations: `listByGoal()`, `listBySpace()`, `listByStatus()`
   - JSON serialization for `dependencies`, `progress`, `config`

3. Create `packages/daemon/src/storage/repositories/space-goal-repository.ts`:
   - Full CRUD operations following `GoalRepository` patterns
   - `rowToSpaceGoal()` handles `workflowId` field
   - `listBySpace()`, `getActiveGoals()`

4. Create `packages/daemon/src/storage/repositories/space-session-group-repository.ts`:
   - CRUD for session groups and members
   - `getGroupsByTask()`, `getGroupsBySpace()`, `addMember()`, `removeMember()`

5. Create managers in `packages/daemon/src/lib/space/managers/`:
   - `SpaceManager` — validates workspace path exists (via `fs.access`), name uniqueness, handles overview composition
   - `SpaceTaskManager` — task lifecycle, dependency validation, status transitions
   - `SpaceGoalManager` — goal lifecycle, status transitions, workflow validation (if `workflowId` provided, verify it exists in same space)

6. Export from `packages/daemon/src/lib/space/index.ts`

7. Write unit tests for all repositories and managers:
   - CRUD operations for each entity
   - Cascade deletes
   - Workspace path validation
   - JSON round-trips
   - Goal workflow_id validation

**Acceptance criteria:**
- All repositories handle CRUD with proper JSON serialization
- Managers validate business rules (workspace path, uniqueness, workflow references)
- Unit tests cover happy paths and error cases
- All files are new — no modifications to existing repositories/managers
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.4: Space RPC Handlers and DaemonEventMap Registration

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.3

**Description:**

Add RPC handlers for Space CRUD operations and register new event types in DaemonEventMap. Also wire into the DaemonApp context.

**Subtasks:**

1. **Register new event types in `DaemonEventMap`** (`packages/daemon/src/lib/daemon-hub.ts`):
   ```typescript
   // Space events
   'space.created': { sessionId: string; space: Space };
   'space.updated': { sessionId: string; spaceId: string; space: Space };
   'space.deleted': { sessionId: string; spaceId: string };
   'space.task.created': { sessionId: string; spaceId: string; task: SpaceTask };
   'space.task.updated': { sessionId: string; spaceId: string; task: SpaceTask };
   'space.goal.created': { sessionId: string; spaceId: string; goal: SpaceGoal };
   'space.goal.updated': { sessionId: string; spaceId: string; goal: SpaceGoal };
   ```
   Import types from `@neokai/shared`.

2. Create `packages/daemon/src/lib/rpc-handlers/space-handlers.ts`:
   - `space.create { name, workspacePath, description?, ... }` → `{ space }`
   - `space.list { includeArchived? }` → `{ spaces }`
   - `space.get { id }` → `{ space }`
   - `space.update { id, ... }` → `{ space }`
   - `space.archive { id }` → `{ success }`
   - `space.delete { id }` → `{ success }`
   - `space.overview { id }` → `{ space, tasks, goals, sessions }`

3. Create `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`:
   - `spaceTask.create`, `spaceTask.list`, `spaceTask.get`, `spaceTask.update`

4. Create `packages/daemon/src/lib/rpc-handlers/space-goal-handlers.ts`:
   - `spaceGoal.create`, `spaceGoal.list`, `spaceGoal.get`, `spaceGoal.update`

5. Wire handlers in `packages/daemon/src/app.ts`:
   - Add Space repositories and managers to `DaemonAppContext`
   - Call `setupSpaceHandlers()`, `setupSpaceTaskHandlers()`, `setupSpaceGoalHandlers()`
   - **Only add new registrations** — do not modify existing handler setup

6. Emit DaemonHub events for all mutations

7. Write unit tests for each RPC handler including error cases

**Acceptance criteria:**
- All Space CRUD operations work via RPC
- `space.create` validates workspace path exists and rejects invalid paths
- DaemonHub events enable real-time UI updates
- All handlers are in new files — no modification to existing handler files
- Error handling returns clear messages
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
