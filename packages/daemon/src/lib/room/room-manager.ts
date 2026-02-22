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
import { SessionRepository } from '../../storage/repositories/session-repository';
import { SessionPairRepository } from '../../storage/repositories/session-pair-repository';
import type {
	Room,
	CreateRoomParams,
	UpdateRoomParams,
	RoomOverview,
	TaskSummary,
	ContextChangedBy,
	TaskSession,
	TaskStatus,
	SessionStatus,
} from '@neokai/shared';
import type { RoomContextVersion } from '@neokai/shared';

export class RoomManager {
	private db: BunDatabase;
	private roomRepo: RoomRepository;
	private taskRepo: TaskRepository;
	private memoryRepo: MemoryRepository;
	private contextRepo: ContextRepository;
	private sessionRepo: SessionRepository;
	private sessionPairRepo: SessionPairRepository;

	constructor(db: BunDatabase) {
		this.db = db;
		this.roomRepo = new RoomRepository(db);
		this.taskRepo = new TaskRepository(db);
		this.memoryRepo = new MemoryRepository(db);
		this.contextRepo = new ContextRepository(db);
		this.sessionRepo = new SessionRepository(db);
		this.sessionPairRepo = new SessionPairRepository(db);
	}

	/**
	 * Create a new room with auto-generated context
	 */
	createRoom(params: CreateRoomParams): Room {
		const createRoomTx = this.db.transaction(() => {
			// Create the room
			const room = this.roomRepo.createRoom(params);

			// Create the context for this room
			const context = this.contextRepo.createContext(room.id);

			// Link the context ID to the room
			this.roomRepo.setRoomContextId(room.id, context.id);

			// Return the updated room
			return this.roomRepo.getRoom(room.id)!;
		});
		return createRoomTx();
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
	 *
	 * This sets:
	 * - Room status to 'archived'
	 * - All associated sessions status to 'archived'
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
	 *
	 * This includes:
	 * - All sessions associated with the room (and their messages/state via CASCADE)
	 * - All session pairs (via CASCADE)
	 * - All tasks (via CASCADE)
	 * - All goals (via CASCADE)
	 * - All recurring jobs (via CASCADE)
	 * - All proposals (via CASCADE)
	 * - All Q&A rounds (via CASCADE)
	 * - All memories (via CASCADE)
	 * - All context versions (via CASCADE)
	 * - The room itself
	 */
	deleteRoom(id: string): void {
		const room = this.roomRepo.getRoom(id);
		if (!room) {
			return;
		}

		const tx = this.db.transaction(() => {
			// Delete all sessions associated with this room
			// This will cascade delete messages and state for each session
			for (const sessionId of room.sessionIds) {
				this.sessionRepo.deleteSession(sessionId);
			}

			// Delete the room - CASCADE will handle:
			// - session_pairs, tasks, goals, recurring_jobs, proposals, memories, context_versions
			this.roomRepo.deleteRoom(id);
		});

		tx();
	}

	/**
	 * Add an allowed path to a room
	 */
	addAllowedPath(roomId: string, path: string, description?: string): Room | null {
		return this.roomRepo.addPath(roomId, path, description);
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

		// Get tasks and session pairs
		const tasks = this.taskRepo.listTasks(roomId);
		const pairsByTaskId = new Map(
			this.sessionPairRepo
				.getPairsByRoom(roomId)
				.filter((pair) => pair.currentTaskId)
				.map((pair) => [pair.currentTaskId!, pair])
		);
		const taskSummaries: TaskSummary[] = tasks.map((task) => {
			const pair = pairsByTaskId.get(task.id);
			const sessions =
				task.sessions ?? (pair ? this.buildSessionsFromPair(pair, task.status) : undefined);

			return {
				id: task.id,
				title: task.title,
				status: task.status,
				priority: task.priority,
				progress: task.progress,
				sessions,
				executionMode:
					task.executionMode ??
					(sessions && sessions.length > 1 ? 'parallel_then_merge' : 'single'),
			};
		});

		// Get context status
		const context = room.contextId ? this.contextRepo.getContext(room.contextId) : null;

		// Build session summaries from actual session data
		const sessions = room.sessionIds.map((id) => {
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
			contextStatus: context?.status,
		};
	}

	private buildSessionsFromPair(
		pair: {
			managerSessionId: string;
			workerSessionId: string;
			status: 'active' | 'idle' | 'crashed' | 'completed';
			createdAt: number;
			updatedAt: number;
		},
		taskStatus: TaskStatus
	): TaskSession[] {
		const manager = this.sessionRepo.getSession(pair.managerSessionId);
		const worker = this.sessionRepo.getSession(pair.workerSessionId);
		const completedAt = pair.status === 'completed' ? pair.updatedAt : undefined;

		return [
			{
				sessionId: pair.managerSessionId,
				role: 'reviewer',
				status: this.mapTaskSessionStatus(pair.status, manager?.status, taskStatus, 'manager'),
				startedAt: pair.createdAt,
				completedAt,
			},
			{
				sessionId: pair.workerSessionId,
				role: 'primary',
				status: this.mapTaskSessionStatus(pair.status, worker?.status, taskStatus, 'worker'),
				startedAt: pair.createdAt,
				completedAt,
			},
		];
	}

	private mapTaskSessionStatus(
		pairStatus: 'active' | 'idle' | 'crashed' | 'completed',
		sessionStatus: SessionStatus | undefined,
		taskStatus: TaskStatus,
		role: 'manager' | 'worker'
	): TaskSession['status'] {
		if (taskStatus === 'failed' || (pairStatus === 'crashed' && role === 'worker')) {
			return 'failed';
		}
		if (taskStatus === 'completed' || pairStatus === 'completed') {
			return 'completed';
		}
		if (
			taskStatus === 'pending' ||
			sessionStatus === 'pending_worktree_choice' ||
			sessionStatus === 'paused'
		) {
			return 'pending';
		}
		if (sessionStatus === 'ended' || sessionStatus === 'archived') {
			return 'completed';
		}
		return 'active';
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

	/**
	 * Get context version history for a room
	 */
	getContextVersions(roomId: string, limit?: number): RoomContextVersion[] {
		return this.roomRepo.getContextVersions(roomId, limit);
	}

	/**
	 * Get a specific context version for a room
	 */
	getContextVersion(roomId: string, version: number): RoomContextVersion | null {
		return this.roomRepo.getContextVersion(roomId, version);
	}

	/**
	 * Rollback room context to a previous version
	 */
	rollbackContext(roomId: string, targetVersion: number, changedBy: ContextChangedBy): Room | null {
		return this.roomRepo.rollbackContext(roomId, targetVersion, changedBy);
	}
}
