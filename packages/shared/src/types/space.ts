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
	/** URL-safe, human-readable identifier (unique, auto-generated from name) */
	slug: string;
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
 * Result of `space.create` RPC.
 *
 * Extends `Space` with an optional `seedWarnings` array that is present when
 * preset agents or built-in workflows failed to seed (partial or total).
 * The space is still usable — warnings are informational only.
 *
 * TODO: The frontend should display these warnings (e.g. toast notification
 * after space creation) so the user knows if seeding was incomplete.
 */
export interface SpaceCreateResult extends Space {
	seedWarnings?: string[];
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
 * Space task status
 *
 * - `open`       — task is queued and waiting to be picked up
 * - `in_progress` — a Task Agent session is actively working on this task
 * - `review`     — workflow agents completed; awaiting human review/approval (supervised mode)
 * - `done`       — task completed successfully
 * - `blocked`    — task requires human attention or intervention
 * - `cancelled`  — task was cancelled and will not be completed
 * - `archived`   — task is archived (soft-delete, `archivedAt` is stamped)
 */
export type SpaceTaskStatus =
	| 'open'
	| 'in_progress'
	| 'review'
	| 'done'
	| 'blocked'
	| 'cancelled'
	| 'archived';

/**
 * Space task priority
 *
 * Numeric priority values P0–P3 where lower number = higher priority.
 */
export type SpaceTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Runtime activity state for a live task-agent member.
 * This is more user-facing than raw session processing states.
 */
export type SpaceTaskActivityState =
	| 'active'
	| 'queued'
	| 'idle'
	| 'waiting_for_input'
	| 'completed'
	| 'failed'
	| 'interrupted';

/**
 * A task managed within a Space.
 * User-facing orchestration unit — one task = one deliverable that may involve
 * multiple workflow node executions internally.
 */
export interface SpaceTask {
	/** Unique identifier */
	id: string;
	/** Space this task belongs to */
	spaceId: string;
	/** Human-friendly numeric ID, unique per space (auto-incremented, like GitHub issue numbers) */
	taskNumber: number;
	/** Task title */
	title: string;
	/** Detailed description */
	description: string;
	/** Current status */
	status: SpaceTaskStatus;
	/** Priority level */
	priority: SpaceTaskPriority;
	/** Free-form labels for filtering and categorisation */
	labels: string[];
	/** IDs of tasks this task depends on (prerequisites in the same space) */
	dependsOn: string[];
	/** Final output from the agent when the task reaches a terminal state; null until set */
	result: string | null;
	/** ID of the workflow run that orchestrates this task (links task to its workflow execution) */
	workflowRunId?: string | null;
	/** ID of the planning task that created this task */
	createdByTaskId?: string | null;
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
	/**
	 * ID of the Task Agent session that orchestrates this task's workflow execution.
	 * Set when the task transitions from `open` to `in_progress` and a Task Agent
	 * session is created. Null when no Task Agent has been spawned yet.
	 * Node-level tasks use `node_executions.agentSessionId` instead.
	 */
	taskAgentSessionId?: string | null;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Timestamp when task transitioned to `in_progress` (milliseconds since epoch); null until started */
	startedAt: number | null;
	/** Timestamp when task reached a terminal state (milliseconds since epoch); null until completed */
	completedAt: number | null;
	/** Timestamp when task was archived (milliseconds since epoch); null until archived */
	archivedAt: number | null;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * One live participant in a task's execution.
 * This can be the orchestration Task Agent or a spawned node agent sub-session.
 */
export interface SpaceTaskActivityMember {
	/** Stable ID for rendering — usually the session ID */
	id: string;
	/** Session backing this activity row */
	sessionId: string;
	/** Whether this row represents the orchestration task agent or a node agent */
	kind: 'task_agent' | 'node_agent';
	/** Human-readable label for the activity row */
	label: string;
	/** Agent name or slot name (e.g. task-agent, reviewer, strict-reviewer). DB column: `role`. */
	role: string;
	/** Derived user-facing activity state */
	state: SpaceTaskActivityState;
	/** Raw session processing status when the session is live in memory */
	processingStatus?: 'idle' | 'queued' | 'processing' | 'waiting_for_input' | 'interrupted' | null;
	/** Raw processing phase when the session is actively processing */
	processingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
	/** Number of persisted SDK messages seen in the backing session */
	messageCount: number;
	/** Linked SpaceTask when this member corresponds to a persisted step task */
	taskId?: string | null;
	/** Human-readable task title associated with this member */
	taskTitle?: string | null;
	/** Status of the linked SpaceTask, if any (uses new 6-value SpaceTaskStatus) */
	taskStatus?: SpaceTaskStatus | null;
	/**
	 * Node execution context for node-agent members.
	 * Provides workflow-internal state (node, agent slot, result) without polluting SpaceTask.
	 */
	nodeExecution?: {
		/** Workflow node ID */
		nodeId: string;
		/** Human-readable node / agent slot name */
		agentName: string;
		/** Execution status */
		status: NodeExecutionStatus;
		/** Result output from `report_done`, if set */
		result?: string | null;
	} | null;
	/** Last update timestamp from the linked SpaceTask or backing session metadata */
	updatedAt?: number | null;
	/** Timestamp of the last persisted SDK message for this session */
	lastMessageAt?: number | null;
}

/**
 * Parameters for creating a new SpaceTask
 */
export interface CreateSpaceTaskParams {
	spaceId: string;
	title: string;
	description?: string;
	priority?: SpaceTaskPriority;
	/** Free-form labels for filtering and categorisation */
	labels?: string[];
	/** IDs of prerequisite tasks in the same space */
	dependsOn?: string[];
	/** Initial status — defaults to 'open' */
	status?: SpaceTaskStatus;
	/** Workflow run that spawned this task */
	workflowRunId?: string | null;
	/** ID of planning task that created this task */
	createdByTaskId?: string | null;
	/**
	 * ID of the Task Agent session that orchestrates this task's workflow execution.
	 * Set when the task transitions from 'open' to 'in_progress'.
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
	labels?: string[];
	dependsOn?: string[];
	result?: string | null;
	workflowRunId?: string | null;
	createdByTaskId?: string | null;
	activeSession?: 'worker' | 'leader' | null;
	prUrl?: string | null;
	prNumber?: number | null;
	prCreatedAt?: number | null;
	/**
	 * ID of the Task Agent session that orchestrates this task's workflow execution.
	 * Set when spawning a Task Agent; null to clear the reference.
	 */
	taskAgentSessionId?: string | null;
	/** Timestamp when task transitioned to `in_progress`; null to clear */
	startedAt?: number | null;
	/** Timestamp when task reached a terminal state; null to clear */
	completedAt?: number | null;
	/** Timestamp when task was archived; null to clear */
	archivedAt?: number | null;
}

// ============================================================================
// Node Execution Types
// ============================================================================

/**
 * Status of a node execution slot within a workflow run.
 *
 * - `pending`     — slot has been created but the agent has not started yet
 * - `in_progress` — agent session is actively running
 * - `done`        — agent called `report_done`; execution completed successfully
 * - `blocked`     — execution requires human intervention or a gate has not passed
 * - `cancelled`   — execution was cancelled (workflow run cancelled or error path)
 */
export type NodeExecutionStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

/**
 * Records the execution of a single agent slot within a workflow run's node.
 * One row is created per `(workflowRunId, workflowNodeId, agentName)` triple.
 * This separates workflow-internal state from the user-facing `SpaceTask`.
 */
export interface NodeExecution {
	/** Unique identifier */
	id: string;
	/** Workflow run this execution belongs to */
	workflowRunId: string;
	/** ID of the workflow node in the workflow definition */
	workflowNodeId: string;
	/** Agent slot name (`WorkflowNodeAgent.name`) — channel routing address */
	agentName: string;
	/** ID of the SpaceAgent assigned to this slot; null when the agent has been deleted */
	agentId: string | null;
	/** Agent sub-session ID for liveness tracking; null until session is created */
	agentSessionId: string | null;
	/** Current execution status */
	status: NodeExecutionStatus;
	/** Output captured from `report_done(summary)`; null until the agent completes */
	result: string | null;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Timestamp when execution transitioned to `in_progress`; null until started */
	startedAt: number | null;
	/** Timestamp when execution reached a terminal state; null until completed */
	completedAt: number | null;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Parameters for creating a new NodeExecution record
 */
export interface CreateNodeExecutionParams {
	workflowRunId: string;
	workflowNodeId: string;
	agentName: string;
	agentId?: string | null;
	/** Initial status — defaults to 'pending' */
	status?: NodeExecutionStatus;
	/** Agent sub-session ID when the session is already known at creation time */
	agentSessionId?: string | null;
}

/**
 * Parameters for updating a NodeExecution record
 */
export interface UpdateNodeExecutionParams {
	status?: NodeExecutionStatus;
	agentSessionId?: string | null;
	result?: string | null;
	startedAt?: number | null;
	completedAt?: number | null;
}

// ============================================================================
// Space Workflow Run Types
// ============================================================================

/**
 * Status of a workflow run.
 *
 * - `pending`     — run created, awaiting Task Agent to start nodes
 * - `in_progress` — at least one node execution is active
 * - `done`        — end node called `report_done` or all nodes completed
 * - `blocked`     — run requires human intervention (gate rejection, crash, etc.)
 * - `cancelled`   — run was cancelled before completion
 */
export type WorkflowRunStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

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
	/**
	 * Reason for workflow run failure. Only set when the run reaches a terminal
	 * failure state (`blocked` or `cancelled`).
	 */
	failureReason?: WorkflowRunFailureReason;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Timestamp when the first node execution started; null until the run begins executing */
	startedAt: number | null;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
	/** Completion timestamp (milliseconds since epoch); null until the run reaches a terminal state */
	completedAt: number | null;
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
	/** Model ID override (e.g., 'claude-haiku-4-5') — uses space default if unset */
	model?: string;
	/** Provider name override (e.g., 'anthropic', 'openai') */
	provider?: string;
	/**
	 * System prompt — persona and constraints for this agent.
	 * Defines WHO the agent is and WHAT it must/must not do.
	 */
	systemPrompt?: string;
	/**
	 * Instructions — default operating procedure for this agent.
	 * Describes HOW the agent performs its work by default. Null when not set.
	 */
	instructions: string | null;
	/**
	 * Tool list override — which tools this agent may use.
	 * Any entry must be a name from KNOWN_TOOLS.
	 * When unset, role-based defaults apply.
	 */
	tools?: string[];
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
	description?: string;
	model?: string;
	provider?: string;
	systemPrompt?: string;
	/** Default operating procedure for this agent; null when not set */
	instructions?: string | null;
	/** Tool list override — any entry must be a name from KNOWN_TOOLS */
	tools?: string[];
}

/**
 * Parameters for updating a SpaceAgent
 */
export interface UpdateSpaceAgentParams {
	name?: string;
	description?: string | null;
	model?: string | null;
	provider?: string | null;
	systemPrompt?: string | null;
	/** Default operating procedure for this agent; null to clear */
	instructions?: string | null;
	/** Tool list override — null clears (reverts to role defaults) */
	tools?: string[] | null;
}

// ============================================================================
// Workflow Types (M3)
// ============================================================================

// ============================================================================
// Gate System — field-based schema
// ============================================================================

/** Field type determines what values are valid and what check ops are available. */
export type GateFieldType = 'boolean' | 'string' | 'number' | 'map';

/**
 * Check operation for scalar fields (boolean, string, number).
 *
 *   - `'=='`     — passes when `data[field] === value`
 *   - `'!='`     — passes when `data[field] !== value`
 *   - `'exists'` — passes when the field is present in data (not `undefined`)
 */
export interface GateFieldScalarCheck {
	op: '==' | '!=' | 'exists';
	value?: unknown;
}

/**
 * Check operation for map fields (counts matching entries).
 *
 *   - `op: 'count'` — counts entries whose value equals `match`, passes when count >= `min`
 *
 * Example: require 3 "approved" reviews in a votes map:
 *   `{ op: 'count', match: 'approved', min: 3 }`
 */
export interface GateFieldMapCheck {
	op: 'count';
	/** Value to match in map entries. */
	match: unknown;
	/** Minimum count required for this field to be satisfied. */
	min: number;
}

/** Union of check operations — scalar or map. */
export type GateFieldCheck = GateFieldScalarCheck | GateFieldMapCheck;

/**
 * A single declared field in the gate schema.
 *
 * Fields define what data the gate stores, who can write it, and what check
 * must pass for the field to be satisfied. A gate opens when ALL fields pass.
 */
export interface GateField {
	/** Field name (key in the gate data store). */
	name: string;
	/** Field type. */
	type: GateFieldType;
	/** Who can write this field — agent names/slot names, node names, 'human', or '*'. */
	writers: string[];
	/** Check that must pass for this field to be satisfied. */
	check: GateFieldCheck;
}

/**
 * A Gate — a declared data store with typed fields. Opens when ALL fields pass.
 *
 * Gates are referenced by channels via `gateId`. A gate has no back-reference
 * to any channel — the same gate can guard multiple channels.
 *
 * Gate runtime data is a key-value store persisted per `(run_id, gate_id)` in
 * the `gate_data` SQLite table. Default data is computed from the field
 * declarations (empty map `{}` for 'map' type, nothing for others). Agents
 * write to gate data via `write_gate`; the runtime evaluates field checks
 * against current data to decide passage.
 */
export interface GateScript {
	/** Script interpreter: 'bash', 'node', or 'python3' */
	interpreter: 'bash' | 'node' | 'python3';
	/** Script source code to execute */
	source: string;
	/** Timeout in milliseconds (default: 30000) */
	timeoutMs?: number;
}

export interface Gate {
	/** Unique identifier */
	id: string;
	/** Human-readable description of what this gate checks. */
	description?: string;
	/** Custom label displayed on the gate badge in the workflow editor. */
	label?: string;
	/** Custom badge color (hex format `#rrggbb`). */
	color?: string;
	/** Declared fields with schema, permissions, and checks. */
	fields?: GateField[];
	/** Optional script-based pre-check executed before field evaluation. */
	script?: GateScript;
	/**
	 * When true, gate data is reset to defaults on cyclic channel traversal.
	 * Used for cyclic workflows where gate state should be cleared each loop.
	 */
	resetOnCycle: boolean;
}

/**
 * Compute default data for a gate from its field declarations.
 * Map fields get `{}`, others get nothing (no key in defaults).
 */
export function computeGateDefaults(fields?: GateField[]): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};
	for (const field of fields ?? []) {
		if (field.type === 'map') {
			defaults[field.name] = {};
		}
	}
	return defaults;
}

