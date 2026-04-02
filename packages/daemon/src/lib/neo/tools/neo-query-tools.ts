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
 * - list_spaces
 * - get_space_status
 * - get_space_details
 * - list_space_agents
 * - list_space_workflows
 * - list_space_runs
 * - list_goals
 * - get_goal_details
 * - get_metrics
 * - list_tasks
 * - get_task_detail
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
	Space,
	SpaceAgent,
	SpaceWorkflow,
	SpaceWorkflowRun,
	SpaceTask,
	NeoTask,
	MissionExecution,
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
	/** Get a single goal by ID */
	getGoal(id: string): RoomGoal | null;
	/** List execution history for a goal (most recent first) */
	listExecutions(goalId: string, limit?: number): MissionExecution[];
}

export interface NeoQueryTaskRepository {
	/**
	 * List tasks for a specific room, optionally filtered by status and archived state.
	 * Note: assignedAgent filtering is NOT in the real TaskFilter; it is applied in-memory
	 * by the tool handler after calling this method.
	 */
	listTasks(roomId: string, filter?: { status?: string; includeArchived?: boolean }): NeoTask[];
	/** Get a single task by ID */
	getTask(id: string): NeoTask | null;
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

// ---------------------------------------------------------------------------
// Space-related interfaces (delegating to SpaceManager / SpaceAgentManager /
// SpaceWorkflowManager and the workflow-run / task repositories)
// ---------------------------------------------------------------------------

export interface NeoQuerySpaceManager {
	/** Returns all spaces, optionally including archived ones. */
	listSpaces(includeArchived?: boolean): Space[] | Promise<Space[]>;
	/** Returns a single space by ID, or null if not found. */
	getSpace(id: string): Space | null | Promise<Space | null>;
}

export interface NeoQuerySpaceAgentManager {
	listBySpaceId(spaceId: string): SpaceAgent[];
}

export interface NeoQuerySpaceWorkflowManager {
	listWorkflows(spaceId: string): SpaceWorkflow[];
}

export interface NeoQueryWorkflowRunRepository {
	listBySpace(spaceId: string): SpaceWorkflowRun[];
}

export interface NeoQuerySpaceTaskRepository {
	listBySpace(spaceId: string): SpaceTask[];
	listByStatus(spaceId: string, status: string): SpaceTask[];
}

/**
 * All dependencies required by the Neo query tools.
 */
export interface NeoToolsConfig {
	roomManager: NeoQueryRoomManager;
	goalRepository: NeoQueryGoalRepository;
	taskRepository: NeoQueryTaskRepository;
	sessionManager: NeoQuerySessionManager;
	settingsManager: NeoQuerySettingsManager;
	authManager: NeoQueryAuthManager;
	mcpServerRepository: NeoQueryMcpServerRepository;
	skillsManager: NeoQuerySkillsManager;
	/** Absolute path to the workspace root (optional — daemon can run without a global workspace) */
	workspaceRoot?: string;
	/** Human-readable app version string, e.g. "0.1.1" */
	appVersion: string;
	/** Unix timestamp (ms) when the daemon process started */
	startedAt: number;
	// Space query dependencies (reuse the same manager instances as the Global Spaces Agent)
	spaceManager: NeoQuerySpaceManager;
	spaceAgentManager: NeoQuerySpaceAgentManager;
	spaceWorkflowManager: NeoQuerySpaceWorkflowManager;
	workflowRunRepository: NeoQueryWorkflowRunRepository;
	spaceTaskRepository: NeoQuerySpaceTaskRepository;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolResult {
	[key: string]: unknown;
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
		taskRepository,
		sessionManager,
		settingsManager,
		authManager,
		mcpServerRepository,
		skillsManager,
		workspaceRoot,
		appVersion,
		startedAt,
		spaceManager,
		spaceAgentManager,
		spaceWorkflowManager,
		workflowRunRepository,
		spaceTaskRepository,
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

		// -----------------------------------------------------------------------
		// Space query tools — delegate to the same SpaceManager /
		// SpaceAgentManager / SpaceWorkflowManager used by the Global Spaces Agent
		// -----------------------------------------------------------------------

		/**
		 * List all spaces with summary information (agent count, workflow count).
		 */
		async list_spaces(args: { include_archived?: boolean }): Promise<ToolResult> {
			const includeArchived = args.include_archived ?? false;
			const spaces = await spaceManager.listSpaces(includeArchived);

			const result = spaces.map((space) => {
				const agents = spaceAgentManager.listBySpaceId(space.id);
				const workflows = spaceWorkflowManager.listWorkflows(space.id);
				return {
					id: space.id,
					slug: space.slug,
					name: space.name,
					status: space.status,
					description: space.description,
					agentCount: agents.length,
					workflowCount: workflows.length,
					defaultModel: space.defaultModel ?? null,
					autonomyLevel: space.autonomyLevel ?? null,
					createdAt: space.createdAt,
					updatedAt: space.updatedAt,
				};
			});

			return jsonResult(result);
		},

		/**
		 * Get a space's current operational status including active runs and task counts.
		 * Archived tasks are excluded from counts (matches UI behavior).
		 */
		async get_space_status(args: { space_id: string }): Promise<ToolResult> {
			const space = await spaceManager.getSpace(args.space_id);
			if (!space) {
				return errorResult(`Space not found: ${args.space_id}`);
			}

			const runs = workflowRunRepository.listBySpace(space.id);
			const activeRuns = runs.filter((r) => r.status === 'in_progress' || r.status === 'blocked');

			// listBySpace defaults to includeArchived=false, matching the UI behavior.
			// Archived tasks are intentionally excluded from the counts here.
			const tasks = spaceTaskRepository.listBySpace(space.id);
			const taskCountByStatus: Record<string, number> = {};
			for (const task of tasks) {
				taskCountByStatus[task.status] = (taskCountByStatus[task.status] ?? 0) + 1;
			}

			return jsonResult({
				id: space.id,
				slug: space.slug,
				name: space.name,
				status: space.status,
				autonomyLevel: space.autonomyLevel ?? null,
				defaultModel: space.defaultModel ?? null,
				totalRunCount: runs.length,
				activeRunCount: activeRuns.length,
				totalTaskCount: tasks.length,
				taskCountByStatus,
				updatedAt: space.updatedAt,
			});
		},

		/**
		 * Get full space details including agents, workflows, and recent runs.
		 */
		async get_space_details(args: { space_id: string }): Promise<ToolResult> {
			const space = await spaceManager.getSpace(args.space_id);
			if (!space) {
				return errorResult(`Space not found: ${args.space_id}`);
			}

			const agents = spaceAgentManager.listBySpaceId(space.id);
			const workflows = spaceWorkflowManager.listWorkflows(space.id);
			const runs = workflowRunRepository.listBySpace(space.id);

			// Return the 10 most recent runs
			const recentRuns = runs
				.slice()
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, 10)
				.map((r) => ({
					id: r.id,
					title: r.title,
					status: r.status,
					workflowId: r.workflowId,
					createdAt: r.createdAt,
					completedAt: r.completedAt ?? null,
				}));

			const agentsSummary = agents.map((a) => ({
				id: a.id,
				name: a.name,
				model: a.model ?? null,
			}));

			const workflowsSummary = workflows.map((w) => ({
				id: w.id,
				name: w.name,
				description: w.description ?? null,
				nodeCount: w.nodes?.length ?? 0,
			}));

			return jsonResult({
				id: space.id,
				slug: space.slug,
				name: space.name,
				status: space.status,
				description: space.description,
				backgroundContext: space.backgroundContext,
				instructions: space.instructions,
				defaultModel: space.defaultModel ?? null,
				allowedModels: space.allowedModels ?? [],
				autonomyLevel: space.autonomyLevel ?? null,
				agents: agentsSummary,
				workflows: workflowsSummary,
				recentRuns,
				sessionIds: space.sessionIds,
				createdAt: space.createdAt,
				updatedAt: space.updatedAt,
			});
		},

