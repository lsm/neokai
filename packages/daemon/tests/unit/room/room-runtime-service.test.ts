import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	RoomRuntimeService,
	type RoomRuntimeServiceConfig,
} from '../../../src/lib/room/runtime/room-runtime-service';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { Room } from '@neokai/shared';
import type { SettingsManager } from '../../../src/lib/settings-manager';

describe('RoomRuntimeService', () => {
	let service: RoomRuntimeService;
	let mockRoomManager: RoomManager;
	let mockSettingsManager: SettingsManager;

	// Helper to create a room mock
	function makeRoom(overrides: Partial<Room> = {}): Room {
		return {
			id: 'room-1',
			name: 'Test Room',
			allowedPaths: [],
			defaultPath: undefined,
			defaultModel: undefined,
			allowedModels: undefined,
			sessionIds: [],
			status: 'active',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		};
	}

	beforeEach(() => {
		mockRoomManager = {
			getRoom: () => null,
		} as unknown as RoomManager;

		mockSettingsManager = {
			getProjectMcpServersConfig: mock(() => ({})),
		} as unknown as SettingsManager;

		const config: RoomRuntimeServiceConfig = {
			db: {} as never,
			messageHub: {} as never,
			daemonHub: {} as never,
			getApiKey: async () => null,
			roomManager: mockRoomManager,
			sessionManager: {} as never,
			defaultWorkspacePath: '/tmp',
			defaultModel: 'global-default-model',
			getGlobalSettings: () => ({}) as never,
			settingsManager: mockSettingsManager,
			reactiveDb: {} as never,
		};

		service = new RoomRuntimeService(config);
	});

	describe('getLeaderModel', () => {
		it('should return null for non-existent room', () => {
			const result = service.getLeaderModel('non-existent');
			expect(result).toBeNull();
		});

		it('should return global default when room has no defaultModel and no agentModels', () => {
			mockRoomManager.getRoom = () => makeRoom();

			const result = service.getLeaderModel('room-1');
			expect(result).toBe('global-default-model');
		});

		it('should return room.defaultModel when agentModels.leader is not set', () => {
			mockRoomManager.getRoom = () => makeRoom({ defaultModel: 'room-default-model' });

			const result = service.getLeaderModel('room-1');
			expect(result).toBe('room-default-model');
		});

		it('should prefer agentModels.leader over room.defaultModel', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default-model',
					config: { agentModels: { leader: 'leader-specific-model' } },
				});

			const result = service.getLeaderModel('room-1');
			expect(result).toBe('leader-specific-model');
		});

		it('should use agentModels.leader even when empty string (explicit override)', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default-model',
					config: { agentModels: { leader: '' } },
				});

			const result = service.getLeaderModel('room-1');
			// Empty string is a valid value - intentional override
			expect(result).toBe('');
		});
	});

	describe('getWorkerModel', () => {
		it('should return null for non-existent room', () => {
			const result = service.getWorkerModel('non-existent');
			expect(result).toBeNull();
		});

		it('should return global default when room has no defaultModel and no agentModels', () => {
			mockRoomManager.getRoom = () => makeRoom();

			const result = service.getWorkerModel('room-1');
			expect(result).toBe('global-default-model');
		});

		it('should return room.defaultModel when agentModels.worker is not set', () => {
			mockRoomManager.getRoom = () => makeRoom({ defaultModel: 'room-default-model' });

			const result = service.getWorkerModel('room-1');
			expect(result).toBe('room-default-model');
		});

		it('should prefer agentModels.worker over room.defaultModel', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default-model',
					config: { agentModels: { worker: 'worker-specific-model' } },
				});

			const result = service.getWorkerModel('room-1');
			expect(result).toBe('worker-specific-model');
		});

		it('should allow different worker and leader models', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default',
					config: {
						agentModels: {
							leader: 'sonnet-4.6',
							worker: 'haiku-4',
						},
					},
				});

			const leaderResult = service.getLeaderModel('room-1');
			const workerResult = service.getWorkerModel('room-1');

			expect(leaderResult).toBe('sonnet-4.6');
			expect(workerResult).toBe('haiku-4');
		});
	});

	describe('setupRoomAgentSession MCP merging', () => {
		let db: Database;
		let setRuntimeMcpServersSpy: ReturnType<typeof mock>;
		let roomCreatedHandler: ((event: { room: Room }) => void) | undefined;

		const mockRoom = (): Room => ({
			id: 'room-test',
			name: 'Test Room',
			allowedPaths: [],
			defaultPath: undefined,
			defaultModel: 'claude-3',
			allowedModels: undefined,
			sessionIds: [],
			status: 'active',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		beforeEach(() => {
			// Real in-memory SQLite — no schema needed since repo constructors don't execute SQL
			db = new Database(':memory:');

			setRuntimeMcpServersSpy = mock(() => {});

			// DaemonHub mock that captures the room.created handler
			const daemonHub = {
				on: (event: string, handler: (data: unknown) => void, opts?: { sessionId?: string }) => {
					if (event === 'room.created' && opts?.sessionId === 'global') {
						roomCreatedHandler = handler as (event: { room: Room }) => void;
					}
					return () => {};
				},
			};

			// Mock AgentSession returned by sessionManager
			const mockAgentSession = {
				getSessionData: () => ({
					config: { model: 'claude-3', provider: 'anthropic' },
				}),
				setRuntimeMcpServers: setRuntimeMcpServersSpy,
				setRuntimeSystemPrompt: mock(() => {}),
			};

			// Mock SessionManager: getSessionAsync resolves immediately with mock session
			const sessionManager = {
				getSessionAsync: mock(async () => mockAgentSession),
				updateSession: mock(async () => {}),
			};

			// Mock settingsManager with project MCP servers
			const projectServers = {
				github: { command: 'npx', args: ['@github/mcp'] },
			};
			mockSettingsManager = {
				getProjectMcpServersConfig: mock(() => projectServers),
			} as unknown as SettingsManager;

			// Mock roomManager — listRooms returns empty so initializeExistingRooms is a no-op
			mockRoomManager = {
				listRooms: () => [],
				getRoom: () => null,
			} as unknown as RoomManager;

			const config: RoomRuntimeServiceConfig = {
				db: {
					getDatabase: () => db,
					getSession: () => null,
				} as never,
				messageHub: { onRequest: () => {} } as never,
				daemonHub: daemonHub as never,
				getApiKey: async () => null,
				roomManager: mockRoomManager,
				sessionManager: sessionManager as never,
				defaultWorkspacePath: '/tmp',
				defaultModel: 'global-default-model',
				getGlobalSettings: () => ({}) as never,
				settingsManager: mockSettingsManager,
				reactiveDb: { onChange: () => () => {}, emit: async () => {} } as never,
			};

			service = new RoomRuntimeService(config);
		});

		afterEach(() => {
			db.close();
			roomCreatedHandler = undefined;
		});

		it('should call setRuntimeMcpServers with project servers merged with room-agent-tools', async () => {
			// Start service — subscribes to room.created, initializes no rooms
			await service.start();

			// Trigger room.created which calls createOrGetRuntime → setupRoomAgentSession
			expect(roomCreatedHandler).toBeDefined();
			roomCreatedHandler!({ room: mockRoom() });

			// Wait for the async .then() inside setupRoomAgentSession to settle
			await new Promise((r) => setTimeout(r, 0));

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const callArg = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;

			// Should include the project server
			expect(callArg).toHaveProperty('github');
			// Should include room-agent-tools (takes precedence, set last)
			expect(callArg).toHaveProperty('room-agent-tools');
		});

		it('should give room-agent-tools precedence over project servers with same name', async () => {
			// Override: project server also named 'room-agent-tools' — should be overridden
			(mockSettingsManager.getProjectMcpServersConfig as ReturnType<typeof mock>).mockReturnValue({
				'room-agent-tools': { command: 'project-version', args: [] },
				'other-tool': { command: 'other-cmd' },
			});

			await service.start();
			expect(roomCreatedHandler).toBeDefined();
			roomCreatedHandler!({ room: mockRoom() });
			await new Promise((r) => setTimeout(r, 0));

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const callArg = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;

			// room-agent-tools should be the runtime version, not the project version
			expect(callArg['room-agent-tools']).not.toEqual({
				command: 'project-version',
				args: [],
			});
			// other-tool should still be present
			expect(callArg).toHaveProperty('other-tool');
		});

		it('should call setRuntimeMcpServers with only room-agent-tools when no project servers', async () => {
			(mockSettingsManager.getProjectMcpServersConfig as ReturnType<typeof mock>).mockReturnValue(
				{}
			);

			await service.start();
			expect(roomCreatedHandler).toBeDefined();
			roomCreatedHandler!({ room: mockRoom() });
			await new Promise((r) => setTimeout(r, 0));

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const callArg = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;

			expect(Object.keys(callArg)).toEqual(['room-agent-tools']);
		});
	});
});
