/**
 * Neo Query Tools - MCP tools for querying system state
 *
 * Read-only tools that give Neo full visibility into the NeoKai system:
 * - list_rooms
 * - get_room_status
 * - get_room_details
 * - get_system_info
 * - get_app_settings
 *
 * Pattern: two-layer design (testable handlers + MCP server wrapper)
 *   createNeoQueryToolHandlers(config) → plain handler functions
 *   createNeoQueryMcpServer(config)    → MCP server wrapping those handlers
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { GlobalSettings, AuthStatus, Room, RoomGoal } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Minimal interfaces — only the surface used by these tools
// ---------------------------------------------------------------------------

export interface NeoQueryRoomManager {
	listRooms(includeArchived?: boolean): Room[];
	getRoom(id: string): Room | null;
	getRoomOverview(roomId: string): {
		room: Room;
		sessions: { id: string; title: string; status: string; lastActiveAt: number }[];
		activeTasks: unknown[];
		allTasks?: unknown[];
	} | null;
}

export interface NeoQueryGoalRepository {
	/** List goals for a specific room, optionally filtered by status */
	listGoals(roomId: string, status?: string): RoomGoal[];
}

export interface NeoQuerySessionManager {
	getActiveSessions(): number;
	listSessions(opts?: {
		includeArchived?: boolean;
		status?: string;
	}): { id: string; status: string }[];
}

export interface NeoQuerySettingsManager {
	getGlobalSettings(): GlobalSettings;
}

export interface NeoQueryAuthManager {
	getAuthStatus(): Promise<AuthStatus>;
}

/**
 * All dependencies required by the Neo query tools.
 */
export interface NeoToolsConfig {
	roomManager: NeoQueryRoomManager;
	goalRepository: NeoQueryGoalRepository;
	sessionManager: NeoQuerySessionManager;
	settingsManager: NeoQuerySettingsManager;
	authManager: NeoQueryAuthManager;
	/** Absolute path to the workspace root */
	workspaceRoot: string;
	/** Human-readable app version string, e.g. "0.1.1" */
	appVersion: string;
	/** Unix timestamp (ms) when the daemon process started */
	startedAt: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

function jsonResult(data: Record<string, unknown> | unknown[]): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): ToolResult {
	return jsonResult({ success: false, error: message });
}

// ---------------------------------------------------------------------------
// Handler functions (testable without MCP plumbing)
// ---------------------------------------------------------------------------

/**
 * Create pure handler functions for Neo query tools.
 * Each handler accepts typed args and returns a ToolResult.
 * No MCP wiring — suitable for direct unit testing.
 */
