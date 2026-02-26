/**
 * Neo Self-Aware Architecture Types
 *
 * Types for rooms, goals, tasks, and summaries.
 * Prepared for Room Runtime v0.19.
 */

// ============================================================================
// Room Types
// ============================================================================

/**
 * Room status
 */
export type RoomStatus = 'active' | 'archived';

/**
 * A workspace path with optional description
 */
export interface WorkspacePath {
	/** The filesystem path */
	path: string;
	/** Optional description of what's in this path */
	description?: string;
}

/**
 * A conceptual workspace for organizing work
 * Rooms are long-running work dimensions that can span multiple sessions and workspaces
 */
export interface Room {
	/** Unique identifier */
	id: string;
	/** Human-readable name */
	name: string;
	/** Allowed workspace paths for this room (multi-path support) */
	allowedPaths: WorkspacePath[];
	/** Default workspace path for new sessions (must be in allowedPaths) */
	defaultPath?: string;
	/** Default model for sessions created in this room */
	defaultModel?: string;
	/** Allowed models for this room (empty/undefined = all models allowed) */
	allowedModels?: string[];
	/** IDs of sessions associated with this room */
	sessionIds: string[];
	/** Current status of the room */
	status: RoomStatus;
	/** Background context for the room - describes project, goals, constraints */
	background?: string;
	/** Custom instructions for how the room agent should behave */
	instructions?: string;
	/** Runtime configuration (maxConcurrentGroups, taskTimeout, etc.) */
	config?: Record<string, unknown>;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Room goal status
 */
export type GoalStatus = 'active' | 'needs_human' | 'completed' | 'archived';

/**
 * Room goal priority
 */
export type GoalPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * A structured objective for a room
 * Goals track progress via linked tasks
 */
export interface RoomGoal {
	/** Unique identifier */
	id: string;
	/** Room this goal belongs to */
	roomId: string;
	/** Goal title */
	title: string;
	/** Detailed description */
	description: string;
	/** Current status */
	status: GoalStatus;
	/** Priority level */
	priority: GoalPriority;
	/** Progress percentage (0-100), aggregated from linked tasks */
	progress: number;
	/** IDs of tasks contributing to this goal */
	linkedTaskIds: string[];
	/** Custom progress metrics */
	metrics?: Record<string, number>;
	/** Number of planning attempts */
	planning_attempts?: number;
	/** Number of goal review attempts */
	goal_review_attempts?: number;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
	/** Completion timestamp (milliseconds since epoch) */
	completedAt?: number;
}

/**
 * Parameters for creating a new room
 */
export interface CreateRoomParams {
	name: string;
	/** Background context for the room - describes project, goals, constraints */
	background?: string;
	/** Workspace paths that can be accessed in this room */
	allowedPaths?: WorkspacePath[];
	/** Default workspace path for new sessions */
	defaultPath?: string;
	/** Default model for new sessions */
	defaultModel?: string;
	/** Allowed models for this room (empty/undefined = all models allowed) */
	allowedModels?: string[];
}

/**
 * Parameters for updating a room
 */
export interface UpdateRoomParams {
	name?: string;
	allowedPaths?: WorkspacePath[];
	defaultPath?: string | null;
	defaultModel?: string | null;
	/** Allowed models for this room (empty/undefined = all models allowed) */
	allowedModels?: string[];
	/** Background context for the room */
	background?: string | null;
	/** Custom instructions for the room agent */
	instructions?: string | null;
}

// ============================================================================
// Neo Task Types
// ============================================================================

/**
 * Task status
 */
export type TaskStatus = 'draft' | 'pending' | 'in_progress' | 'escalated' | 'completed' | 'failed';

/**
 * Task priority
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Task type — determines which agent preset and tools are used
 */
export type TaskType = 'planning' | 'coding' | 'research' | 'design' | 'goal_review';

/**
 * A task managed within a room
 */
export interface NeoTask {
	/** Unique identifier */
	id: string;
	/** Room this task belongs to */
	roomId: string;
	/** Task title */
	title: string;
	/** Detailed description */
	description: string;
	/** Current status */
	status: TaskStatus;
	/** Priority level */
	priority: TaskPriority;
	/** Task type — determines agent preset (default: 'coding') */
	taskType?: TaskType;
	/** ID of the planning task that created this task (for draft→pending promotion) */
	createdByTaskId?: string;
	/** Progress percentage (0-100) */
	progress?: number;
	/** Description of current step */
	currentStep?: string;
	/** Result of completed task */
	result?: string;
	/** Error message for failed task */
	error?: string;
	/** IDs of tasks this task depends on */
	dependsOn: string[];
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Start timestamp (milliseconds since epoch) */
	startedAt?: number;
	/** Completion timestamp (milliseconds since epoch) */
	completedAt?: number;
}

/**
 * Filter options for querying tasks
 */
export interface TaskFilter {
	status?: TaskStatus;
	priority?: TaskPriority;
}

/**
 * Parameters for creating a new task
 */
export interface CreateTaskParams {
	roomId: string;
	title: string;
	description: string;
	priority?: TaskPriority;
	dependsOn?: string[];
	/** Task type — defaults to 'coding' */
	taskType?: TaskType;
	/** Initial status — defaults to 'pending'. Use 'draft' for planning-created tasks. */
	status?: TaskStatus;
	/** ID of planning task that created this task (for draft→pending promotion) */
	createdByTaskId?: string;
}

/**
 * Parameters for updating a task
 */
export interface UpdateTaskParams {
	title?: string;
	description?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	progress?: number;
	currentStep?: string;
	result?: string;
	error?: string;
	dependsOn?: string[];
}

// ============================================================================
// Summary Types (for API responses)
// ============================================================================

/**
 * Summary of a session for room overview
 */
export interface SessionSummary {
	id: string;
	title: string;
	status: string;
	lastActiveAt: number;
}

/**
 * Summary of a task for room overview
 */
export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	progress?: number;
}

/**
 * Overview of a room with related data
 */
export interface RoomOverview {
	room: Room;
	sessions: SessionSummary[];
	activeTasks: TaskSummary[];
}

/**
 * Neo status for a single room
 */
export interface NeoStatus {
	roomId: string;
	activeTaskCount: number;
}

/**
 * Global status of all room instances
 */
export interface GlobalStatus {
	rooms: NeoStatus[];
	totalActiveTasks: number;
}
