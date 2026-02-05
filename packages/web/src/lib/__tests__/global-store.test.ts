// @ts-nocheck
/**
 * Tests for GlobalStore
 *
 * Tests the GlobalStore class which manages application-wide state.
 * Since GlobalStore imports connection-manager (which needs DOM),
 * we test the class behavior patterns instead of the actual singleton.
 */

import { signal, computed } from '@preact/signals';
import type { Session, AuthStatus, HealthStatus, SystemState } from '@neokai/shared';
import { vi } from 'vitest';

// Mock connection-manager before importing GlobalStore
const mockHub = {
	call: vi.fn(),
	subscribeOptimistic: vi.fn(() => vi.fn()),
};

vi.mock('../connection-manager', () => ({
	connectionManager: {
		getHub: vi.fn(() => Promise.resolve(mockHub)),
	},
}));

// Recreate GlobalStore class locally for testing without connection-manager dependency
class TestGlobalStore {
	readonly sessions = signal<Session[]>([]);
	readonly hasArchivedSessions = signal<boolean>(false);
	readonly systemState = signal<SystemState | null>(null);
	readonly settings = signal<Record<string, unknown> | null>(null);

	readonly authStatus = computed<AuthStatus | null>(() => this.systemState.value?.auth || null);
	readonly healthStatus = computed<HealthStatus | null>(
		() => this.systemState.value?.health || null
	);
	readonly sessionCount = computed<number>(() => this.sessions.value.length);
	readonly recentSessions = computed<Session[]>(() => {
		return [...this.sessions.value]
			.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
			.slice(0, 5);
	});
	readonly activeSessions = computed<Session[]>(() => {
		return this.sessions.value.filter((s) => s.status === 'active');
	});
	readonly apiConnectionStatus = computed<'connected' | 'degraded' | 'disconnected'>(
		() => this.systemState.value?.apiConnection?.status || 'connected'
	);

	private cleanupFunctions: Array<() => void> = [];
	private initialized = false;

	getSession(sessionId: string): Session | undefined {
		return this.sessions.value.find((s) => s.id === sessionId);
	}

	updateSession(sessionId: string, updates: Partial<Session>): void {
		this.sessions.value = this.sessions.value.map((s) =>
			s.id === sessionId ? { ...s, ...updates } : s
		);
	}

	removeSession(sessionId: string): void {
		this.sessions.value = this.sessions.value.filter((s) => s.id !== sessionId);
	}

	addSession(session: Session): void {
		this.sessions.value = [...this.sessions.value, session];
	}

	applySessionsDelta(delta: {
		added?: Session[];
		updated?: Partial<Session>[];
		removed?: string[];
	}): void {
		let sessions = [...this.sessions.value];

		if (delta.removed && delta.removed.length > 0) {
			sessions = sessions.filter((s) => !delta.removed!.includes(s.id));
		}

		if (delta.updated && delta.updated.length > 0) {
			for (const updated of delta.updated) {
				const index = sessions.findIndex((s) => s.id === updated.id);
				if (index !== -1) {
					sessions[index] = updated as Session;
				}
			}
		}

		if (delta.added && delta.added.length > 0) {
			sessions.unshift(...(delta.added as Session[]));
		}

		this.sessions.value = sessions;
	}

	destroy(): void {
		for (const cleanup of this.cleanupFunctions) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.cleanupFunctions = [];
		this.initialized = false;
	}
}

// Use TestGlobalStore instead of actual GlobalStore for isolated tests
const GlobalStore = TestGlobalStore;

// Import actual GlobalStore for initialize/refresh tests
import { GlobalStore as ActualGlobalStore } from '../global-store';

// Create a fresh GlobalStore instance for each test
// (not using singleton to isolate tests)
function createTestStore() {
	return new GlobalStore();
}

// Helper to create mock sessions
function createMockSession(id: string, lastActiveAt = new Date().toISOString()): Session {
	return {
		id,
		title: `Session ${id}`,
		workspacePath: `/path/to/${id}`,
		status: 'active',
		config: {},
		metadata: { messageCount: 0 },
		createdAt: new Date().toISOString(),
		lastActiveAt,
	} as Session;
}

