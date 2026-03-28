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
 * - MCP server: all 15 tools are registered
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
	createNeoQueryToolHandlers,
	createNeoQueryMcpServer,
	type NeoToolsConfig,
	type NeoQueryRoomManager,
	type NeoQueryGoalRepository,
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
} from '../../../src/lib/neo/tools/neo-query-tools';
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
			return { room, sessions: [], activeTasks: [], allTasks: [] };
		},
	};
}

function makeGoalRepository(goalsByRoom: Record<string, RoomGoal[]> = {}): NeoQueryGoalRepository {
	return {
		listGoals: (roomId) => goalsByRoom[roomId] ?? [],
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
		role: 'coder',
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
		rules: [],
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
		status: 'completed',
		iterationCount: 0,
		maxIterations: 10,
		createdAt: NOW - 3_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeSpaceTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		spaceTaskNumber: 1,
		title: 'Test Task',
		description: 'A test task',
		status: 'pending',
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
		const activeTasks = [{ id: 'task-1', title: 'Task 1', status: 'in_progress' }];
		const sessions = [{ id: 'session-1', title: 'Session 1', status: 'active', lastActiveAt: NOW }];

		const overview = { room, sessions, activeTasks, allTasks: activeTasks };
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				roomManager: makeRoomManager([room], overview),
				goalRepository: makeGoalRepository({ 'room-1': goals }),
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

// ---------------------------------------------------------------------------
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
			makeWorkflowRun({ id: 'r2', status: 'needs_attention' }),
			makeWorkflowRun({ id: 'r3', status: 'completed' }),
		];
		const tasks = [
			makeSpaceTask({ id: 't1', status: 'pending' }),
			makeSpaceTask({ id: 't2', status: 'pending' }),
			makeSpaceTask({ id: 't3', status: 'completed' }),
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
		expect(result.taskCountByStatus.pending).toBe(2);
		expect(result.taskCountByStatus.completed).toBe(1);
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
		const agents = [makeSpaceAgent({ name: 'Coder', role: 'coder' })];
		const workflows = [makeSpaceWorkflow({ name: 'Dev Workflow', nodes: [{ id: 'n1' } as never] })];
		const runs = [
			makeWorkflowRun({ id: 'r1', status: 'completed', createdAt: NOW - 1000 }),
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
		expect(result.agents[0].role).toBe('coder');
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
				role: 'coder',
				model: 'claude-haiku-4-5',
				description: 'Writes code',
			}),
			makeSpaceAgent({ id: 'a2', name: 'Planner', role: 'planner' }),
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
		expect(result[0].role).toBe('coder');
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
			makeWorkflowRun({ id: 'r1', status: 'completed' }),
			makeWorkflowRun({ id: 'r2', status: 'in_progress' }),
			makeWorkflowRun({ id: 'r3', status: 'completed' }),
		];
		const handlers = createNeoQueryToolHandlers(
			makeConfig({
				spaceManager: makeSpaceManager([space]),
				workflowRunRepository: makeWorkflowRunRepository({ 'space-1': runs }),
			})
		);

		const result = parseResult(
			await handlers.list_space_runs({ space_id: 'space-1', status: 'completed' })
		);
		expect(result).toHaveLength(2);
		expect(result.every((r: { status: string }) => r.status === 'completed')).toBe(true);
	});

	it('returns run fields including goalId and completedAt', async () => {
		const space = makeSpace();
		const runs = [
			makeWorkflowRun({
				id: 'r1',
				title: 'My Run',
				description: 'A run',
				status: 'completed',
				workflowId: 'wf-1',
				goalId: 'goal-1',
				completedAt: NOW,
				iterationCount: 2,
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
		expect(run.goalId).toBe('goal-1');
		expect(run.completedAt).toBe(NOW);
		expect(run.iterationCount).toBe(2);
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

	it('registers exactly 15 tools', () => {
		expect(Object.keys(server.instance._registeredTools)).toHaveLength(15);
	});
});