/**
 * A Channel — a simple unidirectional pipe between agents in a workflow.
 *
 * Channels define messaging topology. A channel without a `gateId` is always open.
 * When `gateId` is set, the channel is gated — messages are held until the
 * referenced Gate's condition passes.
 *
 * This is the separated Channel type (M1.1). Uses `gateId` to reference Gate
 * entities rather than inlining gate conditions.
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
	 * Maximum number of times this channel may be traversed in a single workflow run
	 * before delivery is blocked. Only meaningful for backward (cyclic) channels —
	 * cyclicity is inferred from graph topology, not stored.
	 * Defaults to 5 at runtime when the channel is cyclic and this field is absent.
	 */
	maxCycles?: number;
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
 * Override shape for `systemPrompt` and `instructions` in a workflow node agent slot.
 *
 * - `mode: 'override'` — replaces the agent's default value entirely.
 * - `mode: 'expand'`   — appends the value to the agent's default (separated by `\n\n`).
 */
export interface WorkflowNodeAgentOverride {
	mode: 'override' | 'expand';
	value: string;
}

/**
 * A single agent entry within a multi-agent workflow node.
 * References a SpaceAgent by ID with an optional per-slot configuration override.
 */
export interface WorkflowNodeAgent {
	/** ID of the SpaceAgent assigned to this slot */
	agentId: string;
	/**
	 * Agent slot label — must be unique within the node.
	 * Derived from the SpaceAgent name. When the same agent is added to a node
	 * multiple times, a numeric suffix is appended (e.g. `"Reviewer"` → `"Reviewer-2"`).
	 * Used for gate `writers` lists and `node_executions.agent_name`.
	 */
	name: string;
	/**
	 * Optional model override for this agent slot.
	 * When absent, the assigned SpaceAgent model is used.
	 */
	model?: string;
	/**
	 * Optional system-prompt override for this agent slot.
	 * `mode: 'override'` replaces the agent's `systemPrompt` entirely.
	 * `mode: 'expand'` appends the value to the agent's `systemPrompt`.
	 */
	systemPrompt?: WorkflowNodeAgentOverride;
	/**
	 * Optional instructions override for this agent slot.
	 * `mode: 'override'` replaces the agent's `instructions` entirely.
	 * `mode: 'expand'` appends the value to the agent's `instructions`.
	 */
	instructions?: WorkflowNodeAgentOverride;
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
 * A directed (one-way) messaging channel between two nodes in a workflow.
 *
 * Channels are always one-way. A relationship in both directions is represented as
 * two separate channels — each with its own independent gate and maxCycles.
 *
 * `from` and `to` reference node names (`WorkflowNode.name`). Node names must be
 * unique within a workflow. `to` may be an array to fan-out to multiple nodes.
 *
 * No channels = no messaging constraints (agents are fully isolated).
 */
export interface WorkflowChannel {
	/**
	 * Stable identifier for this channel.
	 * Should be present on all persisted channels. When absent the runtime
	 * generates one at seed/migration time.
	 */
	id?: string;
	/**
	 * Source node name (`WorkflowNode.name`). Must match a node in this workflow.
	 * Use `'*'` to match any node (rare).
	 */
	from: string;
	/**
	 * Target node name(s). `'*'` targets all nodes.
	 * An array enables fan-out delivery to multiple nodes simultaneously.
	 */
	to: string | string[];
	/**
	 * Maximum number of times this channel may be traversed in a single workflow run
	 * before delivery is blocked. Only meaningful for back-channels (cyclic edges).
	 * Defaults to 5 at runtime when the channel is cyclic and this field is absent.
	 */
	maxCycles?: number;
	/** Optional human-readable label for display in the visual editor */
	label?: string;
	/**
	 * Optional reference to a Gate entity in `SpaceWorkflow.gates`.
	 * When set, delivery is blocked until the gate's condition passes.
	 * Each gate belongs to exactly one channel.
	 */
	gateId?: string;
}

/**
 * A single node in the workflow graph.
 * Nodes run one or more agents (in parallel when multiple are specified).
 * Nodes are connected by WorkflowChannels.
 *
 * All agents are specified via `agents: WorkflowNodeAgent[]` — there is no
 * single-agent `agentId` shorthand. `agents` must be non-empty.
 */
/**
 * A single node in the workflow graph.
 * Nodes are the unit of workflow topology — they group one or more agents that
 * execute in parallel. Nodes are connected by WorkflowChannels.
 *
 * Node names must be unique within a workflow (used as channel addressing keys).
 * All agents are specified via `agents: WorkflowNodeAgent[]` — `agents` must be non-empty.
 */
export interface WorkflowNode {
	/** Unique identifier for this node (stable across renames) */
	id: string;
	/**
	 * Human-readable name — must be unique within the workflow.
	 * Used as the addressing key in `WorkflowChannel.from`/`to`.
	 */
	name: string;
	/**
	 * Agents for parallel execution within this node.
	 * Must be non-empty. Each agent runs concurrently; the node completes when all agents complete.
	 */
	agents: WorkflowNodeAgent[];
}

/**
 * Input shape for a workflow node at creation time.
 * `id` is optional — if provided the backend uses it, otherwise a UUID is generated.
 * Providing an explicit `id` allows channels in the same CreateSpaceWorkflowParams
 * call to reference the node before it has been persisted.
 */
export interface WorkflowNodeInput {
	/** Optional pre-assigned node ID. Generated by backend when omitted. */
	id?: string;
	name: string;
	/**
	 * Agents for parallel execution within this node. Must be non-empty.
	 */
	agents: WorkflowNodeAgent[];
}

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
	/**
	 * Workflow-level instructions injected into every agent session in this workflow.
	 * Use this for context all agents need: project conventions, repo structure,
	 * PR/branch naming rules, testing requirements, etc.
	 *
	 * Injection order: Space.instructions → Workflow.instructions → Agent.systemPrompt
	 */
	instructions?: string;
	/** Nodes in the workflow graph */
	nodes: WorkflowNode[];
	/** ID of the node where execution begins */
	startNodeId: string;
	/**
	 * ID of the node where execution ends.
	 * When the end node's execution calls `report_done`, the workflow run is
	 * automatically marked `done`. If absent, completion relies on the
	 * `CompletionDetector` all-agents-done check as a safety net.
	 */
	endNodeId?: string;
	/**
	 * Directed messaging channels between nodes in this workflow.
	 * `from`/`to` reference node names (`WorkflowNode.name`).
	 * Empty or absent means no messaging constraints (agents are fully isolated).
	 */
	channels?: WorkflowChannel[];
	/**
	 * Gate definitions for this workflow.
	 * Gates are independent entities referenced by channels via `gateId`.
	 * Persisted as JSON in the `gates` column of `space_workflows`.
	 */
	gates?: Gate[];
	/** Tags for organizational categorization. Not used for automatic workflow selection. */
	tags: string[];
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
	instructions?: string;
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
	 * ID of the node where execution ends.
	 * When the end node's execution calls `report_done`, the workflow run auto-completes.
	 */
	endNodeId?: string;
	/** Workflow-level messaging channels. */
	channels?: WorkflowChannel[];
	/** Gate definitions for this workflow. */
	gates?: Gate[];
	/** Tags for organizational categorization (default: []). Not used for automatic workflow selection. */
	tags?: string[];
	/** Visual editor node positions: maps node ID to {x, y} canvas coordinates */
	layout?: Record<string, { x: number; y: number }>;
}

