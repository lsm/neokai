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

// Legacy Room compatibility types. Keep these off the active shared root export.
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
} from '@neokai/shared/types/neo';
