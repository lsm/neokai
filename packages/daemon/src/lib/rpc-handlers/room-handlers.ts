/**
 * Room RPC Handlers
 *
 * RPC handlers for room operations:
 * - room.create - Create a room
 * - room.list - List all rooms
 * - room.get - Get room details
 * - room.update - Update room
 * - room.archive - Archive room
 * - room.updateContext - Update room context (background/instructions)
 * - room.getContextVersions - List context version history
 * - room.getContextVersion - Get specific context version
 * - room.rollbackContext - Rollback to a previous context version
 * - room.overview - Get room overview with related data
 * - room.status - Get status for a specific room
 * - neo.status - Get global status (all rooms, sessions, workers)
 *
 * PHASE 4: Removed manager-worker pair RPC handlers (room.createPair, room.getPair, room.getPairs, room.archivePair)
 *
 * Renamed from neo.room.* to room.* for cleaner API.
 */

import type { MessageHub, WorkspacePath, McpServerConfig } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { RoomManager } from '../room/room-manager';
import type { WorkerManager } from '../room/worker-manager';
import type { RoomSelfManager } from './room-self-handlers';
import type { SessionManager } from '../session-manager';
import { createRoomAgentMcpServer } from '../agent/room-agent-tools';
import type { Database } from '../../storage/index';
import { Logger } from '../logger';

const log = new Logger('room-handlers');

/**
 * Global registry for in-process MCP servers for rooms
 * Maps roomId -> MCP server instance
 * These servers are created when a room is created and can be used by both
 * room chat and room self sessions
 */
const roomMcpServerRegistry = new Map<string, ReturnType<typeof createRoomAgentMcpServer>>();

/**
 * Get or create the MCP server for a room
 * The MCP server is created when the room is created and shared by both room chat and room self sessions
 *
 * @public Exported for use by query-options-builder.ts via dynamic require
 */
export function getOrCreateRoomMcpServer(
	roomId: string,
	db: Database
): ReturnType<typeof createRoomAgentMcpServer> {
	let server = roomMcpServerRegistry.get(roomId);
	if (!server) {
		// Import dynamically to avoid circular dependency
		const { GoalRepository } = require('../../storage/repositories/goal-repository');
		const { TaskRepository } = require('../../storage/repositories/task-repository');
		const {
			RecurringJobRepository,
		} = require('../../storage/repositories/recurring-job-repository');

		const goalRepo = new GoalRepository(db.getDatabase());
		const taskRepo = new TaskRepository(db.getDatabase());
		const jobRepo = new RecurringJobRepository(db.getDatabase());

		// Create the MCP server with actual callbacks
		server = createRoomAgentMcpServer({
			roomId,
			sessionId: `room:mcp:${roomId}`, // Internal MCP session ID
			onCompleteGoal: async (params) => {
				// Room self session will handle this
				// SECURITY: Validate goal belongs to this room before mutation
				const goal = goalRepo.getGoal(params.goalId);
				if (goal && goal.roomId === roomId) {
					goalRepo.updateGoal(params.goalId, { status: 'completed' });
				}
			},
			onCreateTask: async (params) => {
				// Room self session will handle this
				const task = taskRepo.createTask({
					roomId,
					title: params.title,
					description: params.description ?? '',
					priority: params.priority ?? 'normal',
					goalId: params.goalId,
				});
				return { taskId: task.id };
			},
			onSpawnWorker: async (_params) => {
				// This is handled by the room self session
				return { workerSessionId: '' };
			},
			onRequestReview: async (_taskId, _reason) => {
				// This is handled by the room self session
			},
			onEscalate: async (_taskId, _reason) => {
				// This is handled by the room self session
			},
			onUpdateGoalProgress: async (params) => {
				// SECURITY: Validate goal belongs to this room before mutation
				const goal = goalRepo.getGoal(params.goalId);
				if (goal && goal.roomId === roomId) {
					goalRepo.updateGoal(params.goalId, { progress: params.progress });
				}
			},
			onListGoals: async (status) => {
				const goals = goalRepo.listGoals(roomId, status);
				return goals.map(
					(g: {
						id: string;
						title: string;
						description?: string;
						status: string;
						priority: string;
						progress?: number;
					}) => ({
						id: g.id,
						title: g.title,
						description: g.description ?? '',
						status: g.status,
						priority: g.priority,
						progress: g.progress ?? 0,
					})
				);
			},
			onListTasks: async (status) => {
				const tasks = taskRepo.listTasks(roomId, status);
				return tasks.map(
					(t: {
						id: string;
						title: string;
						description?: string;
						status: string;
						priority: string;
					}) => ({
						id: t.id,
						title: t.title,
						description: t.description ?? '',
						status: t.status,
						priority: t.priority,
					})
				);
			},
			onListJobs: async () => {
				const jobs = jobRepo.listJobs(roomId);
				return jobs.map(
					(j: {
						id: string;
						name: string;
						description?: string;
						scheduleType: string;
						enabled: boolean;
						nextRunAt?: number;
					}) => ({
						id: j.id,
						name: j.name,
						description: j.description ?? '',
						scheduleType: j.scheduleType,
						enabled: j.enabled,
						nextRunAt: j.nextRunAt,
					})
				);
			},
		});
		roomMcpServerRegistry.set(roomId, server);
	}
	return server;
}

