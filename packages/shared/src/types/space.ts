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
	| 'archived'
	| 'rate_limited'
	| 'usage_limited';

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
	/**
	 * The `WorkflowNodeAgent.name` of the specific agent slot that spawned this task.
	 * Stored at task creation time so `spawn_node_agent` can unambiguously map the task
	 * back to the correct slot even when the same `agentId` appears multiple times in the node.
	 */
	agentName?: string;
	/**
	 * Brief human-readable summary written by the agent when the task reaches a terminal state
	 * (completed, needs_attention, cancelled). Populated by the executing agent; null until set.
	 */
	completionSummary?: string | null;
	/** ID of the workflow run that spawned this task (if any) */
	workflowRunId?: string;
	/** ID of the workflow node that spawned this task (if any) */
	workflowNodeId?: string;
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
	/** Archive timestamp (milliseconds since epoch) — derived from status='archived' */
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
	/**
	 * The `WorkflowNodeAgent.name` of the specific slot that spawned this task.
	 * See `SpaceTask.agentName` for details.
	 */
	agentName?: string;
	/** Workflow run that spawned this task */
	workflowRunId?: string;
	/** Workflow node that spawned this task */
	workflowNodeId?: string;
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
	workflowNodeId?: string | null;
	progress?: number | null;
	currentStep?: string | null;
	result?: string | null;
	/**
	 * Human-readable summary written by the agent when it marks the task as done.
	 * Set alongside `status: 'completed'`; null to clear.
	 */
	completionSummary?: string | null;
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
 * the progress through each node of the workflow definition.
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
	/** Current execution status */
	status: WorkflowRunStatus;
	/** Optional runtime configuration for this run */
	config?: Record<string, unknown>;
	/** Number of times the run has looped back to a previously visited node */
	iterationCount: number;
	/** Maximum iterations before escalating to needs_attention */
	maxIterations: number;
	/** Optional goal/mission ID this run is associated with */
	goalId?: string;
	/**
	 * Reason for workflow run failure. Only set when the run reaches a terminal
	 * failure state (e.g. `needs_attention` or `cancelled`).
	 */
	failureReason?: WorkflowRunFailureReason;
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
	/** Maximum iterations before escalating to needs_attention (overrides workflow default) */
	maxIterations?: number;
	/** Optional goal/mission ID to associate with this run */
	goalId?: string;
}

// ============================================================================
// SpaceAgent Types (M2)
// ============================================================================

/**
 * A named agent configuration within a Space.
 * SpaceAgents can be referenced by name in SpaceWorkflow nodes.
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
	 * (nodes, current node marker, and rules) when the agent runs inside an active
	 * workflow run. Set this on agents whose role involves planning or orchestration
	 * so they can create tasks aligned with the current workflow node.
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

// ---- Legacy condition types (kept for backward compatibility) ----

/**
 * @deprecated Use `GateCondition` instead. Will be removed in a future milestone.
 *
 * Primitive condition type for workflow channel gates.
 */
export type WorkflowConditionType = 'always' | 'human' | 'condition' | 'task_result';

/**
 * @deprecated Use `GateCondition` instead. Will be removed in a future milestone.
 *
 * A condition that guards a workflow channel gate.
 * Conditions determine whether a channel may deliver a message.
 */
