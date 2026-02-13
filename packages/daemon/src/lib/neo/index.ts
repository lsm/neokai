/**
 * Neo Self-Aware Architecture
 *
 * Phase 1: Foundation layer - data structures and persistence.
 * Phase 2: AI logic for Room-Neo.
 *
 * Exports only what's used by the daemon:
 * - RoomManager for room lifecycle management
 * - Types re-exported from @neokai/shared for convenience
 */

// Room Manager - main export used by daemon
export { RoomManager } from './room-manager';

// Types - re-exported from @neokai/shared for backward compatibility
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
} from '@neokai/shared';