		/**
		 * List all agents configured in a space.
		 */
		async list_space_agents(args: { space_id: string }): Promise<ToolResult> {
			const space = await spaceManager.getSpace(args.space_id);
			if (!space) {
				return errorResult(`Space not found: ${args.space_id}`);
			}

			const agents = spaceAgentManager.listBySpaceId(space.id);
			return jsonResult(
				agents.map((a) => ({
					id: a.id,
					name: a.name,
					description: a.description ?? null,
					model: a.model ?? null,
					provider: a.provider ?? null,
					createdAt: a.createdAt,
					updatedAt: a.updatedAt,
				}))
			);
		},

		/**
		 * List all workflows defined in a space.
		 */
		async list_space_workflows(args: { space_id: string }): Promise<ToolResult> {
			const space = await spaceManager.getSpace(args.space_id);
			if (!space) {
				return errorResult(`Space not found: ${args.space_id}`);
			}

			const workflows = spaceWorkflowManager.listWorkflows(space.id);
			return jsonResult(
				workflows.map((w) => ({
					id: w.id,
					name: w.name,
					description: w.description ?? null,
					nodeCount: w.nodes?.length ?? 0,
					tags: w.tags ?? [],
					createdAt: w.createdAt,
					updatedAt: w.updatedAt,
				}))
			);
		},

