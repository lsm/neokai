/**
 * Neo Self-Aware Architecture Types
 *
 * Types for rooms, memories, tasks, contexts, and events.
 * Phase 1: Foundation layer - data structures and persistence.
 */

// ============================================================================
// Room Types
// ============================================================================

/**
 * Room status
 */
export type RoomStatus = 'active' | 'archived';

/**
 * A conceptual workspace for organizing work
 * Rooms are long-running work dimensions that can span multiple sessions and workspaces
 */
export interface Room {
	/** Unique identifier */
	id: string;
	/** Human-readable name */
	name: string;
	/** Optional description of the room's purpose */
	description?: string;
	/** Allowed workspace paths for this room (multi-path support) */
	allowedPaths: string[];
	/** Default workspace path for new sessions (must be in allowedPaths) */
	defaultPath?: string;
	/** Default model for sessions created in this room */
	defaultModel?: string;
	/** IDs of sessions associated with this room */
	sessionIds: string[];
	/** Current status of the room */
	status: RoomStatus;
	/** ID of the context for this room */
	contextId?: string;
	/** Background context for the room - describes project, goals, constraints */
	background?: string;
	/** Custom instructions for how the room agent should behave */
	instructions?: string;
	/** Version of the room context (incremented on changes) */
	contextVersion?: number;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Room goal status
 */
export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

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
	description?: string;
	allowedPaths?: string[];
	defaultPath?: string;
	defaultModel?: string;
}

/**
 * Parameters for updating a room
 */
export interface UpdateRoomParams {
	name?: string;
	description?: string;
	allowedPaths?: string[];
	defaultPath?: string;
	defaultModel?: string;
	/** Background context for the room */
	background?: string;
	/** Custom instructions for the room agent */
	instructions?: string;
}

/**
 * Who made the context change
 */
export type ContextChangedBy = 'human' | 'agent';

/**
 * A versioned snapshot of room context
 */
export interface RoomContextVersion {
	/** Unique identifier */
	id: string;
	/** Room this version belongs to */
	roomId: string;
	/** Version number (sequential per room) */
	version: number;
	/** Background context text */
	background?: string;
	/** Instructions context text */
	instructions?: string;
	/** Who made the change */
	changedBy: ContextChangedBy;
	/** Optional reason for the change */
	changeReason?: string;
	/** When this version was created */
	createdAt: number;
}

// ============================================================================
// Neo Memory Types
// ============================================================================

/**
 * Memory type for categorizing stored information
 */
export type MemoryType = 'conversation' | 'task_result' | 'preference' | 'pattern' | 'note';

/**
 * Memory importance level
 */
export type MemoryImportance = 'low' | 'normal' | 'high';

/**
 * A memory entry stored by Neo for a room
 * Persistent memory that survives across sessions
 */
export interface NeoMemory {
	/** Unique identifier */
	id: string;
	/** Room this memory belongs to */
	roomId: string;
	/** Type of memory */
	type: MemoryType;
	/** The memory content (can be text or JSON) */
	content: string;
	/** Tags for categorization and search */
	tags: string[];
	/** Importance level for prioritization */
	importance: MemoryImportance;
	/** Session ID if memory is session-specific */
	sessionId?: string;
	/** Task ID if memory is related to a task */
	taskId?: string;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last access timestamp (milliseconds since epoch) */
	lastAccessedAt: number;
	/** Number of times this memory has been accessed */
	accessCount: number;
}

/**
 * Parameters for creating a new memory
 */
export interface CreateMemoryParams {
	roomId: string;
	type: MemoryType;
	content: string;
	tags?: string[];
	importance?: MemoryImportance;
	sessionId?: string;
	taskId?: string;
}

// ============================================================================
// Neo Task Types
// ============================================================================

/**
 * Task status
 */
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';

/**
 * Task priority
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * A task managed by Neo within a room
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
	/** Session ID if task is being worked on in a session (legacy, prefer sessionIds) */
	sessionId?: string;
	/** IDs of sessions working on this task (multi-session support) */
	sessionIds?: string[];
	/** How multiple sessions should coordinate */
	executionMode?: TaskExecutionMode;
	/** Detailed session assignments */
	sessions?: TaskSession[];
	/** Link to recurring job if spawned by one */
	recurringJobId?: string;
	/** Current status */
	status: TaskStatus;
	/** Priority level */
	priority: TaskPriority;
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
	sessionId?: string;
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
}

