/**
 * Unit tests for Neo Query Tools
 *
 * Tests the two-layer pattern:
 *   - createNeoQueryToolHandlers: handler functions (no MCP wiring)
 *   - createNeoQueryMcpServer: registers all tools on an MCP server
 *
 * Covers:
 * - list_rooms: happy path, empty list, include_archived flag
 * - get_room_status: found, not found
 * - get_room_details: found with goals/tasks, not found
 * - get_system_info: auth authenticated, auth not authenticated
 * - get_app_settings: returns safe subset of GlobalSettings
 * - list_mcp_servers: happy path, empty list
 * - get_mcp_server_status: found (stdio), found (sse), not found
 * - list_skills: happy path, empty list
 * - get_skill_details: found, not found
 * - list_spaces: happy path, empty list, include_archived flag, agent/workflow counts
 * - get_space_status: found, not found, task counts by status, active run count
 * - get_space_details: found with agents/workflows/runs, not found
 * - list_space_agents: found, not found, agent fields
 * - list_space_workflows: found, not found, workflow fields
 * - list_space_runs: found, not found, status filter, sort order
 * - list_goals: cross-room, room filter, status filter, mission_type filter
 * - get_goal_details: found, not found, execution history
 * - get_metrics: measurable goal, non-measurable goal, not found
 * - list_tasks: cross-room, room filter, status filter, assigned_agent filter
 * - get_task_detail: found, not found
 * - MCP server: all 20 tools are registered
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
	createNeoQueryToolHandlers,
	createNeoQueryMcpServer,
	type NeoToolsConfig,
	type NeoQueryRoomManager,
	type NeoQueryGoalRepository,
	type NeoQueryTaskRepository,
	type NeoQuerySessionManager,
	type NeoQuerySettingsManager,
	type NeoQueryAuthManager,
	type NeoQueryMcpServerRepository,
	type NeoQuerySkillsManager,
	type NeoQuerySpaceManager,
	type NeoQuerySpaceAgentManager,
	type NeoQuerySpaceWorkflowManager,
	type NeoQueryWorkflowRunRepository,
	type NeoQuerySpaceTaskRepository,
} from '../../../../src/lib/neo/tools/neo-query-tools';
import type {
	Room,
	RoomGoal,
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeRoom(overrides: Partial<Room> = {}): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		status: 'active',
		sessionIds: [],
		allowedPaths: [],
		createdAt: NOW - 10_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeGoal(overrides: Partial<RoomGoal> = {}): RoomGoal {
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Test Goal',
		description: 'A test goal',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		metrics: {},
		createdAt: NOW - 5_000,
		updatedAt: NOW,
		missionType: 'one_shot',
		autonomyLevel: 'supervised',
		...overrides,
	};
}

function makeTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		description: 'A test task',
		status: 'pending',
		priority: 'normal',
		taskType: 'coding',
		assignedAgent: 'coder',
		dependsOn: [],
		activeSession: null,
		restrictions: null,
		createdAt: NOW - 3_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeExecution(overrides: Partial<MissionExecution> = {}): MissionExecution {
	return {
		id: 'exec-1',
		goalId: 'goal-1',
		executionNumber: 1,
		startedAt: Math.floor((NOW - 5_000) / 1000),
		status: 'running',
		taskIds: [],
		planningAttempts: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRoomManager(
	rooms: Room[] = [],
	overview: ReturnType<NeoQueryRoomManager['getRoomOverview']> = null
): NeoQueryRoomManager {
	return {
		listRooms: (includeArchived = false) => {
			if (includeArchived) return rooms;
			return rooms.filter((r) => r.status !== 'archived');
		},
		getRoom: (id) => rooms.find((r) => r.id === id) ?? null,
		getRoomOverview: (roomId) => {
			if (overview && overview.room.id === roomId) return overview;
			const room = rooms.find((r) => r.id === roomId);
			if (!room) return null;
			return { room, sessions: [] };
		},
	};
}

function makeGoalRepository(
	goalsByRoom: Record<string, RoomGoal[]> = {},
	goalsById: Record<string, RoomGoal> = {},
	executionsByGoal: Record<string, MissionExecution[]> = {}
): NeoQueryGoalRepository {
	return {
		listGoals: (roomId) => goalsByRoom[roomId] ?? [],
		getGoal: (id) => goalsById[id] ?? null,
		listExecutions: (goalId, limit) => {
			const execs = executionsByGoal[goalId] ?? [];
			return limit !== undefined ? execs.slice(0, limit) : execs;
		},
	};
}

function makeTaskRepository(
	tasksByRoom: Record<string, NeoTask[]> = {},
	tasksById: Record<string, NeoTask> = {}
): NeoQueryTaskRepository {
	return {
		listTasks: (roomId, filter) => {
			let tasks = tasksByRoom[roomId] ?? [];
			if (!filter?.includeArchived) {
				tasks = tasks.filter((t) => t.status !== 'archived');
			}
			if (filter?.status) {
				tasks = tasks.filter((t) => t.status === filter.status);
			}
			// Note: no assignedAgent in real TaskFilter — handler filters in-memory
			return tasks;
		},
		getTask: (id) => tasksById[id] ?? null,
	};
}

function makeSessionManager(
	activeSessions = 0,
	sessions: { id: string; status: string }[] = []
): NeoQuerySessionManager {
	return {
		getActiveSessions: () => activeSessions,
		listSessions: (opts) => {
			if (opts?.status) {
				return sessions.filter((s) => s.status === opts.status);
			}
			return sessions;
		},
	};
}

function makeSettingsManager(overrides: Record<string, unknown> = {}): NeoQuerySettingsManager {
	return {
		getGlobalSettings: () =>
			({
				settingSources: ['user', 'project', 'local'],
				model: 'claude-sonnet-4',
				permissionMode: 'default',
				thinkingLevel: 'none',
				autoScroll: true,
				coordinatorMode: false,
				maxConcurrentWorkers: 3,
				neoSecurityMode: 'balanced',
				neoModel: null,
				showArchived: false,
				fallbackModels: [],
				disabledMcpServers: [],
				...overrides,
			}) as ReturnType<NeoQuerySettingsManager['getGlobalSettings']>,
	};
}

function makeAuthManager(isAuthenticated: boolean, method = 'api_key'): NeoQueryAuthManager {
	return {
		getAuthStatus: async () => ({
			isAuthenticated,
			method: method as 'api_key' | 'oauth_token' | 'none',
			source: 'env' as const,
		}),
	};
}

function makeMcpServer(overrides: Partial<AppMcpServer> = {}): AppMcpServer {
	return {
		id: 'mcp-1',
		name: 'test-server',
		sourceType: 'stdio',
		command: 'npx',
		args: ['-y', 'some-mcp-package'],
		env: { SOME_KEY: 'value' },
		enabled: true,
		createdAt: NOW - 5_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeMcpServerRepository(servers: AppMcpServer[] = []): NeoQueryMcpServerRepository {
	return {
		list: () => servers,
		get: (id) => servers.find((s) => s.id === id) ?? null,
	};
}

function makeSkill(overrides: Partial<AppSkill> = {}): AppSkill {
	return {
		id: 'skill-1',
		name: 'test-skill',
		displayName: 'Test Skill',
		description: 'A test skill',
		sourceType: 'builtin',
		config: { type: 'builtin', commandName: 'test-cmd' },
		enabled: true,
		builtIn: false,
		validationStatus: 'valid',
		createdAt: NOW - 3_000,
		...overrides,
	};
}

function makeSkillsManager(skills: AppSkill[] = []): NeoQuerySkillsManager {
	return {
		listSkills: () => skills,
		getSkill: (id) => skills.find((s) => s.id === id) ?? null,
	};
}

// ---------------------------------------------------------------------------
// Space test fixtures
// ---------------------------------------------------------------------------

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		slug: 'test-space',
		name: 'Test Space',
		description: 'A test space',
		backgroundContext: '',
		instructions: '',
		workspacePath: '/workspace/test',
		status: 'active',
		sessionIds: [],
		createdAt: NOW - 10_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeSpaceAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'Coder',
		instructions: null,
		createdAt: NOW - 5_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeSpaceWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		nodes: [],
		startNodeId: 'node-1',
		tags: [],
		createdAt: NOW - 5_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeWorkflowRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: 'Test Run',
		status: 'done',
		startedAt: null,
		completedAt: null,
		createdAt: NOW - 3_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeSpaceTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		taskNumber: 1,
		title: 'Test Task',
		description: 'A test task',
		status: 'open',
		labels: [],
		result: null,
		priority: 'normal',
		createdAt: NOW - 2_000,
		updatedAt: NOW,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Space mock factories
// ---------------------------------------------------------------------------

function makeSpaceManager(spaces: Space[] = []): NeoQuerySpaceManager {
	return {
		listSpaces: (includeArchived = false) => {
			if (includeArchived) return spaces;
			return spaces.filter((s) => s.status !== 'archived');
		},
		getSpace: (id) => spaces.find((s) => s.id === id) ?? null,
	};
}

function makeSpaceAgentManager(
	agentsBySpace: Record<string, SpaceAgent[]> = {}
): NeoQuerySpaceAgentManager {
	return {
		listBySpaceId: (spaceId) => agentsBySpace[spaceId] ?? [],
	};
}

function makeSpaceWorkflowManager(
	workflowsBySpace: Record<string, SpaceWorkflow[]> = {}
): NeoQuerySpaceWorkflowManager {
	return {
		listWorkflows: (spaceId) => workflowsBySpace[spaceId] ?? [],
	};
}

function makeWorkflowRunRepository(
	runsBySpace: Record<string, SpaceWorkflowRun[]> = {}
): NeoQueryWorkflowRunRepository {
	return {
		listBySpace: (spaceId) => runsBySpace[spaceId] ?? [],
	};
}

function makeSpaceTaskRepository(
	tasksBySpace: Record<string, SpaceTask[]> = {}
): NeoQuerySpaceTaskRepository {
	return {
		listBySpace: (spaceId) => tasksBySpace[spaceId] ?? [],
		listByStatus: (spaceId, status) =>
			(tasksBySpace[spaceId] ?? []).filter((t) => t.status === status),
	};
}

function makeConfig(overrides: Partial<NeoToolsConfig> = {}): NeoToolsConfig {
	return {
		roomManager: makeRoomManager(),
		goalRepository: makeGoalRepository(),
		taskRepository: makeTaskRepository(),
		sessionManager: makeSessionManager(),
		settingsManager: makeSettingsManager(),
		authManager: makeAuthManager(true),
		mcpServerRepository: makeMcpServerRepository(),
		skillsManager: makeSkillsManager(),
		workspaceRoot: '/workspace',
		appVersion: '0.1.1',
		startedAt: NOW - 60_000,
		spaceManager: makeSpaceManager(),
		spaceAgentManager: makeSpaceAgentManager(),
		spaceWorkflowManager: makeSpaceWorkflowManager(),
		workflowRunRepository: makeWorkflowRunRepository(),
		spaceTaskRepository: makeSpaceTaskRepository(),
		...overrides,
	};
}

function parseResult(result: { content: Array<{ type: 'text'; text: string }> }) {
	return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// list_rooms
// ---------------------------------------------------------------------------

describe('list_rooms', () => {
	it('returns empty array when no rooms exist', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_rooms({}));
		expect(result).toEqual([]);
	});

	it('returns active rooms with summary fields', async () => {
		const room = makeRoom({ sessionIds: ['worker-1', 'worker-2', 'room:chat:room-1'] });
		const goal = makeGoal({ status: 'active' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': [goal] }),
			})
		);

		const result = parseResult(await handlers.list_rooms({}));
		expect(result).toHaveLength(1);
		const r = result[0];
		expect(r.id).toBe('room-1');
		expect(r.name).toBe('Test Room');
		expect(r.status).toBe('active');
		// room:chat:room-1 is filtered out → 2 worker sessions
		expect(r.sessionCount).toBe(2);
		expect(r.goalCount).toBe(1);
		expect(r.activeGoalCount).toBe(1);
	});

	it('excludes archived rooms by default', async () => {
		const active = makeRoom({ id: 'room-a', name: 'Active', status: 'active' });
		const archived = makeRoom({ id: 'room-b', name: 'Archived', status: 'archived' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ roomManager: makeRoomManager([active, archived]) })
		);

		const result = parseResult(await handlers.list_rooms({}));
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('room-a');
	});

	it('includes archived rooms when include_archived is true', async () => {
		const active = makeRoom({ id: 'room-a', name: 'Active', status: 'active' });
		const archived = makeRoom({ id: 'room-b', name: 'Archived', status: 'archived' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ roomManager: makeRoomManager([active, archived]) })
		);

		const result = parseResult(await handlers.list_rooms({ include_archived: true }));
		expect(result).toHaveLength(2);
	});

	it('counts only active/needs_human goals as activeGoalCount', async () => {
		const room = makeRoom();
		const goals = [
			makeGoal({ id: 'g1', status: 'active' }),
			makeGoal({ id: 'g2', status: 'needs_human' }),
			makeGoal({ id: 'g3', status: 'completed' }),
			makeGoal({ id: 'g4', status: 'archived' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': goals }),
			})
		);

		const result = parseResult(await handlers.list_rooms({}));
		expect(result[0].goalCount).toBe(4);
		expect(result[0].activeGoalCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// get_room_status
// ---------------------------------------------------------------------------

describe('get_room_status', () => {
	it('returns error when room not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_room_status({ room_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns room status with correct counts', async () => {
		const room = makeRoom({
			sessionIds: ['worker-1', 'worker-2', 'room:lead:room-1'],
			defaultModel: 'claude-opus-4',
		});
		const goals = [
			makeGoal({ id: 'g1', status: 'active' }),
			makeGoal({ id: 'g2', status: 'completed' }),
		];
		const sessions = [
			{ id: 'worker-1', status: 'active' },
			{ id: 'worker-2', status: 'ended' },
		];

		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': goals }),
				sessionManager: makeSessionManager(1, sessions),
			})
		);

		const result = parseResult(await handlers.get_room_status({ room_id: 'room-1' }));
		expect(result.id).toBe('room-1');
		expect(result.name).toBe('Test Room');
		expect(result.defaultModel).toBe('claude-opus-4');
		// room:lead:room-1 is filtered → 2 worker session IDs
		expect(result.sessionCount).toBe(2);
		// only worker-1 has status 'active'
		expect(result.activeSessionCount).toBe(1);
		expect(result.goalCount).toBe(2);
		expect(result.activeGoalCount).toBe(1);
	});

	it('returns null defaultModel when not set', async () => {
		const room = makeRoom({ defaultModel: undefined });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ roomManager: makeRoomManager([room]) })
		);
		const result = parseResult(await handlers.get_room_status({ room_id: 'room-1' }));
		expect(result.defaultModel).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// get_room_details
// ---------------------------------------------------------------------------

describe('get_room_details', () => {
	it('returns error when room not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_room_details({ room_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns full room details with goals and tasks', async () => {
		const room = makeRoom({
			instructions: 'Focus on testing',
			background: 'This is a background',
			allowedModels: ['claude-sonnet-4', 'claude-opus-4'],
		});
		const goals = [
			makeGoal({ id: 'g1', title: 'Goal 1', status: 'active', progress: 50 }),
			makeGoal({ id: 'g2', title: 'Goal 2', status: 'completed', progress: 100 }),
		];
		const sessions = [{ id: 'session-1', title: 'Session 1', status: 'active', lastActiveAt: NOW }];
		const overview = { room, sessions };
		const tasks = [
			makeTask({
				id: 'task-1',
				roomId: 'room-1',
				title: 'Task 1',
				status: 'in_progress',
				priority: 'normal',
			}),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room], overview),
				goalRepository: makeGoalRepository({ 'room-1': goals }),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		const result = parseResult(await handlers.get_room_details({ room_id: 'room-1' }));
		expect(result.id).toBe('room-1');
		expect(result.instructions).toBe('Focus on testing');
		expect(result.background).toBe('This is a background');
		expect(result.allowedModels).toEqual(['claude-sonnet-4', 'claude-opus-4']);
		expect(result.goals).toHaveLength(2);
		expect(result.goals[0].id).toBe('g1');
		expect(result.goals[0].progress).toBe(50);
		expect(result.goals[0].missionType).toBe('one_shot');
		expect(result.goals[1].id).toBe('g2');
		expect(result.sessions).toHaveLength(1);
		expect(result.activeTasks).toHaveLength(1);
		expect(result.allTaskCount).toBe(1);
	});

	it('returns empty goals and tasks when none exist', async () => {
		const room = makeRoom();
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ roomManager: makeRoomManager([room]) })
		);

		const result = parseResult(await handlers.get_room_details({ room_id: 'room-1' }));
		expect(result.goals).toHaveLength(0);
		expect(result.activeTasks).toHaveLength(0);
		expect(result.allTaskCount).toBe(0);
	});

	it('includes shortId in goal summary when present', async () => {
		const room = makeRoom();
		const goal = makeGoal({ shortId: 'G001' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': [goal] }),
			})
		);

		const result = parseResult(await handlers.get_room_details({ room_id: 'room-1' }));
		expect(result.goals[0].shortId).toBe('G001');
	});
});

// ---------------------------------------------------------------------------
// get_system_info
// ---------------------------------------------------------------------------

describe('get_system_info', () => {
	it('returns system info when authenticated', async () => {
		const startedAt = NOW - 120_000; // 2 minutes ago
		const rooms = [makeRoom({ id: 'r1' }), makeRoom({ id: 'r2' })];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager(rooms),
				sessionManager: makeSessionManager(3),
				authManager: makeAuthManager(true, 'api_key'),
				workspaceRoot: '/my/workspace',
				appVersion: '1.2.3',
				startedAt,
			})
		);

		const result = parseResult(await handlers.get_system_info());
		expect(result.appVersion).toBe('1.2.3');
		expect(result.workspaceRoot).toBe('/my/workspace');
		expect(result.startedAt).toBe(startedAt);
		// uptime should be at least 120 seconds
		expect(result.uptimeSeconds).toBeGreaterThanOrEqual(120);
		expect(result.auth.isAuthenticated).toBe(true);
		expect(result.auth.method).toBe('api_key');
		expect(result.roomCount).toBe(2);
		expect(result.activeSessionCount).toBe(3);
	});

	it('reports unauthenticated state correctly', async () => {
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ authManager: makeAuthManager(false, 'none') })
		);

		const result = parseResult(await handlers.get_system_info());
		expect(result.auth.isAuthenticated).toBe(false);
		expect(result.auth.method).toBe('none');
	});

	it('reports oauth_token auth method', async () => {
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ authManager: makeAuthManager(true, 'oauth_token') })
		);

		const result = parseResult(await handlers.get_system_info());
		expect(result.auth.method).toBe('oauth_token');
	});
});

// ---------------------------------------------------------------------------
// get_app_settings
// ---------------------------------------------------------------------------

describe('get_app_settings', () => {
	it('returns safe subset of global settings', async () => {
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				settingsManager: makeSettingsManager({
					model: 'claude-opus-4',
					neoSecurityMode: 'autonomous',
					neoModel: 'claude-sonnet-4',
					maxConcurrentWorkers: 5,
				}),
			})
		);

		const result = parseResult(await handlers.get_app_settings());
		expect(result.model).toBe('claude-opus-4');
		expect(result.neoSecurityMode).toBe('autonomous');
		expect(result.neoModel).toBe('claude-sonnet-4');
		expect(result.maxConcurrentWorkers).toBe(5);
		expect(result.autoScroll).toBe(true);
		expect(result.coordinatorMode).toBe(false);
		expect(result.settingSources).toEqual(['user', 'project', 'local']);
	});

	it('uses defaults for optional fields when unset', async () => {
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				settingsManager: {
					getGlobalSettings: () =>
						({
							settingSources: ['user'],
						}) as ReturnType<NeoQuerySettingsManager['getGlobalSettings']>,
				},
			})
		);

		const result = parseResult(await handlers.get_app_settings());
		expect(result.model).toBeNull();
		expect(result.neoSecurityMode).toBe('balanced');
		expect(result.neoModel).toBeNull();
		expect(result.autoScroll).toBe(true);
		expect(result.coordinatorMode).toBe(false);
		expect(result.maxConcurrentWorkers).toBe(3);
		expect(result.fallbackModels).toEqual([]);
		expect(result.disabledMcpServers).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// list_mcp_servers
// ---------------------------------------------------------------------------

describe('list_mcp_servers', () => {
	it('returns empty array when no servers registered', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_mcp_servers());
		expect(result).toEqual([]);
	});

	it('returns all servers with summary fields', async () => {
		const server = makeMcpServer({ description: 'A test MCP server' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ mcpServerRepository: makeMcpServerRepository([server]) })
		);

		const result = parseResult(await handlers.list_mcp_servers());
		expect(result).toHaveLength(1);
		const s = result[0];
		expect(s.id).toBe('mcp-1');
		expect(s.name).toBe('test-server');
		expect(s.description).toBe('A test MCP server');
		expect(s.sourceType).toBe('stdio');
		expect(s.enabled).toBe(true);
		expect(s.createdAt).toBe(NOW - 5_000);
	});

	it('returns disabled servers with enabled=false', async () => {
		const server = makeMcpServer({ enabled: false });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ mcpServerRepository: makeMcpServerRepository([server]) })
		);

		const result = parseResult(await handlers.list_mcp_servers());
		expect(result[0].enabled).toBe(false);
	});

	it('returns null description when not set', async () => {
		const server = makeMcpServer({ description: undefined });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ mcpServerRepository: makeMcpServerRepository([server]) })
		);

		const result = parseResult(await handlers.list_mcp_servers());
		expect(result[0].description).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// get_mcp_server_status
// ---------------------------------------------------------------------------

describe('get_mcp_server_status', () => {
	it('returns error when server not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_mcp_server_status({ server_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns stdio server details with command and arg list', async () => {
		const server = makeMcpServer({
			sourceType: 'stdio',
			command: 'npx',
			args: ['-y', 'some-pkg'],
			env: { API_KEY: 'secret', DEBUG: '1' },
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ mcpServerRepository: makeMcpServerRepository([server]) })
		);

		const result = parseResult(await handlers.get_mcp_server_status({ server_id: 'mcp-1' }));
		expect(result.id).toBe('mcp-1');
		expect(result.name).toBe('test-server');
		expect(result.enabled).toBe(true);
		expect(result.transport.sourceType).toBe('stdio');
		expect(result.transport.command).toBe('npx');
		expect(result.transport.args).toEqual(['-y', 'some-pkg']);
		// Env values must NOT be included — only key names
		expect(result.transport.envKeys).toEqual(expect.arrayContaining(['API_KEY', 'DEBUG']));
		expect(result.transport.env).toBeUndefined();
	});

	it('returns sse/http server details with url but not header values', async () => {
		const server = makeMcpServer({
			id: 'mcp-2',
			sourceType: 'sse',
			command: undefined,
			args: undefined,
			env: undefined,
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer token123', 'X-Custom': 'val' },
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ mcpServerRepository: makeMcpServerRepository([server]) })
		);

		const result = parseResult(await handlers.get_mcp_server_status({ server_id: 'mcp-2' }));
		expect(result.transport.sourceType).toBe('sse');
		expect(result.transport.url).toBe('https://example.com/mcp');
		// Header values must NOT be included — only key names
		expect(result.transport.headerKeys).toEqual(
			expect.arrayContaining(['Authorization', 'X-Custom'])
		);
		expect(result.transport.headers).toBeUndefined();
	});

	it('returns http server details with url but not header values', async () => {
		const server = makeMcpServer({
			id: 'mcp-3',
			sourceType: 'http',
			command: undefined,
			args: undefined,
			env: undefined,
			url: 'https://example.com/mcp/http',
			headers: { 'X-Api-Key': 'secret', 'X-Tenant': 'acme' },
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ mcpServerRepository: makeMcpServerRepository([server]) })
		);

		const result = parseResult(await handlers.get_mcp_server_status({ server_id: 'mcp-3' }));
		expect(result.transport.sourceType).toBe('http');
		expect(result.transport.url).toBe('https://example.com/mcp/http');
		expect(result.transport.headerKeys).toEqual(expect.arrayContaining(['X-Api-Key', 'X-Tenant']));
		expect(result.transport.headers).toBeUndefined();
	});

	it('returns empty envKeys when env is not set', async () => {
		const server = makeMcpServer({ env: undefined });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ mcpServerRepository: makeMcpServerRepository([server]) })
		);

		const result = parseResult(await handlers.get_mcp_server_status({ server_id: 'mcp-1' }));
		expect(result.transport.envKeys).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// list_skills
// ---------------------------------------------------------------------------

describe('list_skills', () => {
	it('returns empty array when no skills registered', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_skills());
		expect(result).toEqual([]);
	});

	it('returns all skills with summary fields', async () => {
		const skill = makeSkill({ displayName: 'My Skill', description: 'Does stuff' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([skill]) })
		);

		const result = parseResult(await handlers.list_skills());
		expect(result).toHaveLength(1);
		const s = result[0];
		expect(s.id).toBe('skill-1');
		expect(s.name).toBe('test-skill');
		expect(s.displayName).toBe('My Skill');
		expect(s.description).toBe('Does stuff');
		expect(s.sourceType).toBe('builtin');
		expect(s.enabled).toBe(true);
		expect(s.builtIn).toBe(false);
		expect(s.validationStatus).toBe('valid');
	});

	it('list_skills does not include config or createdAt', async () => {
		const skill = makeSkill();
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([skill]) })
		);

		const result = parseResult(await handlers.list_skills());
		expect(result[0].config).toBeUndefined();
		expect(result[0].createdAt).toBeUndefined();
	});

	it('returns disabled skills with enabled=false', async () => {
		const skill = makeSkill({ enabled: false });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([skill]) })
		);

		const result = parseResult(await handlers.list_skills());
		expect(result[0].enabled).toBe(false);
	});

	it('returns skills with various source types', async () => {
		const plugin = makeSkill({
			id: 'skill-plugin',
			name: 'plugin-skill',
			sourceType: 'plugin',
			config: { type: 'plugin', pluginPath: '/abs/path/to/plugin' },
		});
		const mcp = makeSkill({
			id: 'skill-mcp',
			name: 'mcp-skill',
			sourceType: 'mcp_server',
			config: { type: 'mcp_server', appMcpServerId: 'some-mcp-id' },
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([plugin, mcp]) })
		);

		const result = parseResult(await handlers.list_skills());
		expect(result).toHaveLength(2);
		expect(result[0].sourceType).toBe('plugin');
		expect(result[1].sourceType).toBe('mcp_server');
	});
});

// ---------------------------------------------------------------------------
// get_skill_details
// ---------------------------------------------------------------------------

describe('get_skill_details', () => {
	it('returns error when skill not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_skill_details({ skill_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns full skill details including config and createdAt', async () => {
		const skill = makeSkill({
			id: 'skill-1',
			name: 'web-search',
			displayName: 'Web Search',
			sourceType: 'mcp_server',
			config: { type: 'mcp_server', appMcpServerId: 'mcp-uuid' },
			builtIn: true,
			validationStatus: 'valid',
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([skill]) })
		);

		const result = parseResult(await handlers.get_skill_details({ skill_id: 'skill-1' }));
		expect(result.id).toBe('skill-1');
		expect(result.name).toBe('web-search');
		expect(result.displayName).toBe('Web Search');
		expect(result.sourceType).toBe('mcp_server');
		expect(result.config).toEqual({ type: 'mcp_server', appMcpServerId: 'mcp-uuid' });
		expect(result.builtIn).toBe(true);
		expect(result.validationStatus).toBe('valid');
		expect(result.createdAt).toBe(NOW - 3_000);
	});

	it('returns correct validationStatus for invalid skill', async () => {
		const skill = makeSkill({ validationStatus: 'invalid' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([skill]) })
		);

		const result = parseResult(await handlers.get_skill_details({ skill_id: 'skill-1' }));
		expect(result.validationStatus).toBe('invalid');
	});

	it('returns pending validation status for newly created skill', async () => {
		const skill = makeSkill({ validationStatus: 'pending' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([skill]) })
		);

		const result = parseResult(await handlers.get_skill_details({ skill_id: 'skill-1' }));
		expect(result.validationStatus).toBe('pending');
	});

	it('returns plugin config with pluginPath', async () => {
		const skill = makeSkill({
			sourceType: 'plugin',
			config: { type: 'plugin', pluginPath: '/absolute/path/to/plugin' },
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ skillsManager: makeSkillsManager([skill]) })
		);

		const result = parseResult(await handlers.get_skill_details({ skill_id: 'skill-1' }));
		expect(result.config.type).toBe('plugin');
		expect(result.config.pluginPath).toBe('/absolute/path/to/plugin');
	});
});

// list_spaces
// ---------------------------------------------------------------------------

describe('list_spaces', () => {
	it('returns empty array when no spaces exist', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_spaces({}));
		expect(result).toEqual([]);
	});

	it('returns active spaces with agent and workflow counts', async () => {
		const space = makeSpace();
		const agents = [makeSpaceAgent({ id: 'a1' }), makeSpaceAgent({ id: 'a2' })];
		const workflows = [makeSpaceWorkflow({ id: 'w1' })];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				spaceAgentManager: makeSpaceAgentManager({ 'space-1': agents }),
				spaceWorkflowManager: makeSpaceWorkflowManager({ 'space-1': workflows }),
			})
		);

		const result = parseResult(await handlers.list_spaces({}));
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('space-1');
		expect(result[0].name).toBe('Test Space');
		expect(result[0].status).toBe('active');
		expect(result[0].agentCount).toBe(2);
		expect(result[0].workflowCount).toBe(1);
	});

	it('excludes archived spaces by default', async () => {
		const active = makeSpace({ id: 's-a', name: 'Active', status: 'active' });
		const archived = makeSpace({ id: 's-b', name: 'Archived', status: 'archived' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ spaceManager: makeSpaceManager([active, archived]) })
		);

		const result = parseResult(await handlers.list_spaces({}));
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('s-a');
	});

	it('includes archived spaces when include_archived is true', async () => {
		const active = makeSpace({ id: 's-a', status: 'active' });
		const archived = makeSpace({ id: 's-b', status: 'archived' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ spaceManager: makeSpaceManager([active, archived]) })
		);

		const result = parseResult(await handlers.list_spaces({ include_archived: true }));
		expect(result).toHaveLength(2);
	});

	it('returns null defaultModel when not set', async () => {
		const space = makeSpace({ defaultModel: undefined });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ spaceManager: makeSpaceManager([space]) })
		);
		const result = parseResult(await handlers.list_spaces({}));
		expect(result[0].defaultModel).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// get_space_status
// ---------------------------------------------------------------------------

describe('get_space_status', () => {
	it('returns error when space not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_space_status({ space_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns space status with run and task counts', async () => {
		const space = makeSpace({ autonomyLevel: 'supervised', defaultModel: 'claude-opus-4' });
		const runs = [
			makeWorkflowRun({ id: 'r1', status: 'in_progress' }),
			makeWorkflowRun({ id: 'r2', status: 'blocked' }),
			makeWorkflowRun({ id: 'r3', status: 'done' }),
		];
		const tasks = [
			makeSpaceTask({ id: 't1', status: 'open' }),
			makeSpaceTask({ id: 't2', status: 'open' }),
			makeSpaceTask({ id: 't3', status: 'done' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				workflowRunRepository: makeWorkflowRunRepository({ 'space-1': runs }),
				spaceTaskRepository: makeSpaceTaskRepository({ 'space-1': tasks }),
			})
		);

		const result = parseResult(await handlers.get_space_status({ space_id: 'space-1' }));
		expect(result.id).toBe('space-1');
		expect(result.name).toBe('Test Space');
		expect(result.totalRunCount).toBe(3);
		// in_progress + needs_attention = 2
		expect(result.activeRunCount).toBe(2);
		expect(result.totalTaskCount).toBe(3);
		expect(result.taskCountByStatus.open).toBe(2);
		expect(result.taskCountByStatus.done).toBe(1);
		expect(result.autonomyLevel).toBe('supervised');
		expect(result.defaultModel).toBe('claude-opus-4');
	});

	it('returns zero counts when no runs or tasks exist', async () => {
		const space = makeSpace();
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ spaceManager: makeSpaceManager([space]) })
		);
		const result = parseResult(await handlers.get_space_status({ space_id: 'space-1' }));
		expect(result.totalRunCount).toBe(0);
		expect(result.activeRunCount).toBe(0);
		expect(result.totalTaskCount).toBe(0);
		expect(result.taskCountByStatus).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// get_space_details
// ---------------------------------------------------------------------------

describe('get_space_details', () => {
	it('returns error when space not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_space_details({ space_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns full space details with agents, workflows, and recent runs', async () => {
		const space = makeSpace({
			instructions: 'Be thorough',
			backgroundContext: 'TypeScript monorepo',
			allowedModels: ['claude-sonnet-4'],
		});
		const agents = [makeSpaceAgent({ name: 'Coder' })];
		const workflows = [makeSpaceWorkflow({ name: 'Dev Workflow', nodes: [{ id: 'n1' } as never] })];
		const runs = [
			makeWorkflowRun({ id: 'r1', status: 'done', createdAt: NOW - 1000 }),
			makeWorkflowRun({ id: 'r2', status: 'in_progress', createdAt: NOW - 500 }),
		];

		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				spaceAgentManager: makeSpaceAgentManager({ 'space-1': agents }),
				spaceWorkflowManager: makeSpaceWorkflowManager({ 'space-1': workflows }),
				workflowRunRepository: makeWorkflowRunRepository({ 'space-1': runs }),
			})
		);

		const result = parseResult(await handlers.get_space_details({ space_id: 'space-1' }));
		expect(result.id).toBe('space-1');
		expect(result.instructions).toBe('Be thorough');
		expect(result.backgroundContext).toBe('TypeScript monorepo');
		expect(result.allowedModels).toEqual(['claude-sonnet-4']);
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0].name).toBe('Coder');
		expect(result.workflows).toHaveLength(1);
		expect(result.workflows[0].name).toBe('Dev Workflow');
		expect(result.workflows[0].nodeCount).toBe(1);
		// recentRuns sorted newest first
		expect(result.recentRuns).toHaveLength(2);
		expect(result.recentRuns[0].id).toBe('r2');
		expect(result.recentRuns[1].id).toBe('r1');
	});

	it('caps recentRuns at 10', async () => {
		const space = makeSpace();
		const runs = Array.from({ length: 15 }, (_, i) =>
			makeWorkflowRun({ id: `run-${i}`, createdAt: NOW - i * 100 })
		);
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				workflowRunRepository: makeWorkflowRunRepository({ 'space-1': runs }),
			})
		);

		const result = parseResult(await handlers.get_space_details({ space_id: 'space-1' }));
		expect(result.recentRuns).toHaveLength(10);
	});
});

// ---------------------------------------------------------------------------
// list_space_agents
// ---------------------------------------------------------------------------

describe('list_space_agents', () => {
	it('returns error when space not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_space_agents({ space_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns agents for a space with correct fields', async () => {
		const space = makeSpace();
		const agents = [
			makeSpaceAgent({
				id: 'a1',
				name: 'Coder',
				model: 'claude-haiku-4-5',
				description: 'Writes code',
			}),
			makeSpaceAgent({ id: 'a2', name: 'Planner' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				spaceAgentManager: makeSpaceAgentManager({ 'space-1': agents }),
			})
		);

		const result = parseResult(await handlers.list_space_agents({ space_id: 'space-1' }));
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe('a1');
		expect(result[0].name).toBe('Coder');
		expect(result[0].model).toBe('claude-haiku-4-5');
		expect(result[0].description).toBe('Writes code');
		expect(result[1].model).toBeNull();
	});

	it('returns empty array when space has no agents', async () => {
		const space = makeSpace();
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ spaceManager: makeSpaceManager([space]) })
		);
		const result = parseResult(await handlers.list_space_agents({ space_id: 'space-1' }));
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// list_space_workflows
// ---------------------------------------------------------------------------

describe('list_space_workflows', () => {
	it('returns error when space not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_space_workflows({ space_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns workflows with node count and tags', async () => {
		const space = makeSpace();
		const workflows = [
			makeSpaceWorkflow({
				id: 'w1',
				name: 'Dev',
				description: 'Development workflow',
				nodes: [{ id: 'n1' } as never, { id: 'n2' } as never],
				tags: ['dev', 'ci'],
			}),
			makeSpaceWorkflow({ id: 'w2', name: 'Review', nodes: [] }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				spaceWorkflowManager: makeSpaceWorkflowManager({ 'space-1': workflows }),
			})
		);

		const result = parseResult(await handlers.list_space_workflows({ space_id: 'space-1' }));
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe('w1');
		expect(result[0].name).toBe('Dev');
		expect(result[0].description).toBe('Development workflow');
		expect(result[0].nodeCount).toBe(2);
		expect(result[0].tags).toEqual(['dev', 'ci']);
		expect(result[1].nodeCount).toBe(0);
	});

	it('returns empty array when space has no workflows', async () => {
		const space = makeSpace();
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ spaceManager: makeSpaceManager([space]) })
		);
		const result = parseResult(await handlers.list_space_workflows({ space_id: 'space-1' }));
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// list_space_runs
// ---------------------------------------------------------------------------

describe('list_space_runs', () => {
	it('returns error when space not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_space_runs({ space_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns runs sorted newest first', async () => {
		const space = makeSpace();
		const runs = [
			makeWorkflowRun({ id: 'r1', title: 'Old Run', createdAt: NOW - 3000 }),
			makeWorkflowRun({ id: 'r2', title: 'New Run', createdAt: NOW - 1000 }),
			makeWorkflowRun({ id: 'r3', title: 'Mid Run', createdAt: NOW - 2000 }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				workflowRunRepository: makeWorkflowRunRepository({ 'space-1': runs }),
			})
		);

		const result = parseResult(await handlers.list_space_runs({ space_id: 'space-1' }));
		expect(result).toHaveLength(3);
		expect(result[0].id).toBe('r2');
		expect(result[1].id).toBe('r3');
		expect(result[2].id).toBe('r1');
	});

	it('filters runs by status', async () => {
		const space = makeSpace();
		const runs = [
			makeWorkflowRun({ id: 'r1', status: 'done' }),
			makeWorkflowRun({ id: 'r2', status: 'in_progress' }),
			makeWorkflowRun({ id: 'r3', status: 'done' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				workflowRunRepository: makeWorkflowRunRepository({ 'space-1': runs }),
			})
		);

		const result = parseResult(
			await handlers.list_space_runs({ space_id: 'space-1', status: 'done' })
		);
		expect(result).toHaveLength(2);
		expect(result.every((r: { status: string }) => r.status === 'done')).toBe(true);
	});

	it('returns run fields including completedAt', async () => {
		const space = makeSpace();
		const runs = [
			makeWorkflowRun({
				id: 'r1',
				title: 'My Run',
				description: 'A run',
				status: 'done',
				workflowId: 'wf-1',
				completedAt: NOW,
			}),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				workflowRunRepository: makeWorkflowRunRepository({ 'space-1': runs }),
			})
		);

		const result = parseResult(await handlers.list_space_runs({ space_id: 'space-1' }));
		const run = result[0];
		expect(run.title).toBe('My Run');
		expect(run.description).toBe('A run');
		expect(run.workflowId).toBe('wf-1');
		expect(run.completedAt).toBe(NOW);
	});

	it('returns empty array when no runs exist', async () => {
		const space = makeSpace();
		const handlers = createNeoQueryToolHandlers(
			makeConfig({ spaceManager: makeSpaceManager([space]) })
		);
		const result = parseResult(await handlers.list_space_runs({ space_id: 'space-1' }));
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// list_goals
// ---------------------------------------------------------------------------

describe('list_goals', () => {
	it('returns empty array when no goals exist', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_goals({}));
		expect(result.success).toBe(true);
		expect(result.total).toBe(0);
		expect(result.goals).toEqual([]);
	});

	it('returns goals across all rooms when no room_id filter', async () => {
		const room1 = makeRoom({ id: 'room-1', name: 'Room 1' });
		const room2 = makeRoom({ id: 'room-2', name: 'Room 2' });
		const goal1 = makeGoal({ id: 'g1', roomId: 'room-1' });
		const goal2 = makeGoal({ id: 'g2', roomId: 'room-2' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room1, room2]),
				goalRepository: makeGoalRepository({ 'room-1': [goal1], 'room-2': [goal2] }),
			})
		);

		const result = parseResult(await handlers.list_goals({}));
		expect(result.total).toBe(2);
		expect((result.goals as Array<{ id: string }>).map((g) => g.id)).toEqual(
			expect.arrayContaining(['g1', 'g2'])
		);
	});

	it('includes roomName in each goal', async () => {
		const room = makeRoom({ id: 'room-1', name: 'My Room' });
		const goal = makeGoal({ id: 'g1', roomId: 'room-1' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': [goal] }),
			})
		);

		const result = parseResult(await handlers.list_goals({}));
		expect((result.goals as Array<{ roomName: string }>)[0].roomName).toBe('My Room');
	});

	it('filters to a specific room when room_id is provided', async () => {
		const room1 = makeRoom({ id: 'room-1', name: 'Room 1' });
		const room2 = makeRoom({ id: 'room-2', name: 'Room 2' });
		const goal1 = makeGoal({ id: 'g1', roomId: 'room-1' });
		const goal2 = makeGoal({ id: 'g2', roomId: 'room-2' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room1, room2]),
				goalRepository: makeGoalRepository({ 'room-1': [goal1], 'room-2': [goal2] }),
			})
		);

		const result = parseResult(await handlers.list_goals({ room_id: 'room-1' }));
		expect(result.total).toBe(1);
		expect((result.goals as Array<{ id: string }>)[0].id).toBe('g1');
	});

	it('returns error when room_id refers to non-existent room', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_goals({ room_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('filters by mission_type', async () => {
		const room = makeRoom();
		const goals = [
			makeGoal({ id: 'g1', missionType: 'one_shot' }),
			makeGoal({ id: 'g2', missionType: 'measurable' }),
			makeGoal({ id: 'g3', missionType: 'recurring' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': goals }),
			})
		);

		const result = parseResult(await handlers.list_goals({ mission_type: 'measurable' }));
		expect(result.total).toBe(1);
		expect((result.goals as Array<{ id: string }>)[0].id).toBe('g2');
	});

	it('includes nextRunAt and schedulePaused for recurring goals', async () => {
		const room = makeRoom();
		const goal = makeGoal({
			id: 'g1',
			missionType: 'recurring',
			nextRunAt: 9999,
			schedulePaused: true,
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': [goal] }),
			})
		);

		const result = parseResult(await handlers.list_goals({}));
		const goals = result.goals as Array<{ nextRunAt: number; schedulePaused: boolean }>;
		expect(goals[0].nextRunAt).toBe(9999);
		expect(goals[0].schedulePaused).toBe(true);
	});

	it('filters by search substring', async () => {
		const room = makeRoom();
		const goals = [
			makeGoal({ id: 'g1', title: 'Add health check' }),
			makeGoal({ id: 'g2', title: 'Fix login bug' }),
			makeGoal({ id: 'g3', title: 'Add logging' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': goals }),
			})
		);

		const result = parseResult(await handlers.list_goals({ search: 'Add' }));
		expect(result.total).toBe(2);
		const ids = (result.goals as Array<{ id: string }>).map((g) => g.id);
		expect(ids).toContain('g1');
		expect(ids).toContain('g3');
	});

	it('paginates with limit and offset', async () => {
		const room = makeRoom();
		const goals = Array.from({ length: 5 }, (_, i) =>
			makeGoal({ id: `g${i + 1}`, title: `Goal ${i + 1}` })
		);
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': goals }),
			})
		);

		const page1 = parseResult(await handlers.list_goals({ limit: 2, offset: 0 }));
		expect(page1.total).toBe(5);
		expect((page1.goals as unknown[]).length).toBe(2);

		const page3 = parseResult(await handlers.list_goals({ limit: 2, offset: 4 }));
		expect(page3.total).toBe(5);
		expect((page3.goals as unknown[]).length).toBe(1);
	});

	it('returns compact fields when compact:true', async () => {
		const room = makeRoom({ id: 'room-1' });
		const goal = makeGoal({ id: 'g1', title: 'My Goal', roomId: 'room-1' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({ 'room-1': [goal] }),
			})
		);

		const result = parseResult(await handlers.list_goals({ compact: true }));
		expect(result.total).toBe(1);
		const goals = result.goals as Array<Record<string, unknown>>;
		expect(goals[0].id).toBe('g1');
		expect(goals[0].roomId).toBe('room-1');
		expect(goals[0].title).toBe('My Goal');
		expect(goals[0].status).toBeDefined();
		expect(goals[0].priority).toBeDefined();
		expect(goals[0].missionType).toBeDefined();
		expect(goals[0].createdAt).toBeDefined();
		// Large fields excluded in compact mode
		expect(goals[0].roomName).toBeUndefined();
		expect(goals[0].linkedTaskCount).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// get_goal_details
// ---------------------------------------------------------------------------

describe('get_goal_details', () => {
	it('returns error when goal not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_goal_details({ goal_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns full goal details', async () => {
		const room = makeRoom({ id: 'room-1', name: 'Test Room' });
		const goal = makeGoal({
			id: 'g1',
			shortId: 'G001',
			title: 'My Goal',
			description: 'Goal description',
			status: 'active',
			structuredMetrics: [{ name: 'coverage', target: 80, current: 60, unit: '%' }],
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({}, { g1: goal }, {}),
			})
		);

		const result = parseResult(await handlers.get_goal_details({ goal_id: 'g1' }));
		expect(result.id).toBe('g1');
		expect(result.shortId).toBe('G001');
		expect(result.roomName).toBe('Test Room');
		expect(result.title).toBe('My Goal');
		expect(result.description).toBe('Goal description');
		expect(result.structuredMetrics).toHaveLength(1);
		expect(result.structuredMetrics[0].name).toBe('coverage');
		expect(result.executions).toEqual([]);
	});

	it('includes execution history', async () => {
		const room = makeRoom();
		const goal = makeGoal({ id: 'g1' });
		const executions = [
			makeExecution({ id: 'e1', executionNumber: 2, status: 'completed', completedAt: 9999 }),
			makeExecution({ id: 'e2', executionNumber: 1, status: 'completed' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({}, { g1: goal }, { g1: executions }),
			})
		);

		const result = parseResult(await handlers.get_goal_details({ goal_id: 'g1' }));
		expect(result.executions).toHaveLength(2);
		expect(result.executions[0].id).toBe('e1');
		expect(result.executions[0].executionNumber).toBe(2);
		expect(result.executions[0].completedAt).toBe(9999);
	});

	it('respects execution_limit', async () => {
		const room = makeRoom();
		const goal = makeGoal({ id: 'g1' });
		const executions = [1, 2, 3, 4, 5].map((n) =>
			makeExecution({ id: `e${n}`, executionNumber: n })
		);
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				goalRepository: makeGoalRepository({}, { g1: goal }, { g1: executions }),
			})
		);

		const result = parseResult(
			await handlers.get_goal_details({ goal_id: 'g1', execution_limit: 2 })
		);
		expect(result.executions).toHaveLength(2);
	});

	it('returns null roomName when room is not found', async () => {
		const goal = makeGoal({ id: 'g1', roomId: 'deleted-room' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				goalRepository: makeGoalRepository({}, { g1: goal }, {}),
			})
		);

		const result = parseResult(await handlers.get_goal_details({ goal_id: 'g1' }));
		expect(result.roomName).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// get_metrics
// ---------------------------------------------------------------------------

describe('get_metrics', () => {
	it('returns error when goal not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_metrics({ goal_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns error for non-measurable goal', async () => {
		const goal = makeGoal({ id: 'g1', missionType: 'one_shot' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				goalRepository: makeGoalRepository({}, { g1: goal }, {}),
			})
		);

		const result = parseResult(await handlers.get_metrics({ goal_id: 'g1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not a measurable mission');
	});

	it('returns metrics for measurable goal', async () => {
		const goal = makeGoal({
			id: 'g1',
			missionType: 'measurable',
			structuredMetrics: [
				{ name: 'coverage', target: 80, current: 60, unit: '%' },
				{
					name: 'errors',
					target: 0,
					current: 5,
					unit: 'count',
					direction: 'decrease',
					baseline: 20,
				},
			],
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				goalRepository: makeGoalRepository({}, { g1: goal }, {}),
			})
		);

		const result = parseResult(await handlers.get_metrics({ goal_id: 'g1' }));
		expect(result.goalId).toBe('g1');
		expect(result.missionType).toBe('measurable');
		expect(result.metrics).toHaveLength(2);

		const coverage = result.metrics[0];
		expect(coverage.name).toBe('coverage');
		expect(coverage.target).toBe(80);
		expect(coverage.current).toBe(60);
		expect(coverage.unit).toBe('%');
		// progress: 60/80 * 100 = 75
		expect(coverage.progressPct).toBe(75);

		const errors = result.metrics[1];
		expect(errors.name).toBe('errors');
		expect(errors.direction).toBe('decrease');
		// progress: (20-5)/(20-0) * 100 = 75
		expect(errors.progressPct).toBe(75);
	});

	it('handles goal with no structuredMetrics', async () => {
		const goal = makeGoal({ id: 'g1', missionType: 'measurable', structuredMetrics: [] });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				goalRepository: makeGoalRepository({}, { g1: goal }, {}),
			})
		);

		const result = parseResult(await handlers.get_metrics({ goal_id: 'g1' }));
		expect(result.metrics).toEqual([]);
	});

	it('returns 100% progress when decrease metric baseline equals target', async () => {
		const goal = makeGoal({
			id: 'g1',
			missionType: 'measurable',
			// baseline === target means the goal was already at its target when created
			structuredMetrics: [
				{ name: 'errors', target: 0, current: 0, direction: 'decrease', baseline: 0 },
			],
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				goalRepository: makeGoalRepository({}, { g1: goal }, {}),
			})
		);

		const result = parseResult(await handlers.get_metrics({ goal_id: 'g1' }));
		expect(result.metrics[0].progressPct).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

describe('list_tasks', () => {
	it('returns empty array when no tasks exist', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_tasks({}));
		expect(result.success).toBe(true);
		expect(result.total).toBe(0);
		expect(result.tasks).toEqual([]);
	});

	it('returns tasks across all rooms when no room_id filter', async () => {
		const room1 = makeRoom({ id: 'room-1', name: 'Room 1' });
		const room2 = makeRoom({ id: 'room-2', name: 'Room 2' });
		const task1 = makeTask({ id: 't1', roomId: 'room-1' });
		const task2 = makeTask({ id: 't2', roomId: 'room-2' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room1, room2]),
				taskRepository: makeTaskRepository({ 'room-1': [task1], 'room-2': [task2] }),
			})
		);

		const result = parseResult(await handlers.list_tasks({}));
		expect(result.total).toBe(2);
		expect((result.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(
			expect.arrayContaining(['t1', 't2'])
		);
	});

	it('includes roomName in each task', async () => {
		const room = makeRoom({ id: 'room-1', name: 'My Room' });
		const task = makeTask({ id: 't1', roomId: 'room-1' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': [task] }),
			})
		);

		const result = parseResult(await handlers.list_tasks({}));
		expect((result.tasks as Array<{ roomName: string }>)[0].roomName).toBe('My Room');
	});

	it('filters to a specific room when room_id is provided', async () => {
		const room1 = makeRoom({ id: 'room-1', name: 'Room 1' });
		const room2 = makeRoom({ id: 'room-2', name: 'Room 2' });
		const task1 = makeTask({ id: 't1', roomId: 'room-1' });
		const task2 = makeTask({ id: 't2', roomId: 'room-2' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room1, room2]),
				taskRepository: makeTaskRepository({ 'room-1': [task1], 'room-2': [task2] }),
			})
		);

		const result = parseResult(await handlers.list_tasks({ room_id: 'room-1' }));
		expect(result.total).toBe(1);
		expect((result.tasks as Array<{ id: string }>)[0].id).toBe('t1');
	});

	it('returns error when room_id refers to non-existent room', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.list_tasks({ room_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('filters by status', async () => {
		const room = makeRoom();
		const tasks = [
			makeTask({ id: 't1', status: 'pending' }),
			makeTask({ id: 't2', status: 'in_progress' }),
			makeTask({ id: 't3', status: 'completed' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		const result = parseResult(await handlers.list_tasks({ status: 'pending' }));
		expect(result.total).toBe(1);
		expect((result.tasks as Array<{ id: string }>)[0].id).toBe('t1');
	});

	it('filters by assigned_agent', async () => {
		const room = makeRoom();
		const tasks = [
			makeTask({ id: 't1', assignedAgent: 'coder' }),
			makeTask({ id: 't2', assignedAgent: 'general' }),
			makeTask({ id: 't3', assignedAgent: 'planner' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		const result = parseResult(await handlers.list_tasks({ assigned_agent: 'planner' }));
		expect(result.total).toBe(1);
		expect((result.tasks as Array<{ id: string }>)[0].id).toBe('t3');
	});

	it('excludes archived tasks by default', async () => {
		const room = makeRoom();
		const tasks = [
			makeTask({ id: 't1', status: 'pending' }),
			makeTask({ id: 't2', status: 'archived' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		const result = parseResult(await handlers.list_tasks({}));
		expect(result.total).toBe(1);
		expect((result.tasks as Array<{ id: string }>)[0].id).toBe('t1');
	});

	it('includes archived tasks when include_archived is true', async () => {
		const room = makeRoom();
		const tasks = [
			makeTask({ id: 't1', status: 'pending' }),
			makeTask({ id: 't2', status: 'archived' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		const result = parseResult(await handlers.list_tasks({ include_archived: true }));
		expect(result.total).toBe(2);
	});

	it('auto-enables include_archived when status="archived" to avoid zero results', async () => {
		const room = makeRoom();
		const tasks = [
			makeTask({ id: 't1', status: 'pending' }),
			makeTask({ id: 't2', status: 'archived' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		// Without auto-include fix, requesting archived status would return zero results
		const result = parseResult(await handlers.list_tasks({ status: 'archived' }));
		expect(result.total).toBe(1);
		expect((result.tasks as Array<{ id: string }>)[0].id).toBe('t2');
	});

	it('filters by search substring', async () => {
		const room = makeRoom();
		const tasks = [
			makeTask({ id: 't1', title: 'Implement login' }),
			makeTask({ id: 't2', title: 'Fix login bug' }),
			makeTask({ id: 't3', title: 'Add tests' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		const result = parseResult(await handlers.list_tasks({ search: 'login' }));
		expect(result.total).toBe(2);
		const ids = (result.tasks as Array<{ id: string }>).map((t) => t.id);
		expect(ids).toContain('t1');
		expect(ids).toContain('t2');
	});

	it('paginates with limit and offset', async () => {
		const room = makeRoom();
		const tasks = Array.from({ length: 5 }, (_, i) =>
			makeTask({ id: `t${i + 1}`, title: `Task ${i + 1}` })
		);
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': tasks }),
			})
		);

		const page1 = parseResult(await handlers.list_tasks({ limit: 2, offset: 0 }));
		expect(page1.total).toBe(5);
		expect((page1.tasks as unknown[]).length).toBe(2);

		const page3 = parseResult(await handlers.list_tasks({ limit: 2, offset: 4 }));
		expect(page3.total).toBe(5);
		expect((page3.tasks as unknown[]).length).toBe(1);
	});

	it('returns compact fields when compact:true', async () => {
		const room = makeRoom();
		const task = makeTask({ id: 't1', title: 'My Task' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({ 'room-1': [task] }),
			})
		);

		const result = parseResult(await handlers.list_tasks({ compact: true }));
		expect(result.total).toBe(1);
		const tasks = result.tasks as Array<Record<string, unknown>>;
		expect(tasks[0].id).toBe('t1');
		expect(tasks[0].title).toBe('My Task');
		expect(tasks[0].status).toBeDefined();
		expect(tasks[0].priority).toBeDefined();
		expect(tasks[0].taskType).toBeDefined();
		expect(tasks[0].assignedAgent).toBeDefined();
		expect(tasks[0].createdAt).toBeDefined();
		// Large fields excluded in compact mode
		expect(tasks[0].roomName).toBeUndefined();
		expect(tasks[0].prUrl).toBeUndefined();
		expect(tasks[0].progress).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// get_task_detail
// ---------------------------------------------------------------------------

describe('get_task_detail', () => {
	it('returns error when task not found', async () => {
		const handlers = createNeoQueryToolHandlers(makeConfig());
		const result = parseResult(await handlers.get_task_detail({ task_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('missing');
	});

	it('returns full task details', async () => {
		const room = makeRoom({ id: 'room-1', name: 'Test Room' });
		const task = makeTask({
			id: 't1',
			shortId: 'T001',
			title: 'My Task',
			description: 'Task description',
			status: 'in_progress',
			priority: 'high',
			taskType: 'coding',
			assignedAgent: 'coder',
			dependsOn: ['dep-1'],
			prUrl: 'https://github.com/org/repo/pulls/42',
			prNumber: 42,
		});
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room]),
				taskRepository: makeTaskRepository({}, { t1: task }),
			})
		);

		const result = parseResult(await handlers.get_task_detail({ task_id: 't1' }));
		expect(result.id).toBe('t1');
		expect(result.shortId).toBe('T001');
		expect(result.roomName).toBe('Test Room');
		expect(result.title).toBe('My Task');
		expect(result.description).toBe('Task description');
		expect(result.status).toBe('in_progress');
		expect(result.priority).toBe('high');
		expect(result.dependsOn).toEqual(['dep-1']);
		expect(result.prUrl).toBe('https://github.com/org/repo/pulls/42');
		expect(result.prNumber).toBe(42);
	});

	it('returns null for optional fields when unset', async () => {
		const task = makeTask({ id: 't1' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				taskRepository: makeTaskRepository({}, { t1: task }),
			})
		);

		const result = parseResult(await handlers.get_task_detail({ task_id: 't1' }));
		expect(result.shortId).toBeNull();
		expect(result.roomName).toBeNull();
		expect(result.progress).toBeNull();
		expect(result.currentStep).toBeNull();
		expect(result.result).toBeNull();
		expect(result.error).toBeNull();
		expect(result.prUrl).toBeNull();
		expect(result.prNumber).toBeNull();
		expect(result.startedAt).toBeNull();
		expect(result.completedAt).toBeNull();
		expect(result.archivedAt).toBeNull();
		expect(result.restrictions).toBeNull();
	});

	it('includes createdByTaskId when set', async () => {
		const task = makeTask({ id: 't1', createdByTaskId: 'parent-task' });
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				taskRepository: makeTaskRepository({}, { t1: task }),
			})
		);

		const result = parseResult(await handlers.get_task_detail({ task_id: 't1' }));
		expect(result.createdByTaskId).toBe('parent-task');
	});
});

// ---------------------------------------------------------------------------
// MCP server — tool registration
// ---------------------------------------------------------------------------

describe('createNeoQueryMcpServer', () => {
	let server: ReturnType<typeof createNeoQueryMcpServer>;

	beforeEach(() => {
		server = createNeoQueryMcpServer(makeConfig());
	});

	it('names the MCP server "neo-query"', () => {
		expect(server.name).toBe('neo-query');
	});

	it('registers list_rooms tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_rooms');
	});

	it('registers get_room_status tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_room_status');
	});

	it('registers get_room_details tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_room_details');
	});

	it('registers get_system_info tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_system_info');
	});

	it('registers get_app_settings tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_app_settings');
	});

	it('registers list_mcp_servers tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_mcp_servers');
	});

	it('registers get_mcp_server_status tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_mcp_server_status');
	});

	it('registers list_skills tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_skills');
	});

	it('registers get_skill_details tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_skill_details');
	});

	it('registers list_spaces tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_spaces');
	});

	it('registers get_space_status tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_space_status');
	});

	it('registers get_space_details tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_space_details');
	});

	it('registers list_space_agents tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_space_agents');
	});

	it('registers list_space_workflows tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_space_workflows');
	});

	it('registers list_space_runs tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_space_runs');
	});

	it('registers list_goals tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_goals');
	});

	it('registers get_goal_details tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_goal_details');
	});

	it('registers get_metrics tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_metrics');
	});

	it('registers list_tasks tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('list_tasks');
	});

	it('registers get_task_detail tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('get_task_detail');
	});

	it('registers exactly 20 tools', () => {
		expect(Object.keys(server.instance._registeredTools)).toHaveLength(20);
	});
});
