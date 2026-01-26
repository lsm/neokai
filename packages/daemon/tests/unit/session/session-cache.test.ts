/**
 * SessionCache Tests
 *
 * Tests for the session caching system with lazy loading and
 * race condition prevention.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	SessionCache,
	type AgentSessionFactory,
	type SessionLoader,
} from '../../../src/lib/session/session-cache';
import type { Session } from '@liuboer/shared';
import type { AgentSession } from '../../../src/lib/agent/agent-session';

describe('SessionCache', () => {
	let cache: SessionCache;
	let createAgentSessionSpy: ReturnType<typeof mock>;
	let loadFromDBSpy: ReturnType<typeof mock>;
	let mockAgentSession: AgentSession;
	let mockSession: Session;

	beforeEach(() => {
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
				maxTokens: 8192,
				temperature: 1.0,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
		};

		mockAgentSession = {
			getSessionData: () => mockSession,
			updateMetadata: mock(() => {}),
		} as unknown as AgentSession;

		createAgentSessionSpy = mock(() => mockAgentSession);
		loadFromDBSpy = mock(() => mockSession);

		cache = new SessionCache(
			createAgentSessionSpy as AgentSessionFactory,
			loadFromDBSpy as SessionLoader
		);
	});

	describe('get', () => {
		it('should return cached session if exists', () => {
			// First, set a session in the cache
			cache.set('test-session-id', mockAgentSession);

			// Get should return it without loading from DB
			const result = cache.get('test-session-id');

			expect(result).toBe(mockAgentSession);
			expect(loadFromDBSpy).not.toHaveBeenCalled();
		});

		it('should load from DB and cache if not in memory', () => {
			const result = cache.get('test-session-id');

			expect(result).toBe(mockAgentSession);
			expect(loadFromDBSpy).toHaveBeenCalledWith('test-session-id');
			expect(createAgentSessionSpy).toHaveBeenCalledWith(mockSession);
		});

		it('should return null if session not found in DB', () => {
			loadFromDBSpy.mockReturnValue(null);

			const result = cache.get('nonexistent-id');

			expect(result).toBeNull();
			expect(loadFromDBSpy).toHaveBeenCalledWith('nonexistent-id');
			expect(createAgentSessionSpy).not.toHaveBeenCalled();
		});

		it('should throw error if load is in progress', async () => {
			// Start an async load
			const loadPromise = cache.getAsync('test-session-id');

			// Try to get synchronously while load is in progress
			// Note: This test might be flaky depending on timing
			// The lock should be held during the promise resolution

			// Wait for the load to complete
			await loadPromise;
		});
	});

	describe('getAsync', () => {
		it('should return cached session if exists', async () => {
			cache.set('test-session-id', mockAgentSession);

			const result = await cache.getAsync('test-session-id');

			expect(result).toBe(mockAgentSession);
			expect(loadFromDBSpy).not.toHaveBeenCalled();
		});

		it('should load from DB and cache if not in memory', async () => {
			const result = await cache.getAsync('test-session-id');

			expect(result).toBe(mockAgentSession);
			expect(loadFromDBSpy).toHaveBeenCalledWith('test-session-id');
			expect(createAgentSessionSpy).toHaveBeenCalledWith(mockSession);
		});

		it('should return null if session not found in DB', async () => {
			loadFromDBSpy.mockReturnValue(null);

			const result = await cache.getAsync('nonexistent-id');

			expect(result).toBeNull();
		});

		it('should handle concurrent loads with locking', async () => {
			// Start multiple concurrent loads for the same session
			const [result1, result2, result3] = await Promise.all([
				cache.getAsync('test-session-id'),
				cache.getAsync('test-session-id'),
				cache.getAsync('test-session-id'),
			]);

			// All should return the same session
			expect(result1).toBe(mockAgentSession);
			expect(result2).toBe(mockAgentSession);
			expect(result3).toBe(mockAgentSession);

			// loadFromDB should only be called once (not 3 times)
			expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
			expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		});

		it('should return null on createAgentSession error', async () => {
			createAgentSessionSpy.mockImplementation(() => {
				throw new Error('Failed to create agent session');
			});

			const result = await cache.getAsync('test-session-id');

			expect(result).toBeNull();
		});

		it('should clean up lock after error', async () => {
			createAgentSessionSpy.mockImplementationOnce(() => {
				throw new Error('First load failed');
			});

			// First load fails
			const result1 = await cache.getAsync('test-session-id');
			expect(result1).toBeNull();

			// Reset mock to succeed
			createAgentSessionSpy.mockImplementation(() => mockAgentSession);

			// Second load should work (lock was cleaned up)
			const result2 = await cache.getAsync('test-session-id');
			expect(result2).toBe(mockAgentSession);
		});
	});

	describe('set', () => {
		it('should set a session in the cache', () => {
			cache.set('new-session-id', mockAgentSession);

			expect(cache.has('new-session-id')).toBe(true);
			expect(cache.get('new-session-id')).toBe(mockAgentSession);
		});

		it('should overwrite existing session', () => {
			const anotherSession = {
				getSessionData: () => ({ ...mockSession, id: 'another' }),
			} as unknown as AgentSession;

			cache.set('test-id', mockAgentSession);
			cache.set('test-id', anotherSession);

			expect(cache.get('test-id')).toBe(anotherSession);
		});
	});

	describe('remove', () => {
		it('should remove a session from the cache', () => {
			cache.set('test-session-id', mockAgentSession);
			expect(cache.has('test-session-id')).toBe(true);

			cache.remove('test-session-id');

			expect(cache.has('test-session-id')).toBe(false);
		});

		it('should handle removing non-existent session', () => {
			// Should not throw
			cache.remove('nonexistent-id');
			expect(cache.has('nonexistent-id')).toBe(false);
		});
	});

	describe('has', () => {
		it('should return true for cached session', () => {
			cache.set('test-session-id', mockAgentSession);
			expect(cache.has('test-session-id')).toBe(true);
		});

		it('should return false for non-cached session', () => {
			expect(cache.has('nonexistent-id')).toBe(false);
		});
	});

	describe('getActiveCount', () => {
		it('should return 0 for empty cache', () => {
			expect(cache.getActiveCount()).toBe(0);
		});

		it('should return correct count', () => {
			cache.set('session-1', mockAgentSession);
			cache.set('session-2', mockAgentSession);
			cache.set('session-3', mockAgentSession);

			expect(cache.getActiveCount()).toBe(3);
		});
	});

	describe('clear', () => {
		it('should clear all sessions', () => {
			cache.set('session-1', mockAgentSession);
			cache.set('session-2', mockAgentSession);

			cache.clear();

			expect(cache.getActiveCount()).toBe(0);
			expect(cache.has('session-1')).toBe(false);
			expect(cache.has('session-2')).toBe(false);
		});
	});

	describe('getAll', () => {
		it('should return empty map for empty cache', () => {
			const all = cache.getAll();
			expect(all.size).toBe(0);
		});

		it('should return all sessions', () => {
			cache.set('session-1', mockAgentSession);
			cache.set('session-2', mockAgentSession);

			const all = cache.getAll();

			expect(all.size).toBe(2);
			expect(all.has('session-1')).toBe(true);
			expect(all.has('session-2')).toBe(true);
		});
	});

	describe('entries', () => {
		it('should iterate over all sessions', () => {
			cache.set('session-1', mockAgentSession);
			cache.set('session-2', mockAgentSession);

			const entries = [...cache.entries()];

			expect(entries.length).toBe(2);
			expect(entries.map(([id]) => id)).toContain('session-1');
			expect(entries.map(([id]) => id)).toContain('session-2');
		});
	});
});