/**
 * Get an existing MCP server for a room (returns undefined if not created)
 *
 * @public Exported for use by query-options-builder.ts via dynamic require
 */
export function getRoomMcpServer(
	roomId: string
): ReturnType<typeof createRoomAgentMcpServer> | undefined {
	return roomMcpServerRegistry.get(roomId);
}

/**
 * Set/replace the MCP server instance for a room.
 *
 * Used by room self manager to register the live room:self MCP server so
 * room chat sessions and QueryOptionsBuilder resolve a single authoritative instance.
 */
export function setRoomMcpServer(
	roomId: string,
	server: ReturnType<typeof createRoomAgentMcpServer>
): void {
	roomMcpServerRegistry.set(roomId, server);
}

/**
 * PHASE 5: Create or update the room agent MCP server with WorkerManager support
 *
 * This allows room:chat sessions to spawn workers via room agent tools.
 *
 * @param roomId - Room ID
 * @param db - Database instance
 * @param workerManager - WorkerManager for spawning workers (PHASE 5)
 * @param daemonHub - DaemonHub for event emission
 * @param messageHub - MessageHub for RPC calls (optional, enables session management tools)
 * @param roomManager - RoomManager for session listing (optional, enables onListSessions)
 * @returns The MCP server instance
 */
export function createOrUpdateRoomMcpServer(
	roomId: string,
	db: Database,
	workerManager?: WorkerManager,
	daemonHub?: DaemonHub,
	messageHub?: MessageHub,
	roomManager?: RoomManager
): ReturnType<typeof createRoomAgentMcpServer> {
	let server = roomMcpServerRegistry.get(roomId);
	if (!server) {
		// Import dynamically to avoid circular dependency
		const { GoalRepository } = require('../../storage/repositories/goal-repository');
		const { TaskRepository } = require('../../storage/repositories/task-repository');
		const {
			RecurringJobRepository,
		} = require('../../storage/repositories/recurring-job-repository');

		const goalRepo = new GoalRepository(db.getDatabase());
		const taskRepo = new TaskRepository(db.getDatabase());
		const jobRepo = new RecurringJobRepository(db.getDatabase());

		// Create the MCP server with actual callbacks
		server = createRoomAgentMcpServer({
			roomId,
			sessionId: `room:mcp:${roomId}`, // Internal MCP session ID
			onCompleteGoal: async (params) => {
				// Room self session will handle this
				// SECURITY: Validate goal belongs to this room before mutation
				const goal = goalRepo.getGoal(params.goalId);
				if (goal && goal.roomId === roomId) {
					goalRepo.updateGoal(params.goalId, { status: 'completed' });
				}
			},
			onCreateTask: async (params) => {
				// Room self session will handle this
				const task = taskRepo.createTask({
					roomId,
					title: params.title,
					description: params.description ?? '',
					priority: params.priority ?? 'normal',
					goalId: params.goalId,
				});
				return { taskId: task.id };
			},
			onSpawnWorker: async (params) => {
				// PHASE 5: Connect to WorkerManager to spawn workers (if provided)
				// This allows room:chat users to manually spawn workers
				if (workerManager) {
					// Fetch task details from repository
					const task = taskRepo.getTask(params.taskId);
					if (!task) {
						throw new Error(`Task not found: ${params.taskId}`);
					}
					// SECURITY: Validate task belongs to this room before spawning worker
					if (task.roomId !== roomId) {
						throw new Error(`Task ${params.taskId} does not belong to room ${roomId}`);
					}
					const workerSessionId = await workerManager.spawnWorker({
						roomId,
						roomSessionId: `room:chat:${roomId}`, // Actual room:chat session ID (FK valid)
						roomSessionType: 'room_chat',
						taskId: params.taskId,
						taskTitle: task.title,
						taskDescription: task.description ?? undefined,
					});
					return { workerSessionId };
				}
				// Fallback: Return empty response if WorkerManager not available
				return { workerSessionId: '' };
			},
			onRequestReview: async (taskId, reason) => {
				// PHASE 5: Emit review request event for room:self to handle (if daemonHub provided)
				if (daemonHub) {
					await daemonHub.emit('roomAgent.reviewRequested', {
						sessionId: `room:${roomId}`,
						roomId,
						taskId,
						reason,
					});
				}
			},
			onEscalate: async (taskId, reason) => {
				// PHASE 5: Emit escalation event for room:self to handle (if daemonHub provided)
				if (daemonHub) {
					const escalationId = generateUUID();
					await daemonHub.emit('roomAgent.escalated', {
						sessionId: `room:${roomId}`,
						roomId,
						taskId,
						escalationId,
						reason,
					});
				}
			},
			onUpdateGoalProgress: async (params) => {
				// SECURITY: Validate goal belongs to this room before mutation
				const goal = goalRepo.getGoal(params.goalId);
				if (goal && goal.roomId === roomId) {
					goalRepo.updateGoal(params.goalId, { progress: params.progress });
				}
			},
			onListGoals: async (status) => {
				const goals = goalRepo.getGoalsByRoom(roomId);
				return goals
					.filter((g: { status: string }) => !status || g.status === status)
					.map(
						(g: {
							id: string;
							title: string;
							description?: string;
							status: string;
							priority: string;
							progress: number;
						}) => ({
							id: g.id,
							title: g.title,
							description: g.description ?? '',
							status: g.status,
							priority: g.priority,
							progress: g.progress,
						})
					);
			},
			onListJobs: async () => {
				const jobs = jobRepo.getJobsByRoom(roomId);
				return jobs.map(
					(j: {
						id: string;
						name: string;
						description?: string;
						scheduleType: string;
						intervalMinutes?: number | null;
						enabled: boolean;
					}) => ({
						id: j.id,
						name: j.name,
						description: j.description ?? '',
						schedule: `${j.scheduleType}@${j.intervalMinutes ?? 'once'}`,
						enabled: j.enabled,
					})
				);
			},
			onListTasks: async (status) => {
				const tasks = taskRepo.getTasksByRoom(roomId);
				return tasks
					.filter((t: { status: string }) => !status || t.status === status)
					.map(
						(t: {
							id: string;
							title: string;
							description?: string;
							status: string;
							priority: string;
							progress: number;
						}) => ({
							id: t.id,
							title: t.title,
							description: t.description ?? '',
							status: t.status,
							priority: t.priority,
							progress: t.progress,
						})
					);
			},
			// Session management tools (optional - require messageHub)
			onCancelTask: messageHub
				? async (params) => {
						// SECURITY: Validate task belongs to this room before cancellation
						const task = taskRepo.getTask(params.taskId);
						if (!task) {
							throw new Error(`Task not found: ${params.taskId}`);
						}
						if (task.roomId !== roomId) {
							throw new Error(`Task ${params.taskId} does not belong to room ${roomId}`);
						}
						taskRepo.updateTask(params.taskId, { status: 'cancelled', error: params.reason });
						// Archive associated worker session if exists
						if (workerManager) {
							const worker = workerManager.getWorkerByTask(params.taskId);
							if (worker) {
								await messageHub.request('session.archive', {
									sessionId: worker.sessionId,
									confirmed: true,
								});
							}
						}
					}
				: undefined,
			onArchiveSession: messageHub
				? async (params) => {
						await messageHub.request('session.archive', {
							sessionId: params.sessionId,
							confirmed: true,
						});
					}
				: undefined,
			onInterruptSession: messageHub
				? async (params) => {
						await messageHub.request('client.interrupt', {
							sessionId: params.sessionId,
						});
					}
				: undefined,
			onListSessions: roomManager
				? async (_params) => {
						const room = roomManager.getRoom(roomId);
						if (!room) return [];
						const workers = workerManager?.getWorkersByRoom(roomId) ?? [];
						const allSessionIds = new Set(room.sessionIds);
						for (const worker of workers) {
							allSessionIds.add(worker.sessionId);
						}
						return Array.from(allSessionIds).map((sessionId) => {
							const worker = workers.find((w) => w.sessionId === sessionId);
							return {
								id: sessionId,
								title: sessionId.slice(0, 8),
								status: 'active',
								sessionType: worker ? 'worker' : undefined,
								currentTaskId: worker?.taskId,
							};
						});
					}
				: undefined,
		});
		roomMcpServerRegistry.set(roomId, server);
	}
	return server;
}

