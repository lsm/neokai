/**
 * Room Manager
 *
 * Manages room lifecycle and operations:
 * - Create rooms with auto-generated context
 * - List rooms (with optional filter for archived)
 * - Get room details
 * - Update rooms
 * - Archive rooms
 * - Assign/unassign sessions to rooms
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { RoomRepository } from '../../storage/repositories/room-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { MemoryRepository } from '../../storage/repositories/memory-repository';
import { ContextRepository } from '../../storage/repositories/context-repository';
import type {
	Room,
	CreateRoomParams,
	UpdateRoomParams,
	RoomOverview,
	TaskSummary,
} from '@neokai/shared';

export class RoomManager {
	private roomRepo: RoomRepository;
	private taskRepo: TaskRepository;
	private memoryRepo: MemoryRepository;
	private contextRepo: ContextRepository;

	constructor(db: BunDatabase) {
		this.roomRepo = new RoomRepository(db);
		this.taskRepo = new TaskRepository(db);
		this.memoryRepo = new MemoryRepository(db);
		this.contextRepo = new ContextRepository(db);
	}

	/**
	 * Create a new room with auto-generated context
	 */
	createRoom(params: CreateRoomParams): Room {
		// Create the room
		const room = this.roomRepo.createRoom(params);

		// Create the context for this room
		const context = this.contextRepo.createContext(room.id);

		// Link the context ID to the room
		this.roomRepo.setRoomContextId(room.id, context.id);

		// Return the updated room
		return this.roomRepo.getRoom(room.id)!;
	}

	/**
	 * List all rooms, optionally including archived ones
	 */
	listRooms(includeArchived = false): Room[] {
		return this.roomRepo.listRooms(includeArchived);
	}

	/**
	 * Get a room by ID
	 */
	getRoom(id: string): Room | null {
		return this.roomRepo.getRoom(id);
	}

	/**
	 * Update a room
	 */
	updateRoom(id: string, params: UpdateRoomParams): Room | null {
		return this.roomRepo.updateRoom(id, params);
	}

	/**
	 * Archive a room
	 */
	archiveRoom(id: string): Room | null {
		return this.roomRepo.archiveRoom(id);
	}

	/**
	 * Delete a room (and its associated data via CASCADE)
	 */
	deleteRoom(id: string): void {
		this.roomRepo.deleteRoom(id);
	}

	/**
	 * Add an allowed path to a room
	 */
	addAllowedPath(roomId: string, path: string): Room | null {
		return this.roomRepo.addPath(roomId, path);
	}

	/**
	 * Remove an allowed path from a room
	 */
	removeAllowedPath(roomId: string, path: string): Room | null {
		return this.roomRepo.removePath(roomId, path);
	}

	/**
	 * Assign a session to a room
	 */
	assignSession(roomId: string, sessionId: string): Room | null {
		return this.roomRepo.addSessionToRoom(roomId, sessionId);
	}

	/**
	 * Unassign a session from a room
	 */
	unassignSession(roomId: string, sessionId: string): Room | null {
		return this.roomRepo.removeSessionFromRoom(roomId, sessionId);
	}

	/**
	 * Get room overview with related data
	 */
	getRoomOverview(roomId: string): RoomOverview | null {
		const room = this.roomRepo.getRoom(roomId);
		if (!room) return null;

		// Get active tasks
		const tasks = this.taskRepo.listTasks(roomId);
		const activeTasks: TaskSummary[] = tasks
			.filter((t) => t.status !== 'completed' && t.status !== 'failed')
			.map((t) => ({
				id: t.id,
				title: t.title,
				status: t.status,
				priority: t.priority,
				progress: t.progress,
			}));

		// Get context status
		const context = room.contextId ? this.contextRepo.getContext(room.contextId) : null;

		// Build session summaries (placeholder - actual session data would come from SessionManager)
		const sessions = room.sessionIds.map((id) => ({
			id,
			title: `Session ${id.slice(0, 8)}`,
			status: 'active',
			lastActiveAt: Date.now(),
		}));

		return {
			room,
			sessions,
			activeTasks,
			contextStatus: context?.status,
		};
	}

	/**
	 * Get status for a room
	 */
	getRoomStatus(roomId: string) {
		const room = this.roomRepo.getRoom(roomId);
		if (!room) return null;

		const context = room.contextId ? this.contextRepo.getContext(room.contextId) : null;
		const activeTaskCount = this.taskRepo.countActiveTasks(roomId);
		const memoryCount = this.memoryRepo.countMemories(roomId);

		return {
			roomId,
			contextStatus: context?.status ?? 'idle',
			currentTaskId: context?.currentTaskId,
			currentSessionId: context?.currentSessionId,
			activeTaskCount,
			memoryCount,
		};
	}

	/**
	 * Get global status of all room instances
	 */
	getGlobalStatus() {
		const rooms = this.roomRepo.listRooms(false); // Only active rooms

		const roomStatuses = rooms.map((room) => this.getRoomStatus(room.id)).filter(Boolean);

		return {
			rooms: roomStatuses,
			totalActiveTasks: roomStatuses.reduce((sum, r) => sum + (r?.activeTaskCount ?? 0), 0),
			totalMemories: roomStatuses.reduce((sum, r) => sum + (r?.memoryCount ?? 0), 0),
		};
	}
}
