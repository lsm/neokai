# Milestone 3: Workflow Data Model

## Goal

Define the workflow types, repository, manager, RPC handlers, and built-in templates for custom workflows within Spaces. A workflow defines a sequence of agent steps with runtime gates between them and configurable rules. All code lives in the Space namespace — no existing Room code is modified.

## Isolation Checklist

- Types in `packages/shared/src/types/space.ts` (NOT `neo.ts`)
- Repository in `packages/daemon/src/storage/repositories/space-workflow-repository.ts`
- Manager in `packages/daemon/src/lib/space/managers/space-workflow-manager.ts`
- RPC handlers use `spaceWorkflow.*` namespace (NOT `workflow.*`)
- DaemonEventMap entries use `spaceWorkflow.*` namespace
- Built-in templates in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`
- Exports from `packages/daemon/src/lib/space/index.ts` (NOT `room/index.ts`)
- DB tables `space_workflows` and `space_workflow_steps` already created in M1 migration — **no new migration needed**

## Scope

- Workflow shared types (gates, steps, rules) in `space.ts`
- `SpaceWorkflowRepository` and `SpaceWorkflowManager`
- RPC handlers for workflow CRUD (`spaceWorkflow.*`)
- DaemonEventMap registration (`spaceWorkflow.created/updated/deleted`)
- Built-in workflow templates
- Unit tests

---

### Task 3.1: Define Workflow Shared Types

**Agent:** coder
**Priority:** high
**Depends on:** (none — types are independent)

**Description:**

Add workflow types to `packages/shared/src/types/space.ts` (alongside the Space/SpaceTask/SpaceWorkflowRun types from M1 and SpaceAgent types from M2).

**Subtasks:**

1. Add the following types to `packages/shared/src/types/space.ts`:

   ```typescript
   /** Gate type — runtime checkpoints between workflow steps */
   type WorkflowGateType =
     | 'auto'           // Automatically proceed
     | 'human_approval' // Pause for human approval
     | 'quality_check'  // Run automated checks from allowlist
     | 'pr_review'      // PR review gate
     | 'custom';        // Custom workspace-scoped script

   /** A gate between workflow steps */
   interface WorkflowGate {
     type: WorkflowGateType;
     /**
      * For quality_check: must be an allowlisted command (e.g., 'bun run check').
      * For custom: relative path to script within workspace (no '..', no absolute paths).
      * See 00-overview.md "Gate Security Model".
      */
     command?: string;
     description?: string;
     /**
      * Max retries before escalating (0 = no retry).
      * Retry re-evaluates the gate only, does NOT re-run the agent step.
      * After retries exhausted, gate fails and task → 'needs_attention'.
      */
     maxRetries?: number;
     /** Timeout in ms for gate command. Default: 60000. Max: 300000. */
     timeoutMs?: number;
   }

   /** A single step in a workflow */
   interface WorkflowStep {
     id: string;
     name: string;
     /**
      * Which agent executes this step.
      * - builtin: 'planner', 'coder', 'general' (NOT 'leader' — Leader is implicit)
      * - custom: a SpaceAgent ID
      */
     agentRef: string;
     agentRefType: 'builtin' | 'custom';
     entryGate?: WorkflowGate | null;
     exitGate?: WorkflowGate | null;
     instructions?: string;
     order: number;
   }

   /** Rule injected into agent prompts */
   interface WorkflowRule {
     id: string;
     name: string;
     content: string;
     /**
      * Which steps this rule applies to, by step **ID** (not name).
      * IDs survive step renames. Empty array = applies to all steps.
      */
     appliesTo?: string[];
   }

   /** A complete workflow definition within a Space */
   interface SpaceWorkflow {
     id: string;
     spaceId: string;
     name: string;
     description: string;
     steps: WorkflowStep[];
     rules: WorkflowRule[];
     isDefault: boolean;
     tags: string[];
     config?: Record<string, unknown>;
     createdAt: number;
     updatedAt: number;
   }

   interface CreateSpaceWorkflowParams {
     name: string;
     description?: string;
     steps: Omit<WorkflowStep, 'id'>[];
     rules?: Omit<WorkflowRule, 'id'>[];
     tags?: string[];
     config?: Record<string, unknown>;
   }

   interface UpdateSpaceWorkflowParams {
     name?: string;
     description?: string;
     steps?: Omit<WorkflowStep, 'id'>[];
     rules?: Omit<WorkflowRule, 'id'>[];
     tags?: string[];
     config?: Record<string, unknown>;
   }
   ```

2. Export all types from shared package barrel (`packages/shared/src/mod.ts`)

**Acceptance criteria:**
- All workflow types defined and exported from `@neokai/shared` via `space.ts`
- JSDoc on all interfaces with clear semantics for `maxRetries`, `command` constraints, and `agentRef` valid values
- `leader` explicitly documented as NOT a valid `agentRef`
- No modifications to `packages/shared/src/types/neo.ts`
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.2: SpaceWorkflowRepository and SpaceWorkflowManager

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.1, Task 1.2

**Description:**

Build the data access and business logic layers for workflows within Spaces. The `space_workflows` and `space_workflow_steps` tables were already created in the M1 migration — **no new migration needed**.

**Subtasks:**

1. Create `packages/daemon/src/storage/repositories/space-workflow-repository.ts`:
   - `createWorkflow(params: CreateSpaceWorkflowParams & { spaceId: string }): SpaceWorkflow`
   - `getWorkflow(id: string): SpaceWorkflow | null` — joins with `space_workflow_steps`
   - `listWorkflows(spaceId: string): SpaceWorkflow[]`
   - `updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null`
   - `deleteWorkflow(id: string): boolean`
   - `getDefaultWorkflow(spaceId: string): SpaceWorkflow | null`
   - `setDefaultWorkflow(spaceId: string, workflowId: string): void`
   - `getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[]` — finds workflows referencing a custom agent (used for deletion protection in `SpaceAgentManager`)
   - Handle step CRUD within workflow transactions (replace all steps on update)
   - JSON serialization for `rules`, `tags`, `entry_gate`, `exit_gate`
   - `rowToWorkflow()` and `rowToStep()` mapping functions

2. Create `packages/daemon/src/lib/space/managers/space-workflow-manager.ts`:
   - Validation:
     - Name unique within space
     - Step agent references valid: builtin must be `'planner'|'coder'|'general'` (NOT `'leader'`); custom must reference existing `SpaceAgent` in same space (query `SpaceAgentManager`)
     - At least one step required
     - Step order contiguous (0, 1, 2, ...)
     - Gate command validation: `quality_check` → allowlist only; `custom` → relative path, no `..`; `timeoutMs` within range 0–300000
   - Business logic:
     - Setting new default unsets previous default
     - Deleting default workflow clears the space's default

3. Export from `packages/daemon/src/lib/space/index.ts`

4. Write unit tests:
   - Full CRUD lifecycle
   - Step ordering validation
   - Agent reference validation (builtin + custom via `SpaceAgentManager`)
   - Rejection of 'leader' as builtin agent ref
   - Gate command validation (allowlist, path validation)
   - Default workflow management
   - JSON round-trip for gates and rules
   - `getWorkflowsReferencingAgent` returns correct results

**Acceptance criteria:**
- Repository handles CRUD with proper step management using `space_workflows`/`space_workflow_steps` tables
- Manager validates workflow integrity including gate security
- Agent reference validation queries `SpaceAgentManager` (NOT a nonexistent `CustomAgentManager`)
- Default workflow switching works correctly
- All files in Space namespace — nothing in `packages/daemon/src/lib/room/`
- Unit tests cover all paths
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.3: Workflow RPC Handlers and DaemonEventMap Registration

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.2

**Description:**

Add RPC handlers for workflow CRUD using the `spaceWorkflow.*` namespace. Register events in DaemonEventMap.

**Subtasks:**

1. Register in `DaemonEventMap` (`packages/daemon/src/lib/daemon-hub.ts`):
   ```typescript
   'spaceWorkflow.created': { sessionId: string; spaceId: string; workflow: SpaceWorkflow };
   'spaceWorkflow.updated': { sessionId: string; spaceId: string; workflow: SpaceWorkflow };
   'spaceWorkflow.deleted': { sessionId: string; spaceId: string; workflowId: string };
   ```
   Import `SpaceWorkflow` from `@neokai/shared`.

2. Create `packages/daemon/src/lib/rpc-handlers/space-workflow-handlers.ts`:
   - `spaceWorkflow.create { spaceId, name, description, steps, rules, tags }` → `{ workflow }`
   - `spaceWorkflow.list { spaceId }` → `{ workflows }`
   - `spaceWorkflow.get { id }` → `{ workflow }`
   - `spaceWorkflow.update { id, ... }` → `{ workflow }`
   - `spaceWorkflow.delete { id }` → `{ success }`
   - `spaceWorkflow.setDefault { spaceId, workflowId }` → `{ success }`

3. Wire handlers in `packages/daemon/src/lib/rpc-handlers/index.ts` (via `setupRPCHandlers()` — add new registration only, do not modify existing handler setup)

4. Emit DaemonHub events: `spaceWorkflow.created`, `spaceWorkflow.updated`, `spaceWorkflow.deleted`

5. Write unit tests for all handlers

**Acceptance criteria:**
- All CRUD operations work via `spaceWorkflow.*` RPC namespace
- DaemonHub events use `spaceWorkflow.*` namespace (matching what `SpaceStore` subscribes to in M5)
- Error handling covers not-found, validation failures
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3.4: Built-in Workflow Templates

**Agent:** coder
**Priority:** normal
**Depends on:** Task 3.2

**Description:**

Create built-in workflow templates that serve as defaults and examples. Also create the seeding utility. All files in Space namespace.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`:
   - `CODING_WORKFLOW`: Planner → Coder (with `human_approval` exit gate on Planner, `pr_review` exit gate on Coder) — mirrors current multi-agent behavior. Leader is implicit per group, not a step.
   - `RESEARCH_WORKFLOW`: Planner → General (with `auto` gates)
   - `REVIEW_ONLY_WORKFLOW`: Coder (single step, `pr_review` exit gate, no planning)

2. Each template includes appropriate gates with only allowlisted commands

3. `getBuiltInWorkflows(): SpaceWorkflow[]` — returns templates without space-specific IDs

4. `seedDefaultWorkflow(spaceId: string, workflowManager: SpaceWorkflowManager): Promise<void>`:
   - Idempotent: checks if space already has a default workflow
   - Seeds `CODING_WORKFLOW` as default
   - **Call site wired in Task 4.2** (in the `space.create` RPC handler, after `SpaceManager.createSpace()` returns), not here

5. Write unit tests:
   - Template structure validation
   - All agent refs are valid builtins (no 'leader')
   - Idempotent seeding

**Acceptance criteria:**
- Three built-in workflow templates defined
- Templates mirror existing behavior (Leader is implicit, not a step)
- `seedDefaultWorkflow` implemented and tested but NOT wired (that's M4)
- All files in `packages/daemon/src/lib/space/workflows/` (NOT `room/workflows/`)
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