// Test for applySessionsDelta edge cases
describe('GlobalStore - Delta Application Edge Cases', () => {
	let store: GlobalStore;

	beforeEach(() => {
		store = createTestStore();
	});

	afterEach(() => {
		store.destroy();
	});

	describe('applySessionsDelta - Complex Scenarios', () => {
		it('should handle empty delta', () => {
			store.sessions.value = [createMockSession('1'), createMockSession('2')];

			store.applySessionsDelta({});

			expect(store.sessions.value).toHaveLength(2);
		});

		it('should handle removing non-existent session', () => {
			store.sessions.value = [createMockSession('1')];

			store.applySessionsDelta({
				removed: ['nonexistent'],
			});

			expect(store.sessions.value).toHaveLength(1);
			expect(store.sessions.value[0].id).toBe('1');
		});

		it('should handle updating non-existent session', () => {
			store.sessions.value = [createMockSession('1')];

			store.applySessionsDelta({
				updated: [{ ...createMockSession('nonexistent'), title: 'Updated' }],
			});

			// Should not add the non-existent session
			expect(store.sessions.value).toHaveLength(1);
			expect(store.sessions.value[0].id).toBe('1');
		});

		it('should apply operations in correct order: remove, update, add', () => {
			store.sessions.value = [
				createMockSession('1'),
				createMockSession('2'),
				createMockSession('3'),
			];

			store.applySessionsDelta({
				removed: ['2'], // Remove first
				updated: [{ ...createMockSession('1'), title: 'Updated 1' }], // Update second
				added: [createMockSession('4')], // Add last (prepended)
			});

			expect(store.sessions.value).toHaveLength(3);
			expect(store.sessions.value[0].id).toBe('4'); // Added at start
			expect(store.sessions.value[1].id).toBe('1');
			expect(store.sessions.value[1].title).toBe('Updated 1');
			expect(store.sessions.value[2].id).toBe('3');
			// Session '2' should be removed
			expect(store.sessions.value.find((s) => s.id === '2')).toBeUndefined();
		});

		it('should handle multiple additions', () => {
			store.sessions.value = [createMockSession('1')];

			store.applySessionsDelta({
				added: [createMockSession('2'), createMockSession('3'), createMockSession('4')],
			});

			expect(store.sessions.value).toHaveLength(4);
			// Added sessions are prepended in order
			expect(store.sessions.value.map((s) => s.id)).toEqual(['2', '3', '4', '1']);
		});

		it('should handle multiple removals', () => {
			store.sessions.value = [
				createMockSession('1'),
				createMockSession('2'),
				createMockSession('3'),
				createMockSession('4'),
			];

			store.applySessionsDelta({
				removed: ['1', '3'],
			});

			expect(store.sessions.value).toHaveLength(2);
			expect(store.sessions.value.map((s) => s.id)).toEqual(['2', '4']);
		});

		it('should handle multiple updates', () => {
			store.sessions.value = [
				createMockSession('1'),
				createMockSession('2'),
				createMockSession('3'),
			];

			store.applySessionsDelta({
				updated: [
					{ ...createMockSession('1'), title: 'Title 1' },
					{ ...createMockSession('3'), title: 'Title 3' },
				],
			});

			expect(store.sessions.value[0].title).toBe('Title 1');
			expect(store.sessions.value[1].title).toBe('Session 2'); // Unchanged
			expect(store.sessions.value[2].title).toBe('Title 3');
		});

		it('should handle empty arrays in delta', () => {
			store.sessions.value = [createMockSession('1')];

			store.applySessionsDelta({
				removed: [],
				updated: [],
				added: [],
			});

			expect(store.sessions.value).toHaveLength(1);
		});
	});
});

