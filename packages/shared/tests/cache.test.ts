import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { LRUCache, createCacheKey } from '../src/message-hub/cache.ts';

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

		shortCache.set('key1', 'value1');
		shortCache.set('key2', 'value2');

		// Manually call cleanup after expiration
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				// Call cleanup directly to test the functionality
				shortCache['cleanup']();

				// Verify expired entries are removed
				expect(shortCache.size).toBe(0);

				shortCache.destroy();
				resolve();
			}, 60); // Wait for TTL expiration
		});
	});

	test('cleanup timer handles errors gracefully', () => {
		// Test that cleanup errors don't crash the cache
		let timerCallback: (() => void) | null = null;
		const originalSetInterval = global.setInterval;

		// Mock setInterval to capture the callback
		global.setInterval = ((cb: () => void, _interval: number) => {
			timerCallback = cb;
			return 999 as unknown as NodeJS.Timeout;
		}) as typeof setInterval;

		const errorCache = new LRUCache(10, 100);

		// Restore setInterval immediately
		global.setInterval = originalSetInterval;

		// Mock cleanup to throw an error
		const originalCleanup = errorCache['cleanup'].bind(errorCache);
		errorCache['cleanup'] = () => {
			throw new Error('Cleanup error');
		};

		// Invoke the timer callback - should handle the error gracefully
		expect(timerCallback).not.toBeNull();
		if (timerCallback) {
			// Should not throw
			expect(() => timerCallback!()).not.toThrow();
		}

		// Restore and cleanup
		errorCache['cleanup'] = originalCleanup;
		errorCache.destroy();
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

describe('createCacheKey', () => {
	test('should handle null data', () => {
		const key = createCacheKey('test.method', 'session123', null);
		expect(key).toBe('test.method:session123:null');
	});

	test('should handle undefined data', () => {
		const key = createCacheKey('test.method', 'session123', undefined);
		expect(key).toBe('test.method:session123:null');
	});

	test('should handle string data', () => {
		const key = createCacheKey('test.method', 'session123', 'hello world');
		expect(key).toBe('test.method:session123:hello world');
	});

	test('should handle number data', () => {
		const key = createCacheKey('test.method', 'session123', 42);
		expect(key).toBe('test.method:session123:42');
	});

	test('should handle boolean data', () => {
		const key1 = createCacheKey('test.method', 'session123', true);
		expect(key1).toBe('test.method:session123:true');

		const key2 = createCacheKey('test.method', 'session123', false);
		expect(key2).toBe('test.method:session123:false');
	});

	test('should handle small objects directly', () => {
		const data = { foo: 'bar' };
		const key = createCacheKey('test.method', 'session123', data);
		// Small object (<100 chars JSON) should be included directly
		expect(key).toContain('test.method:session123:');
		expect(key).toContain('foo');
		expect(key).toContain('bar');
	});

	test('should hash large objects', () => {
		// Create a large object (>100 chars JSON)
		const largeObj = {
			data: 'x'.repeat(200),
			nested: { a: 1, b: 2, c: 3 },
		};
		const key = createCacheKey('test.method', 'session123', largeObj);
		// Large object should use hash
		expect(key).toMatch(/^test\.method:session123:hash:[a-z0-9]+$/);
	});

	test('should handle circular references gracefully', () => {
		const circular: Record<string, unknown> = { foo: 'bar' };
		circular.self = circular;

		// Should not throw, should use fallback with timestamp
		const key = createCacheKey('test.method', 'session123', circular);
		expect(key).toMatch(/^test\.method:session123:error:\d+$/);
	});

	test('should produce consistent keys for same data', () => {
		const data = { foo: 'bar', baz: [1, 2, 3] };
		const key1 = createCacheKey('test.method', 'session123', data);
		const key2 = createCacheKey('test.method', 'session123', data);
		expect(key1).toBe(key2);
	});

	test('should produce different keys for different data', () => {
		const key1 = createCacheKey('test.method', 'session123', { foo: 'bar' });
		const key2 = createCacheKey('test.method', 'session123', { foo: 'baz' });
		expect(key1).not.toBe(key2);
	});

	test('should handle empty objects', () => {
		const key = createCacheKey('test.method', 'session123', {});
		expect(key).toContain('test.method:session123:');
	});

	test('should handle arrays', () => {
		const arr = [1, 2, 3, 4, 5];
		const key = createCacheKey('test.method', 'session123', arr);
		expect(key).toContain('test.method:session123:');
	});
});
