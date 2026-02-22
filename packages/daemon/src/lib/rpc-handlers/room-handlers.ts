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
 * - room.createPair - Create a manager+worker session pair
 * - room.getPairs - List pairs for a room
 * - room.getPair - Get single pair details
 * - room.archivePair - Archive a pair
 * - neo.status - Get global status (all rooms, sessions, pairs)
 *
 * Renamed from neo.room.* to room.* for cleaner API.
 */

import type { MessageHub, WorkspacePath, McpServerConfig } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { RoomManager } from '../room/room-manager';
import type { SessionPairManager } from '../room/session-pair-manager';
import type { SessionBridge } from '../room/session-bridge';
import type { RoomSelfManager } from './room-self-handlers';
import type { SessionManager } from '../session-manager';
import { createRoomAgentMcpServer } from '../agent/room-agent-tools';
import type { Database } from '../../storage/index';

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
				const goal = goalRepo.getGoal(params.goalId);
				if (goal) {
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
				return { pairId: '', workerSessionId: '', managerSessionId: '' };
			},
			onRequestReview: async (_taskId, _reason) => {
				// This is handled by the room self session
			},
			onEscalate: async (_taskId, _reason) => {
				// This is handled by the room self session
			},
			onUpdateGoalProgress: async (params) => {
				const goal = goalRepo.getGoal(params.goalId);
				if (goal) {
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
 */
export function getRoomMcpServer(
	roomId: string
): ReturnType<typeof createRoomAgentMcpServer> | undefined {
	return roomMcpServerRegistry.get(roomId);
}

/**
 * Delete the MCP server for a room (when room is deleted)
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
	sessionPairManager?: SessionPairManager,
	sessionBridge?: SessionBridge,
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
				// Create the MCP server for this room (shared by room chat and room self)
				if (db) {
					getOrCreateRoomMcpServer(room.id, db);
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
			} catch {
				// Error creating room chat session - non-critical, continue without failing room creation
			}
		}

		// Broadcast room creation event
		daemonHub
			.emit('room.created', {
				sessionId: 'global',
				roomId: room.id,
				room,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
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
			.catch(() => {
				// Event emission error - non-critical, continue
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
			.catch(() => {
				// Event emission error - non-critical, continue
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
			await roomSelfManager.stopAgent(params.roomId).catch(() => {});
			roomSelfManager.removeAgent(params.roomId);
		}

		// Delete the MCP server for this room
		deleteRoomMcpServer(params.roomId);

		// Broadcast room deletion event before deleting
		await daemonHub
			.emit('room.deleted', {
				sessionId: 'global',
				roomId: room.id,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		// Permanently delete the room (CASCADE will delete related data)
		roomManager.deleteRoom(params.roomId);

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

	// room.createPair - Create a new manager+worker session pair
	// TODO: Requires sessionPairManager to be wired up in app.ts and passed here
	messageHub.onRequest('room.createPair', async (data) => {
		if (!sessionPairManager) {
			throw new Error('Session pair functionality not yet available');
		}

		const params = data as {
			roomId: string;
			roomSessionId: string;
			taskTitle: string;
			taskDescription?: string;
			workspacePath?: string;
			model?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.roomSessionId) {
			throw new Error('Room session ID is required');
		}
		if (!params.taskTitle) {
			throw new Error('Task title is required');
		}

		const result = await sessionPairManager.createPair(params);

		// Start the bridge to connect Worker and Manager sessions
		if (sessionBridge) {
			await sessionBridge.startBridge(result.pair.id);
		}

		return result;
	});

	// room.getPairs - List pairs for a room
	// TODO: Requires sessionPairManager to be wired up in app.ts and passed here
	messageHub.onRequest('room.getPairs', async (data) => {
		if (!sessionPairManager) {
			throw new Error('Session pair functionality not yet available');
		}

		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		return { pairs: sessionPairManager.getPairsByRoom(params.roomId) };
	});

	// room.getPair - Get single pair details
	// TODO: Requires sessionPairManager to be wired up in app.ts and passed here
	messageHub.onRequest('room.getPair', async (data) => {
		if (!sessionPairManager) {
			throw new Error('Session pair functionality not yet available');
		}

		const params = data as { pairId: string };

		if (!params.pairId) {
			throw new Error('Pair ID is required');
		}

		const pair = sessionPairManager.getPair(params.pairId);
		if (!pair) {
			throw new Error(`Session pair not found: ${params.pairId}`);
		}

		return { pair };
	});

	// room.archivePair - Archive a pair
	// TODO: Requires sessionPairManager to be wired up in app.ts and passed here
	messageHub.onRequest('room.archivePair', async (data) => {
		if (!sessionPairManager) {
			throw new Error('Session pair functionality not yet available');
		}

		const params = data as { pairId: string };

		if (!params.pairId) {
			throw new Error('Pair ID is required');
		}

		// Stop the bridge before archiving
		if (sessionBridge) {
			sessionBridge.stopBridge(params.pairId);
		}

		const success = await sessionPairManager.archivePair(params.pairId);
		if (!success) {
			throw new Error(`Session pair not found: ${params.pairId}`);
		}

		return { success };
	});
}