/**
 * Parameters for updating an existing SpaceWorkflow.
 * All fields are optional — only provided fields are updated.
 *
 * For array fields (`nodes`, `channels`, `tags`):
 * - Pass a new array to replace the entire collection.
 * - Pass `null` to explicitly clear the field to an empty collection.
 * - Pass `[]` to clear all entries (equivalent to null for arrays).
 */
export interface UpdateSpaceWorkflowParams {
	name?: string;
	description?: string | null;
	instructions?: string | null;
	/**
	 * Replaces the entire node list. Pass `[]` or `null` to clear all nodes.
	 */
	nodes?: WorkflowNode[] | null;
	/**
	 * Updates the workflow entry point. Pass `null` to reset to first node.
	 */
	startNodeId?: string | null;
	/**
	 * Updates the workflow end node. Pass `null` to reset to the last node.
	 */
	endNodeId?: string | null;
	/**
	 * Replaces the channel list. Pass `[]` or `null` to clear all channels.
	 */
	channels?: WorkflowChannel[] | null;
	/**
	 * Replaces the gate list. Pass `[]` or `null` to clear all gates.
	 */
	gates?: Gate[] | null;
	/**
	 * Replaces the tag list. Pass `[]` or `null` to clear all tags.
	 * Tags are for organizational categorization only — not used for automatic workflow selection.
	 */
	tags?: string[] | null;
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
 * - `id` is stripped (regenerated on import)
 * - `from`/`to` use node names (portable across Space instances)
 */
export interface ExportedWorkflowChannel {
	/** Source node name */
	from: string;
	/** Target node name(s) */
	to: string | string[];
	maxCycles?: number;
	label?: string;
	gateId?: string;
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
	/** Optional model override for this agent slot. */
	model?: string;
	/**
	 * Optional system-prompt override for this agent slot.
	 * Accepts both plain strings (legacy export format) and `{ mode, value }` objects.
	 * Plain strings are normalized to `{ mode: 'override', value }` during import.
	 */
	systemPrompt?: WorkflowNodeAgentOverride | string;
	/**
	 * Optional instructions override for this agent slot.
	 * Accepts both plain strings (legacy export format) and `{ mode, value }` objects.
	 * Plain strings are normalized to `{ mode: 'override', value }` during import.
	 */
	instructions?: WorkflowNodeAgentOverride | string;
}

/**
 * A single workflow node (graph node) in the exported format.
 *
 * Differences from `WorkflowNode`:
 * - `id` is stripped (space-specific, regenerated on import)
 * - `agents[]` entries have their `agentId` UUIDs replaced by `agentRef` names.
 * - `channels[]` have moved to `ExportedSpaceWorkflow.channels` (workflow-level).
 *
 * Node names are used as cross-references throughout the exported format
 * (in `ExportedSpaceWorkflow.startNode` / `endNode`).
 * Node names must therefore be unique within an exported workflow.
 */
export interface ExportedWorkflowNode {
	/**
	 * Multiple agents for parallel execution.
	 * `agentId` UUIDs are replaced with portable `agentRef` names.
	 */
	agents: ExportedWorkflowNodeAgent[];
	/** Human-readable node name — used as the stable cross-reference key in the export */
	name: string;
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
	/** System prompt — persona and constraints for this agent */
	systemPrompt?: string;
	/**
	 * Default operating procedure — describes HOW the agent performs its work.
	 * Mirrors `SpaceAgent.instructions`.
	 */
	instructions?: string;
	/**
	 * Tool name overrides — list of tool names from KNOWN_TOOLS this agent may use.
	 * When absent, defaults apply on import.
	 * Mirrors `SpaceAgent.tools`.
	 */
	tools?: string[];
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
	/**
	 * Name of the node where execution ends (optional — mirrors `SpaceWorkflow.endNodeId`).
	 * When present, the end node's `report_done` call auto-completes the workflow run.
	 */
	endNode?: string;
	/** Tags for categorization */
	tags: string[];
	/** Workflow-level instructions injected into every agent session */
	instructions?: string;
	/**
	 * Directed messaging channels. `from`/`to` use node names. Channel `id` is stripped.
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