		/**
		 * List workflow runs for a space, with their status.
		 */
		async list_space_runs(args: { space_id: string; status?: string }): Promise<ToolResult> {
			const space = await spaceManager.getSpace(args.space_id);
			if (!space) {
				return errorResult(`Space not found: ${args.space_id}`);
			}

			let runs = workflowRunRepository.listBySpace(space.id);
			if (args.status) {
				runs = runs.filter((r) => r.status === args.status);
			}

			// Sort newest first
			const sorted = runs.slice().sort((a, b) => b.createdAt - a.createdAt);

			return jsonResult(
				sorted.map((r) => ({
					id: r.id,
					title: r.title,
					description: r.description ?? null,
					status: r.status,
					workflowId: r.workflowId,
					createdAt: r.createdAt,
					updatedAt: r.updatedAt,
					completedAt: r.completedAt ?? null,
				}))
			);
		},

		// -----------------------------------------------------------------------
		// Goal and task query tools
		// -----------------------------------------------------------------------

		/**
		 * List goals across all rooms (or a specific room), with optional filters.
		 */
		async list_goals(args: {
			room_id?: string;
			status?: string;
			mission_type?: string;
			search?: string;
			limit?: number;
			offset?: number;
			compact?: boolean;
		}): Promise<ToolResult> {
			// Determine which rooms to query
			const rooms = args.room_id
				? (() => {
						const r = roomManager.getRoom(args.room_id);
						return r ? [r] : null;
					})()
				: roomManager.listRooms(true); // include archived rooms for cross-room visibility

			if (rooms === null) {
				return errorResult(`Room not found: ${args.room_id}`);
			}

			const allGoals: Record<string, unknown>[] = [];
			for (const room of rooms) {
				const goals = goalRepository.listGoals(room.id, args.status as string | undefined);
				for (const g of goals) {
					// Filter by mission_type if provided (repository does not support this natively)
					if (args.mission_type && (g.missionType ?? 'one_shot') !== args.mission_type) {
						continue;
					}
					allGoals.push({
						id: g.id,
						shortId: g.shortId ?? null,
						roomId: g.roomId,
						roomName: room.name,
						title: g.title,
						status: g.status,
						priority: g.priority,
						progress: g.progress,
						missionType: g.missionType ?? 'one_shot',
						autonomyLevel: g.autonomyLevel ?? 'supervised',
						linkedTaskCount: g.linkedTaskIds.length,
						nextRunAt: g.nextRunAt ?? null,
						schedulePaused: g.schedulePaused ?? false,
						createdAt: g.createdAt,
						updatedAt: g.updatedAt,
					});
				}
			}

			// Search filter (applied after cross-room aggregation)
			const filtered = args.search
				? allGoals.filter((g) =>
						(g.title as string).toLowerCase().includes(args.search!.toLowerCase())
					)
				: allGoals;

			const total = filtered.length;
			const limit = args.limit ?? 50;
			const offset = args.offset ?? 0;
			const paged = filtered.slice(offset, offset + limit);

			if (args.compact) {
				const compactGoals = paged.map((g) => ({
					id: g.id,
					roomId: g.roomId,
					title: g.title,
					status: g.status,
					priority: g.priority,
					missionType: g.missionType,
					createdAt: g.createdAt,
				}));
				return jsonResult({ success: true, total, goals: compactGoals });
			}

			return jsonResult({ success: true, total, goals: paged });
		},

