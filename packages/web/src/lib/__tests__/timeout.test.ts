/**
 * Tests for Timeout Utility
 */

import { describe, it, expect } from 'bun:test';
import {
	TimeoutError,
	withTimeout,
	createDeferred,
	delay,
	timeout,
	raceWithTimeout,
} from '../timeout';

describe('TimeoutError', () => {
	it('should create with operation name and timeout', () => {
		const error = new TimeoutError('fetchData', 5000);
		expect(error.message).toBe('Operation "fetchData" timed out after 5000ms');
		expect(error.name).toBe('TimeoutError');
		expect(error.operation).toBe('fetchData');
		expect(error.timeoutMs).toBe(5000);
	});

	it('should be instanceof Error', () => {
		const error = new TimeoutError('test', 1000);
		expect(error).toBeInstanceOf(Error);
	});

	it('should have proper stack trace', () => {
		const error = new TimeoutError('test', 1000);
		expect(error.stack).toBeDefined();
	});
});

describe('withTimeout', () => {
	it('should resolve when operation completes before timeout', async () => {
		const result = await withTimeout(
			async () => {
				await delay(10);
				return 'success';
			},
			1000,
			'testOp'
		);
		expect(result).toBe('success');
	});

	it('should reject with TimeoutError when operation exceeds timeout', async () => {
		await expect(
			withTimeout(
				async () => {
					await delay(1000);
					return 'never';
				},
				50,
				'slowOp'
			)
		).rejects.toThrow(TimeoutError);
	});

	it('should include operation name in timeout error', async () => {
		try {
			await withTimeout(
				async () => {
					await delay(1000);
				},
				10,
				'myOperation'
			);
			expect(true).toBe(false); // Should not reach here
		} catch (err) {
			expect(err).toBeInstanceOf(TimeoutError);
			expect((err as TimeoutError).operation).toBe('myOperation');
			expect((err as TimeoutError).timeoutMs).toBe(10);
		}
	});

	it('should propagate errors from the operation', async () => {
		await expect(
			withTimeout(
				async () => {
					throw new Error('Operation failed');
				},
				1000,
				'failingOp'
			)
		).rejects.toThrow('Operation failed');
	});

	it('should clear timeout when operation succeeds', async () => {
		// This test ensures no leaked timers
		const start = Date.now();
		await withTimeout(async () => 'quick', 5000, 'quickOp');
		const elapsed = Date.now() - start;
		// Should complete almost immediately, not wait for timeout
		expect(elapsed).toBeLessThan(100);
	});

	it('should clear timeout when operation fails', async () => {
		const start = Date.now();
		try {
			await withTimeout(
				async () => {
					throw new Error('fail');
				},
				5000,
				'failOp'
			);
		} catch {
			// Expected
		}
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(100);
	});
});

describe('createDeferred', () => {
	it('should create a promise that can be resolved externally', async () => {
		const { promise, resolve } = createDeferred<string>();

		setTimeout(() => resolve('resolved'), 10);

		const result = await promise;
		expect(result).toBe('resolved');
	});

	it('should create a promise that can be rejected externally', async () => {
		const { promise, reject } = createDeferred<string>();

		setTimeout(() => reject(new Error('rejected')), 10);

		await expect(promise).rejects.toThrow('rejected');
	});

	it('should resolve immediately when called synchronously', async () => {
		const { promise, resolve } = createDeferred<number>();
		resolve(42);
		const result = await promise;
		expect(result).toBe(42);
	});
});

describe('delay', () => {
	it('should resolve after specified time', async () => {
		const start = Date.now();
		await delay(50);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
		expect(elapsed).toBeLessThan(150);
	});

	it('should resolve with undefined', async () => {
		const result = await delay(10);
		expect(result).toBeUndefined();
	});
});

describe('timeout', () => {
	it('should reject after specified time', async () => {
		const start = Date.now();
		try {
			await timeout(50, 'testTimeout');
			expect(true).toBe(false); // Should not reach here
		} catch (err) {
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(45);
			expect(err).toBeInstanceOf(TimeoutError);
			expect((err as TimeoutError).operation).toBe('testTimeout');
		}
	});
});

describe('raceWithTimeout', () => {
	it('should resolve with first promise to complete', async () => {
		const fast = delay(10).then(() => 'fast');
		const slow = delay(100).then(() => 'slow');

		const result = await raceWithTimeout([fast, slow], 500, 'race');
		expect(result).toBe('fast');
	});

	it('should reject with TimeoutError if all promises are slower than timeout', async () => {
		const slow1 = delay(1000).then(() => 'slow1');
		const slow2 = delay(1000).then(() => 'slow2');

		await expect(raceWithTimeout([slow1, slow2], 50, 'slowRace')).rejects.toThrow(TimeoutError);
	});

	it('should work with single promise', async () => {
		const single = delay(10).then(() => 'single');
		const result = await raceWithTimeout([single], 1000, 'singleRace');
		expect(result).toBe('single');
	});

	it('should propagate errors from racing promises', async () => {
		const failing = Promise.reject(new Error('promise failed'));
		const slow = delay(1000).then(() => 'slow');

		await expect(raceWithTimeout([failing, slow], 500, 'errorRace')).rejects.toThrow(
			'promise failed'
		);
	});
});