describe('GlobalStore', () => {
	let store: GlobalStore;

	beforeEach(() => {
		store = createTestStore();
	});

	afterEach(() => {
		store.destroy();
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
			const sessions = [
				createMockSession('1', '2024-01-01T00:00:00Z'),
				createMockSession('2', '2024-01-05T00:00:00Z'),
				createMockSession('3', '2024-01-03T00:00:00Z'),
				createMockSession('4', '2024-01-04T00:00:00Z'),
				createMockSession('5', '2024-01-02T00:00:00Z'),
				createMockSession('6', '2024-01-06T00:00:00Z'),
			];
			store.sessions.value = sessions;

			const recent = store.recentSessions.value;
			expect(recent).toHaveLength(5);
			expect(recent[0].id).toBe('6'); // Most recent
			expect(recent[1].id).toBe('2');
			expect(recent[2].id).toBe('4');
			expect(recent[3].id).toBe('3');
			expect(recent[4].id).toBe('5');
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

		it('updateSession should not affect other sessions', () => {
			store.updateSession('2', { title: 'Updated' });
			const session1 = store.getSession('1');
			expect(session1?.title).toBe('Session 1');
		});

		it('removeSession should remove session from list', () => {
			store.removeSession('2');
			expect(store.sessions.value).toHaveLength(2);
			expect(store.getSession('2')).toBeUndefined();
		});

		it('removeSession should not throw for non-existent ID', () => {
			expect(() => store.removeSession('nonexistent')).not.toThrow();
			expect(store.sessions.value).toHaveLength(3);
		});

		it('addSession should add session to list', () => {
			const newSession = createMockSession('4');
			store.addSession(newSession);
			expect(store.sessions.value).toHaveLength(4);
			expect(store.getSession('4')).toBeDefined();
		});
	});

	describe('destroy', () => {
		it('should reset initialized flag', () => {
			// Access private initialized via reflection
			const privateStore = store as unknown as { initialized: boolean };
			privateStore.initialized = true;

			store.destroy();

			expect(privateStore.initialized).toBe(false);
		});

		it('should clear cleanup functions', () => {
			const privateStore = store as unknown as {
				cleanupFunctions: Array<() => void>;
			};

			// Add some cleanup functions
			privateStore.cleanupFunctions = [() => {}, () => {}];

			store.destroy();

			expect(privateStore.cleanupFunctions).toHaveLength(0);
		});

		it('should call all cleanup functions', () => {
			const privateStore = store as unknown as {
				cleanupFunctions: Array<() => void>;
			};

			const cleanup1 = vi.fn(() => {});
			const cleanup2 = vi.fn(() => {});
			privateStore.cleanupFunctions = [cleanup1, cleanup2];

			store.destroy();

			expect(cleanup1).toHaveBeenCalled();
			expect(cleanup2).toHaveBeenCalled();
		});

		it('should handle cleanup function errors gracefully', () => {
			const privateStore = store as unknown as {
				cleanupFunctions: Array<() => void>;
			};

			const cleanupError = vi.fn(() => {
				throw new Error('Cleanup error');
			});
			const cleanup2 = vi.fn(() => {});
			privateStore.cleanupFunctions = [cleanupError, cleanup2];

			// Should not throw
			expect(() => store.destroy()).not.toThrow();

			// Second cleanup should still be called
			expect(cleanup2).toHaveBeenCalled();
		});
	});

	describe('applySessionsDelta (private method via reflection)', () => {
		beforeEach(() => {
			store.sessions.value = [
				createMockSession('1'),
				createMockSession('2'),
				createMockSession('3'),
			];
		});

		it('should add new sessions', () => {
			const privateStore = store as unknown as {
				applySessionsDelta: (delta: {
					added?: Session[];
					updated?: Partial<Session>[];
					removed?: string[];
				}) => void;
			};

			privateStore.applySessionsDelta({
				added: [createMockSession('4')],
			});

			expect(store.sessions.value).toHaveLength(4);
			// New sessions are prepended
			expect(store.sessions.value[0].id).toBe('4');
		});

		it('should remove sessions', () => {
			const privateStore = store as unknown as {
				applySessionsDelta: (delta: {
					added?: Session[];
					updated?: Partial<Session>[];
					removed?: string[];
				}) => void;
			};

			privateStore.applySessionsDelta({
				removed: ['2'],
			});

			expect(store.sessions.value).toHaveLength(2);
			expect(store.getSession('2')).toBeUndefined();
		});

		it('should update existing sessions', () => {
			const privateStore = store as unknown as {
				applySessionsDelta: (delta: {
					added?: Session[];
					updated?: Partial<Session>[];
					removed?: string[];
				}) => void;
			};

			privateStore.applySessionsDelta({
				updated: [{ ...createMockSession('2'), title: 'Updated Title' }],
			});

			const session = store.getSession('2');
			expect(session?.title).toBe('Updated Title');
		});

		it('should handle combined operations', () => {
			const privateStore = store as unknown as {
				applySessionsDelta: (delta: {
					added?: Session[];
					updated?: Partial<Session>[];
					removed?: string[];
				}) => void;
			};

			privateStore.applySessionsDelta({
				added: [createMockSession('4')],
				updated: [{ ...createMockSession('1'), title: 'Updated 1' }],
				removed: ['2'],
			});

			expect(store.sessions.value).toHaveLength(3);
			expect(store.sessions.value[0].id).toBe('4'); // Added first
			expect(store.getSession('1')?.title).toBe('Updated 1');
			expect(store.getSession('2')).toBeUndefined();
		});
	});
});