		/**
		 * Get full details for a goal including metrics and execution history.
		 */
		async get_goal_details(args: {
			goal_id: string;
			execution_limit?: number;
		}): Promise<ToolResult> {
			const goal = goalRepository.getGoal(args.goal_id);
			if (!goal) {
				return errorResult(`Goal not found: ${args.goal_id}`);
			}

			const room = roomManager.getRoom(goal.roomId);
			const executions = goalRepository.listExecutions(goal.id, args.execution_limit ?? 10);

			return jsonResult({
				id: goal.id,
				shortId: goal.shortId ?? null,
				roomId: goal.roomId,
				roomName: room?.name ?? null,
				title: goal.title,
				description: goal.description,
				status: goal.status,
				priority: goal.priority,
				progress: goal.progress,
				missionType: goal.missionType ?? 'one_shot',
				autonomyLevel: goal.autonomyLevel ?? 'supervised',
				linkedTaskIds: goal.linkedTaskIds,
				metrics: goal.metrics ?? {},
				structuredMetrics: goal.structuredMetrics ?? [],
				schedule: goal.schedule ?? null,
				schedulePaused: goal.schedulePaused ?? false,
				nextRunAt: goal.nextRunAt ?? null,
				consecutiveFailures: goal.consecutiveFailures ?? 0,
				maxConsecutiveFailures: goal.maxConsecutiveFailures ?? 3,
				replanCount: goal.replanCount ?? 0,
				createdAt: goal.createdAt,
				updatedAt: goal.updatedAt,
				completedAt: goal.completedAt ?? null,
				executions: executions.map((e) => ({
					id: e.id,
					executionNumber: e.executionNumber,
					status: e.status,
					startedAt: e.startedAt,
					completedAt: e.completedAt ?? null,
					resultSummary: e.resultSummary ?? null,
					taskCount: e.taskIds.length,
				})),
			});
		},

		/**
		 * Get current metric values for a measurable goal.
		 */
		async get_metrics(args: { goal_id: string }): Promise<ToolResult> {
			const goal = goalRepository.getGoal(args.goal_id);
			if (!goal) {
				return errorResult(`Goal not found: ${args.goal_id}`);
			}

			if ((goal.missionType ?? 'one_shot') !== 'measurable') {
				return errorResult(
					`Goal ${args.goal_id} is not a measurable mission (type: ${goal.missionType ?? 'one_shot'})`
				);
			}

			const structuredMetrics = goal.structuredMetrics ?? [];

			return jsonResult({
				goalId: goal.id,
				goalTitle: goal.title,
				missionType: goal.missionType ?? 'one_shot',
				metrics: structuredMetrics.map((m) => ({
					name: m.name,
					target: m.target,
					current: m.current,
					unit: m.unit ?? null,
					direction: m.direction ?? 'increase',
					baseline: m.baseline ?? null,
					progressPct: (() => {
						if (m.direction === 'decrease' && m.baseline !== undefined) {
							// baseline === target means the goal is already at target; treat as 100%
							if (m.baseline === m.target) return 100;
							return Math.round(((m.baseline - m.current) / (m.baseline - m.target)) * 100);
						}
						// increase direction (default)
						if (m.target !== 0) return Math.round((m.current / m.target) * 100);
						return m.current >= m.target ? 100 : 0;
					})(),
				})),
				legacyMetrics: goal.metrics ?? {},
			});
		},

