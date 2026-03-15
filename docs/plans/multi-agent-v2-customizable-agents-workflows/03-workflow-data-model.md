# Milestone 3: Workflow Data Model

## Goal

Define the data model, database schema, repository layer, and CRUD RPC handlers for custom workflows. A workflow defines a sequence of agent steps with runtime gates between them and configurable rules.

## Scope

- New shared types for workflows, workflow steps, gates, and rules
- New DB migration adding `workflows` and `workflow_steps` tables
- New `WorkflowRepository` and `WorkflowManager`
- New RPC handlers for workflow CRUD
- Unit tests

---

### Task 3.1: Define Workflow Shared Types

**Agent:** coder
**Priority:** high
**Depends on:** (none -- can start immediately, types are independent)

**Description:**

Add new shared types for workflow definitions. A workflow is a sequence of steps where each step invokes an agent (built-in or custom), with optional gates between steps and rules that govern behavior.

**Subtasks:**

1. Add the following types to `packages/shared/src/types/neo.ts`:

   ```typescript
   /** Gate type -- runtime checkpoints between workflow steps */
   type WorkflowGateType =
     | 'auto'           // Automatically proceed to next step
     | 'human_approval' // Pause for human approval before proceeding
     | 'quality_check'  // Run automated quality checks (tests, lint, etc.)
     | 'pr_review'      // Existing PR review gate (worker exit gate pattern)
     | 'custom';        // Custom gate with user-defined check logic

   /** A gate between workflow steps */
   interface WorkflowGate {
     type: WorkflowGateType;
     /** For custom gates: shell command or script to run */
     command?: string;
     /** Human-readable description of what this gate checks */
     description?: string;
     /** Max retries before escalating (0 = no retry, just fail) */
     maxRetries?: number;
   }

   /** A single step in a workflow */
   interface WorkflowStep {
     id: string;
     /** Display name for this step */
     name: string;
     /** Which agent executes this step -- built-in role or custom agent ID */
     agentRef: string;
     /** Whether agentRef is a built-in role ('planner', 'coder', 'general', 'leader') or a custom agent ID */
     agentRefType: 'builtin' | 'custom';
     /** Gate to pass before this step can start (null for the first step) */
     entryGate?: WorkflowGate | null;
     /** Gate to pass after this step completes */
     exitGate?: WorkflowGate | null;
     /** Step-specific instructions injected into the agent's context */
     instructions?: string;
     /** Order index within the workflow */
     order: number;
   }

   /** Rule definition for a workflow (similar to room instructions) */
   interface WorkflowRule {
     id: string;
     /** Rule name */
     name: string;
     /** Rule content -- injected into agent system prompts */
     content: string;
     /** Which steps this rule applies to (empty = all steps) */
     appliesTo?: string[];
   }

   /** A complete workflow definition */
   interface Workflow {
     id: string;
     roomId: string;
     name: string;
     description: string;
     steps: WorkflowStep[];
     rules: WorkflowRule[];
     /** Whether this is the default workflow for the room */
     isDefault: boolean;
     /** Tags for categorization (e.g., 'coding', 'review', 'research') */
     tags: string[];
     config?: Record<string, unknown>;
     createdAt: number;
     updatedAt: number;
   }
   ```

2. Add `CreateWorkflowParams` and `UpdateWorkflowParams` interfaces

3. Export all new types from the shared package

4. Write unit tests verifying types compile and work in type-safe scenarios

**Acceptance criteria:**
- All workflow types are defined and exported from `@neokai/shared`
- Types support the full workflow lifecycle: creation, step sequencing, gates, rules
- JSDoc documentation on all interfaces
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.2: Database Migration for Workflows

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.1

**Description:**

Add a SQLite migration creating `workflows` and `workflow_steps` tables. Rules and gates are stored as JSON within the workflow and step records respectively (no separate tables needed for MVP).

**Subtasks:**

1. Add a new migration in `packages/daemon/src/storage/schema/migrations.ts`:

   ```sql
   CREATE TABLE IF NOT EXISTS workflows (
     id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     rules TEXT NOT NULL DEFAULT '[]',
     is_default INTEGER NOT NULL DEFAULT 0,
     tags TEXT NOT NULL DEFAULT '[]',
     config TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
   );

   CREATE TABLE IF NOT EXISTS workflow_steps (
     id TEXT PRIMARY KEY,
     workflow_id TEXT NOT NULL,
     name TEXT NOT NULL,
     agent_ref TEXT NOT NULL,
     agent_ref_type TEXT NOT NULL DEFAULT 'builtin' CHECK(agent_ref_type IN ('builtin', 'custom')),
     entry_gate TEXT,
     exit_gate TEXT,
     instructions TEXT,
     step_order INTEGER NOT NULL,
     FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
   );
   ```

