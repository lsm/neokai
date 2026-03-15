# Milestone 1: Custom Agent Data Model

## Goal

Define the data model, database schema, repository layer, and CRUD RPC handlers for user-defined custom agents. Each custom agent belongs to a room and stores a name, description, model/provider selection, tool configuration, and system prompt.

## Scope

- New shared types in `packages/shared/src/types/neo.ts`
- New DB migration adding `custom_agents` table
- New `CustomAgentRepository` in `packages/daemon/src/storage/repositories/`
- New `CustomAgentManager` in `packages/daemon/src/lib/room/managers/`
- New RPC handlers for CRUD operations
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
   - `role: 'worker' | 'reviewer' | 'orchestrator'` -- determines how the agent is used in workflows
   - `config?: Record<string, unknown>` -- extensible configuration (future use)
   - `createdAt: number` -- creation timestamp
   - `updatedAt: number` -- last update timestamp

2. Add `CreateCustomAgentParams` interface (name, description, model, provider, tools, systemPrompt, role, config)

3. Add `UpdateCustomAgentParams` interface (all fields optional except id)

4. Export the new types from the shared package barrel exports

5. Write unit tests verifying the types compile correctly and can be used in type-safe code

**Acceptance criteria:**
- Types are defined and exported from `@neokai/shared`
- Types include JSDoc documentation
- `CustomAgent` has all fields needed for agent creation, configuration, and runtime use
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.2: Database Migration for custom_agents Table

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.1

**Description:**

Add a new SQLite migration that creates the `custom_agents` table. Follow the existing migration pattern in `packages/daemon/src/storage/schema/migrations.ts`.

**Subtasks:**

1. Determine the next migration version number by reading the existing migrations array in `packages/daemon/src/storage/schema/migrations.ts`

2. Add a new migration that creates the `custom_agents` table:
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

3. Add an index on `room_id` for efficient lookups: `CREATE INDEX idx_custom_agents_room_id ON custom_agents(room_id)`

4. Write a migration test in `packages/daemon/tests/unit/storage/migrations/` verifying the table is created correctly and the foreign key cascade works

**Acceptance criteria:**
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
   - Handle JSON serialization for `tools` (array) and `config` (object) columns

2. Create `packages/daemon/src/lib/room/managers/custom-agent-manager.ts`:
   - Wraps repository with validation logic
   - Validates that `name` is unique within a room
   - Validates that `tools` contains only known tool names
   - Validates that `model` is a recognized model ID (use existing model service for validation)

3. Export the new manager from `packages/daemon/src/lib/room/index.ts`

4. Write unit tests for both repository and manager:
   - CRUD operations
   - Unique name constraint
   - Tool validation
   - JSON round-trip for tools and config arrays

**Acceptance criteria:**
- Repository handles all CRUD operations with proper JSON serialization
- Manager validates uniqueness and tool names
- Unit tests cover happy path and error cases
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 1.4: Custom Agent RPC Handlers

**Agent:** coder
**Priority:** normal
**Depends on:** Task 1.3

**Description:**

Add RPC handlers so the frontend can create, list, update, and delete custom agents.

**Subtasks:**

1. Create `packages/daemon/src/lib/rpc-handlers/custom-agent-handlers.ts` with handlers:
   - `customAgent.create { roomId, name, description, model, provider, tools, systemPrompt, role }` -> returns `{ agent: CustomAgent }`
   - `customAgent.list { roomId }` -> returns `{ agents: CustomAgent[] }`
   - `customAgent.get { id }` -> returns `{ agent: CustomAgent }`
   - `customAgent.update { id, ...UpdateCustomAgentParams }` -> returns `{ agent: CustomAgent }`
   - `customAgent.delete { id }` -> returns `{ success: boolean }`

2. Wire the handlers in `packages/daemon/src/app.ts` (follow existing pattern for task-handlers, goal-handlers)

3. Emit DaemonHub events for create/update/delete so UI can react in real-time:
   - `customAgent.created` with `{ roomId, agent }`
   - `customAgent.updated` with `{ roomId, agent }`
   - `customAgent.deleted` with `{ roomId, agentId }`

4. Write unit tests for each RPC handler including error cases (not found, invalid params, duplicate name)

**Acceptance criteria:**
- All CRUD operations work via RPC
- DaemonHub events are emitted for real-time UI updates
- Error handling returns clear messages
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
