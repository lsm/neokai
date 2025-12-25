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
		GLOBAL_SETTINGS: 'state.settings',
		SESSION: 'state.session',
		SESSION_SDK_MESSAGES: 'state.sdkMessages',
	},
}));

// Mock globalStore module
mock.module('../global-store', () => ({
	globalStore: {
		sessions: signal([]),
		systemState: signal(null),
		settings: signal(null),
		addSession: mock(() => {}),
		removeSession: mock(() => {}),
		updateSession: mock(() => {}),
	},
}));

// Import after mocking
import {
	appState,
	initializeApplicationState,
	cleanupApplicationState,
	mergeSdkMessagesWithDedup,
} from '../state';

// Helper to wait for debounced session switching (150ms debounce + buffer)
const waitForSessionSwitch = () => new Promise((resolve) => setTimeout(resolve, 200));

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

			// Initially no active session
			const activeSessionIdBefore = (appState as unknown as { activeSessionId: string | null })
				.activeSessionId;
			expect(activeSessionIdBefore).toBeNull();

			// Change session ID
			currentSessionId.value = 'auto-load-test-session';

			// Wait for debounced session switch to complete
			await waitForSessionSwitch();

			// Should have set the active session
			const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
				.activeSessionId;
			expect(activeSessionIdAfter).toBe('auto-load-test-session');
		});

		it('should cleanup session channels on cleanupSessionChannels()', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Create channels for a session
			currentSessionId.value = 'cleanup-test-session';

			// Wait for debounced session switch to complete
			await waitForSessionSwitch();

			const activeSessionId = (appState as unknown as { activeSessionId: string | null })
				.activeSessionId;
			expect(activeSessionId).toBe('cleanup-test-session');

			// Cleanup specific session
			await appState.cleanupSessionChannels('cleanup-test-session');

			// Should be removed
			const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
				.activeSessionId;
			expect(activeSessionIdAfter).toBeNull();
		});

		it('should stop all session channels on cleanup()', async () => {
			await initializeApplicationState(
				mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
				currentSessionId
			);

			// Create multiple sessions (only last one is active due to single-session invariant)
			currentSessionId.value = 'session-1';
			currentSessionId.value = 'session-2';
			currentSessionId.value = 'session-3';

			// Wait for debounced session switch to complete
			await waitForSessionSwitch();

			// Only the current session has channels (single-session invariant)
			const activeSessionIdBefore = (appState as unknown as { activeSessionId: string | null })
				.activeSessionId;
			expect(activeSessionIdBefore).toBe('session-3');

			// Cleanup all
			cleanupApplicationState();

			// All should be cleared
			const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
				.activeSessionId;
			expect(activeSessionIdAfter).toBeNull();
		});
	});

	// NOTE: Global state channels tests removed - global state is now managed by globalStore

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

		// No active session should be set
		const activeSessionId = (appState as unknown as { activeSessionId: string | null })
			.activeSessionId;
		expect(activeSessionId).toBeNull();
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

		// Wait for debounced session switch to complete
		await waitForSessionSwitch();

		// Only the last session has channels (single-session invariant + debounce)
		const activeSessionId = (appState as unknown as { activeSessionId: string | null })
			.activeSessionId;
		expect(activeSessionId).toBe('rapid-session-9');
	});

	it('should create new channels when switching back to a session', async () => {
		await initializeApplicationState(
			mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
			currentSessionId
		);

		// Set session
		currentSessionId.value = 'reuse-test';
		await waitForSessionSwitch();

		const channels1 = appState.getSessionChannels('reuse-test');

		// Switch away (this will cleanup 'reuse-test' channels after debounce)
		currentSessionId.value = 'other-session';
		await waitForSessionSwitch();

		// Switch back (this will create new channels)
		currentSessionId.value = 'reuse-test';
		await waitForSessionSwitch();

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

describe('mergeSdkMessagesWithDedup', () => {
	// Helper to create a mock SDK message with uuid and timestamp
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const createMessage = (uuid: string, timestamp: number, content = 'test'): any => ({
		type: 'assistant',
		uuid,
		timestamp,
		message: { content },
	});

	it('should return existing messages when added is undefined', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing: any = [createMessage('a', 100), createMessage('b', 200)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup(existing, undefined);
		expect(result).toBe(existing);
	});

	it('should return existing messages when added is empty', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing: any = [createMessage('a', 100), createMessage('b', 200)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup(existing, []);
		expect(result).toBe(existing);
	});

	it('should append new messages without duplicates', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing: any = [createMessage('a', 100), createMessage('b', 200)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const added: any = [createMessage('c', 300)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup(existing, added);

		expect(result).toHaveLength(3);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c']);
	});

	it('should deduplicate messages with same UUID (reconnection bug fix)', () => {
		// Scenario: Snapshot contains [A, B, C, D], then delta arrives with D again
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing: any = [
			createMessage('a', 100),
			createMessage('b', 200),
			createMessage('c', 300),
			createMessage('d', 400),
		];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const added: any = [createMessage('d', 400, 'duplicate')]; // Same UUID as existing 'd'
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup(existing, added);

		// Should NOT have duplicate - only 4 messages, not 5
		expect(result).toHaveLength(4);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('should update existing message when duplicate UUID arrives with newer data', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing: any = [createMessage('a', 100, 'old content')];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const added: any = [createMessage('a', 100, 'new content')];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup(existing, added);

		expect(result).toHaveLength(1);
		// Added message should overwrite existing (takes precedence)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((result[0] as any).message.content).toBe('new content');
	});

	it('should maintain chronological order by timestamp', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing: any = [createMessage('b', 200), createMessage('d', 400)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const added: any = [createMessage('a', 100), createMessage('c', 300)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup(existing, added);

		expect(result).toHaveLength(4);
		// Should be sorted by timestamp, not insertion order
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('should handle multiple duplicates in single delta', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing: any = [createMessage('a', 100), createMessage('b', 200)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const added: any = [
			createMessage('a', 100), // duplicate
			createMessage('b', 200), // duplicate
			createMessage('c', 300), // new
		];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup(existing, added);

		expect(result).toHaveLength(3);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c']);
	});

	it('should handle empty existing messages', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const added: any = [createMessage('a', 100), createMessage('b', 200)];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = mergeSdkMessagesWithDedup([], added);

		expect(result).toHaveLength(2);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b']);
	});
});
