/**
 * Tests for RoomRuntimeService MCP integration.
 *
 * Verifies that:
 * 1. Registry-sourced MCP servers are merged into the final mcpServers map
 *    passed to setRuntimeMcpServers() alongside file-based servers.
 * 2. room-agent-tools always takes precedence (applied last).
 * 3. On mcp.registry.changed, all live room chat sessions are updated.
 */

import { describe, expect, it } from 'bun:test';
import {
	RoomRuntimeService,
	type RoomRuntimeServiceConfig,
} from '../../../../src/lib/room/runtime/room-runtime-service';
import type { McpServerConfig, Room } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DaemonHubListener = (event: Record<string, unknown>) => void;

/** Minimal daemonHub mock that tracks subscriptions and allows manual event emission */
function makeDaemonHub() {
	const listeners = new Map<string, DaemonHubListener[]>();

	return {
		on: (event: string, handler: DaemonHubListener) => {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event)!.push(handler);
			return () => {
				const arr = listeners.get(event);
				if (arr) {
					const idx = arr.indexOf(handler);
					if (idx !== -1) arr.splice(idx, 1);
				}
			};
		},
		emit: async (event: string, payload: Record<string, unknown>) => {
			for (const handler of listeners.get(event) ?? []) {
				handler(payload);
			}
		},
	};
}

function makeRoomManager(rooms: Room[] = []) {
	const byId = new Map(rooms.map((r) => [r.id, r]));
	return {
		listRooms: () => rooms,
		getRoom: (id: string) => byId.get(id) ?? null,
		updateRoom: () => null,
	};
}