		/**
		 * List tasks across all rooms (or a specific room), with optional filters.
		 */
		async list_tasks(args: {
			room_id?: string;
			status?: string;
			assigned_agent?: string;
			include_archived?: boolean;
			search?: string;
			limit?: number;
			offset?: number;
			compact?: boolean;
		}): Promise<ToolResult> {
			// Auto-include archived tasks when the caller explicitly requests archived status,
			// otherwise the repository filter would hide them and return zero results.
			const includeArchived = args.include_archived ?? args.status === 'archived';

			// Determine which rooms to query
			const rooms = args.room_id
				? (() => {
						const r = roomManager.getRoom(args.room_id);
						return r ? [r] : null;
					})()
				: roomManager.listRooms(true); // include archived rooms for cross-room visibility

			if (rooms === null) {
				return errorResult(`Room not found: ${args.room_id}`);
			}

			const allTasks: Record<string, unknown>[] = [];
			for (const room of rooms) {
				// Note: assignedAgent is not in real TaskFilter, so we filter in-memory below.
				const filter: { status?: string; includeArchived?: boolean } = { includeArchived };
				if (args.status) filter.status = args.status;

				let tasks = taskRepository.listTasks(room.id, filter);

				// In-memory filter for assignedAgent (not supported at the SQL level in TaskFilter)
				if (args.assigned_agent) {
					tasks = tasks.filter((t) => (t.assignedAgent ?? 'coder') === args.assigned_agent);
				}

				for (const t of tasks) {
					allTasks.push({
						id: t.id,
						shortId: t.shortId ?? null,
						roomId: t.roomId,
						roomName: room.name,
						title: t.title,
						status: t.status,
						priority: t.priority,
						taskType: t.taskType ?? 'coding',
						assignedAgent: t.assignedAgent ?? 'coder',
						progress: t.progress ?? null,
						activeSession: t.activeSession,
						prUrl: t.prUrl ?? null,
						prNumber: t.prNumber ?? null,
						createdAt: t.createdAt,
						updatedAt: t.updatedAt,
					});
				}
			}

			// Search filter (applied after cross-room aggregation)
			const filtered = args.search
				? allTasks.filter((t) =>
						(t.title as string).toLowerCase().includes(args.search!.toLowerCase())
					)
				: allTasks;

			const total = filtered.length;
			const limit = args.limit ?? 50;
			const offset = args.offset ?? 0;
			const paged = filtered.slice(offset, offset + limit);

			if (args.compact) {
				const compactTasks = paged.map((t) => ({
					id: t.id,
					shortId: t.shortId,
					title: t.title,
					status: t.status,
					priority: t.priority,
					taskType: t.taskType,
					assignedAgent: t.assignedAgent,
					createdAt: t.createdAt,
				}));
				return jsonResult({ success: true, total, tasks: compactTasks });
			}

			return jsonResult({ success: true, total, tasks: paged });
		},

