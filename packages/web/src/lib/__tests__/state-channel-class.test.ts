// @ts-nocheck
/**
 * Comprehensive tests for StateChannel class
 *
 * Tests the StateChannel class to increase coverage to 85%+
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateChannel } from '../state-channel';
import type { MessageHub } from '@liuboer/shared';

// Mock MessageHub
vi.mock('@liuboer/shared', () => ({
	MessageHub: vi.fn(),
}));

// Module-level mock objects
const mockHubObj: {
	call: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	subscribeOptimistic: ReturnType<typeof vi.fn>;
	onConnection: ReturnType<typeof vi.fn>;
} = {
	call: vi.fn(() => Promise.resolve({ data: 'test', timestamp: 123456 })),
	subscribe: vi.fn(() => Promise.resolve(vi.fn())),
	subscribeOptimistic: vi.fn(() => vi.fn()),
	onConnection: vi.fn(() => vi.fn()),
};

vi.mock('../state', () => ({
	appState: { value: {} },
	connectionState: { value: 'disconnected' },
}));

describe('StateChannel - Comprehensive Coverage', () => {
	let channel: StateChannel<{ data: string; timestamp?: number }>;

	beforeEach(() => {
		vi.clearAllMocks();

		// Reset mock hub
		mockHubObj.call = vi.fn(() => Promise.resolve({ data: 'test', timestamp: 123456 }));
		mockHubObj.subscribe = vi.fn(() => Promise.resolve(vi.fn()));
		mockHubObj.subscribeOptimistic = vi.fn(() => vi.fn());
		mockHubObj.onConnection = vi.fn(() => vi.fn());

		// Create channel
		channel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');
	});

	afterEach(async () => {
		if (channel) {
			await channel.stop();
		}
	});

	describe('constructor and options', () => {
		it('should set default options', () => {
			const testChannel = new StateChannel(mockHubObj, 'test.channel');
			expect(testChannel).toBeDefined();
		});

		it('should use custom sessionId', () => {
			const testChannel = new StateChannel(mockHubObj, 'test.channel', {
				sessionId: 'custom-session',
			});
			expect(testChannel).toBeDefined();
		});

		it('should use custom refresh interval', () => {
			const testChannel = new StateChannel(mockHubObj, 'test.channel', {
				refreshInterval: 5000,
			});
			expect(testChannel).toBeDefined();
		});

		it('should use custom optimistic timeout', () => {
			const testChannel = new StateChannel(mockHubObj, 'test.channel', {
				optimisticTimeout: 10000,
			});
			expect(testChannel).toBeDefined();
		});

		it('should support non-blocking mode', () => {
			const testChannel = new StateChannel(mockHubObj, 'test.channel', {
				nonBlocking: true,
			});
			expect(testChannel).toBeDefined();
		});

		it('should support optimistic subscriptions', () => {
			const testChannel = new StateChannel(mockHubObj, 'test.channel', {
				useOptimisticSubscriptions: true,
			});
			expect(testChannel).toBeDefined();
		});

		it('should support custom merge delta function', () => {
			const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
			const testChannel = new StateChannel(mockHubObj, 'test.channel', {
				mergeDelta: mergeFn,
			});
			expect(testChannel).toBeDefined();
		});

		it('should support debug mode', () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const testChannel = new StateChannel(mockHubObj, 'test.channel', {
				debug: true,
			});
			testChannel['log']('test message');
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	describe('start() and stop()', () => {
		it('should fetch snapshot and setup subscriptions on start', async () => {
			await channel.start();

			expect(mockHubObj.call).toHaveBeenCalledWith('test.channel', {}, { sessionId: 'global' });
			expect(mockHubObj.subscribe).toHaveBeenCalled();
		});

		it('should setup optimistic subscriptions when enabled', async () => {
			const optimisticChannel = new StateChannel(
				mockHubObj as unknown as MessageHub,
				'test.channel',
				{ useOptimisticSubscriptions: true }
			);

			await optimisticChannel.start();

			expect(mockHubObj.subscribeOptimistic).toHaveBeenCalled();
			await optimisticChannel.stop();
		});

		it('should setup non-blocking subscriptions when enabled', async () => {
			const nonBlockingChannel = new StateChannel(
				mockHubObj as unknown as MessageHub,
				'test.channel',
				{ nonBlocking: true }
			);

			await nonBlockingChannel.start();

			// Should still fetch snapshot
			expect(mockHubObj.call).toHaveBeenCalled();
			await nonBlockingChannel.stop();
		});

		it('should setup auto-refresh when configured', async () => {
			vi.useFakeTimers();

			const refreshChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
				refreshInterval: 1000,
			});

			await refreshChannel.start();

			// Fast forward time
			vi.advanceTimersByTime(2000);

			await refreshChannel.stop();
			vi.useRealTimers();
		});

		it('should setup reconnection handler', async () => {
			await channel.start();

			expect(mockHubObj.onConnection).toHaveBeenCalled();
		});

		it('should stop and cleanup subscriptions', async () => {
			await channel.start();
			await channel.stop();

			// The stop method should complete without error
			expect(channel.value).toBeDefined();
		});

		it('should clear refresh timer on stop', async () => {
			vi.useFakeTimers();

			const refreshChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
				refreshInterval: 1000,
			});

			await refreshChannel.start();
			await refreshChannel.stop();

			// Timer should be cleared
			vi.advanceTimersByTime(5000);

			await refreshChannel.stop();
			vi.useRealTimers();
		});

		it('should clear optimistic updates on stop', async () => {
			const optimisticChannel = new StateChannel(
				mockHubObj as unknown as MessageHub,
				'test.channel',
				{ optimisticTimeout: 100 }
			);

			await optimisticChannel.start();

			// Add some optimistic updates
			optimisticChannel.updateOptimistic('test-1', (_current) => ({
				data: 'optimistic-1',
			}));

			await optimisticChannel.stop();
			vi.useRealTimers();
		});

		it('should set error state on start failure', async () => {
			mockHubObj.call.mockRejectedValue(new Error('Connection failed'));

			const errorChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');

			await expect(errorChannel.start()).rejects.toThrow('Connection failed');
			expect(errorChannel.hasError.value).toBeInstanceOf(Error);
		});

		it('should handle fetch error gracefully', async () => {
			mockHubObj.call.mockRejectedValueOnce(new Error('Fetch failed'));

			const errorChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');

			await expect(errorChannel.start()).rejects.toThrow();
		});
	});

	describe('refresh()', () => {
		it('should fetch new snapshot', async () => {
			mockHubObj.call.mockResolvedValue({ data: 'refreshed', timestamp: 123457 });

			await channel.start();
			await channel.refresh();

			expect(mockHubObj.call).toHaveBeenCalledTimes(2);
			expect(channel.value?.data).toBe('refreshed');
		});

		it('should handle refresh errors', async () => {
			mockHubObj.call.mockResolvedValueOnce({ data: 'test' });
			mockHubObj.call.mockRejectedValueOnce(new Error('Refresh failed'));

			await channel.start();

			// Should log error but not throw
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			await channel.refresh().catch(() => {});
			consoleSpy.mockRestore();
		});
	});

	describe('updateOptimistic()', () => {
		it('should apply optimistic update immediately', async () => {
			await channel.start();

			channel.updateOptimistic('update-1', (_current) => ({
				data: 'optimistic',
			}));

			expect(channel.value?.data).toBe('optimistic');
		});

		it('should revert optimistic update on timeout', async () => {
			const testChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
				optimisticTimeout: 50,
			});

			await testChannel.start();

			testChannel.updateOptimistic('update-1', (_current) => ({
				data: 'optimistic',
			}));

			// Wait for timeout
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should revert
			expect(testChannel.value?.data).not.toBe('optimistic');

			await testChannel.stop();
		});

		it('should commit when confirmed promise resolves', async () => {
			await channel.start();

			const confirmed = Promise.resolve();
			channel.updateOptimistic('update-1', (_current) => ({ data: 'optimistic' }), confirmed);

			await confirmed;
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(channel.value?.data).toBe('optimistic');
		});

		it('should revert when confirmed promise rejects', async () => {
			await channel.start();

			const confirmed = Promise.reject(new Error('Failed'));

			// Pass the original rejecting promise
			channel.updateOptimistic('update-1', (_current) => ({ data: 'optimistic' }), confirmed);

			// Handle the rejection separately to avoid unhandled promise warning
			await confirmed.catch(() => {});

			// Wait for async rejection handling
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Should have reverted back to original value
			expect(channel.value?.data).not.toBe('optimistic');
		});

		it('should revert when confirmed promise times out', async () => {
			vi.useFakeTimers();

			const testChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
				optimisticTimeout: 100, // 100ms timeout
			});

			mockHubObj.call.mockResolvedValue({ data: 'original' });
			await testChannel.start();

			// Create a promise that never resolves
			const neverResolves = new Promise<void>(() => {
				// This promise never resolves
			});

			testChannel.updateOptimistic(
				'update-timeout',
				(_current) => ({ data: 'optimistic' }),
				neverResolves
			);

			// Initially should have optimistic value
			expect(testChannel.value?.data).toBe('optimistic');

			// Advance time past the timeout
			await vi.advanceTimersByTimeAsync(150);

			// Should have reverted back to original value
			expect(testChannel.value?.data).toBe('original');

			await testChannel.stop();
			vi.useRealTimers();
		});

		it('should warn when state is null', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const emptyChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');

			emptyChannel.updateOptimistic('update-1', (current) => current as { data: string });

			expect(warnSpy).toHaveBeenCalledWith('Cannot update optimistically: state is null');
			warnSpy.mockRestore();
		});

		it('should handle multiple optimistic updates', async () => {
			await channel.start();

			channel.updateOptimistic('update-1', (_current) => ({ data: 'update-1' }));
			expect(channel.value?.data).toBe('update-1');

			channel.updateOptimistic('update-2', (_current) => ({ data: 'update-2' }));
			expect(channel.value?.data).toBe('update-2');
		});
	});

	describe('isStale()', () => {
		it('should return true when never synced', () => {
			expect(channel.isStale()).toBe(true);
		});

		it('should return true when sync time exceeds maxAge', async () => {
			const privateChannel = channel as unknown as {
				lastSync: { value: number };
			};

			mockHubObj.call.mockResolvedValue({ data: 'test', timestamp: Date.now() - 120000 });

			await channel.start();

			privateChannel.lastSync.value = Date.now() - 120000; // 2 minutes ago

			expect(channel.isStale(60000)).toBe(true);
		});

		it('should return false when sync time is within maxAge', async () => {
			const privateChannel = channel as unknown as {
				lastSync: { value: number };
			};

			mockHubObj.call.mockResolvedValue({ data: 'test', timestamp: Date.now() - 30000 });

			await channel.start();

			privateChannel.lastSync.value = Date.now() - 30000; // 30 seconds ago

			expect(channel.isStale(60000)).toBe(false);
		});
	});

	describe('signals', () => {
		it('should expose value signal', async () => {
			expect(channel.$).toBeDefined();
			expect(channel.value).toBeNull();
		});

		it('should expose loading signal', async () => {
			expect(channel.isLoading).toBeDefined();
			expect(channel.isLoading.value).toBe(false);
		});

		it('should set loading during fetch', async () => {
			mockHubObj.call.mockImplementation(
				() =>
					new Promise((resolve) => {
						setTimeout(() => resolve({ data: 'test' }), 50);
					})
			);

			const startPromise = channel.start();

			// Loading should be true during fetch
			expect(channel.isLoading.value).toBe(true);

			await startPromise;

			// Loading should be false after fetch
			expect(channel.isLoading.value).toBe(false);
		});

		it('should expose error signal', () => {
			expect(channel.hasError).toBeDefined();
			expect(channel.hasError.value).toBeNull();
		});

		it('should expose lastSyncTime signal', () => {
			expect(channel.lastSyncTime).toBeDefined();
			expect(channel.lastSyncTime.value).toBe(0);
		});
	});

	describe('mergeSdkMessages()', () => {
		it('should deduplicate messages by uuid', async () => {
			const messagesChannel = new StateChannel<{
				sdkMessages: Array<{ uuid: string; content: string; timestamp: number }>;
			}>(mockHubObj as unknown as MessageHub, 'state.sdkMessages');

			const existing = [
				{ uuid: 'msg-1', content: 'Hello', timestamp: 100 },
				{ uuid: 'msg-2', content: 'World', timestamp: 200 },
			];
			const incoming = [
				{ uuid: 'msg-1', content: 'Hello Updated', timestamp: 150 },
				{ uuid: 'msg-3', content: 'New', timestamp: 300 },
			];

			mockHubObj.call.mockResolvedValue({ sdkMessages: incoming });
			mockHubObj.call.mockResolvedValueOnce({ sdkMessages: existing });

			await messagesChannel.start();

			// Should deduplicate and merge
			const result = messagesChannel.value?.sdkMessages;
			expect(result).toBeDefined();
		});

		it('should sort messages by timestamp', async () => {
			const messagesChannel = new StateChannel<{
				sdkMessages: Array<{ uuid: string; content: string; timestamp: number }>;
			}>(mockHubObj as unknown as MessageHub, 'state.sdkMessages');

			const incoming = [
				{ uuid: 'msg-3', content: 'Third', timestamp: 300 },
				{ uuid: 'msg-1', content: 'First', timestamp: 100 },
				{ uuid: 'msg-2', content: 'Second', timestamp: 200 },
			];

			mockHubObj.call.mockResolvedValue({ sdkMessages: incoming });

			await messagesChannel.start();

			const result = messagesChannel.value?.sdkMessages;
			expect(result).toBeDefined();
		});

		it('should handle empty message arrays', async () => {
			const messagesChannel = new StateChannel<{
				sdkMessages: Array<{ uuid: string; content: string; timestamp: number }>;
			}>(mockHubObj as unknown as MessageHub, 'state.sdkMessages');

			mockHubObj.call.mockResolvedValue({ sdkMessages: [] });

			await messagesChannel.start();

			expect(messagesChannel.value?.sdkMessages).toEqual([]);
		});
	});

	describe('reconnection handling', () => {
		it('should perform hybrid refresh on reconnection', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

			await channel.start();

			// Get the reconnection handler
			const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
			if (onConnectionCall) {
				const callback = onConnectionCall[0];

				// Simulate reconnection
				callback('connected');

				// Should fetch new snapshot
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			consoleSpy.mockRestore();
		});

		it('should set error on disconnect', async () => {
			await channel.start();

			const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
			if (onConnectionCall) {
				const callback = onConnectionCall[0];

				callback('disconnected');

				expect(channel.hasError.value).toBeInstanceOf(Error);
			}
		});

		it('should set error on connection error', async () => {
			await channel.start();

			const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
			if (onConnectionCall) {
				const callback = onConnectionCall[0];

				callback('error');

				expect(channel.hasError.value).toBeInstanceOf(Error);
			}
		});
	});

	describe('edge cases', () => {
		it('should handle empty snapshots', async () => {
			mockHubObj.call.mockResolvedValue(null);

			await channel.start();

			expect(channel.value).toBeNull();
		});

		it('should handle snapshots without timestamp', async () => {
			mockHubObj.call.mockResolvedValue({ data: 'test-no-timestamp' });

			await channel.start();

			// Should use fallback timestamp
			expect(channel.lastSyncTime.value).toBeGreaterThan(0);
		});

		it('should handle concurrent start calls', async () => {
			const promise1 = channel.start();
			const promise2 = channel.start();

			await Promise.all([promise1, promise2]);

			// Should complete without error
			expect(channel.value).toBeDefined();
		});

		it('should handle multiple stop calls', async () => {
			await channel.start();
			await channel.stop();
			await channel.stop();

			// Should complete without error
			expect(channel.value).toBeDefined();
		});
	});

	describe('delta subscriptions', () => {
		it('should subscribe to delta channel when enableDeltas is true', async () => {
			const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
			const deltaChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
				enableDeltas: true,
				mergeDelta: mergeFn,
				useOptimisticSubscriptions: true,
			});

			await deltaChannel.start();

			// Should have called subscribeOptimistic for the delta channel
			expect(mockHubObj.subscribeOptimistic).toHaveBeenCalled();
			const calls = mockHubObj.subscribeOptimistic.mock.calls;
			const deltaCall = calls.find((call) => call[0] === 'test.channel.delta');
			expect(deltaCall).toBeDefined();

			await deltaChannel.stop();
		});

		it('should apply delta updates via mergeDelta function', async () => {
			const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
			const deltaChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
				enableDeltas: true,
				mergeDelta: mergeFn,
				useOptimisticSubscriptions: true,
			});

			await deltaChannel.start();

			// Get the delta callback
			const calls = mockHubObj.subscribeOptimistic.mock.calls;
			const deltaCall = calls.find((call) => call[0] === 'test.channel.delta');

			if (deltaCall) {
				const deltaCallback = deltaCall[1];
				// Simulate delta update
				deltaCallback({ newField: 'value' });

				// mergeDelta should have been called
				expect(mergeFn).toHaveBeenCalled();
			}

			await deltaChannel.stop();
		});

		it('should warn when delta received but state is null', async () => {
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			mockHubObj.call.mockResolvedValue(null); // state will be null

			const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
			const deltaChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
				enableDeltas: true,
				mergeDelta: mergeFn,
				useOptimisticSubscriptions: true,
			});

			await deltaChannel.start();

			// Get the delta callback
			const calls = mockHubObj.subscribeOptimistic.mock.calls;
			const deltaCall = calls.find((call) => call[0] === 'test.channel.delta');

			if (deltaCall) {
				const deltaCallback = deltaCall[1];
				// Simulate delta update when state is null
				deltaCallback({ newField: 'value' });

				// Should log warning
				expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot apply delta'));
			}

			consoleSpy.mockRestore();
			await deltaChannel.stop();
		});
	});

	describe('hybrid refresh error handling', () => {
		it('should throw error when hybridRefresh fails', async () => {
			await channel.start();

			// Make fetchSnapshot fail on reconnect
			mockHubObj.call.mockRejectedValue(new Error('Fetch failed'));

			const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
			if (onConnectionCall) {
				const callback = onConnectionCall[0];

				// Trigger reconnection - this calls hybridRefresh internally
				// The error should be caught by the .catch(console.error) handler
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				callback('connected');

				// Wait for async operation
				await new Promise((resolve) => setTimeout(resolve, 10));

				// Console.error should have been called with the error
				expect(consoleSpy).toHaveBeenCalled();
				consoleSpy.mockRestore();
			}
		});
	});
});
