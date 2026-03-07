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

function resolveLeaderModel(room: Room, globalDefault: string): string {
	const roomConfig = (room.config ?? {}) as RoomConfig;
	const agentModels = roomConfig.agentModels as Record<string, string> | undefined;
	const leaderModel = agentModels?.leader ?? room.defaultModel ?? globalDefault;
	return leaderModel;
}

function resolveWorkerModel(room: Room, globalDefault: string): string {
	const roomConfig = (room.config ?? {}) as RoomConfig;
	const agentModels = roomConfig.agentModels as Record<string, string> | undefined;
	const workerModel = agentModels?.worker ?? room.defaultModel ?? globalDefault;
	return workerModel;
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

		it('should use room.defaultModel when explicitly set to empty string (intentional override)', () => {
			// Empty string is a valid value - if user sets it explicitly, it's used as-is
			// The ?? operator only falls back on null/undefined
			const room: Room = {
				id: 'room-5',
				defaultModel: '',
				config: {},
			};

			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe(''); // Empty string is a valid value
		});

		it('should use agentModels.leader even when empty string (explicit override)', () => {
			// Empty string is treated as a valid value - intentional override
			const room: Room = {
				id: 'room-6',
				defaultModel: 'room-default',
				config: {
					agentModels: {
						leader: '',
					},
				},
			};

			// Empty string is used as-is (?? only falls back on null/undefined)
			const result = resolveLeaderModel(room, 'global-default');
			expect(result).toBe('');
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
	});
});

describe('Worker model resolution', () => {
	describe('resolveWorkerModel', () => {
		it('should use room.defaultModel when agentModels.worker is not set', () => {
			const room: Room = {
				id: 'room-1',
				defaultModel: 'room-default-model',
				config: {},
			};

			const result = resolveWorkerModel(room, 'global-default');
			expect(result).toBe('room-default-model');
		});

		it('should prefer room.config.agentModels.worker over room.defaultModel', () => {
			const room: Room = {
				id: 'room-2',
				defaultModel: 'room-default-model',
				config: {
					agentModels: {
						worker: 'worker-specific-model',
					},
				},
			};

			const result = resolveWorkerModel(room, 'global-default');
			expect(result).toBe('worker-specific-model');
		});

		it('should fall back to global default when neither room.defaultModel nor agentModels.worker is set', () => {
			const room: Room = {
				id: 'room-3',
				config: {},
			};

			const result = resolveWorkerModel(room, 'global-default');
			expect(result).toBe('global-default');
		});

		it('should prioritize agentModels.worker when set', () => {
			const room: Room = {
				id: 'room-4',
				defaultModel: 'room-default',
				config: {
					agentModels: {
						worker: 'haiku-4',
						leader: 'sonnet-4.6',
					},
				},
			};

			const result = resolveWorkerModel(room, 'global-default');
			expect(result).toBe('haiku-4');
		});

		it('should allow different worker and leader models', () => {
			const room: Room = {
				id: 'room-5',
				defaultModel: 'room-default',
				config: {
					agentModels: {
						worker: 'haiku-4',
						leader: 'sonnet-4.6',
					},
				},
			};

			const workerResult = resolveWorkerModel(room, 'global-default');
			const leaderResult = resolveLeaderModel(room, 'global-default');

			expect(workerResult).toBe('haiku-4');
			expect(leaderResult).toBe('sonnet-4.6');
		});
	});
});
