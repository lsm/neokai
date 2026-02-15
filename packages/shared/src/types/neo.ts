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
	/** Creation timestamp (milliseconds since epoch) */
	createdAt: number;
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
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
	/** Session ID if task is being worked on in a session */
	sessionId?: string;
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