2. Add indexes:
   - `CREATE INDEX idx_workflows_room_id ON workflows(room_id)`
   - `CREATE INDEX idx_workflow_steps_workflow_id ON workflow_steps(workflow_id)`

3. Write a migration test verifying:
   - Tables are created
   - Foreign key cascade works (delete workflow -> steps deleted)
   - Room cascade works (delete room -> workflows deleted)

**Acceptance criteria:**
- Migration runs successfully
- CASCADE deletes work correctly
- Migration test passes
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.3: WorkflowRepository and WorkflowManager

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.2

**Description:**

Create the data access and business logic layers for workflows.

**Subtasks:**

1. Create `packages/daemon/src/storage/repositories/workflow-repository.ts`:
   - `createWorkflow(params: CreateWorkflowParams & { roomId: string }): Workflow`
   - `getWorkflow(id: string): Workflow | null` -- joins with `workflow_steps` to build full object
   - `listWorkflows(roomId: string): Workflow[]`
   - `updateWorkflow(id: string, params: UpdateWorkflowParams): Workflow | null`
   - `deleteWorkflow(id: string): boolean`
   - `getDefaultWorkflow(roomId: string): Workflow | null`
   - `setDefaultWorkflow(roomId: string, workflowId: string): void`
   - Handle step CRUD within workflow transactions (replace all steps on update)
   - JSON serialization for `rules`, `tags`, `entry_gate`, `exit_gate`

2. Create `packages/daemon/src/lib/room/managers/workflow-manager.ts`:
   - Wraps repository with validation:
     - Workflow name uniqueness within a room
     - Step agent references are valid (built-in role name or existing custom agent ID)
     - At least one step required
     - Step order is contiguous (0, 1, 2, ...)
   - Business logic:
     - When setting a new default, unset the previous default
     - When deleting a workflow that is the default, clear the room's default

3. Export from `packages/daemon/src/lib/room/index.ts`

4. Write unit tests:
   - Full CRUD lifecycle
   - Step ordering validation
   - Agent reference validation (both builtin and custom)
   - Default workflow management
   - JSON round-trip for gates and rules

**Acceptance criteria:**
- Repository handles all CRUD with proper step management
- Manager validates workflow integrity
- Default workflow switching works correctly
- Unit tests cover all paths
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.4: Workflow RPC Handlers

**Agent:** coder
**Priority:** normal
**Depends on:** Task 3.3

**Description:**

Add RPC handlers for frontend access to workflow CRUD operations.

**Subtasks:**

1. Create `packages/daemon/src/lib/rpc-handlers/workflow-handlers.ts`:
   - `workflow.create { roomId, name, description, steps, rules, tags }` -> `{ workflow }`
   - `workflow.list { roomId }` -> `{ workflows }`
   - `workflow.get { id }` -> `{ workflow }`
   - `workflow.update { id, ... }` -> `{ workflow }`
   - `workflow.delete { id }` -> `{ success }`
   - `workflow.setDefault { roomId, workflowId }` -> `{ success }`

2. Wire handlers in `packages/daemon/src/app.ts`

3. Emit DaemonHub events:
   - `workflow.created`, `workflow.updated`, `workflow.deleted`

4. Write unit tests for all handlers

**Acceptance criteria:**
- All CRUD operations work via RPC
- DaemonHub events enable real-time UI updates
- Error handling covers not-found, validation failures
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.5: Seed Built-in Workflow Templates

**Agent:** coder
**Priority:** normal
**Depends on:** Task 3.3

**Description:**

Create built-in workflow templates that mirror the existing hardcoded behavior. These serve as defaults and examples for users building custom workflows.

**Subtasks:**

1. Create `packages/daemon/src/lib/room/workflows/built-in-workflows.ts` with:
   - `CODING_WORKFLOW`: Planner -> Coder -> Leader (with PR review gate between Coder and Leader) -- mirrors current RoomRuntime behavior
   - `RESEARCH_WORKFLOW`: Planner -> General -> Leader (with auto gate between General and Leader)
   - `REVIEW_ONLY_WORKFLOW`: Coder -> Leader (no planning step, direct implementation to review)

2. Each template includes appropriate gates:
   - `CODING_WORKFLOW`: entry gate `auto` for Planner, exit gate `human_approval` for Planner (plan review), entry gate `auto` for Coder, exit gate `pr_review` for Coder, entry gate `auto` for Leader, exit gate `human_approval` for Leader
   - Templates include default rules matching current room instructions behavior

3. Add a `getBuiltInWorkflows(): Workflow[]` export function

4. When a room is created, optionally seed the `CODING_WORKFLOW` as the default workflow (configurable via room creation params)

5. Write unit tests verifying template structure and that all agent references are valid built-in roles

**Acceptance criteria:**
- Three built-in workflow templates are defined
- Templates mirror existing runtime behavior accurately
- New rooms can be seeded with a default workflow
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
