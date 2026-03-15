# Milestone 3: Workflow Data Model

## Goal

Define the data model, database schema, repository layer, and CRUD RPC handlers for custom workflows. A workflow defines a sequence of agent steps with runtime gates between them and configurable rules.

## Scope

- New shared types for workflows, workflow steps, gates, and rules
- New DB migration (consolidated Migration B, shared with M4 and M7) adding `workflows`, `workflow_steps` tables, `tasks` workflow columns, and `goals.workflow_id`
- New `WorkflowRepository` and `WorkflowManager`
- New RPC handlers for workflow CRUD
- New event types registered in `DaemonEventMap`
- Referential integrity for custom agent references
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
     | 'quality_check'  // Run automated quality checks from allowlist (tests, lint, etc.)
     | 'pr_review'      // Existing PR review gate (worker exit gate pattern)
     | 'custom';        // Custom gate with workspace-scoped script execution

   /** A gate between workflow steps */
   interface WorkflowGate {
     type: WorkflowGateType;
     /**
      * For quality_check gates: must be one of the predefined allowlisted commands
      * (e.g., 'bun run check', 'bun test').
      * For custom gates: path to a script within the workspace directory
      * (no absolute paths, no '..', must be within workspace).
      * See 00-overview.md "Gate Security Model" for full constraints.
      */
     command?: string;
     /** Human-readable description of what this gate checks */
     description?: string;
     /**
      * Max retries before escalating (0 = no retry, just fail the gate).
      * Retry semantics: re-evaluates the gate command/check only (does NOT
      * re-run the agent step). After maxRetries exhausted, the gate fails
      * and the task transitions to 'needs_attention' for human intervention.
      */
     maxRetries?: number;
     /**
      * Timeout in milliseconds for gate command execution.
      * Default: 60000 (60s). Max: 300000 (300s).
      * Only applies to quality_check and custom gates.
      */
     timeoutMs?: number;
   }

   /** A single step in a workflow */
   interface WorkflowStep {
     id: string;
     /** Display name for this step */
     name: string;
     /**
      * Which agent executes this step.
      * - When agentRefType is 'builtin': one of 'planner', 'coder', 'general'
      * - When agentRefType is 'custom': a custom agent ID
      * Note: 'leader' is NOT a valid agentRef — the Leader is always implicitly
      * created alongside any Worker. See 00-overview.md architecture decisions.
      */
     agentRef: string;
     /** Whether agentRef is a built-in role or a custom agent ID */
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
     /**
      * Which steps this rule applies to, by step **ID** (not step name).
      * Using IDs ensures rules survive step renames in the workflow editor.
      * Empty array = applies to all steps.
      */
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

**Acceptance criteria:**
- All workflow types are defined and exported from `@neokai/shared`
- Types support the full workflow lifecycle: creation, step sequencing, gates, rules
- JSDoc documentation on all interfaces, with clear semantics for `maxRetries` (re-evaluate gate only, not re-run step), `command` security constraints, and `agentRef` valid values
- Gate `timeoutMs` field is included with documented defaults and max
- 'leader' is explicitly documented as NOT a valid `agentRef` value
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.2: Database Migration for Workflows (Consolidated Migration B)

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.1

**Description:**

Add a SQLite migration creating `workflows` and `workflow_steps` tables, plus workflow tracking columns on `tasks` and `goals`. This is **consolidated Migration B** — a single migration covering M3, M4, and M7 schema needs.

**Subtasks:**

1. Add a new migration in `packages/daemon/src/storage/schema/migrations.ts`:

   ```sql
   -- Workflow definitions
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

   -- Workflow step definitions
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

   -- Workflow tracking on tasks (for M4 runtime)
   ALTER TABLE tasks ADD COLUMN workflow_id TEXT;
   ALTER TABLE tasks ADD COLUMN current_workflow_step_id TEXT;

   -- Workflow assignment on goals (for M7 selection)
   ALTER TABLE goals ADD COLUMN workflow_id TEXT;
   ```

2. Add indexes:
   - `CREATE INDEX idx_workflows_room_id ON workflows(room_id)`
   - `CREATE INDEX idx_workflow_steps_workflow_id ON workflow_steps(workflow_id)`

3. Write a migration test verifying:
   - Tables are created
   - Foreign key cascade works (delete workflow -> steps deleted)
   - Room cascade works (delete room -> workflows deleted)
   - `tasks.workflow_id` and `tasks.current_workflow_step_id` columns exist and are nullable
   - `goals.workflow_id` column exists and is nullable
   - Existing tasks and goals are unaffected

**Acceptance criteria:**
- Single migration covers all workflow-related schema changes (M3 + M4 + M7)
- CASCADE deletes work correctly
- Migration test passes
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.3: WorkflowRepository and WorkflowManager

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.2

**Description:**

Create the data access and business logic layers for workflows, including referential integrity for custom agent references.

**Subtasks:**

1. Create `packages/daemon/src/storage/repositories/workflow-repository.ts`:
   - `createWorkflow(params: CreateWorkflowParams & { roomId: string }): Workflow`
   - `getWorkflow(id: string): Workflow | null` -- joins with `workflow_steps` to build full object
   - `listWorkflows(roomId: string): Workflow[]`
   - `updateWorkflow(id: string, params: UpdateWorkflowParams): Workflow | null`
   - `deleteWorkflow(id: string): boolean`
   - `getDefaultWorkflow(roomId: string): Workflow | null`
   - `setDefaultWorkflow(roomId: string, workflowId: string): void`
   - `getWorkflowsReferencingAgent(agentId: string): Workflow[]` -- finds workflows that reference a custom agent (used for deletion protection in `CustomAgentManager`)
   - Handle step CRUD within workflow transactions (replace all steps on update)
   - JSON serialization for `rules`, `tags`, `entry_gate`, `exit_gate`
   - Implement `rowToWorkflow()` and `rowToStep()` mapping functions following existing repository patterns

2. Create `packages/daemon/src/lib/room/managers/workflow-manager.ts`:
   - Wraps repository with validation:
     - Workflow name uniqueness within a room
     - Step agent references are valid:
       - Built-in: must be one of `'planner'`, `'coder'`, `'general'` (NOT `'leader'` — Leader is implicit)
       - Custom: must reference an existing custom agent ID in the same room (query `CustomAgentManager`)
     - At least one step required
     - Step order is contiguous (0, 1, 2, ...)
     - Gate command validation:
       - `quality_check` gates: command must be in the allowlist
       - `custom` gates: command must be a relative path within workspace, no `..` traversal
       - `timeoutMs` must be within range (0-300000)
   - Business logic:
     - When setting a new default, unset the previous default
     - When deleting a workflow that is the default, clear the room's default

3. Export from `packages/daemon/src/lib/room/index.ts`

4. Write unit tests:
   - Full CRUD lifecycle
   - Step ordering validation
   - Agent reference validation (both builtin and custom)
   - Rejection of 'leader' as a builtin agent ref
   - Gate command validation (allowlist for quality_check, path validation for custom)
   - Default workflow management
   - JSON round-trip for gates and rules
   - `getWorkflowsReferencingAgent` returns correct results

**Acceptance criteria:**
- Repository handles all CRUD with proper step management
- Manager validates workflow integrity including gate security constraints
- Agent reference validation prevents invalid references
- Default workflow switching works correctly
- Unit tests cover all paths
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.4: Workflow RPC Handlers and DaemonEventMap Registration

**Agent:** coder
**Priority:** normal
**Depends on:** Task 3.3

**Description:**

Add RPC handlers for frontend access to workflow CRUD operations. Register new event types in `DaemonEventMap`.

**Subtasks:**

1. **Register new event types in `DaemonEventMap`** (`packages/daemon/src/lib/daemon-hub.ts`):
   Add the following entries:
   ```typescript
   // Workflow events (routed via room channel: sessionId = 'room:${roomId}')
   'workflow.created': { sessionId: string; roomId: string; workflow: Workflow };
   'workflow.updated': { sessionId: string; roomId: string; workflow: Workflow };
   'workflow.deleted': { sessionId: string; roomId: string; workflowId: string };
   ```
   Import the `Workflow` type from `@neokai/shared`.

2. Create `packages/daemon/src/lib/rpc-handlers/workflow-handlers.ts`:
   - `workflow.create { roomId, name, description, steps, rules, tags }` -> `{ workflow }`
   - `workflow.list { roomId }` -> `{ workflows }`
   - `workflow.get { id }` -> `{ workflow }`
   - `workflow.update { id, ... }` -> `{ workflow }`
   - `workflow.delete { id }` -> `{ success }`
   - `workflow.setDefault { roomId, workflowId }` -> `{ success }`

3. Wire handlers in `packages/daemon/src/app.ts`

4. Emit DaemonHub events using registered types:
   - `workflow.created`, `workflow.updated`, `workflow.deleted`

5. Write unit tests for all handlers

**Acceptance criteria:**
- All CRUD operations work via RPC
- DaemonHub events are registered in `DaemonEventMap` (TypeScript compilation succeeds)
- DaemonHub events enable real-time UI updates
- Error handling covers not-found, validation failures
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.5: Built-in Workflow Templates (Definitions Only)

**Agent:** coder
**Priority:** normal
**Depends on:** Task 3.3

**Description:**

Create built-in workflow template definitions that mirror the existing hardcoded behavior. These serve as defaults and examples for users building custom workflows. **This task only defines templates and the seeding utility function.** The actual call site that seeds workflows during room creation is wired in Task 4.2a (M4), avoiding a circular M3 -> M4 dependency.

**Subtasks:**

1. Create `packages/daemon/src/lib/room/workflows/built-in-workflows.ts` with:
   - `CODING_WORKFLOW`: Planner -> Coder (with `human_approval` exit gate on Planner for plan review, `pr_review` exit gate on Coder) -- mirrors current RoomRuntime behavior. Note: Leader is implicit per group, not a workflow step.
   - `RESEARCH_WORKFLOW`: Planner -> General (with `auto` gates)
   - `REVIEW_ONLY_WORKFLOW`: Coder (single step, `pr_review` exit gate, no planning step)

2. Each template includes appropriate gates:
   - Templates include default rules matching current room instructions behavior
   - Gate commands for `quality_check` use only allowlisted commands

3. Add a `getBuiltInWorkflows(): Workflow[]` export function that returns template definitions (without room-specific IDs)

4. Create a `seedDefaultWorkflow(roomId: string, workflowManager: WorkflowManager): Promise<void>` utility function:
   - Idempotent: checks if room already has a default workflow before seeding
   - Only seeds `CODING_WORKFLOW` as the default
   - **Not wired into any call site in this task** — the call site in `room-manager.ts` is added in Task 4.2a after the runtime can execute workflows

5. Write unit tests:
   - Verify template structure (correct steps, valid agent refs, valid gates)
   - Verify all agent references are valid built-in roles (no 'leader')
   - Verify idempotent seeding logic (calling `seedDefaultWorkflow` twice does not create duplicates)

**Acceptance criteria:**
- Three built-in workflow templates are defined
- Templates mirror existing runtime behavior accurately (Leader is implicit, not a step)
- `seedDefaultWorkflow` utility is implemented and tested but NOT wired into room creation (that's Task 4.2a)
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
