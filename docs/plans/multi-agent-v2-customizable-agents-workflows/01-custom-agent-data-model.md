# Milestone 1: Custom Agent Data Model

## Goal

Define the data model, database schema, repository layer, and CRUD RPC handlers for user-defined custom agents. Each custom agent belongs to a room and stores a name, description, model/provider selection, tool configuration, and system prompt.

## Scope

- New shared types in `packages/shared/src/types/neo.ts`
- New DB migration (consolidated Migration A, shared with M2) adding `custom_agents` table and `custom_agent_id` column on `tasks`
- New `CustomAgentRepository` in `packages/daemon/src/storage/repositories/`
- New `CustomAgentManager` in `packages/daemon/src/lib/room/managers/`
- New RPC handlers for CRUD operations
- New event types registered in `DaemonEventMap` (`packages/daemon/src/lib/daemon-hub.ts`)
- Unit tests for repository, manager, and RPC handlers

---

### Task 1.1: Define Custom Agent Shared Types

**Agent:** coder
**Priority:** high
**Depends on:** (none)

**Description:**

Add new shared types for custom agent definitions to `packages/shared/src/types/neo.ts`. These types define what a user-created agent looks like.

**Subtasks:**

1. Add a `CustomAgent` interface with fields:
   - `id: string` -- unique identifier
   - `roomId: string` -- owning room
   - `name: string` -- user-chosen display name (e.g., "Security Reviewer", "Tester")
   - `description: string` -- what this agent does
   - `model: string` -- model ID (e.g., "claude-sonnet-4-6")
   - `provider?: string` -- provider name (e.g., "anthropic", "openai")
   - `tools: string[]` -- list of allowed tool names (e.g., ["Read", "Write", "Bash", "Grep"])
   - `systemPrompt: string` -- custom system prompt for this agent
   - `role: 'worker' | 'reviewer' | 'orchestrator'` -- determines how the agent is used in workflows (see 00-overview.md "WorkflowExecutor Operates at Goal Level" for how roles interact with the Leader)
   - `config?: Record<string, unknown>` -- extensible configuration (future use)
   - `createdAt: number` -- creation timestamp
   - `updatedAt: number` -- last update timestamp

2. Add `CreateCustomAgentParams` interface (name, description, model, provider, tools, systemPrompt, role, config)

3. Add `UpdateCustomAgentParams` interface (all fields optional except id)

4. Export the new types from the shared package barrel exports

5. **Define `KNOWN_TOOLS` constant** in `packages/shared/src/types/tools.ts` (new file):
   - `export const KNOWN_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TaskOutput', 'TaskStop'] as const;`
   - `export type KnownTool = (typeof KNOWN_TOOLS)[number];`
   - This is the **single source of truth** for the tool list, referenced by `CustomAgentManager` (Task 1.3) for validation and by `CustomAgentEditor` (Task 5.2) for the frontend tool picker
   - Export from the shared package barrel

**Acceptance criteria:**
- Types are defined and exported from `@neokai/shared`
- `KNOWN_TOOLS` constant is defined and exported as the single source of truth for tool names
- Types include JSDoc documentation explaining each field and the role semantics (worker = specialized task executor, reviewer = produces review output for Leader to approve, orchestrator = reserved for future use)
- `CustomAgent` has all fields needed for agent creation, configuration, and runtime use
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.2: Database Migration for custom_agents Table (Consolidated Migration A)

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.1

**Description:**

Add a new SQLite migration that creates the `custom_agents` table AND adds the `custom_agent_id` column to the `tasks` table. This is **consolidated Migration A** — a single migration covering both M1 and M2 schema needs to avoid migration ordering conflicts.

**Subtasks:**

1. Determine the next migration version number by reading the existing migrations array in `packages/daemon/src/storage/schema/migrations.ts`

2. Add a single new migration that:

   a. Creates the `custom_agents` table:
   ```sql
   CREATE TABLE IF NOT EXISTS custom_agents (
     id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL,
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
     FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
   );
   ```

   b. Adds `custom_agent_id` column to `tasks`:
   ```sql
   ALTER TABLE tasks ADD COLUMN custom_agent_id TEXT;
   ```

3. Add indexes:
   - `CREATE INDEX idx_custom_agents_room_id ON custom_agents(room_id)`

4. Write a migration test in `packages/daemon/tests/unit/storage/migrations/` verifying:
   - The `custom_agents` table is created correctly
   - The foreign key cascade works (delete room -> agents deleted)
   - The `custom_agent_id` column is added to `tasks`
   - Existing tasks are unaffected (column is nullable)

**Acceptance criteria:**
- Single migration covers both `custom_agents` table and `tasks.custom_agent_id` column
- Migration runs successfully and creates the table
- Foreign key cascade deletes custom agents when room is deleted
- Migration test passes
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.3: CustomAgentRepository and CustomAgentManager

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.2