export function createNeoQueryToolHandlers(config: NeoToolsConfig) {
	const {
		roomManager,
		goalRepository,
		sessionManager,
		settingsManager,
		authManager,
		workspaceRoot,
		appVersion,
		startedAt,
	} = config;

	return {
		/**
		 * List all active rooms with summary information.
		 */
		async list_rooms(args: { include_archived?: boolean }): Promise<ToolResult> {
			const includeArchived = args.include_archived ?? false;
			const rooms = roomManager.listRooms(includeArchived);

			const result = rooms.map((room) => {
				const goals = goalRepository.listGoals(room.id);
				return {
					id: room.id,
					name: room.name,
					status: room.status,
					sessionCount: room.sessionIds.filter(
						(id) =>
							!id.startsWith('room:chat:') &&
							!id.startsWith('room:self:') &&
							!id.startsWith('room:craft:') &&
							!id.startsWith('room:lead:')
					).length,
					goalCount: goals.length,
					activeGoalCount: goals.filter((g) => g.status === 'active' || g.status === 'needs_human')
						.length,
					defaultModel: room.defaultModel ?? null,
					createdAt: room.createdAt,
					updatedAt: room.updatedAt,
				};
			});

			return jsonResult(result);
		},

		/**
		 * Get a room's current operational status.
		 */
		async get_room_status(args: { room_id: string }): Promise<ToolResult> {
			const room = roomManager.getRoom(args.room_id);
			if (!room) {
				return errorResult(`Room not found: ${args.room_id}`);
			}

			const goals = goalRepository.listGoals(room.id);
			const activeGoals = goals.filter((g) => g.status === 'active' || g.status === 'needs_human');

			// Worker sessions (exclude internal room:* management sessions)
			const workerSessionIds = room.sessionIds.filter(
				(id) =>
					!id.startsWith('room:chat:') &&
					!id.startsWith('room:self:') &&
					!id.startsWith('room:craft:') &&
					!id.startsWith('room:lead:')
			);

			const activeSessions = sessionManager
				.listSessions({ status: 'active' })
				.filter((s) => workerSessionIds.includes(s.id));

			return jsonResult({
				id: room.id,
				name: room.name,
				status: room.status,
				defaultModel: room.defaultModel ?? null,
				sessionCount: workerSessionIds.length,
				activeSessionCount: activeSessions.length,
				goalCount: goals.length,
				activeGoalCount: activeGoals.length,
				updatedAt: room.updatedAt,
			});
		},

		/**
		 * Get full room details including goals summary and tasks summary.
		 */
		async get_room_details(args: { room_id: string }): Promise<ToolResult> {
			const overview = roomManager.getRoomOverview(args.room_id);
			if (!overview) {
				return errorResult(`Room not found: ${args.room_id}`);
			}

			const { room, sessions, activeTasks, allTasks } = overview;
			const goals = goalRepository.listGoals(room.id);

			const goalsSummary = goals.map((g) => ({
				id: g.id,
				shortId: g.shortId ?? null,
				title: g.title,
				status: g.status,
				priority: g.priority,
				progress: g.progress,
				missionType: g.missionType ?? 'one_shot',
				linkedTaskCount: g.linkedTaskIds.length,
			}));

			return jsonResult({
				id: room.id,
				name: room.name,
				status: room.status,
				defaultModel: room.defaultModel ?? null,
				allowedModels: room.allowedModels ?? [],
				instructions: room.instructions ?? null,
				background: room.background ?? null,
				sessions,
				goals: goalsSummary,
				activeTasks,
				allTaskCount: allTasks?.length ?? activeTasks.length,
				createdAt: room.createdAt,
				updatedAt: room.updatedAt,
			});
		},

		/**
		 * Get system-wide information about the NeoKai instance.
		 */
		async get_system_info(): Promise<ToolResult> {
			const authStatus = await authManager.getAuthStatus();
			const uptimeMs = Date.now() - startedAt;
			const uptimeSec = Math.floor(uptimeMs / 1000);

			const rooms = roomManager.listRooms(false);
			const activeSessions = sessionManager.getActiveSessions();

			return jsonResult({
				appVersion,
				workspaceRoot,
				uptimeSeconds: uptimeSec,
				startedAt,
				auth: {
					isAuthenticated: authStatus.isAuthenticated,
					method: authStatus.method,
				},
				roomCount: rooms.length,
				activeSessionCount: activeSessions,
			});
		},

		/**
		 * Get the current global application settings.
		 */
		async get_app_settings(): Promise<ToolResult> {
			const settings = settingsManager.getGlobalSettings();

			// Return a safe subset — exclude raw mcpServerSettings (potentially large/noisy)
			return jsonResult({
				model: settings.model ?? null,
				permissionMode: settings.permissionMode ?? null,
				thinkingLevel: settings.thinkingLevel ?? null,
				autoScroll: settings.autoScroll ?? true,
				coordinatorMode: settings.coordinatorMode ?? false,
				maxConcurrentWorkers: settings.maxConcurrentWorkers ?? 3,
				neoSecurityMode: settings.neoSecurityMode ?? 'balanced',
				neoModel: settings.neoModel ?? null,
				settingSources: settings.settingSources,
				showArchived: settings.showArchived ?? false,
				fallbackModels: settings.fallbackModels ?? [],
				disabledMcpServers: settings.disabledMcpServers ?? [],
			});
		},
	};
}

// ---------------------------------------------------------------------------
// MCP server wrapper
// ---------------------------------------------------------------------------

/**
 * Create the MCP server that exposes all Neo query tools.
 * The server wraps the handlers returned by createNeoQueryToolHandlers.
 */
export function createNeoQueryMcpServer(config: NeoToolsConfig) {
	const handlers = createNeoQueryToolHandlers(config);

	const tools = [
		tool(
			'list_rooms',
			'List all rooms in the NeoKai system with summary info (id, name, status, session count, goal count).',
			{
				include_archived: z
					.boolean()
					.optional()
					.default(false)
					.describe('Include archived rooms in the results (default: false)'),
			},
			(args) => handlers.list_rooms(args)
		),

		tool(
			'get_room_status',
			'Get the current operational status of a specific room, including active sessions, goal count, and current model.',
			{
				room_id: z.string().describe('ID of the room to query'),
			},
			(args) => handlers.get_room_status(args)
		),

		tool(
			'get_room_details',
			'Get full details for a room including goals summary, active tasks summary, and session list.',
			{
				room_id: z.string().describe('ID of the room to query'),
			},
			(args) => handlers.get_room_details(args)
		),

		tool(
			'get_system_info',
			'Get system-wide information about the NeoKai instance: app version, uptime, auth status, workspace root, and active session count.',
			{},
			() => handlers.get_system_info()
		),

		tool(
			'get_app_settings',
			'Get the current global application settings including model, permission mode, Neo security mode, and other preferences.',
			{},
			() => handlers.get_app_settings()
		),
	];

	return createSdkMcpServer({ name: 'neo-query', tools });
}