// Tests for actual GlobalStore with mocked connection-manager
describe('GlobalStore - initialize()', () => {
	let store: ActualGlobalStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = new ActualGlobalStore();
	});

	afterEach(() => {
		store.destroy();
	});

	it('should return early if already initialized', async () => {
		// First initialize
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});
		await store.initialize();

		// Reset call count
		mockHub.call.mockClear();

		// Second initialize should return early
		await store.initialize();

		expect(mockHub.call).not.toHaveBeenCalled();
	});

	it('should fetch initial state snapshot on first initialize', async () => {
		const mockSnapshot = {
			sessions: {
				sessions: [createMockSession('1')],
				hasArchivedSessions: true,
			},
			system: {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'connected' },
			},
			settings: {
				settings: { showArchived: false },
			},
		};
		mockHub.call.mockResolvedValueOnce(mockSnapshot);

		await store.initialize();

		expect(mockHub.call).toHaveBeenCalledWith('state.global.snapshot', {});
		expect(store.sessions.value).toHaveLength(1);
		expect(store.sessions.value[0].id).toBe('1');
		expect(store.hasArchivedSessions.value).toBe(true);
		expect(store.systemState.value).toEqual(mockSnapshot.system);
		expect(store.settings.value).toEqual({ showArchived: false });
	});

	it('should set up subscriptions after fetching snapshot', async () => {
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});

		await store.initialize();

		// Should subscribe to 4 channels: sessions, sessions.delta, system, settings
		expect(mockHub.subscribeOptimistic).toHaveBeenCalledTimes(4);
		expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith(
			'state.sessions',
			expect.any(Function),
			{ sessionId: 'global' }
		);
		expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith(
			'state.sessions.delta',
			expect.any(Function),
			{ sessionId: 'global' }
		);
		expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith('state.system', expect.any(Function), {
			sessionId: 'global',
		});
		expect(mockHub.subscribeOptimistic).toHaveBeenCalledWith(
			'state.settings',
			expect.any(Function),
			{ sessionId: 'global' }
		);
	});

	it('should handle sessions subscription updates', async () => {
		let sessionsCallback:
			| ((state: { sessions: Session[]; hasArchivedSessions: boolean }) => void)
			| null = null;

		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});

		mockHub.subscribeOptimistic.mockImplementation((channel: string, callback: unknown) => {
			if (channel === 'state.sessions') {
				sessionsCallback = callback as typeof sessionsCallback;
			}
			return vi.fn();
		});

		await store.initialize();

		// Simulate sessions update
		const newSessions = [createMockSession('new-1'), createMockSession('new-2')];
		sessionsCallback?.({ sessions: newSessions, hasArchivedSessions: true });

		expect(store.sessions.value).toHaveLength(2);
		expect(store.sessions.value[0].id).toBe('new-1');
		expect(store.hasArchivedSessions.value).toBe(true);
	});

	it('should handle sessions delta subscription updates', async () => {
		let deltaCallback:
			| ((delta: { added?: Session[]; updated?: Partial<Session>[]; removed?: string[] }) => void)
			| null = null;

		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [createMockSession('1')], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});

		mockHub.subscribeOptimistic.mockImplementation((channel: string, callback: unknown) => {
			if (channel === 'state.sessions.delta') {
				deltaCallback = callback as typeof deltaCallback;
			}
			return vi.fn();
		});

		await store.initialize();

		// Simulate delta update
		deltaCallback?.({ added: [createMockSession('2')], removed: ['1'] });

		expect(store.sessions.value).toHaveLength(1);
		expect(store.sessions.value[0].id).toBe('2');
	});

	it('should handle system state subscription updates', async () => {
		let systemCallback: ((state: SystemState) => void) | null = null;

		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});

		mockHub.subscribeOptimistic.mockImplementation((channel: string, callback: unknown) => {
			if (channel === 'state.system') {
				systemCallback = callback as typeof systemCallback;
			}
			return vi.fn();
		});

		await store.initialize();

		// Simulate system state update
		const newSystemState = {
			auth: { authenticated: true, method: 'oauth' },
			health: { status: 'degraded' },
			apiConnection: { status: 'degraded' },
		};
		systemCallback?.(newSystemState as SystemState);

		expect(store.systemState.value).toEqual(newSystemState);
	});

	it('should handle settings subscription updates', async () => {
		let settingsCallback: ((state: { settings: unknown }) => void) | null = null;

		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});

		mockHub.subscribeOptimistic.mockImplementation((channel: string, callback: unknown) => {
			if (channel === 'state.settings') {
				settingsCallback = callback as typeof settingsCallback;
			}
			return vi.fn();
		});

		await store.initialize();

		// Simulate settings update
		settingsCallback?.({ settings: { showArchived: true, theme: 'dark' } });

		expect(store.settings.value).toEqual({ showArchived: true, theme: 'dark' });
	});

	it('should handle initialization error gracefully', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockHub.call.mockRejectedValueOnce(new Error('Network error'));

		await store.initialize();

		expect(consoleSpy).toHaveBeenCalledWith(
			'[GlobalStore] Failed to initialize:',
			expect.any(Error)
		);

		// Store should remain in uninitialized state
		const privateStore = store as unknown as { initialized: boolean };
		expect(privateStore.initialized).toBe(false);

		consoleSpy.mockRestore();
	});

	it('should handle null snapshot gracefully', async () => {
		mockHub.call.mockResolvedValueOnce(null);

		await store.initialize();

		// Should still set up subscriptions even if snapshot is null
		expect(mockHub.subscribeOptimistic).toHaveBeenCalledTimes(4);
		expect(store.sessions.value).toEqual([]);
	});

	it('should handle snapshot with missing fields', async () => {
		mockHub.call.mockResolvedValueOnce({
			sessions: null,
			system: null,
			settings: null,
		});

		await store.initialize();

		expect(store.sessions.value).toEqual([]);
		expect(store.hasArchivedSessions.value).toBe(false);
		expect(store.systemState.value).toBeNull();
		expect(store.settings.value).toBeNull();
	});
});

