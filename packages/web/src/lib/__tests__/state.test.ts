/**
 * Tests for Application State Management
 *
 * Tests signal subscription leak fixes and state channel management.
 */

import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { signal } from '@preact/signals';

// Mock the MessageHub and StateChannel
const mockHub = {
	isConnected: mock(() => true),
	subscribe: mock(() => Promise.resolve(() => {})),
	subscribeOptimistic: mock(() => () => {}),
	call: mock(() => Promise.resolve({})),
};

const mockStateChannel = {
	start: mock(() => Promise.resolve()),
	stop: mock(() => {}),
	$: signal(null),
};

// Mock the state-channel module
mock.module('../state-channel', () => ({
	StateChannel: class MockStateChannel {
		$ = signal(null);
		start = mockStateChannel.start;
		stop = mockStateChannel.stop;
	},
	DeltaMergers: {
		array: mock((current: unknown[], _delta: unknown) => current),
		append: mock((current: unknown[], _delta: unknown) => current),
	},
}));

// Mock the @liuboer/shared module
mock.module('@liuboer/shared', () => ({
	STATE_CHANNELS: {
		GLOBAL_SESSIONS: 'state.sessions',
		GLOBAL_SYSTEM: 'state.system',
		SESSION: 'state.session',
		SESSION_SDK_MESSAGES: 'state.sdkMessages',
	},
}));

// Import after mocking
import { appState, initializeApplicationState, cleanupApplicationState } from '../state';

describe('ApplicationState', () => {
	let currentSessionId: import('@preact/signals').Signal<string | null>;

	beforeEach(() => {
		// Reset mocks
		mockStateChannel.start.mockReset();
		mockStateChannel.stop.mockReset();

		// Create fresh session ID signal for each test with explicit type
		currentSessionId = signal(null) as import('@preact/signals').Signal<string | null>;
	});

	afterEach(() => {
		// Cleanup state after each test
		cleanupApplicationState();
	});

	describe('Subscription Leak Prevention', () => {
		it('should track subscriptions for cleanup', async () => {
			// Initialize state
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Trigger a session change to create subscription
			currentSessionId.value = 'test-session-1';

			// Access private subscriptions array via reflection
			const subscriptions = (appState as unknown as { subscriptions: Array<() => void> })
				.subscriptions;

			// Should have at least one subscription (from setupCurrentSessionAutoLoad)
			expect(subscriptions.length).toBeGreaterThan(0);
		});

		it('should cleanup subscriptions on cleanup()', async () => {
			// Initialize state
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Get subscriptions before cleanup
			const subscriptionsBefore = (appState as unknown as { subscriptions: Array<() => void> })
				.subscriptions;
			const subscriptionCount = subscriptionsBefore.length;

			// Track unsubscribe calls
			let unsubscribeCalls = 0;
			subscriptionsBefore.forEach((_, index) => {
				const original = subscriptionsBefore[index];
				subscriptionsBefore[index] = () => {
					unsubscribeCalls++;
					if (original) original();
				};
			});

			// Cleanup
			cleanupApplicationState();

			// Verify subscriptions were called
			expect(unsubscribeCalls).toBe(subscriptionCount);

			// Verify subscriptions array is cleared
			const subscriptionsAfter = (appState as unknown as { subscriptions: Array<() => void> })
				.subscriptions;
			expect(subscriptionsAfter.length).toBe(0);
		});

		it('should not leak subscriptions on multiple initializations', async () => {
			// Initialize, cleanup, re-initialize pattern
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);
			cleanupApplicationState();

			// Create fresh signal for second initialization
			const newSessionId = signal<string | null>(null);
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				newSessionId
			);

			// Should not have accumulated subscriptions
			const subscriptions = (appState as unknown as { subscriptions: Array<() => void> })
				.subscriptions;
			expect(subscriptions.length).toBeLessThanOrEqual(1);
		});
	});

	describe('Session Channel Management', () => {
		it('should auto-load session channels when currentSessionId changes', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Initially no session channels
			const sessionChannelsBefore = (
				appState as unknown as { sessionChannels: Map<string, unknown> }
			).sessionChannels;
			expect(sessionChannelsBefore.size).toBe(0);

			// Change session ID
			currentSessionId.value = 'auto-load-test-session';

			// Should have created channels for the session
			const sessionChannelsAfter = (
				appState as unknown as { sessionChannels: Map<string, unknown> }
			).sessionChannels;
			expect(sessionChannelsAfter.has('auto-load-test-session')).toBe(true);
		});

		it('should cleanup session channels on cleanupSessionChannels()', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Create channels for a session
			currentSessionId.value = 'cleanup-test-session';

			const sessionChannels = (appState as unknown as { sessionChannels: Map<string, unknown> })
				.sessionChannels;
			expect(sessionChannels.has('cleanup-test-session')).toBe(true);

			// Cleanup specific session
			appState.cleanupSessionChannels('cleanup-test-session');

			// Should be removed
			expect(sessionChannels.has('cleanup-test-session')).toBe(false);
		});

		it('should stop all session channels on cleanup()', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Create multiple sessions
			currentSessionId.value = 'session-1';
			currentSessionId.value = 'session-2';
			currentSessionId.value = 'session-3';

			const sessionChannelsBefore = (
				appState as unknown as { sessionChannels: Map<string, unknown> }
			).sessionChannels;
			// After cleanup on switch fix: only the current session has channels
			expect(sessionChannelsBefore.size).toBe(1);
			expect(sessionChannelsBefore.has('session-3')).toBe(true);

			// Cleanup all
			cleanupApplicationState();

			// All should be cleared
			const sessionChannelsAfter = (
				appState as unknown as { sessionChannels: Map<string, unknown> }
			).sessionChannels;
			expect(sessionChannelsAfter.size).toBe(0);
		});
	});

	describe('Global State Channels', () => {
		it('should initialize global channels on start', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Global channels should be initialized
			expect(appState.global.value).not.toBeNull();
		});

		it('should stop global channels on cleanup', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			expect(appState.global.value).not.toBeNull();

			cleanupApplicationState();

			expect(appState.global.value).toBeNull();
		});
	});

	describe('Initialization State', () => {
		it('should prevent double initialization', async () => {
			// First initialization
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Spy on console.warn
			const warnSpy = spyOn(console, 'warn');

			// Try to initialize again
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Should have warned
			expect(warnSpy).toHaveBeenCalledWith('State already initialized');

			warnSpy.mockRestore();
		});

		it('should reset initialized flag on cleanup', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Access private initialized signal
			const initialized = (appState as unknown as { initialized: { value: boolean } }).initialized;
			expect(initialized.value).toBe(true);

			cleanupApplicationState();

			expect(initialized.value).toBe(false);
		});
	});
});