function makeRoom(id: string): Room {
	return {
		id,
		name: `Room ${id}`,
		allowedPaths: [{ path: '/tmp' }],
		defaultPath: '/tmp',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeConfig(overrides: Partial<RoomRuntimeServiceConfig> = {}): RoomRuntimeServiceConfig {
	return {
		db: {} as never,
		messageHub: {} as never,
		daemonHub: makeDaemonHub() as never,
		getApiKey: async () => null,
		roomManager: makeRoomManager() as never,
		sessionManager: {} as never,
		defaultWorkspacePath: '/tmp',
		defaultModel: 'test-model',
		getGlobalSettings: () => ({}) as never,
		settingsManager: { getEnabledMcpServersConfig: () => ({}) } as never,
		reactiveDb: {} as never,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests: initial MCP merge in setupRoomAgentSession
// ---------------------------------------------------------------------------

describe('RoomRuntimeService MCP merge — setupRoomAgentSession', () => {
	it('includes registry-sourced servers in the map passed to setRuntimeMcpServers', async () => {
		const registryServer: McpServerConfig = { type: 'stdio', command: 'npx', args: ['my-mcp'] };

		const appMcpManager = {
			getEnabledMcpConfigs: () => ({ 'registry-server': registryServer }),
			getEnabledMcpConfigsForRoom: () => ({ 'registry-server': registryServer }),
			getEnabledMcpConfigsForSession: () => ({ 'registry-server': registryServer }),
		};

		const setRuntimeMcpServersCalls: Array<Record<string, McpServerConfig>> = [];

		const roomChatSession = {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.push(map);
			},
			setRuntimeSystemPrompt: () => {},
			getSessionData: () => ({
				config: { model: 'test-model', provider: 'anthropic' },
			}),
		};

		const sessionManager = {
			getSessionAsync: async (id: string) => {
				if (id.startsWith('room:chat:')) return roomChatSession;
				return null;
			},
			updateSession: async () => {},

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-1');
		const roomManager = makeRoomManager([room]);

		const service = new RoomRuntimeService(
			makeConfig({
				appMcpManager: appMcpManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
			})
		);

		// Call setupRoomAgentSession via the private method (test-only access)
		const serviceAny = service as unknown as {
			setupRoomAgentSession: (
				room: Room,
				groupRepo: unknown,
				taskManager: unknown,
				goalManager: unknown
			) => void;
		};

		// Provide minimal stubs for the repos/managers passed into setupRoomAgentSession
		const groupRepo = {
			getActiveGroups: () => [],
		};
		const taskManager = {
			getTask: () => null,
			listTasks: () => [],
		};
		const goalManager = {
			getGoal: () => null,
			listGoals: () => [],
		};

		serviceAny.setupRoomAgentSession(room, groupRepo, taskManager, goalManager);

		// Wait for the async getSessionAsync promise to resolve
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setRuntimeMcpServersCalls.length).toBeGreaterThanOrEqual(1);
		const finalMap = setRuntimeMcpServersCalls[setRuntimeMcpServersCalls.length - 1]!;

		// Registry server must be present
		expect(finalMap['registry-server']).toEqual(registryServer);
		// room-agent-tools must always be present (in-process server)
		expect(finalMap['room-agent-tools']).toBeDefined();
	});

	it('room-agent-tools takes precedence over a registry entry with the same name', async () => {
		// Simulate a registry entry with the reserved name 'room-agent-tools'
		const conflictingServer: McpServerConfig = {
			type: 'stdio',
			command: 'should-be-overridden',
		};

		const appMcpManager = {
			getEnabledMcpConfigs: () => ({ 'room-agent-tools': conflictingServer }),
			getEnabledMcpConfigsForRoom: () => ({ 'room-agent-tools': conflictingServer }),
			getEnabledMcpConfigsForSession: () => ({ 'room-agent-tools': conflictingServer }),
		};

		const setRuntimeMcpServersCalls: Array<Record<string, McpServerConfig>> = [];

		const roomChatSession = {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.push(map);
			},
			setRuntimeSystemPrompt: () => {},
			getSessionData: () => ({
				config: { model: 'test-model', provider: 'anthropic' },
			}),
		};

		const sessionManager = {
			getSessionAsync: async (id: string) => {
				if (id.startsWith('room:chat:')) return roomChatSession;
				return null;
			},
			updateSession: async () => {},

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-2');
		const roomManager = makeRoomManager([room]);

		const service = new RoomRuntimeService(
			makeConfig({
				appMcpManager: appMcpManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
			})
		);

		const serviceAny = service as unknown as {
			setupRoomAgentSession: (
				room: Room,
				groupRepo: unknown,
				taskManager: unknown,
				goalManager: unknown
			) => void;
		};

		serviceAny.setupRoomAgentSession(
			room,
			{ getActiveGroups: () => [] },
			{ getTask: () => null, listTasks: () => [] },
			{ getGoal: () => null, listGoals: () => [] }
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setRuntimeMcpServersCalls.length).toBeGreaterThanOrEqual(1);
		const finalMap = setRuntimeMcpServersCalls[setRuntimeMcpServersCalls.length - 1]!;

		// room-agent-tools must NOT be the conflicting registry entry
		expect(
			(finalMap['room-agent-tools'] as McpServerConfig & { command?: string }).command
		).not.toBe('should-be-overridden');
	});

	it('merges file-based servers alongside registry servers', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-server' };
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-server' };

		const appMcpManager = {
			getEnabledMcpConfigs: () => ({ 'registry-mcp': registryServer }),
			getEnabledMcpConfigsForRoom: () => ({ 'registry-mcp': registryServer }),
			getEnabledMcpConfigsForSession: () => ({ 'registry-mcp': registryServer }),
		};

		const settingsManager = {
			getEnabledMcpServersConfig: () => ({ 'file-mcp': fileServer }),
		};

		const setRuntimeMcpServersCalls: Array<Record<string, McpServerConfig>> = [];

		const roomChatSession = {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.push(map);
			},
			setRuntimeSystemPrompt: () => {},
			getSessionData: () => ({
				config: { model: 'test-model', provider: 'anthropic' },
			}),
		};

		const sessionManager = {
			getSessionAsync: async (id: string) => {
				if (id.startsWith('room:chat:')) return roomChatSession;
				return null;
			},
			updateSession: async () => {},

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-3');
		const roomManager = makeRoomManager([room]);

		const service = new RoomRuntimeService(
			makeConfig({
				appMcpManager: appMcpManager as never,
				settingsManager: settingsManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
			})
		);

		const serviceAny = service as unknown as {
			setupRoomAgentSession: (
				room: Room,
				groupRepo: unknown,
				taskManager: unknown,
				goalManager: unknown
			) => void;
		};

		serviceAny.setupRoomAgentSession(
			room,
			{ getActiveGroups: () => [] },
			{ getTask: () => null, listTasks: () => [] },
			{ getGoal: () => null, listGoals: () => [] }
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setRuntimeMcpServersCalls.length).toBeGreaterThanOrEqual(1);
		const finalMap = setRuntimeMcpServersCalls[setRuntimeMcpServersCalls.length - 1]!;

		expect(finalMap['file-mcp']).toEqual(fileServer);
		expect(finalMap['registry-mcp']).toEqual(registryServer);
		expect(finalMap['room-agent-tools']).toBeDefined();
	});

	it('works without appMcpManager (optional field)', async () => {
		// No appMcpManager provided — should not throw and file-based + room-agent-tools still applied
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-server' };

		const settingsManager = {
			getEnabledMcpServersConfig: () => ({ 'file-mcp': fileServer }),
		};

		const setRuntimeMcpServersCalls: Array<Record<string, McpServerConfig>> = [];

		const roomChatSession = {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.push(map);
			},
			setRuntimeSystemPrompt: () => {},
			getSessionData: () => ({
				config: { model: 'test-model', provider: 'anthropic' },
			}),
		};

		const sessionManager = {
			getSessionAsync: async (id: string) => {
				if (id.startsWith('room:chat:')) return roomChatSession;
				return null;
			},
			updateSession: async () => {},

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-4');
		const roomManager = makeRoomManager([room]);

		const service = new RoomRuntimeService(
			makeConfig({
				// appMcpManager intentionally omitted
				settingsManager: settingsManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
			})
		);

		const serviceAny = service as unknown as {
			setupRoomAgentSession: (
				room: Room,
				groupRepo: unknown,
				taskManager: unknown,
				goalManager: unknown
			) => void;
		};

		serviceAny.setupRoomAgentSession(
			room,
			{ getActiveGroups: () => [] },
			{ getTask: () => null, listTasks: () => [] },
			{ getGoal: () => null, listGoals: () => [] }
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setRuntimeMcpServersCalls.length).toBeGreaterThanOrEqual(1);
		const finalMap = setRuntimeMcpServersCalls[setRuntimeMcpServersCalls.length - 1]!;

		expect(finalMap['file-mcp']).toEqual(fileServer);
		expect(finalMap['room-agent-tools']).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: mcp.registry.changed hot-reload
// ---------------------------------------------------------------------------

describe('RoomRuntimeService — mcp.registry.changed hot-reload', () => {
	it('re-applies MCP configs to live room chat sessions when registry changes', async () => {
		const daemonHub = makeDaemonHub();
		const registryServer: McpServerConfig = { type: 'stdio', command: 'new-registry-server' };

		const appMcpManager = {
			getEnabledMcpConfigs: () => ({ 'hot-server': registryServer }),
			getEnabledMcpConfigsForRoom: () => ({ 'hot-server': registryServer }),
			getEnabledMcpConfigsForSession: () => ({ 'hot-server': registryServer }),
		};

		const setRuntimeMcpServersCalls: Array<Record<string, McpServerConfig>> = [];

		const roomChatSession = {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.push(map);
			},
			setRuntimeSystemPrompt: () => {},
			getSessionData: () => ({
				config: { model: 'test-model', provider: 'anthropic' },
			}),
		};

		const sessionManager = {
			getSessionAsync: async (id: string) => {
				if (id.startsWith('room:chat:')) return roomChatSession;
				return null;
			},
			updateSession: async () => {},

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-hot');
		const roomManager = makeRoomManager([room]);

		const service = new RoomRuntimeService(
			makeConfig({
				appMcpManager: appMcpManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
				daemonHub: daemonHub as never,
			})
		);

		// Manually inject the runtime and room-agent-tools server into the private maps
		// so the registry.changed handler sees a live room without going through full startup.
		const serviceAny = service as unknown as {
			runtimes: Map<string, unknown>;
			roomAgentMcpServers: Map<string, McpServerConfig>;
		};

		const mockRuntime = {
			start: () => {},
			stop: () => {},
			getState: () => 'running',
		};
		serviceAny.runtimes.set('room-hot', mockRuntime);

		const roomAgentToolsServer: McpServerConfig = {
			type: 'stdio',
			command: 'room-agent-tools-cmd',
		};
		serviceAny.roomAgentMcpServers.set('room-hot', roomAgentToolsServer);

		// Subscribe to events (wires up the mcp.registry.changed listener)
		const servicePrivate = service as unknown as { subscribeToEvents: () => void };
		servicePrivate.subscribeToEvents();

		// Emit mcp.registry.changed
		await daemonHub.emit('mcp.registry.changed', { sessionId: 'global' });

		// Wait for the async session lookup to resolve
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setRuntimeMcpServersCalls.length).toBeGreaterThanOrEqual(1);
		const updatedMap = setRuntimeMcpServersCalls[setRuntimeMcpServersCalls.length - 1]!;

		// Registry-sourced server must be in the updated map
		expect(updatedMap['hot-server']).toEqual(registryServer);
		// room-agent-tools must be included from the cached server
		expect(updatedMap['room-agent-tools']).toEqual(roomAgentToolsServer);
	});

	it('skips rooms that have no cached room-agent-tools server but still applies other servers', async () => {
		const daemonHub = makeDaemonHub();
		const registryServer: McpServerConfig = { type: 'stdio', command: 'reg-server' };

		const appMcpManager = {
			getEnabledMcpConfigs: () => ({ 'reg-server': registryServer }),
			getEnabledMcpConfigsForRoom: () => ({ 'reg-server': registryServer }),
			getEnabledMcpConfigsForSession: () => ({ 'reg-server': registryServer }),
		};

		const setRuntimeMcpServersCalls: Array<Record<string, McpServerConfig>> = [];

		const roomChatSession = {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.push(map);
			},
			setRuntimeSystemPrompt: () => {},
			getSessionData: () => ({
				config: { model: 'test-model', provider: 'anthropic' },
			}),
		};

		const sessionManager = {
			getSessionAsync: async (id: string) => {
				if (id.startsWith('room:chat:')) return roomChatSession;
				return null;
			},
			updateSession: async () => {},

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-no-agent-tools');
		const roomManager = makeRoomManager([room]);

		const service = new RoomRuntimeService(
			makeConfig({
				appMcpManager: appMcpManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
				daemonHub: daemonHub as never,
			})
		);

		const serviceAny = service as unknown as {
			runtimes: Map<string, unknown>;
			roomAgentMcpServers: Map<string, McpServerConfig>;
		};

		// Inject a runtime but NO room-agent-tools entry in the cache
		serviceAny.runtimes.set('room-no-agent-tools', {
			start: () => {},
			stop: () => {},
			getState: () => 'running',
		});
		// roomAgentMcpServers map is intentionally left empty for this room

		const servicePrivate = service as unknown as { subscribeToEvents: () => void };
		servicePrivate.subscribeToEvents();

		await daemonHub.emit('mcp.registry.changed', { sessionId: 'global' });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setRuntimeMcpServersCalls.length).toBeGreaterThanOrEqual(1);
		const updatedMap = setRuntimeMcpServersCalls[setRuntimeMcpServersCalls.length - 1]!;

		// Registry server is still applied
		expect(updatedMap['reg-server']).toEqual(registryServer);
		// room-agent-tools is absent because it's not cached
		expect(updatedMap['room-agent-tools']).toBeUndefined();
	});

	it('does not call setRuntimeMcpServers for rooms with no live session', async () => {
		const daemonHub = makeDaemonHub();

		const sessionManager = {
			// Always returns null — no session found
			getSessionAsync: async () => null,

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-no-session');
		const roomManager = makeRoomManager([room]);

		const appMcpManager = {
			getEnabledMcpConfigs: () => ({}),
			getEnabledMcpConfigsForRoom: () => ({}),
			getEnabledMcpConfigsForSession: () => ({}),
		};

		const service = new RoomRuntimeService(
			makeConfig({
				appMcpManager: appMcpManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
				daemonHub: daemonHub as never,
			})
		);

		const serviceAny = service as unknown as {
			runtimes: Map<string, unknown>;
		};
		serviceAny.runtimes.set('room-no-session', {
			start: () => {},
			stop: () => {},
			getState: () => 'running',
		});

		const servicePrivate = service as unknown as { subscribeToEvents: () => void };
		servicePrivate.subscribeToEvents();

		// Should not throw even if session is missing
		await daemonHub.emit('mcp.registry.changed', { sessionId: 'global' });
		await new Promise((resolve) => setTimeout(resolve, 10));
		// No assertion on calls — just verifying no error is thrown
	});
});

// ---------------------------------------------------------------------------
// Tests: registry wins over file on name collision
// ---------------------------------------------------------------------------

describe('RoomRuntimeService MCP merge — collision resolution', () => {
	it('registry-sourced server wins over file-based server on same name', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-cmd' };
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-cmd' };

		const appMcpManager = {
			getEnabledMcpConfigs: () => ({ 'shared-name': registryServer }),
			getEnabledMcpConfigsForRoom: () => ({ 'shared-name': registryServer }),
			getEnabledMcpConfigsForSession: () => ({ 'shared-name': registryServer }),
		};

		const settingsManager = {
			getEnabledMcpServersConfig: () => ({ 'shared-name': fileServer }),
		};

		const setRuntimeMcpServersCalls: Array<Record<string, McpServerConfig>> = [];

		const roomChatSession = {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.push(map);
			},
			setRuntimeSystemPrompt: () => {},
			getSessionData: () => ({
				config: { model: 'test-model', provider: 'anthropic' },
			}),
		};

		const sessionManager = {
			getSessionAsync: async (id: string) => {
				if (id.startsWith('room:chat:')) return roomChatSession;
				return null;
			},
			updateSession: async () => {},

			registerSession: () => {},
			unregisterSession: () => {},
		};

		const room = makeRoom('room-collision');
		const roomManager = makeRoomManager([room]);

		const service = new RoomRuntimeService(
			makeConfig({
				appMcpManager: appMcpManager as never,
				settingsManager: settingsManager as never,
				sessionManager: sessionManager as never,
				roomManager: roomManager as never,
			})
		);

		const serviceAny = service as unknown as {
			setupRoomAgentSession: (
				room: Room,
				groupRepo: unknown,
				taskManager: unknown,
				goalManager: unknown
			) => void;
		};

		serviceAny.setupRoomAgentSession(
			room,
			{ getActiveGroups: () => [] },
			{ getTask: () => null, listTasks: () => [] },
			{ getGoal: () => null, listGoals: () => [] }
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setRuntimeMcpServersCalls.length).toBeGreaterThanOrEqual(1);
		const finalMap = setRuntimeMcpServersCalls[setRuntimeMcpServersCalls.length - 1]!;

		// Registry wins on name collision with file-based
		expect((finalMap['shared-name'] as McpServerConfig & { command?: string }).command).toBe(
			'registry-cmd'
		);
	});
});
