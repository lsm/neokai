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
 * Space autonomy level — controls how much the Space Agent can act without human approval.
 *
 * - `supervised` (default): Space Agent notifies human of all judgment-required events
 *   and waits for approval before acting.
 * - `semi_autonomous`: Space Agent can retry failed tasks and reassign them autonomously;
 *   escalates to human after one failed retry or when uncertain.
 */
export type SpaceAutonomyLevel = 'supervised' | 'semi_autonomous';

/**
 * Typed runtime configuration for a Space.
 */
export interface SpaceConfig {
	/** Maximum number of tasks that may run concurrently in this Space */
	maxConcurrentTasks?: number;
	/** Timeout for a single task in milliseconds */
	taskTimeoutMs?: number;
}

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
	/** Autonomy level — controls how much the Space Agent can act without human approval */
	autonomyLevel?: SpaceAutonomyLevel;
	/** Runtime configuration (maxConcurrentTasks, taskTimeoutMs, etc.) */
	config?: SpaceConfig;
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
	/** Autonomy level for the Space Agent */
	autonomyLevel?: SpaceAutonomyLevel;
	/** Runtime configuration */
	config?: SpaceConfig;
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
	autonomyLevel?: SpaceAutonomyLevel;
	config?: SpaceConfig;
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
	| 'cancelled'
	| 'archived';

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
	/** ID of the goal/mission this task is associated with */
	goalId?: string;
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
	/**
	 * ID of the Task Agent session that orchestrates this task's workflow execution.
	 * Set when the task transitions from 'pending' to 'in_progress' and a Task Agent
	 * session is created. Null when no Task Agent has been spawned yet.
	 */
	taskAgentSessionId?: string | null;
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
	/** Goal/mission this task is associated with */
	goalId?: string;
	/**
	 * ID of the Task Agent session that orchestrates this task's workflow execution.
	 * Set when the task transitions from 'pending' to 'in_progress'.
	 */
	taskAgentSessionId?: string | null;
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
	/** Goal/mission this task is associated with; null to clear */
	goalId?: string | null;
	/**
	 * ID of the Task Agent session that orchestrates this task's workflow execution.
	 * Set when spawning a Task Agent; null to clear the reference.
	 */
	taskAgentSessionId?: string | null;
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
	/** ID of the step currently being executed; undefined when the run has not yet been assigned a step */
	currentStepId?: string;
	/** Current execution status */
	status: WorkflowRunStatus;
	/** Optional runtime configuration for this run */
	config?: Record<string, unknown>;
	/** Number of times the run has looped back to a previously visited step */
	iterationCount: number;
	/** Maximum iterations before escalating to needs_attention */
	maxIterations: number;
	/** Optional goal/mission ID this run is associated with */
	goalId?: string;
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
	/**
	 * ID of the step to start execution from — should be set to workflow.startStepId.
	 * Omit to leave the run without an initial step; the executor must call
	 * updateCurrentStep() before calling advance().
	 */
	currentStepId?: string;
	/** Maximum iterations before escalating to needs_attention (overrides workflow default) */
	maxIterations?: number;
	/** Optional goal/mission ID to associate with this run */
	goalId?: string;
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
	/** ID of the workflow run (SpaceWorkflowRun) this group is associated with (for UI display) */
	workflowRunId?: string;
	/** ID of the current workflow step being executed by this group */
	currentStepId?: string;
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
	 * Role label — a free-form string describing the agent's purpose (e.g. 'coder', 'general').
	 * Used only for display and default system prompt labeling; has no runtime routing effect.
	 */
	role: string;
	/** Model ID override (e.g., 'claude-haiku-4-5') — uses space default if unset */
	model?: string;
	/** Provider name override (e.g., 'anthropic', 'openai') */
	provider?: string;
	/** Custom system prompt appended to the role preset */
	systemPrompt?: string;
	/**
	 * Tool list override — which tools this agent may use.
	 * Any entry must be a name from KNOWN_TOOLS.
	 * When unset, role-based defaults apply.
	 */
	tools?: string[];
	/** Tool configuration overrides */
	toolConfig?: Record<string, unknown>;
	/**
	 * When true, the agent's task message includes the full workflow structure
	 * (steps, current step marker, and rules) when the agent runs inside an active
	 * workflow run. Set this on agents whose role involves planning or orchestration
	 * so they can create tasks aligned with the current workflow step.
	 *
	 * Driven by data, not by hardcoded role checks — any agent can have this set.
	 */
	injectWorkflowContext?: boolean;
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
	role: string;
	description?: string;
	model?: string;
	provider?: string;
	systemPrompt?: string;
	/** Tool list override — any entry must be a name from KNOWN_TOOLS */
	tools?: string[];
	toolConfig?: Record<string, unknown>;
	/** When true, the agent receives workflow structure context in its task message. */
	injectWorkflowContext?: boolean;
}

