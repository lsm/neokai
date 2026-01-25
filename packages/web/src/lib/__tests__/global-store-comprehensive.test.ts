// @ts-nocheck
/**
 * Comprehensive tests for global-store.ts
 *
 * Tests GlobalStore class including initialization, refresh, and
 * state management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '@liuboer/shared';
import { STATE_CHANNELS } from '@liuboer/shared';

// Mock connection-manager module - must be at top level and use inline factory
vi.mock('../connection-manager.js', () => {
	const mockHub = {
		call: vi.fn(),
		subscribe: vi.fn(() => vi.fn()),
		subscribeOptimistic: vi.fn(() => vi.fn()),
		forceResubscribe: vi.fn(),
		isConnected: vi.fn(() => true),
	};
	return {
		connectionManager: {
			getHubIfConnected: vi.fn(() => mockHub),
			getHub: vi.fn(async () => mockHub),
		},
	};
});

// Now import GlobalStore - it will use the mocked connectionManager
import { GlobalStore } from '../global-store.js';

// Import connectionManager to access the mock
import { connectionManager } from '../connection-manager.js';

// Helper to create mock sessions
function createMockSession(id: string, overrides: Partial<Session> = {}): Session {
	return {
		id,
		title: `Session ${id}`,
		workspacePath: `/path/to/${id}`,
		status: 'active',
		config: {},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
		createdAt: '2024-01-01T00:00:00Z',
		lastActiveAt: '2024-01-01T00:00:00Z',
		...overrides,
	};
}

describe('GlobalStore', () => {
	let store: GlobalStore;

	beforeEach(() => {
		store = new GlobalStore();
		vi.clearAllMocks();
		// Reset default mock behavior - return a working hub
		(
			connectionManager as unknown as {
				getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
				getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
			}
		).getHubIfConnected.mockReturnValue({
			call: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
			subscribeOptimistic: vi.fn(() => vi.fn()),
			forceResubscribe: vi.fn(),
			isConnected: vi.fn(() => true),
		});
		(
			connectionManager as unknown as {
				getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
				getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
			}
		).getHub.mockResolvedValue({
			call: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
			subscribeOptimistic: vi.fn(() => vi.fn()),
			forceResubscribe: vi.fn(),
			isConnected: vi.fn(() => true),
		});
	});

	describe('Initial State', () => {
		it('should start with empty sessions array', () => {
			expect(store.sessions.value).toEqual([]);
		});

		it('should start with hasArchivedSessions as false', () => {
			expect(store.hasArchivedSessions.value).toBe(false);
		});

		it('should start with null systemState', () => {
			expect(store.systemState.value).toBeNull();
		});

		it('should start with null settings', () => {
			expect(store.settings.value).toBeNull();
		});

		it('should start with initialized as false', () => {
			const privateStore = store as unknown as { initialized: boolean };
			expect(privateStore.initialized).toBe(false);
		});
	});

	describe('Computed Accessors', () => {
		it('authStatus should return null when systemState is null', () => {
			expect(store.authStatus.value).toBeNull();
		});

		it('authStatus should return auth from systemState', () => {
			store.systemState.value = {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'connected' },
			};
			expect(store.authStatus.value).toEqual({
				authenticated: true,
				method: 'api_key',
			});
		});

		it('healthStatus should return null when systemState is null', () => {
			expect(store.healthStatus.value).toBeNull();
		});

		it('healthStatus should return health from systemState', () => {
			store.systemState.value = {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'connected' },
			};
			expect(store.healthStatus.value).toEqual({ status: 'healthy' });
		});

		it('sessionCount should return 0 when no sessions', () => {
			expect(store.sessionCount.value).toBe(0);
		});

		it('sessionCount should return correct count', () => {
			store.sessions.value = [createMockSession('1'), createMockSession('2')];
			expect(store.sessionCount.value).toBe(2);
		});

		it('recentSessions should return last 5 sessions sorted by lastActiveAt', () => {
			// Create sessions with different lastActiveAt timestamps
			const session1 = createMockSession('1');
			session1.lastActiveAt = '2024-01-01T00:00:00Z';
			const session2 = createMockSession('2');
			session2.lastActiveAt = '2024-01-05T00:00:00Z';
			const session3 = createMockSession('3');
			session3.lastActiveAt = '2024-01-03T00:00:00Z';
			const session4 = createMockSession('4');
			session4.lastActiveAt = '2024-01-04T00:00:00Z';
			const session5 = createMockSession('5');
			session5.lastActiveAt = '2024-01-02T00:00:00Z';
			const session6 = createMockSession('6');
			session6.lastActiveAt = '2024-01-06T00:00:00Z';

			const sessions = [session1, session2, session3, session4, session5, session6];
			store.sessions.value = sessions;

			const recent = store.recentSessions.value;
			expect(recent).toHaveLength(5);
			// Most recent first (sorted by lastActiveAt descending)
			expect(recent[0].id).toBe('6'); // 2024-01-06
			expect(recent[1].id).toBe('2'); // 2024-01-05
			expect(recent[2].id).toBe('4'); // 2024-01-04
			expect(recent[3].id).toBe('3'); // 2024-01-03
			expect(recent[4].id).toBe('5'); // 2024-01-02
		});

		it('activeSessions should filter by active status', () => {
			const sessions = [
				createMockSession('1'),
				{ ...createMockSession('2'), status: 'archived' as const },
				createMockSession('3'),
			];
			store.sessions.value = sessions;

			const active = store.activeSessions.value;
			expect(active).toHaveLength(2);
			expect(active.map((s) => s.id)).toEqual(['1', '3']);
		});

		it('apiConnectionStatus should return connected by default', () => {
			expect(store.apiConnectionStatus.value).toBe('connected');
		});

		it('apiConnectionStatus should reflect systemState', () => {
			store.systemState.value = {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'degraded' },
			};
			expect(store.apiConnectionStatus.value).toBe('degraded');
		});
	});

	describe('initialize', () => {
		it('should fetch snapshot and set initial state', async () => {
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: {
						sessions: [createMockSession('sess-1')],
						hasArchivedSessions: false,
					},
					system: {
						auth: { authenticated: true, method: 'api_key' },
						health: { status: 'healthy' },
						apiConnection: { status: 'connected' },
					},
					settings: { settings: { permissionMode: 'bypassPermissions' } },
				}),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.initialize();

			expect(store.sessions.value).toHaveLength(1);
			expect(store.sessions.value[0].id).toBe('sess-1');
			expect(store.systemState.value?.auth?.method).toBe('api_key');
			expect(store.settings.value).toEqual({ permissionMode: 'bypassPermissions' });
		});

		it('should subscribe to all state channels', async () => {
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: { sessions: [], hasArchivedSessions: false },
					system: null,
					settings: null,
				}),
				subscribeOptimistic: vi.fn(() => vi.fn()),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.initialize();

			expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SESSIONS,
				expect.any(Function),
				{ sessionId: 'global' }
			);
			expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith(
				`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				expect.any(Function),
				{ sessionId: 'global' }
			);
			expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SYSTEM,
				expect.any(Function),
				{ sessionId: 'global' }
			);
			expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith(
				STATE_CHANNELS.GLOBAL_SETTINGS,
				expect.any(Function),
				{ sessionId: 'global' }
			);
		});

		it('should not initialize twice', async () => {
			// Setup mock to return valid snapshot
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: { sessions: [], hasArchivedSessions: false },
					system: null,
					settings: null,
				}),
				subscribeOptimistic: vi.fn(() => vi.fn()),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.initialize();

			// Check that initialized flag is set
			const privateStore = store as unknown as { initialized: boolean };
			expect(privateStore.initialized).toBe(true);

			// Reset the mock call count
			mockHub.call.mockClear();

			// Second initialize should be a no-op
			await store.initialize();

			// Hub call should not have been made again
			expect(mockHub.call).not.toHaveBeenCalled();
		});

		it('should set hasArchivedSessions from snapshot', async () => {
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: {
						sessions: [],
						hasArchivedSessions: true,
					},
					system: null,
					settings: null,
				}),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.initialize();

			expect(store.hasArchivedSessions.value).toBe(true);
		});
	});

	describe('refresh', () => {
		beforeEach(async () => {
			// Initialize store first
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: { sessions: [], hasArchivedSessions: false },
					system: null,
					settings: null,
				}),
				subscribeOptimistic: vi.fn(() => vi.fn()),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);
			await store.initialize();
		});

		it('should fetch fresh snapshot from server', async () => {
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: {
						sessions: [createMockSession('sess-refreshed')],
						hasArchivedSessions: true,
					},
					system: {
						auth: { authenticated: true, method: 'oauth' },
						health: { status: 'healthy' },
						apiConnection: { status: 'connected' },
					},
					settings: { settings: { permissionMode: 'acceptEdits' } },
				}),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.refresh();

			expect(store.sessions.value[0].id).toBe('sess-refreshed');
			expect(store.hasArchivedSessions.value).toBe(true);
			expect(store.systemState.value?.auth?.method).toBe('oauth');
			expect(store.settings.value?.permissionMode).toBe('acceptEdits');
		});

		it('should call correct channel for refresh', async () => {
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: { sessions: [], hasArchivedSessions: false },
					system: null,
					settings: null,
				}),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.refresh();

			expect(mockHub.call).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});
		});
	});

	describe('Session Helpers', () => {
		beforeEach(() => {
			store.sessions.value = [
				createMockSession('1'),
				createMockSession('2'),
				createMockSession('3'),
			];
		});

		it('getSession should return session by ID', () => {
			const session = store.getSession('2');
			expect(session).toBeDefined();
			expect(session?.id).toBe('2');
		});

		it('getSession should return undefined for non-existent ID', () => {
			const session = store.getSession('nonexistent');
			expect(session).toBeUndefined();
		});

		it('updateSession should update session properties', () => {
			store.updateSession('2', { title: 'Updated Title' });
			const session = store.getSession('2');
			expect(session?.title).toBe('Updated Title');
		});

		it('removeSession should remove session from list', () => {
			store.removeSession('2');
			expect(store.sessions.value).toHaveLength(2);
			expect(store.getSession('2')).toBeUndefined();
		});

		it('addSession should add session to list', () => {
			const newSession = createMockSession('4');
			store.addSession(newSession);
			expect(store.sessions.value).toHaveLength(4);
			expect(store.getSession('4')).toBeDefined();
		});
	});

	describe('destroy', () => {
		it('should reset initialized flag', async () => {
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: { sessions: [], hasArchivedSessions: false },
					system: null,
					settings: null,
				}),
				subscribeOptimistic: vi.fn(() => vi.fn()),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.initialize();
			store.destroy();

			const privateStore = store as unknown as { initialized: boolean };
			expect(privateStore.initialized).toBe(false);
		});

		it('should clear cleanup functions', async () => {
			const mockHub = {
				call: vi.fn().mockResolvedValue({
					sessions: { sessions: [], hasArchivedSessions: false },
					system: null,
					settings: null,
				}),
				subscribeOptimistic: vi.fn(() => vi.fn()),
			};
			(
				connectionManager as unknown as {
					getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
					getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
				}
			).getHub.mockResolvedValue(mockHub);

			await store.initialize();
			store.destroy();

			const privateStore = store as unknown as { cleanupFunctions: Array<() => void> };
			expect(privateStore.cleanupFunctions).toHaveLength(0);
		});
	});
});