		/**
		 * Get full details for a specific task.
		 */
		async get_task_detail(args: { task_id: string }): Promise<ToolResult> {
			const task = taskRepository.getTask(args.task_id);
			if (!task) {
				return errorResult(`Task not found: ${args.task_id}`);
			}

			const room = roomManager.getRoom(task.roomId);

			return jsonResult({
				id: task.id,
				shortId: task.shortId ?? null,
				roomId: task.roomId,
				roomName: room?.name ?? null,
				title: task.title,
				description: task.description,
				status: task.status,
				priority: task.priority,
				taskType: task.taskType ?? 'coding',
				assignedAgent: task.assignedAgent ?? 'coder',
				createdByTaskId: task.createdByTaskId ?? null,
				progress: task.progress ?? null,
				currentStep: task.currentStep ?? null,
				result: task.result ?? null,
				error: task.error ?? null,
				dependsOn: task.dependsOn,
				activeSession: task.activeSession,
				prUrl: task.prUrl ?? null,
				prNumber: task.prNumber ?? null,
				prCreatedAt: task.prCreatedAt ?? null,
				restrictions: task.restrictions ?? null,
				createdAt: task.createdAt,
				startedAt: task.startedAt ?? null,
				completedAt: task.completedAt ?? null,
				archivedAt: task.archivedAt ?? null,
				updatedAt: task.updatedAt,
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

		// Space query tools
		tool(
			'list_spaces',
			'List all spaces in the NeoKai system with summary info (id, name, status, agent count, workflow count).',
			{
				include_archived: z
					.boolean()
					.optional()
					.default(false)
					.describe('Include archived spaces in the results (default: false)'),
			},
			(args) => handlers.list_spaces(args)
		),

		tool(
			'get_space_status',
			'Get the current operational status of a specific space, including active workflow runs and task counts by status. Archived tasks are excluded from counts.',
			{
				space_id: z.string().describe('ID of the space to query'),
			},
			(args) => handlers.get_space_status(args)
		),

		tool(
			'get_space_details',
			'Get full details for a space including its agents, workflows, and recent workflow runs.',
			{
				space_id: z.string().describe('ID of the space to query'),
			},
			(args) => handlers.get_space_details(args)
		),

		tool(
			'list_space_agents',
			'List all agents configured in a space (name, role, model).',
			{
				space_id: z.string().describe('ID of the space to query'),
			},
			(args) => handlers.list_space_agents(args)
		),

		tool(
			'list_space_workflows',
			'List all workflows defined in a space.',
			{
				space_id: z.string().describe('ID of the space to query'),
			},
			(args) => handlers.list_space_workflows(args)
		),

		tool(
			'list_space_runs',
			'List workflow runs for a space, optionally filtered by status. Returns all matching runs (unbounded) sorted newest first.',
			{
				space_id: z.string().describe('ID of the space to query'),
				status: z
					.enum(['pending', 'in_progress', 'done', 'blocked', 'cancelled'])
					.optional()
					.describe('Filter runs by status'),
			},
			(args) => handlers.list_space_runs(args)
		),

		// Goal and task query tools
		tool(
			'list_goals',
			'List goals across all rooms or a specific room. Filterable by room, status, and mission type. Use compact:true and limit/offset to reduce payload size.',
			{
				room_id: z
					.string()
					.optional()
					.describe('Filter to goals in a specific room (omit for all rooms)'),
				status: z
					.enum(['active', 'needs_human', 'completed', 'archived'])
					.optional()
					.describe('Filter by goal status'),
				mission_type: z
					.enum(['one_shot', 'measurable', 'recurring'])
					.optional()
					.describe('Filter by mission type'),
				search: z.string().optional().describe('Substring match on goal title'),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.default(50)
					.describe('Maximum number of goals to return (default: 50)'),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.default(0)
					.describe('Number of goals to skip for pagination (default: 0)'),
				compact: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						'Return only summary fields (id, title, status, priority, missionType, createdAt) to reduce payload size'
					),
			},
			(args) => handlers.list_goals(args)
		),

		tool(
			'get_goal_details',
			'Get full details for a goal including structured metrics, execution history, and schedule information.',
			{
				goal_id: z.string().describe('ID of the goal to query'),
				execution_limit: z
					.number()
					.int()
					.positive()
					.optional()
					.default(10)
					.describe('Maximum number of executions to return (default: 10)'),
			},
			(args) => handlers.get_goal_details(args)
		),

		tool(
			'get_metrics',
			'Get current metric values for a measurable goal, including target vs current values and computed progress percentages.',
			{
				goal_id: z.string().describe('ID of the measurable goal to query'),
			},
			(args) => handlers.get_metrics(args)
		),

		tool(
			'list_tasks',
			'List tasks across all rooms or a specific room. Filterable by room, status, and assigned agent. Use compact:true and limit/offset to reduce payload size.',
			{
				room_id: z
					.string()
					.optional()
					.describe('Filter to tasks in a specific room (omit for all rooms)'),
				status: z
					.enum([
						'draft',
						'pending',
						'in_progress',
						'review',
						'completed',
						'needs_attention',
						'cancelled',
						'archived',
						'rate_limited',
						'usage_limited',
					])
					.optional()
					.describe('Filter by task status'),
				assigned_agent: z
					.enum(['coder', 'general', 'planner'])
					.optional()
					.describe('Filter by assigned agent type'),
				include_archived: z
					.boolean()
					.optional()
					.default(false)
					.describe('Include archived tasks (default: false)'),
				search: z.string().optional().describe('Substring match on task title'),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.default(50)
					.describe('Maximum number of tasks to return (default: 50)'),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.default(0)
					.describe('Number of tasks to skip for pagination (default: 0)'),
				compact: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						'Return only summary fields (id, shortId, title, status, priority, taskType, assignedAgent, createdAt) to reduce payload size'
					),
			},
			(args) => handlers.list_tasks(args)
		),

		tool(
			'get_task_detail',
			'Get full details for a specific task including description, result, error, dependencies, and PR information.',
			{
				task_id: z.string().describe('ID of the task to query'),
			},
			(args) => handlers.get_task_detail(args)
		),
	];

	return createSdkMcpServer({ name: 'neo-query', tools });
}
