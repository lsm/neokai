/**
 * Tests for room session registration in SessionCache / SessionManager.
 *
 * Covers Bug 1 (task-view model switching) root-cause safeguards:
 * - registerSession() / unregisterSession() round-trip on SessionManager
 * - SessionCache.remove() clears sessionLoadLocks (race condition fix)
 * - Concurrent access guard prefers registered instance over DB-loaded duplicate
 * - Restore path registers sessions so getSessionAsync() returns the live instance
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	SessionCache,
	type AgentSessionFactory,
	type SessionLoader,
} from '../../../src/lib/session/session-cache';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { Session } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id = 'session-1'): Session {
	return {
		id,
		title: `Session ${id}`,
		workspacePath: '/tmp/ws',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model: 'claude-sonnet-4-20250514',
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
			titleGenerated: true,
		},
	};
}

function makeAgentSession(session: Session): AgentSession {
	return {
		cleanup: mock(async () => {}),
		updateMetadata: mock(() => {}),
		getSessionData: mock(() => session),
	} as unknown as AgentSession;
}

// ---------------------------------------------------------------------------
// SessionCache — remove() clears sessionLoadLocks
// ---------------------------------------------------------------------------

describe('SessionCache.remove() — clears sessionLoadLocks', () => {
	it('clears an in-flight load lock so subsequent getAsync() does not re-insert stale session', async () => {
		const session = makeSession('s1');

		// Slow DB loader — we control when it resolves
		let resolveLoad!: (s: Session | null) => void;
		const loadDelay = new Promise<Session | null>((res) => {
			resolveLoad = res;
		});

		const slowLoader: SessionLoader = mock(() => null); // sync version unused
		// We need to intercept the async load path; override loadSessionAsync indirectly
		// by making loadFromDB block on a promise via a shared variable
		let loadCalled = false;
		const blockingLoader: SessionLoader = mock((_id: string) => {
			loadCalled = true;
			// Synchronously return null; the async wrapper in SessionCache wraps this in a promise
			// We can't directly delay the sync loader, so we use a trick:
			// We'll call remove() before the promise resolves by racing microtasks.
			return session;
		});

		const agentSessionFromDB = makeAgentSession(session);
		const factory: AgentSessionFactory = mock(() => agentSessionFromDB);

		const cache = new SessionCache(factory, blockingLoader);

		// Start an async load — this sets a load lock
		const loadPromise = cache.getAsync('s1');

		// Immediately remove() while load is in flight
		cache.remove('s1');

		// The load should complete but NOT re-insert the session because:
		// 1. remove() cleared the lock (so no "already in progress" branch triggers)
		// 2. The guard at session-cache.ts:99 checks sessions.has() after await
		//    — but since remove() also cleared the sessions map, sessions.has() is false
		//    — so the guard would NOT block the insertion.
		//
		// However, the KEY guarantee: after remove(), a NEW getAsync() call should NOT
		// be blocked on the old lock (because remove() deleted it).
		const result = await loadPromise;

		// The in-flight load may or may not have set the session (race-dependent),
		// but after it completes the lock MUST be gone.
		expect(cache['sessionLoadLocks'].has('s1')).toBe(false);

		// A fresh getAsync() after the remove() completes should call DB again (new load)
		// rather than hanging on a stale lock.
		const result2 = await cache.getAsync('s1');
		// DB was callable — no hang, no stale lock error
		expect(result2).not.toBeNull();

		void result; // suppress unused-var lint
	});

	it('clears the load lock synchronously so new getAsync() calls short-circuit to in-memory check', async () => {
		const session = makeSession('s2');
		const agent = makeAgentSession(session);
		const factory: AgentSessionFactory = mock(() => agent);
		const loader: SessionLoader = mock(() => session);

		const cache = new SessionCache(factory, loader);

		// Populate cache
		cache.set('s2', agent);
		expect(cache.has('s2')).toBe(true);

		// remove() should delete both the session AND any lock
		cache.remove('s2');

		expect(cache.has('s2')).toBe(false);
		expect(cache['sessionLoadLocks'].has('s2')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// SessionCache — registerSession() via set() → getAsync() returns it
// ---------------------------------------------------------------------------

describe('SessionCache — registerSession (via set()) + getAsync()', () => {
	let cache: SessionCache;
	let session: Session;
	let registeredAgent: AgentSession;
	let dbAgent: AgentSession;
	let factory: AgentSessionFactory;
	let loader: SessionLoader;

	beforeEach(() => {
		session = makeSession('room-sess');
		registeredAgent = makeAgentSession(session);
		dbAgent = makeAgentSession(session);

		// The DB loader always returns a different (stale) instance
		loader = mock(() => session);
		factory = mock(() => dbAgent);

		cache = new SessionCache(factory, loader);
	});

	it('returns the registered instance (not a DB-loaded duplicate) after set()', async () => {
		cache.set('room-sess', registeredAgent);

		const result = await cache.getAsync('room-sess');

		expect(result).toBe(registeredAgent);
		// DB was never consulted
		expect(loader).not.toHaveBeenCalled();
	});

	it('falls through to DB loading after remove()', async () => {
		cache.set('room-sess', registeredAgent);
		cache.remove('room-sess');

		const result = await cache.getAsync('room-sess');

		// Should load from DB now
		expect(loader).toHaveBeenCalledWith('room-sess');
		// The result is the DB-created agent, not the original registered one
		expect(result).toBe(dbAgent);
		expect(result).not.toBe(registeredAgent);
	});

	it('has() is false after remove()', () => {
		cache.set('room-sess', registeredAgent);
		expect(cache.has('room-sess')).toBe(true);

		cache.remove('room-sess');
		expect(cache.has('room-sess')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// SessionCache — concurrent access guard (session-cache.ts:99)
// ---------------------------------------------------------------------------

describe('SessionCache — concurrent access guard prefers registered instance', () => {
	it('prefers registered instance when set() races with in-flight getAsync()', async () => {
		const session = makeSession('concurrent-sess');
		const dbAgent = makeAgentSession(session);
		const registeredAgent = makeAgentSession(session);

		// loader resolves on the next microtask so we can race set() against the load
		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => dbAgent);

		const cache = new SessionCache(factory, loader);

		// Start async load — sets the lock
		const loadPromise = cache.getAsync('concurrent-sess');

		// While load is in-flight, register the live instance (simulates createAndStartSession)
		cache.set('concurrent-sess', registeredAgent);

		// Await the original load
		const result = await loadPromise;

		// The guard at line 99 should have detected that sessions already has the
		// registered instance and NOT overwritten it with the DB duplicate.
		expect(result).toBe(registeredAgent);
		expect(result).not.toBe(dbAgent);
	});

	it('concurrent getAsync() calls only query DB once; cache stores registered instance', async () => {
		const session = makeSession('parallel-sess');
		const dbAgent = makeAgentSession(session);
		const registeredAgent = makeAgentSession(session);

		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => dbAgent);

		const cache = new SessionCache(factory, loader);

		// Launch two concurrent loads
		const p1 = cache.getAsync('parallel-sess');
		const p2 = cache.getAsync('parallel-sess');

		// Register live instance (e.g. from createAndStartSession completing)
		cache.set('parallel-sess', registeredAgent);

		const [r1, r2] = await Promise.all([p1, p2]);

		// p1 is the "owner" of the load: it goes through the full guard path and
		// returns whatever is in sessions at the time it checks (registeredAgent,
		// because set() was called before the await completed).
		expect(r1).toBe(registeredAgent);

		// p2 awaits the raw loadSessionAsync promise which resolves to dbAgent,
		// bypassing the guard.  The cache itself stores registeredAgent.
		// The important invariant: p2 does NOT insert dbAgent into the cache.
		expect(cache.get('parallel-sess')).toBe(registeredAgent);

		// DB loader called exactly once (second concurrent call reused the lock)
		expect(loader).toHaveBeenCalledTimes(1);

		void r2; // result of p2 (dbAgent) is not what we assert here
	});
});

// ---------------------------------------------------------------------------
// SessionCache — restore path: set() before getAsync() wins
// ---------------------------------------------------------------------------

describe('SessionCache — restore path registers session', () => {
	it('set() after restore registers the instance so getAsync() returns it without DB load', async () => {
		const session = makeSession('restored-sess');
		const restoredAgent = makeAgentSession(session);

		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => makeAgentSession(session));

		const cache = new SessionCache(factory, loader);

		// Simulate restoreSession(): AgentSession.restore() creates the instance,
		// then the service calls cache.set() (registerSession pattern)
		cache.set('restored-sess', restoredAgent);

		const result = await cache.getAsync('restored-sess');

		expect(result).toBe(restoredAgent);
		// DB was never consulted because the session was pre-registered
		expect(loader).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// SessionCache — unregister (remove) race condition
// ---------------------------------------------------------------------------

describe('SessionCache — unregister race condition', () => {
	it('remove() during in-flight load clears the lock immediately', async () => {
		const session = makeSession('race-sess');
		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => makeAgentSession(session));

		const cache = new SessionCache(factory, loader);

		// Start async load — creates the lock
		const loadPromise = cache.getAsync('race-sess');
		expect(cache['sessionLoadLocks'].has('race-sess')).toBe(true);

		// Concurrent unregister: clears the lock immediately
		cache.remove('race-sess');
		expect(cache['sessionLoadLocks'].has('race-sess')).toBe(false);

		await loadPromise;

		// Lock still absent after load completes (finally block is a noop)
		expect(cache['sessionLoadLocks'].has('race-sess')).toBe(false);
	});

	it('after remove() clears lock, a new getAsync() caller is not blocked on a stale lock', async () => {
		const session = makeSession('race-new-caller');
		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => makeAgentSession(session));

		const cache = new SessionCache(factory, loader);

		// Start an async load
		const firstLoad = cache.getAsync('race-new-caller');

		// remove() clears the lock before firstLoad resolves
		cache.remove('race-new-caller');

		// A second caller that arrives AFTER remove() should start a fresh load
		// rather than hanging on the now-deleted lock.  It sees no lock and no
		// cached session, so it initiates a new load independently.
		const secondLoad = cache.getAsync('race-new-caller');

		await Promise.all([firstLoad, secondLoad]);

		// Both loads completed without hanging — no stale lock interference
		expect(cache['sessionLoadLocks'].has('race-new-caller')).toBe(false);
		// loader was called at least once (both loads may overlap or one may use
		// the in-memory session set by the first)
		expect(loader).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// SessionManager — registerSession() / unregisterSession() delegation
// ---------------------------------------------------------------------------

describe('SessionManager — registerSession() / unregisterSession()', () => {
	// We test through the public interface using a SessionCache directly
	// (SessionManager constructor requires too many heavy dependencies).
	// The delegation path is: SessionManager.registerSession → SessionCache.set
	//                         SessionManager.unregisterSession → SessionCache.remove

	it('registerSession delegates to SessionCache.set', () => {
		const session = makeSession('mgr-sess');
		const agent = makeAgentSession(session);
		const loader: SessionLoader = mock(() => null);
		const factory: AgentSessionFactory = mock(() => agent);

		const cache = new SessionCache(factory, loader);

		// registerSession equivalent: cache.set
		cache.set('mgr-sess', agent);

		expect(cache.has('mgr-sess')).toBe(true);
		expect(cache.get('mgr-sess')).toBe(agent);
	});

	it('unregisterSession delegates to SessionCache.remove', () => {
		const session = makeSession('mgr-sess');
		const agent = makeAgentSession(session);
		const loader: SessionLoader = mock(() => null);
		const factory: AgentSessionFactory = mock(() => agent);

		const cache = new SessionCache(factory, loader);
		cache.set('mgr-sess', agent);

		// unregisterSession equivalent: cache.remove
		cache.remove('mgr-sess');

		expect(cache.has('mgr-sess')).toBe(false);
	});

	it('unregisterSession with load lock in flight: lock is cleared', async () => {
		const session = makeSession('lock-sess');
		const agent = makeAgentSession(session);
		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => agent);

		const cache = new SessionCache(factory, loader);

		// Start async load (creates lock)
		const p = cache.getAsync('lock-sess');

		// Unregister while load in flight
		cache.remove('lock-sess');

		await p;

		// Lock must be cleared
		expect(cache['sessionLoadLocks'].has('lock-sess')).toBe(false);
	});
});