/**
 * Parameters for updating a SpaceAgent
 */
export interface UpdateSpaceAgentParams {
	name?: string;
	description?: string | null;
	role?: string;
	model?: string | null;
	provider?: string | null;
	systemPrompt?: string | null;
	/** Tool list override — null clears (reverts to role defaults) */
	tools?: string[] | null;
	toolConfig?: Record<string, unknown> | null;
	/** When true, the agent receives workflow structure context in its task message. */
	injectWorkflowContext?: boolean | null;
}

// ============================================================================
// Workflow Types (M3)
// ============================================================================

/**
 * Primitive condition type for workflow transitions.
 *
 * - `always`: The transition fires unconditionally.
 * - `human`: Blocks until a human explicitly approves (via a signal / run config update).
 * - `condition`: A user-supplied shell expression; the transition fires when it exits with code 0.
 *   NeoKai is a framework — no allowlist is applied. Users are responsible for what they run.
 * - `task_result`: Matches against the `result` field of the most recently completed task on the
 *   current step. The transition fires when the task result starts with or equals the condition's
 *   `expression` value (e.g., `'passed'`, `'failed'`).
 */
export type WorkflowConditionType = 'always' | 'human' | 'condition' | 'task_result';

/**
 * A condition that guards a workflow transition.
 * Conditions determine whether a transition may fire when advance() is called.
 */
export interface WorkflowCondition {
	/** Condition type. */
	type: WorkflowConditionType;
	/**
	 * Expression to evaluate for the `condition` and `task_result` types.
	 *
	 * - For `condition`: a shell expression; the transition fires when it exits with code 0.
	 *   No allowlist is applied — users are responsible for the expression content.
	 * - For `task_result`: the match value to compare against the completed task's `result`
	 *   field (e.g., `'passed'`, `'failed'`). The transition fires when the task result
	 *   starts with or equals this value.
	 */
	expression?: string;
	/** Human-readable description of what this condition checks */
	description?: string;
	/**
	 * Maximum number of times to retry condition evaluation on failure.
	 * Defaults to 0 (no retries — fail immediately on first failure).
	 */
	maxRetries?: number;
	/** Timeout for condition evaluation in milliseconds (0 = use default) */
	timeoutMs?: number;
}

/**
 * A directed edge in the workflow graph.
 * Transitions connect steps and carry optional conditions that determine
 * whether the edge may be followed during advance().
 *
 * advance() evaluates transitions from the current step in ascending `order`
 * and follows the first one whose condition passes.
 * A step with no outgoing transitions is a terminal step — advance() marks the
 * run as 'completed' when reached.
 */
export interface WorkflowTransition {
	/** Unique identifier */
	id: string;
	/** Source step ID */
	from: string;
	/** Target step ID */
	to: string;
	/** Optional condition guarding this transition. Absent = 'always' (unconditional). */
	condition?: WorkflowCondition;
	/** Sort order among transitions with the same `from` step. Lower = evaluated first. */
	order?: number;
	/**
	 * When `true`, following this transition increments `iterationCount` on the run.
	 * Used for cycle detection in iterative workflows — avoids heuristic-based detection
	 * that would misfire on DAG merge paths.
	 */
	isCyclic?: boolean;
}

