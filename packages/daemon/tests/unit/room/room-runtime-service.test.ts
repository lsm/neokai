import { describe, expect, it, beforeEach, mock } from 'bun:test';
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

	describe('settingsManager integration', () => {
		it('should expose getProjectMcpServersConfig on the settings manager', () => {
			// Verify the mock settings manager has the expected method
			const result = mockSettingsManager.getProjectMcpServersConfig();
			expect(result).toEqual({});
		});

		it('should return project MCP servers config when configured', () => {
			const projectServers = {
				github: { type: 'stdio' as const, command: 'npx', args: ['@github/mcp'] },
			};
			(mockSettingsManager.getProjectMcpServersConfig as ReturnType<typeof mock>).mockReturnValue(
				projectServers
			);

			const result = mockSettingsManager.getProjectMcpServersConfig();
			expect(result).toEqual(projectServers);
		});
	});
});
