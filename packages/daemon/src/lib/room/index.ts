/**
 * Room Package
 *
 * Exports room-related managers:
 * - RoomManager for room lifecycle management
 * - TaskManager for task management
 * - GoalManager for goal management with progress tracking
 */

export { RoomManager } from './managers/room-manager';
export { TaskManager } from './managers/task-manager';
// @public - Library export
export { GoalManager } from './managers/goal-manager';
export { RoomRuntimeService } from './runtime/room-runtime-service';
export type { RoomRuntimeServiceConfig } from './runtime/room-runtime-service';

// Types - re-exported from @neokai/shared for convenience
export type {
	Room,
	RoomStatus,
	CreateRoomParams,
	UpdateRoomParams,
	NeoTask,
	TaskStatus,
	TaskPriority,
	TaskFilter,
	CreateTaskParams,
	UpdateTaskParams,
	SessionSummary,
	TaskSummary,
	RoomOverview,
	NeoStatus,
	GlobalStatus,
	// Goal types
	RoomGoal,
	GoalStatus,
	GoalPriority,
} from '@neokai/shared';
