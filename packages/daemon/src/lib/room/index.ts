/**
 * Room Package
 *
 * Exports room-related managers:
 * - RoomManager for room lifecycle management
 * - ContextManager for conversation context
 * - MemoryManager for memory storage and retrieval
 * - TaskManager for task management
 * - WorkerManager for manager-less worker orchestration (PHASE 2)
 * - GoalManager for goal management with progress tracking
 * - RecurringJobScheduler for scheduled recurring jobs
 * - RoomSelfService for room self lifecycle management
 *
 * PHASE 4: Removed SessionPairManager and SessionBridge
 *
 * Unified Session Architecture:
 * - RoomSelfService uses AgentSession.fromInit() for AI orchestration
 * - Session ID format: room:self:${roomId}
 */

export { RoomManager } from './room-manager';
export { ContextManager } from './context-manager';
export { MemoryManager } from './memory-manager';
export { TaskManager } from './task-manager';
// PHASE 2 & 4: Manager-less architecture - WorkerManager replaces SessionPairManager
export { WorkerManager } from './worker-manager';
// @public - Library export
export { GoalManager } from './goal-manager';
// @public - Library export
export { RecurringJobScheduler } from './recurring-job-scheduler';
// @public - Library export
export {
	RoomSelfService,
	type RoomSelfContext,
	type RoomSelfConfig,
	type RoomSelfPlanningContext,
	type RoomSelfReviewContext,
	type RoomMessageEvent,
} from './room-self-service';

// @public - Library export
// Room Self Lifecycle
export { RoomSelfLifecycleManager } from './room-self-lifecycle-manager';

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
	RoomSelfState,
	RoomSelfLifecycleState,
	RoomSelfSessionMetadata,
	// Note: RoomSelfPlanningContext and RoomSelfReviewContext are exported from RoomSelfService
	RoomSelfHumanInput,
	RoomSelfWaitingContext,
	ManagerHookEvent,
	ManagerHookPayload,
} from '@neokai/shared';

// @public - Library export
// Constants - re-exported from @neokai/shared
export { DEFAULT_ROOM_SELF_CONFIG } from '@neokai/shared';
