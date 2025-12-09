import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { LRUCache, fastHash, createCacheKey } from '../src/message-hub/cache.ts';

describe('LRUCache', () => {
	let cache: LRUCache<string, string>;

	beforeEach(() => {
		cache = new LRUCache(3, 1000); // maxSize: 3, ttl: 1000ms
	});

	afterEach(() => {
		cache.destroy();
	});

	test('basic get/set operations', () => {
		cache.set('key1', 'value1');
		expect(cache.get('key1')).toBe('value1');
		expect(cache.size).toBe(1);
	});

	test('LRU eviction when at capacity', () => {
		cache.set('key1', 'value1');
		cache.set('key2', 'value2');
		cache.set('key3', 'value3');
		cache.set('key4', 'value4'); // Should evict key1

		expect(cache.get('key1')).toBeUndefined();
		expect(cache.get('key2')).toBe('value2');
		expect(cache.get('key3')).toBe('value3');
		expect(cache.get('key4')).toBe('value4');
	});

	test('TTL expiration on get', () => {
		const shortCache = new LRUCache(10, 50); // 50ms TTL
		shortCache.set('key1', 'value1');

		expect(shortCache.get('key1')).toBe('value1');

		// Wait for expiration
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(shortCache.get('key1')).toBeUndefined();
				shortCache.destroy();
				resolve();
			}, 60);
		});
	});

	test('TTL expiration on has', () => {
		const shortCache = new LRUCache(10, 50); // 50ms TTL
		shortCache.set('key1', 'value1');

		expect(shortCache.has('key1')).toBe(true);

		// Wait for expiration
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(shortCache.has('key1')).toBe(false);
				shortCache.destroy();
				resolve();
			}, 60);
		});
	});

	test('has returns false for non-existent key', () => {
		expect(cache.has('nonexistent')).toBe(false);
	});

	test('delete removes key', () => {
		cache.set('key1', 'value1');
		expect(cache.delete('key1')).toBe(true);
		expect(cache.get('key1')).toBeUndefined();
		expect(cache.delete('key1')).toBe(false);
	});

	test('clear removes all entries', () => {
		cache.set('key1', 'value1');
		cache.set('key2', 'value2');
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get('key1')).toBeUndefined();
	});

	test('cleanup removes expired entries', () => {
		const shortCache = new LRUCache(10, 50); // 50ms TTL

		// Spy on console.log to verify cleanup message
		const originalLog = console.log;
		const logSpy = jest.fn();
		console.log = logSpy;

		shortCache.set('key1', 'value1');
		shortCache.set('key2', 'value2');

		// Manually call cleanup after expiration
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				// Call cleanup directly to test the functionality
				shortCache['cleanup']();

				expect(shortCache.size).toBe(0); // Should be cleaned up

				// Verify cleanup message was logged
				expect(logSpy).toHaveBeenCalledWith('[LRUCache] Cleaned up 2 expired entries');

				console.log = originalLog;
				shortCache.destroy();
				resolve();
			}, 60); // Wait for TTL expiration
		});
	});

	test('cleanup timer handles errors gracefully', () => {
		// Test the actual setInterval callback that wraps cleanup in try-catch
		// We'll mock setInterval to capture the callback and invoke it with a mocked cleanup that throws

		let timerCallback: (() => void) | null = null;
		const originalSetInterval = global.setInterval;

		// Mock setInterval to capture the callback
		global.setInterval = ((cb: () => void, _interval: number) => {
			timerCallback = cb;
			return 999 as unknown as NodeJS.Timeout; // Return a fake timer ID
		}) as typeof setInterval;

		// Spy on console.error
		const originalError = console.error;
		const errorSpy = jest.fn();
		console.error = errorSpy;

		// Create cache - this will call setInterval and capture the callback
		const errorCache = new LRUCache(10, 100);

		// Restore setInterval immediately
		global.setInterval = originalSetInterval;

		// Mock cleanup to throw an error
		const originalCleanup = errorCache['cleanup'].bind(errorCache);
		errorCache['cleanup'] = () => {
			throw new Error('Cleanup error');
		};

		// Now invoke the captured timer callback, which should catch the error
		expect(timerCallback).not.toBeNull();
		if (timerCallback) {
			const callback: () => void = timerCallback;
			callback(); // This should trigger the try-catch in the timer callback
		}

		// Restore
		errorCache['cleanup'] = originalCleanup;
		console.error = originalError;
		errorCache.destroy();

		// Error should have been logged by the timer callback's catch block
		expect(errorSpy).toHaveBeenCalledWith('[LRUCache] Cleanup failed:', expect.any(Error));
	});

	test('destroy stops cleanup timer and clears cache', () => {
		cache.set('key1', 'value1');
		cache.destroy();
		expect(cache.size).toBe(0);

		// Verify timer is stopped (cleanupTimer should be null)
		expect(cache['cleanupTimer']).toBeNull();
	});

	test('LRU ordering - recently used items stay', () => {
		cache.set('key1', 'value1');
		cache.set('key2', 'value2');
		cache.set('key3', 'value3');

		// Access key1 to make it recently used
		cache.get('key1');

		// Add key4, should evict key2 (oldest)
		cache.set('key4', 'value4');

		expect(cache.get('key1')).toBe('value1'); // Still there
		expect(cache.get('key2')).toBeUndefined(); // Evicted
		expect(cache.get('key3')).toBe('value3');
		expect(cache.get('key4')).toBe('value4');
	});

	test('updating existing key moves it to end', () => {
		cache.set('key1', 'value1');
		cache.set('key2', 'value2');
		cache.set('key3', 'value3');

		// Update key1
		cache.set('key1', 'value1-updated');

		// Add key4, should evict key2
		cache.set('key4', 'value4');

		expect(cache.get('key1')).toBe('value1-updated');
		expect(cache.get('key2')).toBeUndefined();
	});
});

