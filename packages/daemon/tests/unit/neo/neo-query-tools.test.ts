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
 * - MCP server: all 5 tools are registered
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
} from '../../../src/lib/neo/tools/neo-query-tools';
import type { Room, RoomGoal } from '@neokai/shared';

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

function makeConfig(overrides: Partial<NeoToolsConfig> = {}): NeoToolsConfig {
	return {
		roomManager: makeRoomManager(),
		goalRepository: makeGoalRepository(),
		sessionManager: makeSessionManager(),
		settingsManager: makeSettingsManager(),
		authManager: makeAuthManager(true),
		workspaceRoot: '/workspace',
		appVersion: '0.1.1',
		startedAt: NOW - 60_000,
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

	it('registers exactly 5 tools', () => {
		expect(Object.keys(server.instance._registeredTools)).toHaveLength(5);
	});
});
