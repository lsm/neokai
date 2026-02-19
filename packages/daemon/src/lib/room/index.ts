/**
 * Room Package
 *
 * Exports room-related managers:
 * - RoomManager for room lifecycle management
 * - ContextManager for conversation context
 * - MemoryManager for memory storage and retrieval
 * - TaskManager for task management
 * - SessionPairManager for manager-worker session pairs
 * - GoalManager for goal management with progress tracking
 * - RecurringJobScheduler for scheduled recurring jobs
 * - RoomAgentService for room agent lifecycle management
 *
 * Unified Session Architecture:
 * - RoomAgentService uses AgentSession.fromInit() for AI orchestration
 * - Session ID format: room:{roomId}
 */

export { RoomManager } from './room-manager';
export { ContextManager } from './context-manager';
export { MemoryManager } from './memory-manager';
export { TaskManager } from './task-manager';
export { SessionPairManager } from './session-pair-manager';
export { SessionBridge } from './session-bridge';
// @public - Library export
export { GoalManager } from './goal-manager';
// @public - Library export
export { RecurringJobScheduler } from './recurring-job-scheduler';
// @public - Library export
export {
	RoomAgentService,
	type RoomAgentContext,
	type RoomAgentConfig,
	type RoomAgentPlanningContext,
	type RoomAgentReviewContext,
	type RoomMessageEvent,
} from './room-agent-service';

// @public - Library export
// Room Agent Lifecycle
export { RoomAgentLifecycleManager } from './room-agent-lifecycle-manager';

// Types - re-exported from @neokai/shared for convenience
export type {
	Room,
	RoomStatus,
	CreateRoomParams,
	UpdateRoomParams,
	NeoMemory,
	MemoryType,
	MemoryImportance,
	CreateMemoryParams,
	NeoTask,
	TaskStatus,
	TaskPriority,
	TaskFilter,
	CreateTaskParams,
	UpdateTaskParams,
	NeoContext,
	NeoContextStatus,
	NeoContextMessage,
	ContextMessageRole,
	SessionEvent,
	SessionEventType,
	SessionSummary,
	TaskSummary,
	RoomOverview,
	NeoStatus,
	GlobalStatus,
	SessionPair,
	SessionPairStatus,
	SessionPairSummary,
	CreateSessionPairParams,
	// New types for self-building automation
	RoomGoal,
	GoalStatus,
	GoalPriority,
	RecurringJob,
	RecurringJobSchedule,
	RecurringTaskTemplate,
	TaskExecutionMode,
	TaskSession,
	RoomAgentState,
	RoomAgentLifecycleState,
	RoomAgentSessionMetadata,
	// Note: RoomAgentPlanningContext and RoomAgentReviewContext are exported from RoomAgentService
	RoomAgentHumanInput,
	RoomAgentWaitingContext,
	ManagerHookEvent,
	ManagerHookPayload,
} from '@neokai/shared';

// @public - Library export
// Constants - re-exported from @neokai/shared
export { DEFAULT_ROOM_AGENT_CONFIG } from '@neokai/shared';
