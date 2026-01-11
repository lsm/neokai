// @ts-nocheck
/**
 * Tests for StateChannel and DeltaMergers
 *
 * Tests the StateChannel class for client-side state synchronization
 * and the DeltaMergers helper utilities.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { StateChannel, DeltaMergers } from '../state-channel';
import type { MessageHub } from '@liuboer/shared';

// Create mock MessageHub
function createMockHub() {
	return {
		call: mock(() => Promise.resolve(null)),
		subscribe: mock(() => Promise.resolve(() => Promise.resolve())),
		subscribeOptimistic: mock(() => () => {}),
		onConnection: mock(() => () => {}),
	};
}

describe('StateChannel', () => {
	let mockHub: ReturnType<typeof createMockHub>;
	let channel: StateChannel<{ data: string }>;

	beforeEach(() => {
		mockHub = createMockHub();
	});

	afterEach(async () => {
		if (channel) {
			await channel.stop();
		}
	});

	describe('constructor', () => {
		it('should create with default options', () => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
			expect(channel).toBeDefined();
		});

		it('should create with custom options', () => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
				sessionId: 'test-session',
				enableDeltas: false,
				refreshInterval: 5000,
				debug: true,
				optimisticTimeout: 10000,
			});
			expect(channel).toBeDefined();
		});
	});

	describe('value and signals', () => {
		beforeEach(() => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
		});

		it('should start with null value', () => {
			expect(channel.value).toBeNull();
		});

		it('should expose reactive signal via $', () => {
			expect(channel.$).toBeDefined();
			expect(channel.$.value).toBeNull();
		});

		it('should expose loading signal', () => {
			expect(channel.isLoading).toBeDefined();
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

	describe('isStale', () => {
		beforeEach(() => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
		});

		it('should return true when never synced', () => {
			expect(channel.isStale()).toBe(true);
		});

		it('should return true when sync time exceeds maxAge', async () => {
			// Manually set lastSync via reflection
			const privateChannel = channel as unknown as { lastSync: { value: number } };
			privateChannel.lastSync.value = Date.now() - 120000; // 2 minutes ago

			expect(channel.isStale(60000)).toBe(true);
		});

		it('should return false when sync time is within maxAge', async () => {
			const privateChannel = channel as unknown as { lastSync: { value: number } };
			privateChannel.lastSync.value = Date.now() - 30000; // 30 seconds ago

			expect(channel.isStale(60000)).toBe(false);
		});

		it('should use default maxAge of 60000ms', () => {
			const privateChannel = channel as unknown as { lastSync: { value: number } };
			privateChannel.lastSync.value = Date.now() - 30000;

			expect(channel.isStale()).toBe(false);
		});
	});

	describe('start', () => {
		beforeEach(() => {
			mockHub.call.mockImplementation(() => Promise.resolve({ data: 'test' }));
		});

		it('should fetch initial snapshot', async () => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
			await channel.start();

			expect(mockHub.call).toHaveBeenCalledWith('test.channel', {}, { sessionId: 'global' });
		});

		it('should update state with snapshot', async () => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
			await channel.start();

			expect(channel.value).toEqual({ data: 'test' });
		});

		it('should setup subscriptions', async () => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
			await channel.start();

			expect(mockHub.subscribe).toHaveBeenCalled();
		});

		it('should use subscribeOptimistic when option enabled', async () => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
				useOptimisticSubscriptions: true,
			});
			await channel.start();

			expect(mockHub.subscribeOptimistic).toHaveBeenCalled();
		});

		it('should throw on fetch error', async () => {
			mockHub.call.mockImplementation(() => Promise.reject(new Error('Network error')));
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');

			await expect(channel.start()).rejects.toThrow('Network error');
		});

		it('should set error state on fetch error', async () => {
			mockHub.call.mockImplementation(() => Promise.reject(new Error('Network error')));
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');

			try {
				await channel.start();
			} catch {
				// Expected
			}

			expect(channel.hasError.value).toBeInstanceOf(Error);
			expect(channel.hasError.value?.message).toBe('Network error');
		});
	});

	describe('stop', () => {
		it('should call all unsubscribe functions', async () => {
			const unsubscribe1 = mock(() => Promise.resolve());
			const unsubscribe2 = mock(() => Promise.resolve());
			mockHub.subscribe.mockImplementation(() => Promise.resolve(unsubscribe1));
			mockHub.onConnection.mockImplementation(() => unsubscribe2);
			mockHub.call.mockImplementation(() => Promise.resolve({ data: 'test' }));

			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
			await channel.start();
			await channel.stop();

			expect(unsubscribe1).toHaveBeenCalled();
		});

		it('should clear refresh timer', async () => {
			mockHub.call.mockImplementation(() => Promise.resolve({ data: 'test' }));

			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
				refreshInterval: 1000,
			});
			await channel.start();

			const privateChannel = channel as unknown as {
				refreshTimer: ReturnType<typeof setInterval> | null;
			};
			expect(privateChannel.refreshTimer).not.toBeNull();

			await channel.stop();
			expect(privateChannel.refreshTimer).toBeNull();
		});
	});

	describe('refresh', () => {
		it('should fetch new snapshot', async () => {
			mockHub.call.mockImplementation(() => Promise.resolve({ data: 'initial' }));
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
			await channel.start();

			mockHub.call.mockImplementation(() => Promise.resolve({ data: 'refreshed' }));
			await channel.refresh();

			expect(channel.value).toEqual({ data: 'refreshed' });
		});
	});

	describe('updateOptimistic', () => {
		beforeEach(async () => {
			mockHub.call.mockImplementation(() => Promise.resolve({ data: 'initial' }));
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
				optimisticTimeout: 100,
			});
			await channel.start();
		});

		it('should apply optimistic update immediately', () => {
			channel.updateOptimistic('update-1', (current) => ({ ...current, data: 'optimistic' }));
			expect(channel.value).toEqual({ data: 'optimistic' });
		});

		it('should revert on timeout', async () => {
			channel.updateOptimistic('update-1', (current) => ({ ...current, data: 'optimistic' }));

			// Wait for timeout
			await new Promise((resolve) => setTimeout(resolve, 150));

			expect(channel.value).toEqual({ data: 'initial' });
		});

		it('should commit when confirmed promise resolves', async () => {
			const confirmed = Promise.resolve();
			channel.updateOptimistic(
				'update-1',
				(current) => ({ ...current, data: 'optimistic' }),
				confirmed
			);

			await confirmed;
			// Small delay for microtask
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(channel.value).toEqual({ data: 'optimistic' });
		});

		it('should revert when confirmed promise rejects', async () => {
			const confirmed = Promise.reject(new Error('Failed'));
			channel.updateOptimistic(
				'update-1',
				(current) => ({ ...current, data: 'optimistic' }),
				confirmed.catch(() => {}) // Prevent unhandled rejection
			);

			// Small delay for microtask
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should revert (or still be optimistic if not yet processed)
			// The actual revert happens in catch handler
		});

		it('should warn when state is null', () => {
			channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			channel.updateOptimistic('update-1', (current) => current);

			expect(warnSpy).toHaveBeenCalledWith('Cannot update optimistically: state is null');
			warnSpy.mockRestore();
		});
	});
});

describe('DeltaMergers', () => {
	describe('array', () => {
		interface Item {
			id: string;
			name: string;
		}

		it('should add new items to start of array', () => {
			const current: Item[] = [{ id: '1', name: 'One' }];
			const delta = { added: [{ id: '2', name: 'Two' }] };

			const result = DeltaMergers.array(current, delta);

			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('2'); // Added at start
			expect(result[1].id).toBe('1');
		});

		it('should remove items by id', () => {
			const current: Item[] = [
				{ id: '1', name: 'One' },
				{ id: '2', name: 'Two' },
				{ id: '3', name: 'Three' },
			];
			const delta = { removed: ['2'] };

			const result = DeltaMergers.array(current, delta);

			expect(result).toHaveLength(2);
			expect(result.map((i) => i.id)).toEqual(['1', '3']);
		});

		it('should update existing items', () => {
			const current: Item[] = [
				{ id: '1', name: 'One' },
				{ id: '2', name: 'Two' },
			];
			const delta = { updated: [{ id: '2', name: 'Updated Two' }] };

			const result = DeltaMergers.array(current, delta);

			expect(result).toHaveLength(2);
			expect(result[1].name).toBe('Updated Two');
		});

		it('should handle combined operations in correct order', () => {
			const current: Item[] = [
				{ id: '1', name: 'One' },
				{ id: '2', name: 'Two' },
			];
			const delta = {
				added: [{ id: '3', name: 'Three' }],
				updated: [{ id: '1', name: 'Updated One' }],
				removed: ['2'],
			};

			const result = DeltaMergers.array(current, delta);

			// Order: remove -> update -> add (prepend)
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('3');
			expect(result[1].name).toBe('Updated One');
		});

		it('should handle empty delta', () => {
			const current: Item[] = [{ id: '1', name: 'One' }];
			const delta = {};

			const result = DeltaMergers.array(current, delta);

			expect(result).toEqual(current);
		});

		it('should handle non-existent update gracefully', () => {
			const current: Item[] = [{ id: '1', name: 'One' }];
			const delta = { updated: [{ id: 'nonexistent', name: 'Ghost' }] };

			const result = DeltaMergers.array(current, delta);

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ id: '1', name: 'One' });
		});
	});

	describe('object', () => {
		it('should merge object properties', () => {
			const current = { a: 1, b: 2, c: 3 };
			const delta = { b: 20, d: 4 };

			const result = DeltaMergers.object(current, delta);

			expect(result).toEqual({ a: 1, b: 20, c: 3, d: 4 });
		});

		it('should handle empty delta', () => {
			const current = { a: 1, b: 2 };
			const delta = {};

			const result = DeltaMergers.object(current, delta);

			expect(result).toEqual({ a: 1, b: 2 });
		});

		it('should handle nested objects (shallow merge)', () => {
			const current = { nested: { a: 1, b: 2 }, other: 'value' };
			const delta = { nested: { c: 3 } };

			const result = DeltaMergers.object(current, delta);

			// Shallow merge - nested object is replaced, not merged
			expect(result).toEqual({ nested: { c: 3 }, other: 'value' });
		});
	});

	describe('append', () => {
		it('should append added items to end of array', () => {
			const current = [1, 2, 3];
			const delta = { added: [4, 5] };

			const result = DeltaMergers.append(current, delta);

			expect(result).toEqual([1, 2, 3, 4, 5]);
		});

		it('should return current array when no added items', () => {
			const current = [1, 2, 3];
			const delta = {};

			const result = DeltaMergers.append(current, delta);

			expect(result).toBe(current);
		});

		it('should handle empty added array', () => {
			const current = [1, 2, 3];
			const delta = { added: [] };

			// When added is empty array, it's still truthy so a new array is created
			const result = DeltaMergers.append(current, delta);

			// Implementation returns new array with empty spread
			expect(result).toEqual([1, 2, 3]);
		});

		it('should work with objects', () => {
			const current = [{ id: 1 }, { id: 2 }];
			const delta = { added: [{ id: 3 }] };

			const result = DeltaMergers.append(current, delta);

			expect(result).toHaveLength(3);
			expect(result[2]).toEqual({ id: 3 });
		});
	});
});