export interface WorkflowCondition {
	/** Condition type. */
	type: WorkflowConditionType;
	/**
	 * Expression to evaluate for the `condition` and `task_result` types.
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

// ============================================================================
// Gate System (M1.1) — separated from channels
// ============================================================================

/**
 * A `check` condition evaluates a named key in the gate's data store.
 *
 * The gate opens when `data[field]` equals `value`.
 *
 * Examples:
 *   - Human approval: `{ type: 'check', field: 'approved', value: true }`
 *   - Task result:    `{ type: 'check', field: 'result', value: 'passed' }`
 */
export interface GateConditionCheck {
	type: 'check';
	/** Key in the gate's data store to evaluate. */
	field: string;
	/** Expected value. Gate opens when `data[field] === value`. */
	value: unknown;
}

/**
 * A `count` condition checks the numeric value of a field against a threshold.
 *
 * The gate opens when `data[field] >= threshold`.
 *
 * Examples:
 *   - Require 2 approvals: `{ type: 'count', field: 'approvals', threshold: 2 }`
 */
export interface GateConditionCount {
	type: 'count';
	/** Key in the gate's data store whose numeric value to compare. */
	field: string;
	/** Gate opens when the field value ≥ threshold. */
	threshold: number;
}

/**
 * Composite `all` condition — logical AND. Gate opens when ALL nested conditions pass.
 *
 * Conditions are evaluated in order; short-circuits on first failure.
 */
export interface GateConditionAll {
	type: 'all';
	/** Nested conditions that must all pass. */
	conditions: GateCondition[];
}

/**
 * Composite `any` condition — logical OR. Gate opens when ANY nested condition passes.
 *
 * Conditions are evaluated in order; short-circuits on first success.
 */
export interface GateConditionAny {
	type: 'any';
	/** Nested conditions — at least one must pass. */
	conditions: GateCondition[];
}

/**
 * Discriminated union of gate condition types.
 *
 * Four types cover all gate behaviors:
 * - `check`  — field equality check against gate data
 * - `count`  — numeric threshold check against gate data
 * - `all`    — composite AND (recursive)
 * - `any`    — composite OR (recursive)
 *
 * No `always` type — a channel without a `gateId` is always open.
 */
export type GateCondition =
	| GateConditionCheck
	| GateConditionCount
	| GateConditionAll
	| GateConditionAny;

/**
 * A Gate — an independent entity that controls passage through channels.
 *
 * Gates are referenced by channels via `gateId`. A gate has no back-reference
 * to any channel — the same gate can guard multiple channels.
 *
 * Gate data is a key-value store persisted per `(run_id, gate_id)` in the
 * `gate_data` SQLite table. Agents write to gate data via `write_gate`;
 * the runtime evaluates the condition against current data to decide passage.
 */
export interface Gate {
	/** Unique identifier */
	id: string;
	/** Condition that must be satisfied for the gate to open. */
	condition: GateCondition;
	/**
	 * Default data values for the gate. Populated into `gate_data` when a
	 * workflow run starts. Keys not present here default to `undefined`.
	 */
	data: Record<string, unknown>;
	/**
	 * Roles allowed to write to this gate's data store.
	 * An empty array means no role can write (effectively read-only).
	 * Use `['*']` to allow all roles.
	 */
	allowedWriterRoles: string[];
	/** Human-readable description of what this gate checks. */
	description?: string;
	/**
	 * When true, gate data is reset to `data` (defaults) each time the workflow
	 * cycles through a channel referencing this gate. Used for cyclic workflows.
	 */
	resetOnCycle: boolean;
}

/**
 * A Channel — a simple unidirectional pipe between agents in a workflow.
 *
 * Channels define messaging topology. A channel without a `gateId` is always open.
 * When `gateId` is set, the channel is gated — messages are held until the
 * referenced Gate's condition passes.
 *
 * This is the separated Channel type (M1.1). The legacy `WorkflowChannel` type
 * with its inline `gate?: WorkflowCondition` is preserved for backward compatibility
 * but new code should use `Channel` + `Gate`.
 */
export interface Channel {
	/** Unique identifier */
	id: string;
	/**
	 * Source agent name string (`WorkflowNodeAgent.name`), node name,
	 * or `'*'` for all agents. Cross-node format: `"nodeId/agentName"`.
	 */
	from: string;
	/**
	 * Target agent name string, array of name strings, or `'*'` for all agents.
	 * An array enables fan-out or hub-spoke topologies.
	 */
	to: string | string[];
	/**
	 * Optional reference to a Gate entity. When absent, the channel is always open.
	 * When present, message delivery is blocked until the gate's condition passes.
	 */
	gateId?: string;
	/**
	 * When true, each delivery on this channel increments the run's iteration counter.
	 * Used for cyclic workflows.
	 */
	isCyclic?: boolean;
	/** Optional human-readable label for display in the visual editor. */
	label?: string;
}

/**
 * Failure reason for a workflow run that entered a terminal failure state.
 */
export type WorkflowRunFailureReason =
	| 'humanRejected'
	| 'maxIterationsReached'
	| 'nodeTimeout'
	| 'agentCrash';

/**
 * A single agent entry within a multi-agent workflow node.
 * References a SpaceAgent by ID with an optional per-slot configuration override.
 */
export interface WorkflowNodeAgent {
	/** ID of the SpaceAgent assigned to execute this node slot */
	agentId: string;
	/**
	 * Unique identifier for this agent slot within the node.
	 * Used for channel routing (`WorkflowChannel.from`/`to`) and must be unique across
	 * all agent slots in the same node.
	 *
	 * This is a **slot-specific label** distinct from `SpaceAgent.role`, which identifies
	 * the agent's job category (e.g. `"coder"`, `"reviewer"`). The same `SpaceAgent` may
	 * appear in multiple slots with different `WorkflowNodeAgent.name` values (e.g.
	 * `"strict-reviewer"` and `"quick-reviewer"`). When added via the UI a second time,
	 * a numeric suffix is appended automatically (e.g. `"coder"` → `"coder-2"`).
	 */
	name: string;
	/** Override the agent's default model for this slot. */
	model?: string;
	/** Override the agent's default system prompt for this slot. */
	systemPrompt?: string;
	/** Per-agent instructions override — appended to the agent's system prompt */
	instructions?: string;
}

/**
 * The stable ID used for the Task Agent virtual node in the visual editor.
 *
 * The Task Agent is a **virtual node** — it is never persisted in the DB's
 * `space_workflow_nodes` table. Instead it is:
 *   - Injected at runtime by the frontend (during deserialization)
 *   - Injected at runtime by the backend (during channel resolution at workflow run start)
 *   - Stripped from the persisted node list during serialization
 *
 * Task Agent **channels** ARE persisted as regular `WorkflowChannel` entries
 * (with `from: 'task-agent'` or `to: 'task-agent'` roles). These replace the
 * backend-only auto-generation introduced in Milestone 3 with persisted,
 * user-manageable channel entries visible in the frontend.
 */
export const TASK_AGENT_NODE_ID = '__task_agent__';

/**
 * A directed messaging channel between agents in a workflow.
 * Channels define which agents may send messages to which other agents and
 * can optionally enforce gate conditions before message delivery.
 *
 * Addressing uses agent name strings (`WorkflowNodeAgent.name`) or `'*'` for broadcast.
 * Cross-node channels use the format `"nodeId/agentName"` in `from`/`to` to
 * address agents in a specific node; within-node channels use plain agent names.
 *
 * Supported messaging patterns:
 * - Within-node DM:        `{ from: 'coder', to: 'reviewer' }`
 * - Within-node broadcast: `{ from: 'coder', to: '*' }`
 * - Cross-node DM:         `{ from: 'nodeA/coder', to: 'nodeB/reviewer' }`
 * - Cross-node fan-out:    `{ from: 'nodeA/coder', to: ['nodeB/reviewer', 'nodeC/qa'] }`
 *
 * No channels = no messaging constraints (agents are fully isolated).
 */
export interface WorkflowChannel {
	/** Optional stable identifier for this channel */
	id?: string;
	/**
	 * Source agent name string (matches `WorkflowNodeAgent.name`) or `'*'` for all agents.
	 * Cross-node format: `"nodeId/agentName"`.
	 */
	from: string;
	/**
	 * Target agent name string, array of name strings, or `'*'` for all agents.
	 * Cross-node format: `"nodeId/agentName"`.
	 * An array with multiple entries enables fan-out (A→[B,C,D]) and
	 * hub-spoke bidirectional (A↔[B,C,D]) topologies.
	 */
	to: string | string[];
	/**
	 * Messaging direction.
	 * - `one-way`: messages flow only from `from` to `to`.
	 * - `bidirectional` with single `to`: point-to-point, expanded to A→B + B→A.
	 * - `bidirectional` with array `to`: hub-spoke — hub sends to all spokes, each
	 *   spoke may reply to hub only (no spoke-to-spoke messaging).
	 */
	direction: 'one-way' | 'bidirectional';
	/**
	 * When true, each delivery on this channel increments the run's iteration counter.
	 * Used for cyclic workflows — channel-level analogue of WorkflowTransition.isCyclic.
	 */
	isCyclic?: boolean;
	/** Optional human-readable label for display in the visual editor */
	label?: string;
	/**
	 * Optional gate condition evaluated before a message is delivered on this channel.
	 * When present, the message is held until the condition passes.
	 * Absent means the channel is always open (no gate).
	 */
	gate?: WorkflowCondition;
}

/**
 * A single node in the workflow graph.
 * Nodes run one or more agents (in parallel when multiple are specified).
 * Nodes are connected by WorkflowChannels.
 *
 * All agents are referenced by ID — there is no separate builtin/custom distinction.
 * Preset agents (coder, general, planner, reviewer) seeded at Space creation time
 * are regular SpaceAgent records that happen to have a well-known role label.
 *
 * At least one of `agentId` or `agents` must be provided.
 */
export interface WorkflowNode {
	/** Unique identifier for this node (stable across renames) */
	id: string;
	/** Human-readable name for display */
	name: string;
	/**
	 * ID of the SpaceAgent assigned to execute this node.
	 * Shorthand for single-agent nodes. When `agents` is also provided, `agents` takes
	 * precedence and this field is ignored.
	 * At least one of `agentId` or `agents` must be provided.
	 */
	agentId?: string;
	/**
	 * Multiple agents for parallel execution within this node.
	 * When provided (non-empty), takes precedence over `agentId`.
	 * Each agent runs concurrently; the node completes when all agents complete.
	 * At least one of `agentId` or `agents` must be provided.
	 */
	agents?: WorkflowNodeAgent[];
	/** Node-specific instructions shared by all agents in this node */
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
	 * List of node IDs this rule applies to.
	 *
	 * Uses node **IDs** (not names) so that rules survive node renames.
	 * Empty array or omitted means the rule applies to ALL nodes in the workflow.
	 */
	appliesTo?: string[];
}

/**
 * Input shape for a workflow node at creation time.
 * `id` is optional — if provided the backend uses it, otherwise a UUID is generated.
 * Providing an explicit `id` allows channels in the same CreateSpaceWorkflowParams
 * call to reference the node before it has been persisted.
 *
 * At least one of `agentId` or `agents` must be provided.
 */
export interface WorkflowNodeInput {
	/** Optional pre-assigned node ID. Generated by backend when omitted. */
	id?: string;
	name: string;
	/**
	 * ID of the SpaceAgent assigned to execute this node.
	 * Shorthand for single-agent nodes. When `agents` is also provided, `agents` takes
	 * precedence. At least one of `agentId` or `agents` must be provided.
	 */
	agentId?: string;
	/**
	 * Multiple agents for parallel execution within this node.
	 * When provided (non-empty), takes precedence over `agentId`.
	 * At least one of `agentId` or `agents` must be provided.
	 */
	agents?: WorkflowNodeAgent[];
	instructions?: string;
}

/**
 * Input shape for a workflow rule at creation time.
 * `id` is backend-assigned and must not be provided by callers.
 */
export type WorkflowRuleInput = Omit<WorkflowRule, 'id'>;

/**
 * A named, reusable workflow definition within a Space.
 * Workflows are collaboration graphs: nodes are agent groups, channels are communication paths.
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
	nodes: WorkflowNode[];
	/** ID of the node where execution begins */
	startNodeId: string;
	/** Rules that govern agent behavior during this workflow */
	rules: WorkflowRule[];
	/**
	 * Directed messaging channels between agents in this workflow.
	 * Channels define which agents may communicate and under what conditions.
	 * Agent names in `from`/`to` match `WorkflowNodeAgent.name`; cross-node channels
	 * use `"nodeId/agentName"` addressing.
	 * Empty or absent means no messaging constraints (agents are fully isolated).
	 */
	channels?: WorkflowChannel[];
	/**
	 * Gate definitions for this workflow.
	 * Gates are independent entities referenced by channels via `gateId`.
	 * Persisted as JSON in the `gates` column of `space_workflows`.
	 */
	gates?: Gate[];
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
	/** Visual editor node positions: maps node ID to {x, y} canvas coordinates */
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
	 * Workflow nodes. Nodes may include an optional `id` field — if provided, the backend
	 * uses it as the node's UUID so that `channels` in the same call can reference it.
	 */
	nodes?: WorkflowNodeInput[];
	/**
	 * ID of the node where execution begins.
	 * Defaults to the first node in the `nodes` array when omitted.
	 */
	startNodeId?: string;
	/**
	 * Rules governing agent behavior. `id` is backend-assigned.
	 */
	rules?: WorkflowRuleInput[];
	/**
	 * Workflow-level messaging channels. `id` is optional — backend generates one when omitted.
	 */
	channels?: WorkflowChannel[];
	/** Gate definitions for this workflow. */
	gates?: Gate[];
	/**
	 * @deprecated isDefault has no runtime effect. Workflow selection uses only explicit workflowId or AI auto-select.
	 */
	isDefault?: boolean;
	/** Tags for organizational categorization (default: []). Not used for automatic workflow selection. */
	tags?: string[];
	config?: Record<string, unknown>;
	/** Maximum iterations for cyclic workflows before escalating to needs_attention */
	maxIterations?: number;
	/** Visual editor node positions: maps node ID to {x, y} canvas coordinates */
	layout?: Record<string, { x: number; y: number }>;
}

