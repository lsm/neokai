import { describe, expect, it } from 'bun:test';

// Test the model resolution logic directly
// This mirrors the logic in room-runtime-service.ts createOrGetRuntime

interface RoomConfig {
	agentModels?: Record<string, string>;
	[key: string]: unknown;
}

interface Room {
	id: string;
	defaultModel?: string;
	config?: RoomConfig;
}

/**
 * Resolve leader model with priority: agentModels.leader > room.defaultModel > global default
 * Empty strings are filtered out as they're not valid model identifiers.
 */
function resolveLeaderModel(room: Room, globalDefault: string): string {
	const roomConfig = (room.config ?? {}) as RoomConfig;
	const agentModels = roomConfig.agentModels as Record<string, string> | undefined;
	const leaderModel =
		(agentModels?.leader && agentModels.leader.trim() !== '' ? agentModels.leader : undefined) ??
		(room.defaultModel && room.defaultModel.trim() !== '' ? room.defaultModel : undefined) ??
		globalDefault;
	return leaderModel;
}

describe('Leader model resolution', () => {
	describe('resolveLeaderModel', () => {
		it('should use room.defaultModel when agentModels.leader is not set', () => {
			const room: Room = {
				id: 'room-1',
				defaultModel: 'room-default-model',
				config: {},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('room-default-model');
		});

		it('should prefer room.config.agentModels.leader over room.defaultModel', () => {
			const room: Room = {
				id: 'room-2',
				defaultModel: 'room-default-model',
				config: {
					agentModels: {
						leader: 'leader-specific-model',
					},
				},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('leader-specific-model');
		});

		it('should fall back to global default when neither room.defaultModel nor agentModels.leader is set', () => {
			const room: Room = {
				id: 'room-3',
				config: {},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('global-default');
		});

		it('should use global default when room.defaultModel is undefined', () => {
			const room: Room = {
				id: 'room-4',
				defaultModel: undefined,
				config: {},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('global-default');
		});

		it('should fall back from empty string room.defaultModel to global default', () => {
			// Empty string is not a valid model identifier, should fall back to global default
			const room: Room = {
				id: 'room-5',
				defaultModel: '',
				config: {},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('global-default');
		});

		it('should fall back from empty string agentModels.leader to room.defaultModel', () => {
			// Empty string is not a valid model identifier, should fall back to room.defaultModel
			const room: Room = {
				id: 'room-6',
				defaultModel: 'room-default',
				config: {
					agentModels: {
						leader: '',
					},
				},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('room-default');
		});

		it('should prioritize agentModels.leader when set', () => {
			const room: Room = {
				id: 'room-7',
				defaultModel: 'room-default',
				config: {
					agentModels: {
						leader: 'glm-5',
						coder: 'claude-sonnet',
					},
				},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('glm-5');
		});

		it('should handle missing config object', () => {
			const room: Room = {
				id: 'room-8',
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('global-default');
		});

		it('should handle whitespace-only strings as invalid', () => {
			const room: Room = {
				id: 'room-9',
				defaultModel: '   ',
				config: {
					agentModels: {
						leader: '\t\n',
					},
				},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('global-default');
		});
	});
});
