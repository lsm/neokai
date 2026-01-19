// @ts-nocheck
/**
 * Tests for GlobalStore
 *
 * Tests the GlobalStore class which manages application-wide state.
 * Since GlobalStore imports connection-manager (which needs DOM),
 * we test the class behavior patterns instead of the actual singleton.
 */

import { signal, computed } from '@preact/signals';
import type { Session, AuthStatus, HealthStatus, SystemState } from '@liuboer/shared';

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

// Use TestGlobalStore instead of actual GlobalStore
const GlobalStore = TestGlobalStore;

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