describe('GlobalStore - refresh()', () => {
	let store: ActualGlobalStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = new ActualGlobalStore();
	});

	afterEach(() => {
		store.destroy();
	});

	it('should return early if not initialized', async () => {
		await store.refresh();

		expect(mockHub.call).not.toHaveBeenCalled();
	});

	it('should fetch fresh snapshot when initialized', async () => {
		// Initialize first
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});
		await store.initialize();

		// Set up refresh mock
		const freshSnapshot = {
			sessions: {
				sessions: [createMockSession('refreshed-1')],
				hasArchivedSessions: true,
			},
			system: {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'connected' },
			},
			settings: {
				settings: { refreshed: true },
			},
		};
		mockHub.call.mockResolvedValueOnce(freshSnapshot);

		await store.refresh();

		expect(mockHub.call).toHaveBeenLastCalledWith('state.global.snapshot', {});
		expect(store.sessions.value).toHaveLength(1);
		expect(store.sessions.value[0].id).toBe('refreshed-1');
		expect(store.hasArchivedSessions.value).toBe(true);
		expect(store.settings.value).toEqual({ refreshed: true });
	});

	it('should complete refresh successfully when initialized', async () => {
		// Initialize first
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});
		await store.initialize();

		// Refresh
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});
		await store.refresh();

		// Verify refresh called the snapshot endpoint
		expect(mockHub.call).toHaveBeenLastCalledWith('state.global.snapshot', {});
	});

	it('should throw error on refresh failure', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// Initialize first
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});
		await store.initialize();

		// Refresh with error
		mockHub.call.mockRejectedValueOnce(new Error('Refresh failed'));

		await expect(store.refresh()).rejects.toThrow('Refresh failed');
		expect(consoleSpy).toHaveBeenCalledWith(
			'[GlobalStore] Failed to refresh state:',
			expect.any(Error)
		);

		consoleSpy.mockRestore();
	});

	it('should handle null refresh snapshot gracefully', async () => {
		// Initialize first
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [createMockSession('1')], hasArchivedSessions: true },
			system: { auth: { authenticated: true } },
			settings: { settings: { initial: true } },
		});
		await store.initialize();

		// Refresh with null
		mockHub.call.mockResolvedValueOnce(null);

		await store.refresh();

		// State should remain unchanged when snapshot is null
		expect(store.sessions.value).toHaveLength(1);
		expect(store.sessions.value[0].id).toBe('1');
	});
});

