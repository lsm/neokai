/**
 * Space System Types
 *
 * Types for the Space multi-agent workflow system.
 * Spaces are distinct from Rooms — they are workspace-first, workflow-centric
 * contexts for orchestrating custom agents and automated pipelines.
 */

// ============================================================================
// Space Types
// ============================================================================

/**
 * Space status
 */
export type SpaceStatus = 'active' | 'archived';

/**
 * A Space — a workspace-first context for multi-agent workflows.
 * Unlike Rooms, a Space has a single required workspace path and is
 * designed around workflow execution with customizable agents.
 */
export interface Space {
	/** Unique identifier */
	id: string;
	/** Absolute path to the workspace this Space operates on (required, unique) */
	workspacePath: string;
	/** Human-readable name */
	name: string;
	/** Short description of this Space's purpose */
	description: string;
	/** Background context — describes project, codebase, conventions, constraints */
	backgroundContext: string;
	/** Custom instructions for how Space agents should behave */
	instructions: string;
	/** Default model for sessions and agents in this Space */
	defaultModel?: string;
	/** Allowed models for this Space (empty/undefined = all models allowed) */
	allowedModels?: string[];
	/** IDs of sessions associated with this Space */
	sessionIds: string[];
	/** Current status of the Space */
	status: SpaceStatus;
	/** Runtime configuration (maxConcurrentTasks, taskTimeout, etc.) */
	config?: Record<string, unknown>;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Parameters for creating a new Space
 */
export interface CreateSpaceParams {
	/** Absolute path to the workspace (required, must exist) */
	workspacePath: string;
	/** Human-readable name */
	name: string;
	/** Short description of this Space's purpose */
	description?: string;
	/** Background context for agents */
	backgroundContext?: string;
	/** Custom instructions for agents */
	instructions?: string;
	/** Default model for new sessions and agents */
	defaultModel?: string;
	/** Allowed models for this Space */
	allowedModels?: string[];
	/** Runtime configuration */
	config?: Record<string, unknown>;
}

/**
 * Parameters for updating a Space
 */
export interface UpdateSpaceParams {
	name?: string;
	description?: string;
	backgroundContext?: string;
	instructions?: string;
	defaultModel?: string | null;
	allowedModels?: string[];
	config?: Record<string, unknown>;
}

// ============================================================================
// Space Task Types
// ============================================================================

/**
 * Space task status — matches NeoTask status set plus space-specific values
 */
export type SpaceTaskStatus =
	| 'draft'
	| 'pending'
	| 'in_progress'
	| 'review'
	| 'completed'
	| 'needs_attention'
	| 'cancelled';

/**
 * Space task priority
 */
export type SpaceTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Space task type — determines default execution approach
 */
export type SpaceTaskType = 'planning' | 'coding' | 'research' | 'design' | 'review';

/**
 * A task managed within a Space.
 * Mirrors NeoTask but is tied to a Space (not a Room) and includes
 * workflow/agent routing fields built in from the start.
 */
export interface SpaceTask {
	/** Unique identifier */
	id: string;
	/** Space this task belongs to */
	spaceId: string;
	/** Task title */
	title: string;
	/** Detailed description */
	description: string;
	/** Current status */
	status: SpaceTaskStatus;
	/** Priority level */
	priority: SpaceTaskPriority;
	/** Task type — determines default execution approach */
	taskType?: SpaceTaskType;
	/** Which agent type should execute this task (default: 'coder') */
	assignedAgent?: 'coder' | 'general';
	/** ID of a custom Space agent assigned to execute this task */
	customAgentId?: string;
	/** ID of the workflow run that spawned this task (if any) */
	workflowRunId?: string;
	/** ID of the workflow step that spawned this task (if any) */
	workflowStepId?: string;
	/** ID of the planning task that created this task */
	createdByTaskId?: string;
	/** Progress percentage (0-100) */
	progress?: number | null;
	/** Description of current step */
	currentStep?: string | null;
	/** Result of completed task */
	result?: string | null;
	/** Error message for failed task */
	error?: string | null;
	/** IDs of tasks this task depends on */
	dependsOn: string[];
	/** Draft input text for the human input area */
	inputDraft?: string | null;
	/**
	 * Which agent session is currently active (generating output).
	 * Cleared when the session reaches a terminal state.
	 */
	activeSession?: 'worker' | 'leader' | null;
	/** Pull request URL (when task has associated PR) */
	prUrl?: string | null;
	/** Pull request number (extracted from URL for display) */
	prNumber?: number | null;
	/** When PR was created/submitted (milliseconds since epoch) */
	prCreatedAt?: number | null;
	/** Archive timestamp (milliseconds since epoch) — orthogonal to status */
	archivedAt?: number | null;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Start timestamp (milliseconds since epoch) */
	startedAt?: number;
	/** Completion timestamp (milliseconds since epoch) */
	completedAt?: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Parameters for creating a new SpaceTask
 */
export interface CreateSpaceTaskParams {
	spaceId: string;
	title: string;
	description: string;
	priority?: SpaceTaskPriority;
	taskType?: SpaceTaskType;
	assignedAgent?: 'coder' | 'general';
	/** Custom Space agent to execute this task */
	customAgentId?: string;
	/** Workflow run that spawned this task */
	workflowRunId?: string;
	/** Workflow step that spawned this task */
	workflowStepId?: string;
	dependsOn?: string[];
	/** Initial status — defaults to 'pending' */
	status?: SpaceTaskStatus;
	/** ID of planning task that created this task */
	createdByTaskId?: string;
}

/**
 * Parameters for updating a SpaceTask
 */
export interface UpdateSpaceTaskParams {
	title?: string;
	description?: string;
	status?: SpaceTaskStatus;
	priority?: SpaceTaskPriority;
	taskType?: SpaceTaskType;
	assignedAgent?: 'coder' | 'general';
	customAgentId?: string | null;
	workflowRunId?: string | null;
	workflowStepId?: string | null;
	progress?: number | null;
	currentStep?: string | null;
	result?: string | null;
	error?: string | null;
	dependsOn?: string[];
	activeSession?: 'worker' | 'leader' | null;
	prUrl?: string | null;
	prNumber?: number | null;
	prCreatedAt?: number | null;
	inputDraft?: string | null;
}

// ============================================================================
// Space Workflow Run Types
// ============================================================================

/**
 * Status of a workflow run
 */
export type WorkflowRunStatus =
	| 'pending'
	| 'in_progress'
	| 'completed'
	| 'cancelled'
	| 'needs_attention';

/**
 * Tracks a single execution of a Space workflow.
 * A workflow run is created each time a workflow is triggered and tracks
 * the progress through each step of the workflow definition.
 */
export interface SpaceWorkflowRun {
	/** Unique identifier */
	id: string;
	/** Space this run belongs to */
	spaceId: string;
	/** ID of the workflow definition being executed */
	workflowId: string;
	/** Human-readable title for this run (e.g., "Deploy v2.1 — Run #3") */
	title: string;
	/** Optional description or goal for this run */
	description?: string;
	/** Zero-based index of the step currently being executed */
	currentStepIndex: number;
	/** Current execution status */
	status: WorkflowRunStatus;
	/** Optional runtime configuration for this run */
	config?: Record<string, unknown>;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
	/** Completion timestamp (milliseconds since epoch) */
	completedAt?: number;
}

/**
 * Parameters for creating a new SpaceWorkflowRun
 */
export interface CreateWorkflowRunParams {
	spaceId: string;
	workflowId: string;
	title: string;
	description?: string;
}

// ============================================================================
// Space Session Group Types
// ============================================================================

/**
 * A member of a SpaceSessionGroup
 */
export interface SpaceSessionGroupMember {
	/** Unique identifier of this membership record */
	id: string;
	/** Session group this member belongs to */
	groupId: string;
	/** ID of the session */
	sessionId: string;
	/** Role of this session within the group */
	role: 'worker' | 'leader';
	/** Display order within the group */
	orderIndex: number;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
}

/**
 * A named group of sessions within a Space.
 * Session groups allow organizing related sessions (e.g., a workflow run's
 * leader + workers) under a single logical unit for display and management.
 */
export interface SpaceSessionGroup {
	/** Unique identifier */
	id: string;
	/** Space this group belongs to */
	spaceId: string;
	/** Human-readable label for the group */
	name: string;
	/** Optional description of the group's purpose */
	description?: string;
	/** Members of this group */
	members: SpaceSessionGroupMember[];
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

// ============================================================================
// SpaceAgent Types (M2)
// ============================================================================

/**
 * Builtin agent roles available in the Space system.
 *
 * NOTE: 'leader' is intentionally NOT a valid agent role — the Leader agent is
 * always implicit and managed by SpaceRuntime. User-configurable agents are
 * limited to worker roles: 'planner', 'coder', 'general'.
 */
export type BuiltinAgentRole = 'planner' | 'coder' | 'general';

/**
 * A named agent configuration within a Space.
 * SpaceAgents can be referenced by name in SpaceWorkflow steps.
 */
export interface SpaceAgent {
	/** Unique identifier */
	id: string;
	/** Space this agent belongs to */
	spaceId: string;
	/** Human-readable name (unique within a space) */
	name: string;
	/** Optional description of this agent's specialization */
	description?: string;
	/**
	 * Builtin role preset — determines default tools and behavior.
	 * One of: 'planner', 'coder', 'general'.
	 * NOTE: 'leader' is NOT a valid role here — Leader is implicit in SpaceRuntime.
	 */
	role: BuiltinAgentRole;
	/** Model ID override (e.g., 'claude-haiku-4-5') — uses space default if unset */
	model?: string;
	/** Provider name override (e.g., 'anthropic', 'openai') */
	provider?: string;
	/** Custom system prompt appended to the role preset */
	systemPrompt?: string;
	/** Tool configuration overrides */
	toolConfig?: Record<string, unknown>;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Parameters for creating a new SpaceAgent
 */
export interface CreateSpaceAgentParams {
	spaceId: string;
	name: string;
	role: BuiltinAgentRole;
	description?: string;
	model?: string;
	provider?: string;
	systemPrompt?: string;
	toolConfig?: Record<string, unknown>;
}

/**
 * Parameters for updating a SpaceAgent
 */
export interface UpdateSpaceAgentParams {
	name?: string;
	description?: string | null;
	role?: BuiltinAgentRole;
	model?: string | null;
	provider?: string | null;
	systemPrompt?: string | null;
	toolConfig?: Record<string, unknown> | null;
}

// ============================================================================
// Workflow Types (M3)
// ============================================================================

/**
 * The type of gate used at workflow step boundaries.
 *
 * - `auto`: Gate passes automatically when the agent step finishes
 * - `human_approval`: Requires a human to explicitly approve before proceeding
 * - `quality_check`: Runs an allowlisted command and passes only on exit code 0
 * - `pr_review`: Waits for a GitHub PR review to approve before proceeding
 * - `custom`: Runs a custom script at a relative workspace path (must be allowlisted)
 */
export type WorkflowGateType = 'auto' | 'human_approval' | 'quality_check' | 'pr_review' | 'custom';

/**
 * A gate that controls whether a workflow step may start (entry gate) or
 * whether the workflow may advance to the next step (exit gate).
 */
export interface WorkflowGate {
	/**
	 * Type of gate.
	 * - 'auto': passes immediately
	 * - 'human_approval': blocks until a human approves
	 * - 'quality_check': runs an allowlisted shell command
	 * - 'pr_review': waits for GitHub PR approval
	 * - 'custom': runs a script at a relative workspace path
	 */
	type: WorkflowGateType;
	/**
	 * Command or script to execute for 'quality_check' and 'custom' gate types.
	 *
	 * - For `quality_check`: must be an allowlisted command (e.g., 'bun test', 'npm run lint').
	 *   Gate passes on exit code 0, fails on any non-zero exit.
	 * - For `custom`: must be a path relative to the workspace root (e.g., './scripts/verify.sh').
	 *   The script is resolved relative to the Space's workspacePath.
	 */
	command?: string;
	/** Human-readable description of what this gate checks */
	description?: string;
	/**
	 * Maximum number of times the gate evaluation is retried on failure.
	 *
	 * IMPORTANT: retries re-evaluate the gate only — they do NOT re-run the
	 * agent step that preceded the gate. To re-run the step itself, the entire
	 * workflow step must be retried at a higher level.
	 *
	 * Defaults to 0 (no retries — fail immediately on first failure).
	 */
	maxRetries?: number;
	/** Timeout for gate evaluation in milliseconds (0 = no timeout) */
	timeoutMs?: number;
}

/**
 * Discriminated union encoding the agent reference within a workflow step.
 *
 * Using a union (rather than two separate fields) lets TypeScript enforce that
 * 'leader' is rejected at compile time when agentRefType is 'builtin'.
 *
 * - `builtin`: agentRef is one of the BuiltinAgentRole values ('planner', 'coder', 'general').
 *   NOTE: 'leader' is NOT a valid builtin agentRef — Leader is always implicit in SpaceRuntime.
 * - `custom`: agentRef is the `name` of a SpaceAgent defined in this Space.
 */
export type WorkflowStepAgent =
	| { agentRefType: 'builtin'; agentRef: BuiltinAgentRole }
	| { agentRefType: 'custom'; agentRef: string };

/**
 * A single step within a SpaceWorkflow.
 * Each step runs one agent and optionally has entry/exit gates.
 */
export type WorkflowStep = WorkflowStepAgent & {
	/** Unique identifier for this step (stable across renames) */
	id: string;
	/** Human-readable name for display */
	name: string;
	/**
	 * Gate checked before this step begins execution.
	 * If absent, the step starts automatically when the previous step's exit gate passes.
	 */
	entryGate?: WorkflowGate;
	/**
	 * Gate checked after this step's agent finishes.
	 * If absent, the workflow advances to the next step automatically.
	 */
	exitGate?: WorkflowGate;
	/** Step-specific instructions appended to the agent's system prompt */
	instructions?: string;
	/** Zero-based execution order within the workflow */
	order: number;
};

/**
 * A rule that applies to workflow execution, similar to room-level rules.
 * Rules express constraints, standards, or guidelines the agent must follow.
 */
export interface WorkflowRule {
	/** Unique identifier (stable across renames) */
	id: string;
	/** Human-readable name for display */
	name: string;
	/** Rule content — markdown prose describing the constraint or guideline */
	content: string;
	/**
	 * List of step IDs this rule applies to.
	 *
	 * Uses step **IDs** (not names) so that rules survive step renames.
	 * Empty array or omitted means the rule applies to ALL steps in the workflow.
	 */
	appliesTo?: string[];
}

/**
 * Distributive Omit that preserves discriminated union structure.
 *
 * TypeScript's built-in `Omit<T, K>` does not distribute over union members —
 * when applied to an intersection type that wraps a union (like `WorkflowStep`),
 * it collapses the discriminant and silently drops union enforcement.
 * `DistributiveOmit` maps over each union branch individually so that
 * discriminated-union invariants are preserved in the result.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Input shape for a workflow step at creation time.
 * `id` and `order` are backend-assigned and must not be provided by callers.
 * The backend assigns `id` (UUID) and derives `order` from the array position.
 *
 * Uses `DistributiveOmit` (not `Omit`) so that the `WorkflowStepAgent`
 * discriminated union is preserved: TypeScript will still reject
 * `agentRef: 'leader'` when `agentRefType: 'builtin'` at compile time.
 */
export type WorkflowStepInput = DistributiveOmit<WorkflowStep, 'id' | 'order'>;

/**
 * Input shape for a workflow rule at creation time.
 * `id` is backend-assigned and must not be provided by callers.
 */
export type WorkflowRuleInput = Omit<WorkflowRule, 'id'>;

/**
 * A named, reusable workflow definition within a Space.
 * Workflows define an ordered sequence of agent steps with gates and rules.
 * The SpaceRuntime executes workflows by creating SpaceWorkflowRun instances.
 */
export interface SpaceWorkflow {
	/** Unique identifier */
	id: string;
	/** Space this workflow belongs to */
	spaceId: string;
	/** Human-readable name */
	name: string;
	/** Optional description of what this workflow accomplishes */
	description?: string;
	/** Ordered list of steps — executed in ascending `order` */
	steps: WorkflowStep[];
	/** Rules that govern agent behavior during this workflow */
	rules: WorkflowRule[];
	/** Tags for categorization */
	tags: string[];
	/** Additional runtime configuration (opaque bag for future extensibility) */
	config?: Record<string, unknown>;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Parameters for creating a new SpaceWorkflow
 */
export interface CreateSpaceWorkflowParams {
	spaceId: string;
	name: string;
	description?: string;
	/**
	 * Steps in execution order. `id` and `order` are backend-assigned;
	 * the array position determines execution order.
	 */
	steps?: WorkflowStepInput[];
	/**
	 * Rules governing agent behavior. `id` is backend-assigned.
	 */
	rules?: WorkflowRuleInput[];
	/** Tags for categorization (default: []). */
	tags?: string[];
	config?: Record<string, unknown>;
}

/**
 * Parameters for updating an existing SpaceWorkflow.
 * All fields are optional — only provided fields are updated.
 *
 * For array fields (`steps`, `rules`, `tags`):
 * - Pass a new array to replace the entire collection.
 * - Pass `null` to explicitly clear the field to an empty collection.
 * - Pass `[]` to clear all entries (equivalent to null for arrays).
 */
export interface UpdateSpaceWorkflowParams {
	name?: string;
	description?: string | null;
	/**
	 * Replaces the entire step list. Pass `[]` or `null` to clear all steps.
	 * The backend re-assigns `order` from the array position.
	 */
	steps?: WorkflowStep[] | null;
	/**
	 * Replaces the entire rule list. Pass `[]` or `null` to clear all rules.
	 */
	rules?: WorkflowRule[] | null;
	/**
	 * Replaces the tag list. Pass `[]` or `null` to clear all tags.
	 */
	tags?: string[] | null;
	config?: Record<string, unknown> | null;
}