/**
 * Input shape for a transition at creation time.
 * `id` is backend-assigned.
 */
export type WorkflowTransitionInput = Omit<WorkflowTransition, 'id'>;

/**
 * A single node in the workflow graph.
 * Each step runs one agent. Steps are connected by WorkflowTransitions.
 *
 * All agents are referenced by ID — there is no separate builtin/custom distinction.
 * Preset agents (coder, general, planner, reviewer) seeded at Space creation time
 * are regular SpaceAgent records that happen to have a well-known role label.
 */
export interface WorkflowStep {
	/** Unique identifier for this step (stable across renames) */
	id: string;
	/** Human-readable name for display */
	name: string;
	/** ID of the SpaceAgent assigned to execute this step */
	agentId: string;
	/** Step-specific instructions appended to the agent's system prompt */
	instructions?: string;
}

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
 * Input shape for a workflow step at creation time.
 * `id` is optional — if provided the backend uses it, otherwise a UUID is generated.
 * Providing an explicit `id` allows transitions in the same CreateSpaceWorkflowParams
 * call to reference the step before it has been persisted.
 */
export interface WorkflowStepInput {
	/** Optional pre-assigned step ID. Generated by backend when omitted. */
	id?: string;
	name: string;
	agentId: string;
	instructions?: string;
}

/**
 * Input shape for a workflow rule at creation time.
 * `id` is backend-assigned and must not be provided by callers.
 */
export type WorkflowRuleInput = Omit<WorkflowRule, 'id'>;

/**
 * A named, reusable workflow definition within a Space.
 * Workflows are directed graphs: steps are nodes, transitions are edges.
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
	/** Nodes in the workflow graph */
	steps: WorkflowStep[];
	/** Directed edges in the workflow graph */
	transitions: WorkflowTransition[];
	/** ID of the step where execution begins */
	startStepId: string;
	/** Rules that govern agent behavior during this workflow */
	rules: WorkflowRule[];
	/**
	 * @deprecated isDefault is no longer used for workflow selection.
	 * Workflow selection uses only two modes: explicit workflowId or AI auto-select.
	 * This field is retained for backward compatibility but has no runtime effect.
	 */
	isDefault?: boolean;
	/** Tags for organizational categorization. Not used for automatic workflow selection. */
	tags: string[];
	/** Additional runtime configuration (opaque bag for future extensibility) */
	config?: Record<string, unknown>;
	/** Maximum iterations for cyclic workflows before escalating to needs_attention */
	maxIterations?: number;
	/** Visual editor node positions: maps step ID to {x, y} canvas coordinates */
	layout?: Record<string, { x: number; y: number }>;
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
	 * Step nodes. Steps may include an optional `id` field — if provided, the backend
	 * uses it as the step's UUID so that `transitions` in the same call can reference it.
	 */
	steps?: WorkflowStepInput[];
	/**
	 * Directed edges connecting steps. `from` and `to` must reference step IDs
	 * (either pre-assigned via `WorkflowStepInput.id` or backend-generated UUIDs).
	 */
	transitions?: WorkflowTransitionInput[];
	/**
	 * ID of the step where execution begins.
	 * Defaults to the first step in the `steps` array when omitted.
	 */
	startStepId?: string;
	/**
	 * Rules governing agent behavior. `id` is backend-assigned.
	 */
	rules?: WorkflowRuleInput[];
	/**
	 * @deprecated isDefault has no runtime effect. Workflow selection uses only explicit workflowId or AI auto-select.
	 */
	isDefault?: boolean;
	/** Tags for organizational categorization (default: []). Not used for automatic workflow selection. */
	tags?: string[];
	config?: Record<string, unknown>;
	/** Maximum iterations for cyclic workflows before escalating to needs_attention */
	maxIterations?: number;
	/** Visual editor node positions: maps step ID to {x, y} canvas coordinates */
	layout?: Record<string, { x: number; y: number }>;
}

