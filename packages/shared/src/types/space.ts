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