/**
 * Parameters for updating an existing SpaceWorkflow.
 * All fields are optional — only provided fields are updated.
 *
 * For array fields (`nodes`, `channels`, `rules`, `tags`):
 * - Pass a new array to replace the entire collection.
 * - Pass `null` to explicitly clear the field to an empty collection.
 * - Pass `[]` to clear all entries (equivalent to null for arrays).
 */
export interface UpdateSpaceWorkflowParams {
	name?: string;
	description?: string | null;
	/**
	 * Replaces the entire node list. Pass `[]` or `null` to clear all nodes.
	 */
	nodes?: WorkflowNode[] | null;
	/**
	 * Updates the workflow entry point. Pass `null` to reset to first node.
	 */
	startNodeId?: string | null;
	/**
	 * Replaces the entire rule list. Pass `[]` or `null` to clear all rules.
	 */
	rules?: WorkflowRule[] | null;
	/**
	 * Replaces the channel list. Pass `[]` or `null` to clear all channels.
	 */
	channels?: WorkflowChannel[] | null;
	/**
	 * Replaces the gate list. Pass `[]` or `null` to clear all gates.
	 */
	gates?: Gate[] | null;
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
 * A directed messaging channel in the portable export format.
 *
 * Differences from `WorkflowChannel`:
 * - `id` is stripped (space-specific, regenerated on import if needed)
 * - `from`/`to` use agent slot name strings (`WorkflowNodeAgent.name`), node names,
 *   or `'*'` for broadcast — all portable across Space instances.
 */
export interface ExportedWorkflowChannel {
	/**
	 * Source agent slot name (`WorkflowNodeAgent.name`), node name for fan-out,
	 * or `'*'` for all agents in the workflow.
	 */
	from: string;
	/**
	 * Target agent slot name(s), node name for fan-out, or `'*'` for all agents.
	 * An array enables fan-out or hub-spoke topologies.
	 */
	to: string | string[];
	direction: 'one-way' | 'bidirectional';
	isCyclic?: boolean;
	label?: string;
	gate?: WorkflowCondition;
}

/**
 * A single agent entry within a multi-agent exported workflow node.
 * Mirrors `WorkflowNodeAgent` but uses a portable `agentRef` name instead of a UUID.
 */
export interface ExportedWorkflowNodeAgent {
	/** Name of the SpaceAgent (portable, not a UUID) */
	agentRef: string;
	/**
	 * Unique identifier for this agent slot within the node.
	 * Must be unique across all agents in the same exported node.
	 * Mirrors `WorkflowNodeAgent.name`.
	 */
	name: string;
	/** Override the agent's default model for this slot. */
	model?: string;
	/** Override the agent's default system prompt for this slot. */
	systemPrompt?: string;
	/** Per-agent instructions override */
	instructions?: string;
}

/**
 * A single workflow node (graph node) in the exported format.
 *
 * Differences from `WorkflowNode`:
 * - `id` is stripped (space-specific, regenerated on import)
 * - `agentId` UUID is replaced by `agentRef` (the agent's **name**), making the
 *   reference portable across Space instances that may have different UUIDs.
 * - `agents[]` entries have their `agentId` UUIDs replaced by `agentRef` names.
 * - `channels[]` have moved to `ExportedSpaceWorkflow.channels` (workflow-level).
 *
 * Node names are used as cross-references throughout the exported format
 * (in `ExportedSpaceWorkflow.startNode`, and `ExportedWorkflowRule.appliesTo`).
 * Node names must therefore be unique within an exported workflow.
 *
 * At least one of `agentRef` or `agents` (non-empty) must be present:
 * - Single-agent nodes use `agentRef` (shorthand, backward-compatible).
 * - Multi-agent nodes use `agents` (array of `ExportedWorkflowNodeAgent` entries).
 * - The export function never sets both simultaneously, but the type and Zod schema
 *   do not enforce mutual exclusivity — if both are present, `agents` takes precedence
 *   on import (consistent with `WorkflowNode` resolution semantics).
 */
export interface ExportedWorkflowNode {
	/**
	 * Name of the SpaceAgent assigned to this node (portable, not a UUID).
	 * Used for single-agent nodes. Mutually exclusive with `agents`.
	 */
	agentRef?: string;
	/**
	 * Multiple agents for parallel execution.
	 * Used for multi-agent nodes. Mutually exclusive with `agentRef`.
	 * When present (non-empty), `agentRef` must be absent.
	 */
	agents?: ExportedWorkflowNodeAgent[];
	/** Human-readable node name — used as the stable cross-reference key in the export */
	name: string;
	/** Node-specific instructions appended to the agent's system prompt */
	instructions?: string;
}

/**
 * A workflow rule in the exported format.
 *
 * Differences from `WorkflowRule`:
 * - `id` is stripped (space-specific, regenerated on import)
 * - `appliesTo` contains node **names** instead of node UUIDs (strings),
 *   so the reference survives re-import with freshly generated node IDs.
 */
export interface ExportedWorkflowRule {
	/** Human-readable name for display */
	name: string;
	/** Rule content — markdown prose describing the constraint or guideline */
	content: string;
	/**
	 * Names of the nodes this rule applies to.
	 * Empty array or omitted means the rule applies to ALL nodes.
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
 * Node IDs are stripped; cross-references use node names.
 * Channel IDs are stripped; `from`/`to` use node/agent names.
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
	/** Graph nodes — node order in this array is not significant */
	nodes: ExportedWorkflowNode[];
	/** Name of the node where execution begins */
	startNode: string;
	/** Rules governing agent behavior; `appliesTo` uses node names */
	rules: ExportedWorkflowRule[];
	/** Tags for categorization */
	tags: string[];
	/** Additional runtime configuration */
	config?: Record<string, unknown>;
	/**
	 * Directed messaging channels for the workflow.
	 * Uses agent slot name strings and node names (portable — not UUIDs).
	 * Channel `id` fields are stripped during export and omitted here.
	 * Absent or empty means agents are fully isolated (no messaging constraints).
	 */
	channels?: ExportedWorkflowChannel[];
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