// Tests for actual GlobalStore session helpers
describe('GlobalStore - Session Helpers (actual)', () => {
	let store: ActualGlobalStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = new ActualGlobalStore();
		// Set up initial sessions directly
		store.sessions.value = [createMockSession('1'), createMockSession('2'), createMockSession('3')];
	});

	afterEach(() => {
		store.destroy();
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

	it('updateSession should not affect other sessions', () => {
		store.updateSession('2', { title: 'Updated' });
		const session1 = store.getSession('1');
		expect(session1?.title).toBe('Session 1');
	});

	it('removeSession should remove session from list', () => {
		store.removeSession('2');
		expect(store.sessions.value).toHaveLength(2);
		expect(store.getSession('2')).toBeUndefined();
	});

	it('removeSession should not throw for non-existent ID', () => {
		expect(() => store.removeSession('nonexistent')).not.toThrow();
		expect(store.sessions.value).toHaveLength(3);
	});

	it('addSession should add session to list', () => {
		const newSession = createMockSession('4');
		store.addSession(newSession);
		expect(store.sessions.value).toHaveLength(4);
		expect(store.getSession('4')).toBeDefined();
	});
});

// Tests for actual GlobalStore destroy with cleanup errors
describe('GlobalStore - destroy (actual)', () => {
	let store: ActualGlobalStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = new ActualGlobalStore();
	});

	it('should handle cleanup function errors gracefully', async () => {
		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Initialize first
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});

		// Make one of the unsubscribe functions throw
		let callCount = 0;
		mockHub.subscribeOptimistic.mockImplementation(() => {
			callCount++;
			if (callCount === 2) {
				return () => {
					throw new Error('Cleanup error');
				};
			}
			return vi.fn();
		});

		await store.initialize();

		// Should not throw even if cleanup throws
		expect(() => store.destroy()).not.toThrow();
		expect(consoleSpy).toHaveBeenCalledWith('[GlobalStore] Cleanup error:', expect.any(Error));

		consoleSpy.mockRestore();
	});

	it('should reset initialized flag on destroy', async () => {
		// Initialize first
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});
		await store.initialize();

		const privateStore = store as unknown as { initialized: boolean };
		expect(privateStore.initialized).toBe(true);

		store.destroy();

		expect(privateStore.initialized).toBe(false);
	});

	it('should clear cleanup functions on destroy', async () => {
		// Initialize first
		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});
		await store.initialize();

		const privateStore = store as unknown as { cleanupFunctions: Array<() => void> };
		expect(privateStore.cleanupFunctions.length).toBe(4);

		store.destroy();

		expect(privateStore.cleanupFunctions.length).toBe(0);
	});
});