describe('fastHash', () => {
	test('generates consistent hash for same input', () => {
		const hash1 = fastHash('test string');
		const hash2 = fastHash('test string');
		expect(hash1).toBe(hash2);
	});

	test('generates different hashes for different inputs', () => {
		const hash1 = fastHash('test1');
		const hash2 = fastHash('test2');
		expect(hash1).not.toBe(hash2);
	});

	test('handles empty string', () => {
		const hash = fastHash('');
		expect(typeof hash).toBe('string');
		expect(hash.length).toBeGreaterThan(0);
	});

	test('handles long strings', () => {
		const longString = 'a'.repeat(10000);
		const hash = fastHash(longString);
		expect(typeof hash).toBe('string');
	});

	test('handles unicode characters', () => {
		const hash1 = fastHash('hello 世界');
		const hash2 = fastHash('hello world');
		expect(hash1).not.toBe(hash2);
	});

	test('different string lengths produce different hashes', () => {
		// Test that length is incorporated into hash
		const hash1 = fastHash('a');
		const hash2 = fastHash('aa');
		expect(hash1).not.toBe(hash2);
	});

	test('handles special characters', () => {
		const hash = fastHash('!@#$%^&*()_+-={}[]|:;"<>?,./');
		expect(typeof hash).toBe('string');
		expect(hash.length).toBeGreaterThan(0);
	});
});

describe('createCacheKey', () => {
	test('handles null data', () => {
		const key = createCacheKey('method', 'session', null);
		expect(key).toBe('method:session:null');
	});

	test('handles undefined data', () => {
		const key = createCacheKey('method', 'session', undefined);
		expect(key).toBe('method:session:null');
	});

	test('handles string data', () => {
		const key = createCacheKey('method', 'session', 'test');
		expect(key).toBe('method:session:test');
	});

	test('handles number data', () => {
		const key = createCacheKey('method', 'session', 42);
		expect(key).toBe('method:session:42');
	});

	test('handles boolean data', () => {
		const key = createCacheKey('method', 'session', true);
		expect(key).toBe('method:session:true');
	});

	test('handles small object (< 100 chars)', () => {
		const data = { foo: 'bar' };
		const key = createCacheKey('method', 'session', data);
		expect(key).toBe('method:session:{"foo":"bar"}');
	});

	test('handles large object (>= 100 chars) with hash', () => {
		const data = { foo: 'a'.repeat(100) };
		const key = createCacheKey('method', 'session', data);
		expect(key).toContain('method:session:hash:');
		expect(key).not.toContain('"foo"');
	});

	test('handles circular reference with timestamp fallback', () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;

		const key = createCacheKey('method', 'session', circular);
		expect(key).toMatch(/^method:session:error:\d+$/);
	});

	test('different objects produce different cache keys', () => {
		const key1 = createCacheKey('method', 'session', { a: 1 });
		const key2 = createCacheKey('method', 'session', { a: 2 });
		expect(key1).not.toBe(key2);
	});

	test('different methods produce different cache keys', () => {
		const key1 = createCacheKey('method1', 'session', { a: 1 });
		const key2 = createCacheKey('method2', 'session', { a: 1 });
		expect(key1).not.toBe(key2);
	});

	test('different sessions produce different cache keys', () => {
		const key1 = createCacheKey('method', 'session1', { a: 1 });
		const key2 = createCacheKey('method', 'session2', { a: 1 });
		expect(key1).not.toBe(key2);
	});
});