describe('ApplicationState - Edge Cases', () => {
	let currentSessionId: import('@preact/signals').Signal<string | null>;

	beforeEach(() => {
		currentSessionId = signal(null) as import('@preact/signals').Signal<string | null>;
	});

	afterEach(() => {
		cleanupApplicationState();
	});

	it('should handle null session ID in auto-load', async () => {
		await initializeApplicationState(
			mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
			currentSessionId
		);

		// Set to null (should not throw)
		currentSessionId.value = null;

		// No session channels should be created
		const sessionChannels = (appState as unknown as { sessionChannels: Map<string, unknown> })
			.sessionChannels;
		expect(sessionChannels.size).toBe(0);
	});

	it('should handle rapid session ID changes', async () => {
		await initializeApplicationState(
			mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
			currentSessionId
		);

		// Rapid changes
		for (let i = 0; i < 10; i++) {
			currentSessionId.value = `rapid-session-${i}`;
		}

		// After cleanup on switch fix: only the last session has channels
		const sessionChannels = (appState as unknown as { sessionChannels: Map<string, unknown> })
			.sessionChannels;
		expect(sessionChannels.size).toBe(1);
		expect(sessionChannels.has('rapid-session-9')).toBe(true);
	});

	it('should create new channels when switching back to a session', async () => {
		await initializeApplicationState(
			mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
			currentSessionId
		);

		// Set session
		currentSessionId.value = 'reuse-test';

		const channels1 = appState.getSessionChannels('reuse-test');

		// Switch away (this will cleanup 'reuse-test' channels)
		currentSessionId.value = 'other-session';

		// Switch back (this will create new channels)
		currentSessionId.value = 'reuse-test';

		const channels2 = appState.getSessionChannels('reuse-test');

		// After cleanup on switch fix: channels are recreated, not reused
		expect(channels1).not.toBe(channels2);

		// But both should be valid channel instances
		expect(channels1).toBeDefined();
		expect(channels2).toBeDefined();
		expect(channels1.session).toBeDefined();
		expect(channels2.session).toBeDefined();
	});

	it('should throw when getSessionChannels called before init', () => {
		// Don't initialize - should throw
		expect(() => appState.getSessionChannels('test')).toThrow('State not initialized');
	});
});
