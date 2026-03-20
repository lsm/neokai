/**
 * Room RPC Handlers
 *
 * RPC handlers for room operations:
 * - room.create - Create a room
 * - room.list - List all rooms
 * - room.get - Get room details
 * - room.update - Update room
 * - room.archive - Archive room
 * - room.delete - Delete room
 * - room.overview - Get room overview with related data
 * - neo.status - Get global status (all rooms, sessions)
 * - agents.cli.list - List detected CLI agents
 */

import type { MessageHub, WorkspacePath, Provider } from '@neokai/shared';

/**
 * Infer the provider for a given model ID based on known naming conventions.
 * This avoids loading the full provider registry (which requires optional SDK deps).
 */
function inferProviderForModel(modelId: string): Provider {
	if (modelId.startsWith('glm-') || modelId === 'glm') return 'glm';
	if (modelId.startsWith('minimax-') || modelId === 'minimax') return 'minimax';
	return 'anthropic';
}
import type { DaemonHub } from '../daemon-hub';
import type { RoomManager } from '../room/managers/room-manager';
import type { RoomRuntimeService } from '../room/runtime/room-runtime-service';
import type { SessionManager } from '../session-manager';
import { getCliAgents, refresh as refreshCliAgents } from '../room/agents/cli-agent-registry';
import { Logger } from '../logger';

const log = new Logger('room-handlers');

export function setupRoomHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	workspaceRoot?: string,
	sessionManager?: SessionManager
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
		if (sessionManager) {
			const roomChatSessionId = `room:chat:${room.id}`;
			try {
				await sessionManager.createSession({
					sessionId: roomChatSessionId,
					title: room.name,
					workspacePath: defaultPath ?? allowedPaths[0]?.path,
					config: {
						model: room.defaultModel,
					},
					sessionType: 'room_chat',
					roomId: room.id,
				});

				// Explicitly assign the room chat session to the room
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
			config?: Record<string, unknown>;
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
			config: params.config,
		});

		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// When defaultModel changes, sync the room chat session's model so it uses
		// the new model on the next query. This prevents stale sessions from running
		// with a model that is no longer configured (e.g., after switching from GLM to Anthropic).
		if (params.defaultModel && sessionManager) {
			const roomChatSessionId = `room:chat:${room.id}`;
			try {
				const existingSession = sessionManager.getSessionFromDB(roomChatSessionId);
				if (existingSession) {
					const newProvider = inferProviderForModel(params.defaultModel);
					await sessionManager.updateSession(roomChatSessionId, {
						config: {
							...existingSession.config,
							model: params.defaultModel,
							provider: newProvider,
						},
					});
				}
			} catch (err) {
				log.warn(`Could not sync room chat session model for room ${room.id}:`, err);
			}
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

	// neo.status - Get global status (all rooms, sessions)
	messageHub.onRequest('neo.status', async () => {
		return roomManager.getGlobalStatus();
	});

	// agents.cli.list - List detected CLI agents with install/auth status
	messageHub.onRequest('agents.cli.list', async (data) => {
		const params = data as { refresh?: boolean } | undefined;
		if (params?.refresh) {
			refreshCliAgents();
		}
		return { agents: getCliAgents() };
	});
}

export function setupRoomRuntimeHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	roomRuntimeService: RoomRuntimeService
): void {
	// room.runtime.state - Get runtime state for a room
	messageHub.onRequest('room.runtime.state', async (data) => {
		const params = data as { roomId: string };
		if (!params.roomId) throw new Error('Room ID is required');
		const state = roomRuntimeService.getRuntimeState(params.roomId);
		return { state: state ?? 'stopped' };
	});

	// room.runtime.models - Get resolved leader/worker models for a room
	messageHub.onRequest('room.runtime.models', async (data) => {
		const params = data as { roomId: string };
		if (!params.roomId) throw new Error('Room ID is required');
		const leaderModel = roomRuntimeService.getLeaderModel(params.roomId);
		const workerModel = roomRuntimeService.getWorkerModel(params.roomId);
		return { leaderModel, workerModel };
	});

	// room.runtime.pause - Pause runtime
	messageHub.onRequest('room.runtime.pause', async (data) => {
		const params = data as { roomId: string };
		if (!params.roomId) throw new Error('Room ID is required');
		const success = roomRuntimeService.pauseRuntime(params.roomId);
		if (!success) throw new Error(`No runtime for room: ${params.roomId}`);
		daemonHub
			.emit('room.runtime.stateChanged', {
				sessionId: `room:${params.roomId}`,
				roomId: params.roomId,
				state: 'paused',
			})
			.catch(() => {});
		return { success: true, state: 'paused' };
	});

	// room.runtime.resume - Resume runtime
	messageHub.onRequest('room.runtime.resume', async (data) => {
		const params = data as { roomId: string };
		if (!params.roomId) throw new Error('Room ID is required');
		const success = roomRuntimeService.resumeRuntime(params.roomId);
		if (!success) throw new Error(`No runtime for room: ${params.roomId}`);
		daemonHub
			.emit('room.runtime.stateChanged', {
				sessionId: `room:${params.roomId}`,
				roomId: params.roomId,
				state: 'running',
			})
			.catch(() => {});
		return { success: true, state: 'running' };
	});

	// room.runtime.stop - Stop runtime
	messageHub.onRequest('room.runtime.stop', async (data) => {
		const params = data as { roomId: string };
		if (!params.roomId) throw new Error('Room ID is required');
		const success = roomRuntimeService.stopRuntime(params.roomId);
		if (!success) throw new Error(`No runtime for room: ${params.roomId}`);
		daemonHub
			.emit('room.runtime.stateChanged', {
				sessionId: `room:${params.roomId}`,
				roomId: params.roomId,
				state: 'stopped',
			})
			.catch(() => {});
		return { success: true, state: 'stopped' };
	});

	// room.runtime.start - Start (or restart) runtime
	messageHub.onRequest('room.runtime.start', async (data) => {
		const params = data as { roomId: string };
		if (!params.roomId) throw new Error('Room ID is required');
		const success = roomRuntimeService.startRuntime(params.roomId);
		if (!success) throw new Error(`Room not found: ${params.roomId}`);
		daemonHub
			.emit('room.runtime.stateChanged', {
				sessionId: `room:${params.roomId}`,
				roomId: params.roomId,
				state: 'running',
			})
			.catch(() => {});
		return { success: true, state: 'running' };
	});
}