// Tests for actual GlobalStore applySessionsDelta
describe('GlobalStore - applySessionsDelta (actual)', () => {
	let store: ActualGlobalStore;
	let deltaCallback:
		| ((delta: { added?: Session[]; updated?: Partial<Session>[]; removed?: string[] }) => void)
		| null = null;

	beforeEach(async () => {
		vi.clearAllMocks();
		store = new ActualGlobalStore();

		// Initialize with sessions
		mockHub.call.mockResolvedValueOnce({
			sessions: {
				sessions: [createMockSession('1'), createMockSession('2'), createMockSession('3')],
				hasArchivedSessions: false,
			},
			system: null,
			settings: { settings: null },
		});

		// Capture the delta callback
		mockHub.subscribeOptimistic.mockImplementation((channel: string, callback: unknown) => {
			if (channel === 'state.sessions.delta') {
				deltaCallback = callback as typeof deltaCallback;
			}
			return vi.fn();
		});

		await store.initialize();
	});

	afterEach(() => {
		store.destroy();
		deltaCallback = null;
	});

	it('should handle empty delta', () => {
		deltaCallback?.({});
		expect(store.sessions.value).toHaveLength(3);
	});

	it('should remove sessions via delta', () => {
		deltaCallback?.({ removed: ['2'] });
		expect(store.sessions.value).toHaveLength(2);
		expect(store.getSession('2')).toBeUndefined();
	});

	it('should update sessions via delta', () => {
		deltaCallback?.({ updated: [{ ...createMockSession('2'), title: 'Updated Title' }] });
		expect(store.getSession('2')?.title).toBe('Updated Title');
	});

	it('should add sessions via delta', () => {
		deltaCallback?.({ added: [createMockSession('4')] });
		expect(store.sessions.value).toHaveLength(4);
		expect(store.sessions.value[0].id).toBe('4'); // Prepended
	});

	it('should handle removing non-existent session', () => {
		deltaCallback?.({ removed: ['nonexistent'] });
		expect(store.sessions.value).toHaveLength(3);
	});

	it('should handle updating non-existent session', () => {
		deltaCallback?.({ updated: [{ ...createMockSession('nonexistent'), title: 'New' }] });
		expect(store.sessions.value).toHaveLength(3);
	});

	it('should apply combined delta operations in correct order', () => {
		deltaCallback?.({
			removed: ['2'],
			updated: [{ ...createMockSession('1'), title: 'Updated 1' }],
			added: [createMockSession('4')],
		});

		expect(store.sessions.value).toHaveLength(3);
		expect(store.sessions.value[0].id).toBe('4'); // Added first
		expect(store.getSession('1')?.title).toBe('Updated 1');
		expect(store.getSession('2')).toBeUndefined();
	});
});