/**
 * Parameters for updating an existing SpaceWorkflow.
 * All fields are optional — only provided fields are updated.
 *
 * For array fields (`steps`, `transitions`, `rules`, `tags`):
 * - Pass a new array to replace the entire collection.
 * - Pass `null` to explicitly clear the field to an empty collection.
 * - Pass `[]` to clear all entries (equivalent to null for arrays).
 */
export interface UpdateSpaceWorkflowParams {
	name?: string;
	description?: string | null;
	/**
	 * Replaces the entire step list. Pass `[]` or `null` to clear all steps.
	 */
	steps?: WorkflowStep[] | null;
	/**
	 * Replaces the entire transition list. Pass `[]` or `null` to clear all transitions.
	 */
	transitions?: WorkflowTransitionInput[] | null;
	/**
	 * Updates the workflow entry point. Pass `null` to reset to first step.
	 */
	startStepId?: string | null;
	/**
	 * Replaces the entire rule list. Pass `[]` or `null` to clear all rules.
	 */
	rules?: WorkflowRule[] | null;
	/**
	 * @deprecated isDefault has no runtime effect. Workflow selection uses only explicit workflowId or AI auto-select.
	 */
	isDefault?: boolean;
	/**
	 * Replaces the tag list. Pass `[]` or `null` to clear all tags.
	 * Tags are for organizational categorization only — not used for automatic workflow selection.
	 */
	tags?: string[] | null;
	config?: Record<string, unknown> | null;
	/** Maximum iterations for cyclic workflows. Pass `null` to clear. */
	maxIterations?: number | null;
	/** Visual editor node positions. Pass `null` to clear. */
	layout?: Record<string, { x: number; y: number }> | null;
}

// ============================================================================
// Export / Import Format Types (M8)
// ============================================================================

/**
 * A single workflow step (graph node) in the exported format.
 *
 * Differences from `WorkflowStep`:
 * - `id` is stripped (space-specific, regenerated on import)
 * - `agentId` UUID is replaced by `agentRef` (the agent's **name**), making the
 *   reference portable across Space instances that may have different UUIDs.
 *
 * Step names are used as cross-references throughout the exported format
 * (in `ExportedWorkflowTransition.fromStep`/`toStep`,
 * `ExportedSpaceWorkflow.startStep`, and `ExportedWorkflowRule.appliesTo`).
 * Step names must therefore be unique within an exported workflow.
 */
export interface ExportedWorkflowStep {
	/** Name of the SpaceAgent assigned to this step (portable, not a UUID) */
	agentRef: string;
	/** Human-readable step name — used as the stable cross-reference key in the export */
	name: string;
	/** Step-specific instructions appended to the agent's system prompt */
	instructions?: string;
}

/**
 * A directed edge in the exported workflow graph.
 *
 * Differences from `WorkflowTransition`:
 * - `id` is stripped (space-specific, regenerated on import)
 * - `from`/`to` step UUIDs are replaced by step **names** for portability
 */
export interface ExportedWorkflowTransition {
	/** Name of the source step */
	fromStep: string;
	/** Name of the target step */
	toStep: string;
	/** Optional condition guarding this transition. Absent = unconditional. */
	condition?: WorkflowCondition;
	/** Sort order among transitions with the same source step. Lower = evaluated first. */
	order?: number;
	/**
	 * When `true`, following this transition increments `iterationCount` on the run.
	 * Used for cycle detection in iterative workflows.
	 */
	isCyclic?: boolean;
}

/**
 * A workflow rule in the exported format.
 *
 * Differences from `WorkflowRule`:
 * - `id` is stripped (space-specific, regenerated on import)
 * - `appliesTo` contains step **names** instead of step UUIDs (strings),
 *   so the reference survives re-import with freshly generated step IDs.
 */