/**
 * Parameters for updating a task
 */
export interface UpdateTaskParams {
	title?: string;
	description?: string;
	sessionId?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	progress?: number;
	currentStep?: string;
	result?: string;
	error?: string;
	dependsOn?: string[];
	/** IDs of sessions working on this task (multi-session support) */
	sessionIds?: string[];
	/** How multiple sessions should coordinate */
	executionMode?: TaskExecutionMode;
	/** Detailed session assignments */
	sessions?: TaskSession[];
	/** Link to recurring job if spawned by one */
	recurringJobId?: string;
}

// ============================================================================
// Multi-Session Task Types
// ============================================================================

/**
 * Task execution mode for multi-session support
 */
export type TaskExecutionMode = 'single' | 'parallel' | 'serial' | 'parallel_then_merge';

/**
 * Session assignment within a task
 */
export interface TaskSession {
	/** Session ID */
	sessionId: string;
	/** Role of this session in the task */
	role: 'primary' | 'secondary' | 'reviewer';
	/** Status of this session's work */
	status: 'pending' | 'active' | 'completed' | 'failed';
	/** When this session started work */
	startedAt?: number;
	/** When this session completed work */
	completedAt?: number;
}

// ============================================================================
// Recurring Job Types
// ============================================================================

/**
 * Schedule configuration for recurring jobs
 */
export type RecurringJobSchedule =
	| { type: 'cron'; expression: string }
	| { type: 'interval'; minutes: number }
	| { type: 'daily'; hour: number; minute: number }
	| { type: 'weekly'; dayOfWeek: number; hour: number; minute: number };

/**
 * Task template for recurring jobs
 */
export interface RecurringTaskTemplate {
	/** Task title template */
	title: string;
	/** Task description template */
	description: string;
	/** Default priority for spawned tasks */
	priority: TaskPriority;
	/** Default execution mode for spawned tasks */
	executionMode?: TaskExecutionMode;
}

/**
 * A recurring job that spawns tasks on a schedule
 */