// Tests for subscription callbacks (actual GlobalStore)
describe('GlobalStore - Subscription Callbacks (actual)', () => {
	let store: ActualGlobalStore;
	let sessionsCallback:
		| ((state: { sessions: Session[]; hasArchivedSessions: boolean }) => void)
		| null = null;
	let systemCallback: ((state: SystemState) => void) | null = null;
	let settingsCallback: ((state: { settings: unknown }) => void) | null = null;

	beforeEach(async () => {
		vi.clearAllMocks();
		store = new ActualGlobalStore();

		mockHub.call.mockResolvedValueOnce({
			sessions: { sessions: [], hasArchivedSessions: false },
			system: null,
			settings: { settings: null },
		});

		// Capture all callbacks
		mockHub.subscribeOptimistic.mockImplementation((channel: string, callback: unknown) => {
			if (channel === 'state.sessions') {
				sessionsCallback = callback as typeof sessionsCallback;
			} else if (channel === 'state.system') {
				systemCallback = callback as typeof systemCallback;
			} else if (channel === 'state.settings') {
				settingsCallback = callback as typeof settingsCallback;
			}
			return vi.fn();
		});

		await store.initialize();
	});

	afterEach(() => {
		store.destroy();
		sessionsCallback = null;
		systemCallback = null;
		settingsCallback = null;
	});

	it('should handle sessions update with missing sessions field', () => {
		sessionsCallback?.({ sessions: undefined as unknown as Session[], hasArchivedSessions: true });
		expect(store.sessions.value).toEqual([]);
		expect(store.hasArchivedSessions.value).toBe(true);
	});

	it('should handle sessions update with missing hasArchivedSessions field', () => {
		const newSessions = [createMockSession('1')];
		sessionsCallback?.({
			sessions: newSessions,
			hasArchivedSessions: undefined as unknown as boolean,
		});
		expect(store.sessions.value).toHaveLength(1);
		expect(store.hasArchivedSessions.value).toBe(false);
	});

	it('should update systemState through subscription', () => {
		const newSystemState = {
			auth: { authenticated: true, method: 'api_key' },
			health: { status: 'healthy' },
			apiConnection: { status: 'connected' },
		};
		systemCallback?.(newSystemState as SystemState);
		expect(store.systemState.value).toEqual(newSystemState);
	});

	it('should handle settings update with missing settings field', () => {
		settingsCallback?.({ settings: undefined });
		expect(store.settings.value).toBeNull();
	});

	it('should update settings through subscription', () => {
		settingsCallback?.({ settings: { theme: 'dark', showArchived: true } });
		expect(store.settings.value).toEqual({ theme: 'dark', showArchived: true });
	});
});

// Tests for actual GlobalStore computed accessors
describe('GlobalStore - Computed Accessors (actual)', () => {
	let store: ActualGlobalStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = new ActualGlobalStore();
	});

	afterEach(() => {
		store.destroy();
	});

	describe('healthStatus', () => {
		it('should return health from systemState', () => {
			store.systemState.value = {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'connected' },
			} as SystemState;
			expect(store.healthStatus.value).toEqual({ status: 'healthy' });
		});
	});

	describe('recentSessions', () => {
		it('should return last 5 sessions sorted by lastActiveAt', () => {
			const sessions = [
				createMockSession('1', '2024-01-01T00:00:00Z'),
				createMockSession('2', '2024-01-05T00:00:00Z'),
				createMockSession('3', '2024-01-03T00:00:00Z'),
				createMockSession('4', '2024-01-04T00:00:00Z'),
				createMockSession('5', '2024-01-02T00:00:00Z'),
				createMockSession('6', '2024-01-06T00:00:00Z'),
			];
			store.sessions.value = sessions;

			const recent = store.recentSessions.value;
			expect(recent).toHaveLength(5);
			expect(recent[0].id).toBe('6'); // Most recent
			expect(recent[1].id).toBe('2');
			expect(recent[2].id).toBe('4');
			expect(recent[3].id).toBe('3');
			expect(recent[4].id).toBe('5');
		});

		it('should handle sessions with same lastActiveAt', () => {
			const sameTime = '2024-01-01T00:00:00Z';
			const sessions = [createMockSession('1', sameTime), createMockSession('2', sameTime)];
			store.sessions.value = sessions;

			const recent = store.recentSessions.value;
			expect(recent).toHaveLength(2);
		});
	});

	describe('activeSessions', () => {
		it('should filter by active status', () => {
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
	});

	describe('apiConnectionStatus', () => {
		it('should return connected by default', () => {
			expect(store.apiConnectionStatus.value).toBe('connected');
		});

		it('should return degraded when system state shows degraded', () => {
			store.systemState.value = {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'degraded' },
			} as SystemState;
			expect(store.apiConnectionStatus.value).toBe('degraded');
		});

		it('should return disconnected when system state shows disconnected', () => {
			store.systemState.value = {
				auth: { authenticated: true, method: 'api_key' },
				health: { status: 'healthy' },
				apiConnection: { status: 'disconnected' },
			} as SystemState;
			expect(store.apiConnectionStatus.value).toBe('disconnected');
		});
	});
});