export interface ExportedWorkflowRule {
	/** Human-readable name for display */
	name: string;
	/** Rule content — markdown prose describing the constraint or guideline */
	content: string;
	/**
	 * Names of the steps this rule applies to.
	 * Empty array or omitted means the rule applies to ALL steps.
	 */
	appliesTo?: string[];
}

/**
 * A Space agent in the portable export format.
 * Space-specific fields (`id`, `spaceId`, `createdAt`, `updatedAt`) are stripped.
 */
export interface ExportedSpaceAgent {
	/** Format version — always 1 for this revision */
	version: 1;
	/** Discriminator for the exported entity type */
	type: 'agent';
	/** Human-readable name */
	name: string;
	/** Optional description of this agent's specialization */
	description?: string;
	/** Model ID override */
	model?: string;
	/** Provider name override */
	provider?: string;
	/**
	 * Role label — free-form string describing the agent's purpose (e.g. 'coder', 'reviewer').
	 * Used for display and default system prompt labeling; has no runtime routing effect.
	 * Mirrors `SpaceAgent.role`.
	 */
	role: string;
	/** Custom system prompt */
	systemPrompt?: string;
	/**
	 * Tool name overrides — list of tool names from KNOWN_TOOLS this agent may use.
	 * When absent, role-based defaults apply on import.
	 * Mirrors `SpaceAgent.tools`.
	 */
	tools?: string[];
	/**
	 * When true, the agent receives full workflow structure in its task message when
	 * running inside an active workflow run. Mirrors `SpaceAgent.injectWorkflowContext`.
	 */
	injectWorkflowContext?: boolean;
	/**
	 * Additional agent configuration.
	 *
	 * Forward-compatibility stub: `SpaceAgent` does not currently expose a `config`
	 * field, so `exportAgent()` never populates this. It is reserved here for future
	 * agent-level configuration that cannot be expressed through the named fields above,
	 * and for hand-crafted export payloads that need to carry extra metadata.
	 */
	config?: Record<string, unknown>;
}

/**
 * A Space workflow in the portable export format.
 * Space-specific fields (`id`, `spaceId`, `createdAt`, `updatedAt`) are stripped.
 * Step IDs are stripped; cross-references use step names.
 * Transition IDs are stripped; `from`/`to` use step names.
 */
export interface ExportedSpaceWorkflow {
	/** Format version — always 1 for this revision */
	version: 1;
	/** Discriminator for the exported entity type */
	type: 'workflow';
	/** Human-readable name */
	name: string;
	/** Optional description */
	description?: string;
	/** Graph nodes — step order in this array is not significant */
	steps: ExportedWorkflowStep[];
	/** Graph edges — directed transitions between steps */
	transitions: ExportedWorkflowTransition[];
	/** Name of the step where execution begins */
	startStep: string;
	/** Rules governing agent behavior; `appliesTo` uses step names */
	rules: ExportedWorkflowRule[];
	/** Tags for categorization */
	tags: string[];
	/** Additional runtime configuration */
	config?: Record<string, unknown>;
}

/**
 * A bundle containing one or more exported agents and/or workflows.
 * The bundle is the top-level unit of the export/import file format.
 */
export interface SpaceExportBundle {
	/** Format version — always 1 for this revision */
	version: 1;
	/** Discriminator for the top-level type */
	type: 'bundle';
	/** Human-readable bundle name */
	name: string;
	/** Optional description of the bundle's purpose */
	description?: string;
	/** Exported agents (may be empty) */
	agents: ExportedSpaceAgent[];
	/** Exported workflows (may be empty) */
	workflows: ExportedSpaceWorkflow[];
	/** Export timestamp (milliseconds since epoch) */
	exportedAt: number;
	/** Source Space identifier (name or workspace path) for informational purposes */
	exportedFrom?: string;
}
