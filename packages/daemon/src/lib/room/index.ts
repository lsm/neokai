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
 */

export { RoomManager } from './room-manager';
export { ContextManager } from './context-manager';
export { MemoryManager } from './memory-manager';
export { TaskManager } from './task-manager';
export { SessionPairManager } from './session-pair-manager';
export { SessionBridge } from './session-bridge';
export { GoalManager } from './goal-manager';
export { RecurringJobScheduler } from './recurring-job-scheduler';
export {
	RoomAgentService,
	type RoomAgentContext,
	type RoomAgentConfig,
} from './room-agent-service';

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
	ManagerHookEvent,
	ManagerHookPayload,
} from '@neokai/shared';
