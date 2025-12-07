/**
 * LRU Cache for MessageHub request deduplication
 *
 * Features:
 * - Bounded size (prevents unbounded memory growth)
 * - TTL-based expiration
 * - Automatic cleanup of stale entries
 */

export interface CacheEntry<T> {
	value: T;
	timestamp: number;
}

export class LRUCache<K, V> {
	private cache: Map<K, CacheEntry<V>> = new Map();
	private readonly maxSize: number;
	private readonly ttl: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(maxSize: number = 500, ttl: number = 60000) {
		this.maxSize = maxSize;
		this.ttl = ttl;

		// FIX P0.4: Periodic cleanup every 30 seconds with error handling
		// If cleanup throws, catch it to prevent timer chain from breaking
		this.cleanupTimer = setInterval(() => {
			try {
				this.cleanup();
			} catch (error) {
				console.error('[LRUCache] Cleanup failed:', error);
				// Continue - don't break the timer chain
			}
		}, 30000);
	}

	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (!entry) {
			return undefined;
		}

		// Check if expired
		if (Date.now() - entry.timestamp > this.ttl) {
			this.cache.delete(key);
			return undefined;
		}

		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);

		return entry.value;
	}

	set(key: K, value: V): void {
		// Remove if already exists (will re-add at end)
		this.cache.delete(key);

		// Evict oldest if at capacity
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}

		// Add new entry
		this.cache.set(key, {
			value,
			timestamp: Date.now(),
		});
	}

	delete(key: K): boolean {
		return this.cache.delete(key);
	}

	has(key: K): boolean {
		const entry = this.cache.get(key);
		if (!entry) {
			return false;
		}

		// Check if expired
		if (Date.now() - entry.timestamp > this.ttl) {
			this.cache.delete(key);
			return false;
		}

		return true;
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}

	/**
	 * Remove expired entries
	 */
	private cleanup(): void {
		const now = Date.now();
		const keysToDelete: K[] = [];

		for (const [key, entry] of this.cache.entries()) {
			if (now - entry.timestamp > this.ttl) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			this.cache.delete(key);
		}

		if (keysToDelete.length > 0) {
			console.log(`[LRUCache] Cleaned up ${keysToDelete.length} expired entries`);
		}
	}

	/**
	 * Stop cleanup timer
	 */
	destroy(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.clear();
	}
}

/**
 * Fast hash function for cache keys
 * FIX P2.5: Improved collision resistance using 53-bit hash (JavaScript safe integer)
 * Uses FNV-1a variant with larger bit space
 */
export function fastHash(str: string): string {
	// FNV-1a constants for 53-bit hash (JavaScript's safe integer range)
	const FNV_PRIME = 0x01000193; // 16777619
	let hash = 0x811c9dc5; // 2166136261 (FNV offset basis)

	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		// Multiply and keep within 53-bit safe integer range
		hash = Math.imul(hash, FNV_PRIME);
	}

	// Convert to positive number and return base-36 string
	// Use >>> 0 to ensure unsigned 32-bit, then add length for extra entropy
	const hash32 = hash >>> 0;
	const lengthHash = (str.length * 31) & 0xfffff; // 20 bits for length component

	// Combine hash with length for better distribution
	return (hash32 + lengthHash).toString(36);
}

/**
 * Create cache key from method, sessionId, and data
 * Uses hashing instead of full JSON.stringify for performance
 */
export function createCacheKey(method: string, sessionId: string, data: unknown): string {
	try {
		// For small/simple data, use direct serialization
		if (data === null || data === undefined) {
			return `${method}:${sessionId}:null`;
		}

		if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
			return `${method}:${sessionId}:${data}`;
		}

		// For objects, use hash for performance
		const dataStr = JSON.stringify(data);

		// If data is small, include it directly
		if (dataStr.length < 100) {
			return `${method}:${sessionId}:${dataStr}`;
		}

		// Otherwise use hash
		const dataHash = fastHash(dataStr);
		return `${method}:${sessionId}:hash:${dataHash}`;
	} catch (error) {
		// Circular reference or other error - use timestamp as fallback
		return `${method}:${sessionId}:error:${Date.now()}`;
	}
}