/**
 * Delete the MCP server for a room (when room is deleted)
 *
 * @public Exported for use by room-self-handlers.ts
 */
export function deleteRoomMcpServer(roomId: string): void {
	const server = roomMcpServerRegistry.get(roomId);
	if (server) {
		roomMcpServerRegistry.delete(roomId);
	}
}

export function setupRoomHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	workerManager: WorkerManager,
	roomSelfManager?: RoomSelfManager,
	workspaceRoot?: string,
	sessionManager?: SessionManager,
	db?: Database
): void {
	// room.create - Create a new room
	messageHub.onRequest('room.create', async (data) => {
		const params = data as {
			name: string;
			background?: string;
			allowedPaths?: WorkspacePath[];
			defaultPath?: string;
		};

		if (!params.name) {
			throw new Error('Room name is required');
		}

		// Auto-populate workspace paths from workspaceRoot if not provided
		const allowedPaths = params.allowedPaths ?? (workspaceRoot ? [{ path: workspaceRoot }] : []);
		const defaultPath = params.defaultPath ?? (workspaceRoot ? workspaceRoot : undefined);

		const room = roomManager.createRoom({
			name: params.name,
			background: params.background,
			allowedPaths,
			defaultPath,
		});

		// Create the room's user-facing chat session
		// Session ID format: room:chat:${roomId}
		// This is the interactive interface where users chat with the room
		if (sessionManager) {
			const roomChatSessionId = `room:chat:${room.id}`;
			try {
				// Create the MCP server for this room with WorkerManager support (PHASE 5)
				// This is shared by room chat and room self sessions
				if (db) {
					createOrUpdateRoomMcpServer(
						room.id,
						db,
						workerManager,
						daemonHub,
						messageHub,
						roomManager
					);
				}

				await sessionManager.createSession({
					sessionId: roomChatSessionId,
					title: room.name,
					workspacePath: defaultPath ?? allowedPaths[0]?.path,
					config: {
						model: room.defaultModel,
						// Inject the room-agent-tools MCP server marker
						mcpServers: {
							'room-agent-tools': {
								type: '__IN_PROCESS_ROOM_AGENT_TOOLS__',
								roomId: room.id,
							} as unknown as McpServerConfig,
						},
					},
					sessionType: 'room_chat',
					roomId: room.id,
				});

				// Explicitly assign the room chat session to the room
				// This ensures room.sessionIds includes the chat session
				roomManager.assignSession(room.id, roomChatSessionId);
			} catch (error) {
				log.warn(`Failed to create room chat session for room ${room.id}:`, error);
			}
		}

		// Broadcast room creation event
		daemonHub
			.emit('room.created', {
				sessionId: 'global',
				roomId: room.id,
				room,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.created for room ${room.id}:`, error);
			});

		return { room };
	});

	// room.list - List all rooms
	messageHub.onRequest('room.list', async (data) => {
		const params = data as { includeArchived?: boolean };
		const rooms = roomManager.listRooms(params.includeArchived ?? false);
		return { rooms };
	});

	// room.get - Get room overview with related data
	messageHub.onRequest('room.get', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const overview = roomManager.getRoomOverview(params.roomId);
		if (!overview) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return overview; // Returns RoomOverview directly (not wrapped in { room })
	});

	// room.update - Update a room
	messageHub.onRequest('room.update', async (data) => {
		const params = data as {
			roomId: string;
			name?: string;
			allowedPaths?: WorkspacePath[];
			defaultPath?: string;
			defaultModel?: string;
			allowedModels?: string[];
			background?: string;
			instructions?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.updateRoom(params.roomId, {
			name: params.name,
			allowedPaths: params.allowedPaths,
			defaultPath: params.defaultPath,
			defaultModel: params.defaultModel,
			allowedModels: params.allowedModels,
			background: params.background,
			instructions: params.instructions,
		});

		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Broadcast room update event
		daemonHub
			.emit('room.updated', {
				sessionId: 'global',
				roomId: room.id,
				room,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.updated for room ${room.id}:`, error);
			});

		return { room };
	});

	// room.archive - Archive a room
	messageHub.onRequest('room.archive', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.archiveRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Broadcast room archive event
		daemonHub
			.emit('room.archived', {
				sessionId: 'global',
				roomId: room.id,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.archived for room ${room.id}:`, error);
			});

		return { room };
	});

	// room.delete - Permanently delete a room
	messageHub.onRequest('room.delete', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Stop and remove the room agent before deleting
		if (roomSelfManager) {
			await roomSelfManager.stopAgent(params.roomId).catch((error) => {
				log.error(`Failed to stop room agent for room ${params.roomId}:`, error);
			});
			roomSelfManager.removeAgent(params.roomId);
		}

		// Terminate all active workers for this room before deleting
		await workerManager.terminateWorkersForRoom(params.roomId).catch((error) => {
			// Log but continue - we still want to delete the room
			log.error(`Error terminating workers for room ${params.roomId}:`, error);
		});

		// Delete the MCP server for this room
		deleteRoomMcpServer(params.roomId);

		// Broadcast room deletion event before deleting
		await daemonHub
			.emit('room.deleted', {
				sessionId: 'global',
				roomId: room.id,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.deleted for room ${room.id}:`, error);
			});

		// Permanently delete the room (CASCADE will delete related data)
		const deleted = roomManager.deleteRoom(params.roomId);
		if (!deleted) {
			throw new Error(`Failed to delete room: ${params.roomId}`);
		}

		return { success: true };
	});

	// room.updateContext - Update room background and instructions
	messageHub.onRequest('room.updateContext', async (data) => {
		const params = data as {
			roomId: string;
			background?: string;
			instructions?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const room = roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error('Room not found');
		}

		const updated = roomManager.updateRoom(params.roomId, {
			background: params.background,
			instructions: params.instructions,
		});

		// Emit event for room agents to react
		await daemonHub.emit('room.contextUpdated', {
			sessionId: `room:${params.roomId}`,
			roomId: params.roomId,
			changes: {
				background: params.background,
				instructions: params.instructions,
			},
		});

		return { room: updated };
	});

	// room.getContextVersions - List version history for room context
	messageHub.onRequest('room.getContextVersions', async (data) => {
		const params = data as {
			roomId: string;
			limit?: number;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const versions = roomManager.getContextVersions(params.roomId, params.limit);
		return { versions };
	});

	// room.getContextVersion - Get a specific context version
	messageHub.onRequest('room.getContextVersion', async (data) => {
		const params = data as {
			roomId: string;
			version: number;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (params.version === undefined || params.version === null) {
			throw new Error('Version number is required');
		}

		const versionRecord = roomManager.getContextVersion(params.roomId, params.version);
		if (!versionRecord) {
			throw new Error(`Version ${params.version} not found for room ${params.roomId}`);
		}

		return { version: versionRecord };
	});

	// room.rollbackContext - Rollback room context to a previous version
	messageHub.onRequest('room.rollbackContext', async (data) => {
		const params = data as {
			roomId: string;
			version: number;
			changedBy?: 'human' | 'agent';
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (params.version === undefined || params.version === null) {
			throw new Error('Version number is required');
		}

		const room = roomManager.rollbackContext(
			params.roomId,
			params.version,
			params.changedBy ?? 'human'
		);

		if (!room) {
			throw new Error(`Failed to rollback room ${params.roomId} to version ${params.version}`);
		}

		// Emit event for room agents to react
		await daemonHub.emit('room.contextRolledBack', {
			sessionId: `room:${params.roomId}`,
			roomId: params.roomId,
			rolledBackToVersion: params.version,
			newVersion: room.contextVersion ?? 0,
		});

		return { room };
	});

	// room.overview - Get room overview with related data
	messageHub.onRequest('room.overview', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const overview = roomManager.getRoomOverview(params.roomId);
		if (!overview) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { overview };
	});

	// room.status - Get status for a specific room
	messageHub.onRequest('room.status', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const status = roomManager.getRoomStatus(params.roomId);
		if (!status) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { status };
	});

	// neo.status - Get global status (all rooms, sessions, pairs)
	messageHub.onRequest('neo.status', async () => {
		return roomManager.getGlobalStatus();
	});

	// room.assignSession - Assign a session to a room
	messageHub.onRequest('room.assignSession', async (data) => {
		const params = data as { roomId: string; sessionId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.sessionId) {
			throw new Error('Session ID is required');
		}

		const room = roomManager.assignSession(params.roomId, params.sessionId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// room.unassignSession - Unassign a session from a room
	messageHub.onRequest('room.unassignSession', async (data) => {
		const params = data as { roomId: string; sessionId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.sessionId) {
			throw new Error('Session ID is required');
		}

		const room = roomManager.unassignSession(params.roomId, params.sessionId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// room.addPath - Add an allowed path to a room
	messageHub.onRequest('room.addPath', async (data) => {
		const params = data as { roomId: string; path: string; description?: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.path) {
			throw new Error('Path is required');
		}

		const room = roomManager.addAllowedPath(params.roomId, params.path, params.description);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// room.removePath - Remove an allowed path from a room
	messageHub.onRequest('room.removePath', async (data) => {
		const params = data as { roomId: string; path: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.path) {
			throw new Error('Path is required');
		}

		const room = roomManager.removeAllowedPath(params.roomId, params.path);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		return { room };
	});

	// PHASE 4: Removed deprecated manager-worker pair RPC handlers:
	// - room.createPair (replaced by WorkerManager.spawnWorker via room agent tools)
	// - room.getPairs (use worker_sessions table via WorkerManager)
	// - room.getPair (use WorkerManager.getWorkerByTask or getWorkerBySessionId)
	// - room.archivePair (use session.archive RPC for worker sessions)

	// REHYDRATION: Create MCP servers for all existing rooms on daemon restart
	// This ensures room:chat sessions can use room-agent-tools after restart
	if (db) {
		const rooms = roomManager.listRooms();
		for (const room of rooms) {
			// Only create if not already in registry (idempotent)
			if (!roomMcpServerRegistry.has(room.id)) {
				createOrUpdateRoomMcpServer(room.id, db, workerManager, daemonHub, messageHub, roomManager);
			}
		}
	}
}