**Description:**

Create the data access layer (repository) and business logic layer (manager) for custom agents.

**Subtasks:**

1. Create `packages/daemon/src/storage/repositories/custom-agent-repository.ts`:
   - `createAgent(params: CreateCustomAgentParams & { roomId: string }): CustomAgent`
   - `getAgent(id: string): CustomAgent | null`
   - `listAgents(roomId: string): CustomAgent[]`
   - `updateAgent(id: string, params: UpdateCustomAgentParams): CustomAgent | null`
   - `deleteAgent(id: string): boolean`
   - `getAgentsByIds(ids: string[]): CustomAgent[]` -- batch lookup for workflow validation
   - `isAgentReferenced(agentId: string): { workflows: string[] }` -- checks if agent is referenced by any workflow steps (cross-table query on `workflow_steps.agent_ref` where `agent_ref_type = 'custom'`)
   - Handle JSON serialization for `tools` (array) and `config` (object) columns
   - Implement `rowToAgent()` mapping function following existing repository patterns

2. Create `packages/daemon/src/lib/room/managers/custom-agent-manager.ts`:
   - Wraps repository with validation logic
   - Validates that `name` is unique within a room
   - Validates that `tools` contains only known tool names (reference the tool list from `packages/shared/src/types/tools.ts` or define a `KNOWN_TOOLS` constant in `@neokai/shared` as the single source of truth)
   - Validates that `model` is a recognized model ID (use the models list from `packages/shared/src/models.ts`)
   - **Deletion protection**: When deleting an agent, check `isAgentReferenced()`. If the agent is referenced by workflow steps, return an error with the list of referencing workflow names. Agents must be removed from workflows before deletion.

3. Export the new manager from `packages/daemon/src/lib/room/index.ts` (verified: this barrel file exists)

4. Write unit tests for both repository and manager:
   - CRUD operations
   - Unique name constraint
   - Tool validation
   - Model validation
   - JSON round-trip for tools and config arrays
   - Deletion protection when referenced by workflows

**Acceptance criteria:**
- Repository handles all CRUD operations with proper JSON serialization
- Manager validates uniqueness, tool names, and model IDs
- Deletion is blocked when agent is referenced by workflow steps (with clear error message listing affected workflows)
- Unit tests cover happy path and error cases
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.4: Custom Agent RPC Handlers and DaemonEventMap Registration

**Agent:** coder
**Priority:** normal
**Depends on:** Task 1.3

**Description:**

Add RPC handlers so the frontend can create, list, update, and delete custom agents. Register new event types in `DaemonEventMap` for type-safe event emission.

**Subtasks:**

1. **Register new event types in `DaemonEventMap`** (`packages/daemon/src/lib/daemon-hub.ts`):
   Add the following entries to the `DaemonEventMap` interface:
   ```typescript
   // Custom agent events (routed via room channel: sessionId = 'room:${roomId}')
   'customAgent.created': { sessionId: string; roomId: string; agent: CustomAgent };
   'customAgent.updated': { sessionId: string; roomId: string; agent: CustomAgent };
   'customAgent.deleted': { sessionId: string; roomId: string; agentId: string };
   ```
   Import the `CustomAgent` type from `@neokai/shared`.

2. Create `packages/daemon/src/lib/rpc-handlers/custom-agent-handlers.ts` with handlers:
   - `customAgent.create { roomId, name, description, model, provider, tools, systemPrompt, role }` -> returns `{ agent: CustomAgent }`
   - `customAgent.list { roomId }` -> returns `{ agents: CustomAgent[] }`
   - `customAgent.get { id }` -> returns `{ agent: CustomAgent }`
   - `customAgent.update { id, ...UpdateCustomAgentParams }` -> returns `{ agent: CustomAgent }`
   - `customAgent.delete { id }` -> returns `{ success: boolean }` (returns error if agent is referenced by workflows)

3. Wire the handlers in `packages/daemon/src/app.ts` (follow existing pattern for task-handlers, goal-handlers)

4. Emit DaemonHub events for create/update/delete (using the types registered in step 1):
   - `customAgent.created` with `{ sessionId: 'room:${roomId}', roomId, agent }`
   - `customAgent.updated` with `{ sessionId: 'room:${roomId}', roomId, agent }`
   - `customAgent.deleted` with `{ sessionId: 'room:${roomId}', roomId, agentId }`

5. Write unit tests for each RPC handler including error cases (not found, invalid params, duplicate name, deletion of referenced agent)

**Acceptance criteria:**
- All CRUD operations work via RPC
- DaemonHub events are registered in `DaemonEventMap` (TypeScript compilation succeeds)
- DaemonHub events are emitted for real-time UI updates
- Delete handler returns clear error when agent is referenced by workflows
- Error handling returns clear messages
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
