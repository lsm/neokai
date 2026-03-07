/**
 * Room Manager
 *
 * Manages room lifecycle and operations:
 * - Create rooms
 * - List rooms (with optional filter for archived)
 * - Get room details
 * - Update rooms
 * - Archive rooms
 * - Delete rooms
 * - Assign/unassign sessions to rooms
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { RoomRepository } from '../../../storage/repositories/room-repository';
import { TaskRepository } from '../../../storage/repositories/task-repository';
import { SessionRepository } from '../../../storage/repositories/session-repository';
import type {
	Room,
	CreateRoomParams,
	UpdateRoomParams,
	RoomOverview,
	TaskSummary,
	NeoTask,
} from '@neokai/shared';

export class RoomManager {
	private db: BunDatabase;
	private roomRepo: RoomRepository;
	private taskRepo: TaskRepository;
	private sessionRepo: SessionRepository;

	constructor(db: BunDatabase) {
		this.db = db;
		this.roomRepo = new RoomRepository(db);
		this.taskRepo = new TaskRepository(db);
		this.sessionRepo = new SessionRepository(db);
	}

	/**
	 * Create a new room
	 */
	createRoom(params: CreateRoomParams): Room {
		return this.roomRepo.createRoom(params);
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
	 * Archive a room and all its sessions (atomic transaction)
	 */
	archiveRoom(id: string): Room | null {
		const room = this.roomRepo.getRoom(id);
		if (!room) {
			return null;
		}

		const tx = this.db.transaction(() => {
			// Archive all sessions associated with this room
			for (const sessionId of room.sessionIds) {
				this.sessionRepo.archiveSession(sessionId);
			}

			// Archive the room
			return this.roomRepo.archiveRoom(id);
		});

		return tx() as Room | null;
	}

	/**
	 * Delete a room and all its associated data (atomic transaction)
	 */
	deleteRoom(id: string): boolean {
		const room = this.roomRepo.getRoom(id);
		if (!room) {
			return false;
		}

		const tx = this.db.transaction(() => {
			// Delete all sessions associated with this room
			for (const sessionId of room.sessionIds) {
				this.sessionRepo.deleteSession(sessionId);
			}

			// Delete the room — CASCADE handles tasks, goals, etc.
			return this.roomRepo.deleteRoom(id);
		});

		return tx() as boolean;
	}

	/**
	 * Assign a session to a room
	 */
	assignSession(roomId: string, sessionId: string): Room | null {
		return this.roomRepo.addSessionToRoom(roomId, sessionId);
	}

	/**
	 * Get room overview with related data
	 */
	getRoomOverview(roomId: string): RoomOverview | null {
		const room = this.roomRepo.getRoom(roomId);
		if (!room) return null;

		const tasks = this.taskRepo.listTasks(roomId);
		const toSummary = (task: NeoTask): TaskSummary => ({
			id: task.id,
			title: task.title,
			status: task.status,
			priority: task.priority,
			progress: task.progress,
			dependsOn: task.dependsOn,
			error: task.error,
			currentStep: task.currentStep,
		});
		const nonTerminal = tasks.filter((t) => t.status !== 'completed' && t.status !== 'failed');
		const taskSummaries = nonTerminal.map(toSummary);
		const allTaskSummaries = tasks.map(toSummary);

		// Build session summaries from actual session data
		// Filter out room-specific sessions (chat, craft, lead)
		const sessions = room.sessionIds
			.filter(
				(id) =>
					!id.startsWith('room:chat:') &&
					!id.startsWith('room:self:') &&
					!id.startsWith('room:craft:') &&
					!id.startsWith('room:lead:')
			)
			.map((id) => {
				const session = this.sessionRepo.getSession(id);
				if (!session) {
					return {
						id,
						title: `Session ${id.slice(0, 8)}`,
						status: 'ended' as const,
						lastActiveAt: 0,
					};
				}
				return {
					id: session.id,
					title: session.title,
					status: session.status,
					lastActiveAt: new Date(session.lastActiveAt).getTime(),
				};
			});

		return {
			room,
			sessions,
			activeTasks: taskSummaries,
			allTasks: allTaskSummaries,
		};
	}

	/**
	 * Get status for a room
	 */
	getRoomStatus(roomId: string) {
		const room = this.roomRepo.getRoom(roomId);
		if (!room) return null;

		const activeTaskCount = this.taskRepo.countActiveTasks(roomId);

		return {
			roomId,
			activeTaskCount,
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
		};
	}
}