export interface RecurringJob {
	/** Unique identifier */
	id: string;
	/** Room this job belongs to */
	roomId: string;
	/** Job name */
	name: string;
	/** Detailed description */
	description: string;
	/** Schedule configuration */
	schedule: RecurringJobSchedule;
	/** Task template for spawned tasks */
	taskTemplate: RecurringTaskTemplate;
	/** Whether the job is enabled */
	enabled: boolean;
	/** When the job last ran */
	lastRunAt?: number;
	/** When the job will run next */
	nextRunAt?: number;
	/** Number of times the job has run */
	runCount: number;
	/** Maximum number of runs (optional) */
	maxRuns?: number;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Parameters for creating a recurring job
 */
export interface CreateRecurringJobParams {
	roomId: string;
	name: string;
	description: string;
	schedule: RecurringJobSchedule;
	taskTemplate: RecurringTaskTemplate;
	enabled?: boolean;
	maxRuns?: number;
}

// ============================================================================
// Neo Context Types
// ============================================================================

/**
 * Neo context status
 */
export type NeoContextStatus = 'idle' | 'thinking' | 'waiting_for_input';

/**
 * Message role in context
 */
export type ContextMessageRole = 'system' | 'user' | 'assistant';

/**
 * Neo context for a room - manages conversation history
 */
export interface NeoContext {
	/** Unique identifier */
	id: string;
	/** Room this context belongs to */
	roomId: string;
	/** Total tokens used in context */
	totalTokens: number;
	/** Last time context was compacted (milliseconds since epoch) */
	lastCompactedAt?: number;
	/** Current context status */
	status: NeoContextStatus;
	/** Current task being worked on */
	currentTaskId?: string;
	/** Current session being used */
	currentSessionId?: string;
}

/**
 * A message in the Neo context
 */
export interface NeoContextMessage {
	/** Unique identifier */
	id: string;
	/** Context this message belongs to */
	contextId: string;
	/** Message role */
	role: ContextMessageRole;
	/** Message content */
	content: string;
	/** Timestamp (milliseconds since epoch) */
	timestamp: number;
	/** Token count for this message */
	tokenCount: number;
	/** Session ID if message was from a session */
	sessionId?: string;
	/** Task ID if message was related to a task */
	taskId?: string;
}

// ============================================================================
// Session Event Types
// ============================================================================

/**
 * Types of session events that Neo can react to
 */
export type SessionEventType =
	| 'turn_complete'
	| 'question_asked'
	| 'question_answered'
	| 'error'
	| 'session_created'
	| 'session_archived';

/**
 * An event from a session that Neo observes
 */
export interface SessionEvent {
	/** Event type */
	type: SessionEventType;
	/** Session ID that generated the event */
	sessionId: string;
	/** Room ID if session is assigned to a room */
	roomId?: string;
	/** Event timestamp (milliseconds since epoch) */
	timestamp: number;
	/** Event-specific data */
	data?: unknown;
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
	/** Detailed session assignments */
	sessions?: TaskSession[];
	/** How multiple sessions should coordinate */
	executionMode?: TaskExecutionMode;
}

/**
 * Overview of a room with related data
 */
export interface RoomOverview {
	room: Room;
	sessions: SessionSummary[];
	activeTasks: TaskSummary[];
	contextStatus?: NeoContextStatus;
}

/**
 * Neo status for a single room
 */
export interface NeoStatus {
	roomId: string;
	contextStatus: NeoContextStatus;
	currentTaskId?: string;
	currentSessionId?: string;
	activeTaskCount: number;
	memoryCount: number;
}

/**
 * Global status of all Neo instances
 */
export interface GlobalStatus {
	rooms: NeoStatus[];
	totalActiveTasks: number;
	totalMemories: number;
}

// ============================================================================
// Session Pair Types (Dual-Session Architecture)
// ============================================================================

/**
 * Status of a session pair
 */
export type SessionPairStatus = 'active' | 'idle' | 'crashed' | 'completed';

/**
 * Represents a paired Manager + Worker session within a Room.
 * Created when RoomAgent delegates work to be executed.
 */
export interface SessionPair {
	/** Unique identifier for this pair */
	id: string;
	/** Room this pair belongs to */
	roomId: string;
	/** The RoomSession that created this pair */
	roomSessionId: string;
	/** The manager session ID */
	managerSessionId: string;
	/** The worker session ID */
	workerSessionId: string;
	/** Current status of the pair */
	status: SessionPairStatus;
	/** Current task being worked on */
	currentTaskId?: string;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
}

/**
 * Summary view of a session pair for listings.
 */
export interface SessionPairSummary {
	id: string;
	managerSessionId: string;
	workerSessionId: string;
	status: SessionPairStatus;
	currentTaskId?: string;
}

/**
 * Parameters for creating a new session pair.
 */
export interface CreateSessionPairParams {
	roomId: string;
	roomSessionId: string;
	taskTitle: string;
	taskDescription?: string;
	workspacePath?: string;
	model?: string;
}

// ============================================================================
// Room Agent Types
// ============================================================================

/**
 * Room agent lifecycle states
 */
export type RoomAgentLifecycleState =
	| 'idle'
	| 'planning'
	| 'executing'
	| 'waiting'
	| 'reviewing'
	| 'error'
	| 'paused';

/**
 * State of a room's agent
 */
export interface RoomAgentState {
	/** Room this agent manages */
	roomId: string;
	/** Current lifecycle state */
	lifecycleState: RoomAgentLifecycleState;
	/** Current goal being worked on */
	currentGoalId?: string;
	/** Current task being executed */
	currentTaskId?: string;
	/** Active session pair IDs */
	activeSessionPairIds: string[];
	/** Last activity timestamp */
	lastActivityAt: number;
	/** Error count for health monitoring */
	errorCount: number;
	/** Last error message */
	lastError?: string;
	/** Queue of planned actions */
	pendingActions: string[];
}

/**
 * Room agent session metadata (stored in sessions table)
 */
export interface RoomAgentSessionMetadata {
	sessionType: 'room';
	roomId: string;
	lifecycleState: RoomAgentLifecycleState;
	waitingFor?: 'review' | 'escalation' | 'question';
	waitingContext?: {
		taskId?: string;
		reason?: string;
		questionId?: string;
	};
}

/**
 * Context passed to room agent for planning decisions
 */
export interface RoomAgentPlanningContext {
	type: 'idle_check' | 'event_triggered' | 'goal_review' | 'context_update';
	activeGoals: RoomGoal[];
	pendingTasks: NeoTask[];
	inProgressTasks: NeoTask[];
	capacity: number;
	eventContext?: {
		type: 'github' | 'user_message' | 'timer' | 'job_triggered';
		data: unknown;
	};
	timestamp: number;
}

/**
 * Context for reviewing completed work
 */
export interface RoomAgentReviewContext {
	taskId: string;
	summary: string;
	filesChanged?: string[];
	goalProgress?: {
		goalId: string;
		previousProgress: number;
		newProgress: number;
	}[];
	timestamp: number;
}

/**
 * Human input types for room agent
 */
export type RoomAgentHumanInput =
	| { type: 'review_response'; taskId: string; response: string; approved: boolean }
	| { type: 'escalation_response'; escalationId: string; response: string }
	| { type: 'question_response'; questionId: string; responses: Record<string, string | string[]> }
	| { type: 'message'; content: string };

/**
 * Room agent waiting context
 */
export interface RoomAgentWaitingContext {
	type: 'review' | 'escalation' | 'question';
	taskId?: string;
	escalationId?: string;
	questionId?: string;
	reason?: string;
	since: number;
}

/**
 * Room agent configuration
 */
export interface RoomAgentConfig {
	maxConcurrentPairs: number;
	idleCheckIntervalMs: number;
	planningTimeoutMs: number;
	maxErrorCount: number;
	autoStartOnRoomCreate: boolean;
}

/**
 * Default configuration for room agents.
 * @public
 */
export const DEFAULT_ROOM_AGENT_CONFIG: RoomAgentConfig = {
	maxConcurrentPairs: 3,
	idleCheckIntervalMs: 60000, // 1 minute
	planningTimeoutMs: 300000, // 5 minutes
	maxErrorCount: 5,
	autoStartOnRoomCreate: false,
};

// ============================================================================
// Proposal Types
// ============================================================================

/**
 * Types of proposals an agent can make
 */
export type ProposalType =
	| 'file_change'
	| 'context_update'
	| 'goal_create'
	| 'goal_modify'
	| 'task_create'
	| 'task_modify'
	| 'config_change'
	| 'custom';

/**
 * Status of a proposal
 */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'applied';

/**
 * A proposal from a room agent that requires human approval
 * Part of the human-in-the-loop design for sensitive operations
 */
export interface RoomProposal {
	/** Unique identifier */
	id: string;
	/** Room this proposal belongs to */
	roomId: string;
	/** Session that created this proposal */
	sessionId: string;
	/** Type of proposal */
	type: ProposalType;
	/** Short title describing the proposal */
	title: string;
	/** Detailed description of what will be done */
	description: string;
	/** The proposed changes as structured data */
	proposedChanges: Record<string, unknown>;
	/** Why this change is being proposed */
	reasoning: string;
	/** Current status */
	status: ProposalStatus;
	/** Who approved/rejected (if applicable) */
	actedBy?: string;
	/** Response/reason for approval/rejection */
	actionResponse?: string;
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Action timestamp (milliseconds since epoch) */
	actedAt?: number;
}

/**
 * Parameters for creating a new proposal
 */
export interface CreateProposalParams {
	roomId: string;
	sessionId: string;
	type: ProposalType;
	title: string;
	description: string;
	proposedChanges: Record<string, unknown>;
	reasoning: string;
}

/**
 * Filter options for querying proposals
 */
export interface ProposalFilter {
	status?: ProposalStatus;
	type?: ProposalType;
	sessionId?: string;
}

// ============================================================================
// Manager Hook Types
// ============================================================================

/**
 * Events that trigger manager hooks
 */
export type ManagerHookEvent =
	| 'task_started'
	| 'task_progress'
	| 'task_completed'
	| 'task_failed'
	| 'task_escalated'
	| 'review_requested'
	| 'worker_timeout';

/**
 * Payload for manager hook events
 */
export interface ManagerHookPayload {
	/** Event type */
	event: ManagerHookEvent;
	/** Room ID */
	roomId: string;
	/** Session pair ID */
	pairId: string;
	/** Task ID */
	taskId: string;
	/** Event-specific data */
	data: Record<string, unknown>;
	/** Event timestamp */
	timestamp: number;
}
