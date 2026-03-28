/**
 * Neo Query Tools - MCP tools for querying system state
 *
 * Read-only tools that give Neo full visibility into the NeoKai system:
 * - list_rooms
 * - get_room_status
 * - get_room_details
 * - get_system_info
 * - get_app_settings
 * - list_mcp_servers
 * - get_mcp_server_status
 * - list_skills
 * - get_skill_details
 *
 * Pattern: two-layer design (testable handlers + MCP server wrapper)
 *   createNeoQueryToolHandlers(config) → plain handler functions
 *   createNeoQueryMcpServer(config)    → MCP server wrapping those handlers
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
	GlobalSettings,
	AuthStatus,
	Room,
	RoomGoal,
	TaskSummary,
	AppMcpServer,
	AppSkill,
} from '@neokai/shared';
import { isWorkerSessionId } from '../../room/session-utils';

// ---------------------------------------------------------------------------
// Minimal interfaces — only the surface used by these tools
// ---------------------------------------------------------------------------

export interface NeoQueryRoomManager {
	listRooms(includeArchived?: boolean): Room[];
	getRoom(id: string): Room | null;
	getRoomOverview(roomId: string): {
		room: Room;
		sessions: { id: string; title: string; status: string; lastActiveAt: number }[];
		activeTasks: TaskSummary[];
		allTasks?: TaskSummary[];
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

export interface NeoQueryMcpServerRepository {
	list(): AppMcpServer[];
	get(id: string): AppMcpServer | null;
}

export interface NeoQuerySkillsManager {
	listSkills(): AppSkill[];
	getSkill(id: string): AppSkill | null;
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
	mcpServerRepository: NeoQueryMcpServerRepository;
	skillsManager: NeoQuerySkillsManager;
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
		mcpServerRepository,
		skillsManager,
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
					sessionCount: room.sessionIds.filter(isWorkerSessionId).length,
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
			const workerSessionIds = room.sessionIds.filter(isWorkerSessionId);

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

		/**
		 * List all registered MCP servers with their enabled/disabled status.
		 */
		async list_mcp_servers(): Promise<ToolResult> {
			const servers = mcpServerRepository.list();

			const result = servers.map((s) => ({
				id: s.id,
				name: s.name,
				description: s.description ?? null,
				sourceType: s.sourceType,
				enabled: s.enabled,
				createdAt: s.createdAt ?? null,
				updatedAt: s.updatedAt ?? null,
			}));

			return jsonResult(result);
		},

		/**
		 * Get details for a specific MCP server by ID.
		 */
		async get_mcp_server_status(args: { server_id: string }): Promise<ToolResult> {
			const server = mcpServerRepository.get(args.server_id);
			if (!server) {
				return errorResult(`MCP server not found: ${args.server_id}`);
			}

			// Build transport-specific config (omit sensitive env values)
			const transportConfig: Record<string, unknown> = { sourceType: server.sourceType };
			if (server.sourceType === 'stdio') {
				transportConfig['command'] = server.command ?? null;
				transportConfig['args'] = server.args ?? [];
				// Expose env key names only (not values) to avoid leaking secrets
				transportConfig['envKeys'] = server.env ? Object.keys(server.env) : [];
			} else {
				transportConfig['url'] = server.url ?? null;
				// Expose header key names only (not values) to avoid leaking secrets
				transportConfig['headerKeys'] = server.headers ? Object.keys(server.headers) : [];
			}

			return jsonResult({
				id: server.id,
				name: server.name,
				description: server.description ?? null,
				enabled: server.enabled,
				transport: transportConfig,
				createdAt: server.createdAt ?? null,
				updatedAt: server.updatedAt ?? null,
			});
		},

		/**
		 * List all skills with type and enabled status.
		 */
		async list_skills(): Promise<ToolResult> {
			const skills = skillsManager.listSkills();

			const result = skills.map((s) => ({
				id: s.id,
				name: s.name,
				displayName: s.displayName,
				description: s.description,
				sourceType: s.sourceType,
				enabled: s.enabled,
				builtIn: s.builtIn,
				validationStatus: s.validationStatus,
			}));

			return jsonResult(result);
		},

		/**
		 * Get full details for a specific skill by ID including validation status.
		 */
		async get_skill_details(args: { skill_id: string }): Promise<ToolResult> {
			const skill = skillsManager.getSkill(args.skill_id);
			if (!skill) {
				return errorResult(`Skill not found: ${args.skill_id}`);
			}

			return jsonResult({
				id: skill.id,
				name: skill.name,
				displayName: skill.displayName,
				description: skill.description,
				sourceType: skill.sourceType,
				config: skill.config,
				enabled: skill.enabled,
				builtIn: skill.builtIn,
				validationStatus: skill.validationStatus,
				createdAt: skill.createdAt,
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

		tool(
			'list_mcp_servers',
			'List all registered application-level MCP servers with their enabled/disabled status, source type, and description.',
			{},
			() => handlers.list_mcp_servers()
		),

		tool(
			'get_mcp_server_status',
			'Get details for a specific MCP server by ID: transport type, configuration (command/URL, env key names), and enabled status.',
			{
				server_id: z.string().describe('ID of the MCP server to query'),
			},
			(args) => handlers.get_mcp_server_status(args)
		),

		tool(
			'list_skills',
			'List all application-level skills with their source type (builtin/plugin/mcp_server), enabled status, and validation status.',
			{},
			() => handlers.list_skills()
		),

		tool(
			'get_skill_details',
			'Get full details for a specific skill by ID including its config, validation status, and whether it is built-in.',
			{
				skill_id: z.string().describe('ID of the skill to query'),
			},
			(args) => handlers.get_skill_details(args)
		),
	];

	return createSdkMcpServer({ name: 'neo-query', tools });
}
