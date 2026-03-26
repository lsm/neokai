/**
 * Tests for room session registration in SessionCache / SessionManager.
 *
 * Covers Bug 1 (task-view model switching) root-cause safeguards:
 * - SessionCache.remove() fully prevents stale session re-insertion, even by
 *   the original in-flight getAsync() caller (via removedWhileLoading set)
 * - SessionCache.remove() clears sessionLoadLocks for new callers
 * - Concurrent access guard prefers registered instance over DB-loaded duplicate
 * - Restore path registers sessions so getSessionAsync() returns the live instance
 * - SessionManager.registerSession() / unregisterSession() delegation verified
 *   against an actual SessionManager instance
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
	SessionCache,
	type AgentSessionFactory,
	type SessionLoader,
} from '../../../src/lib/session/session-cache';
import { SessionManager } from '../../../src/lib/session/session-manager';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { AuthManager } from '../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import type { MessageHub, Session } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';
import type { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import type { JobQueueProcessor } from '../../../src/storage/job-queue-processor';

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
// SessionCache — remove() fully prevents stale re-insertion (P0 fix)
// ---------------------------------------------------------------------------

describe('SessionCache.remove() — prevents stale session re-insertion', () => {
	it('in-flight getAsync() does NOT re-insert session after remove() (removedWhileLoading guard)', async () => {
		const session = makeSession('s1');
		const dbAgent = makeAgentSession(session);

		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => dbAgent);

		const cache = new SessionCache(factory, loader);

		// Start async load — sets the lock
		const loadPromise = cache.getAsync('s1');
		expect(cache['sessionLoadLocks'].has('s1')).toBe(true);

		// remove() while load is in flight
		cache.remove('s1');
		// removedWhileLoading must be set so the in-flight load is blocked
		expect(cache['removedWhileLoading'].has('s1')).toBe(true);
		// lock cleared immediately for new callers
		expect(cache['sessionLoadLocks'].has('s1')).toBe(false);

		await loadPromise;

		// The in-flight load completed but must NOT have re-inserted the session
		expect(cache.has('s1')).toBe(false);
		// removedWhileLoading cleaned up in finally
		expect(cache['removedWhileLoading'].has('s1')).toBe(false);
	});

	it('remove() on a session with no in-flight lock does NOT add to removedWhileLoading', () => {
		const session = makeSession('s2');
		const agent = makeAgentSession(session);
		const factory: AgentSessionFactory = mock(() => agent);
		const loader: SessionLoader = mock(() => session);

		const cache = new SessionCache(factory, loader);
		cache.set('s2', agent);

		// No in-flight lock, so removedWhileLoading must not be touched
		cache.remove('s2');

		expect(cache.has('s2')).toBe(false);
		expect(cache['removedWhileLoading'].has('s2')).toBe(false);
		expect(cache['sessionLoadLocks'].has('s2')).toBe(false);
	});

	it('new getAsync() after remove() starts a fresh load (not blocked on stale lock)', async () => {
		const session = makeSession('s3');
		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => makeAgentSession(session));

		const cache = new SessionCache(factory, loader);

		// Start and remove
		const firstLoad = cache.getAsync('s3');
		cache.remove('s3');
		await firstLoad;

		// Session was evicted by remove() — cache must be empty
		expect(cache.has('s3')).toBe(false);

		// A fresh caller should start a new load without hanging
		const freshResult = await cache.getAsync('s3');
		expect(freshResult).not.toBeNull();
		expect(loader).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// SessionCache — registerSession (via set()) + getAsync()
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

		loader = mock(() => session);
		factory = mock(() => dbAgent);

		cache = new SessionCache(factory, loader);
	});

	it('returns the registered instance (not a DB-loaded duplicate) after set()', async () => {
		cache.set('room-sess', registeredAgent);

		const result = await cache.getAsync('room-sess');

		expect(result).toBe(registeredAgent);
		expect(loader).not.toHaveBeenCalled();
	});

	it('falls through to DB loading after remove()', async () => {
		cache.set('room-sess', registeredAgent);
		cache.remove('room-sess');

		const result = await cache.getAsync('room-sess');

		expect(loader).toHaveBeenCalledWith('room-sess');
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

		const loader: SessionLoader = mock(() => session);
		const factory: AgentSessionFactory = mock(() => dbAgent);

		const cache = new SessionCache(factory, loader);

		// Start async load — sets the lock
		const loadPromise = cache.getAsync('concurrent-sess');

		// While load is in-flight, register the live instance (simulates createAndStartSession)
		cache.set('concurrent-sess', registeredAgent);

		const result = await loadPromise;

		// Guard must have kept the registered instance, not the DB duplicate
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

		await Promise.all([p1, p2]);

		// The cache stores the registered instance — the guard prevented the DB duplicate
		// from overwriting it.  (p1 returns registeredAgent; p2 returns the raw load result
		// from loadSessionAsync because it awaits the inner promise directly, but the cache
		// itself is authoritative.)
		expect(cache.get('parallel-sess')).toBe(registeredAgent);

		// DB loader called exactly once
		expect(loader).toHaveBeenCalledTimes(1);
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
		expect(loader).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// SessionManager — registerSession() / unregisterSession() delegation
// Tests use a real SessionManager instance to verify the delegation chain.
// ---------------------------------------------------------------------------

describe('SessionManager — registerSession() / unregisterSession()', () => {
	let sessionManager: SessionManager;
	let mockDb: Database;

	beforeEach(() => {
		mockDb = {
			createSession: mock(() => {}),
			updateSession: mock(() => {}),
			deleteSession: mock(() => {}),
			getSession: mock(() => null),
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			})),
			listSessions: mock(() => []),
			getGlobalToolsConfig: mock(() => ({
				systemPrompt: { claudeCodePreset: { allowed: true, defaultEnabled: true } },
				mcpServers: {},
				kaiTools: { memory: { allowed: true, defaultEnabled: true } },
			})),
			saveGlobalToolsConfig: mock(() => {}),
			getMessagesByStatus: mock(() => []),
			saveSDKMessage: mock(() => {}),
			getUserMessages: mock(() => []),
			getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
			getSDKMessageCount: mock(() => 0),
			deleteMessagesAfter: mock(() => 0),
			deleteMessagesAtAndAfter: mock(() => 0),
			getUserMessageByUuid: mock(() => undefined),
			countMessagesAfter: mock(() => 0),
			updateMessage: mock(() => {}),
			saveUserMessage: mock(() => {}),
			getTaskRepo: mock(() => ({ getTask: mock(() => null), getTaskByShortId: mock(() => null) })),
			getGoalRepo: mock(() => ({ getGoal: mock(() => null), getGoalByShortId: mock(() => null) })),
		} as unknown as Database;

		const mockMessageHub = {
			event: mock(async () => {}),
			onRequest: mock(() => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		const mockAuthManager = {
			getCurrentApiKey: mock(async () => 'test-api-key'),
		} as unknown as AuthManager;

		const mockSettingsManager = {
			getSettings: mock(() => ({})),
			updateSettings: mock(() => {}),
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			})),
			listMcpServersFromSources: mock(() => []),
		} as unknown as SettingsManager;

		const mockEventBus = {
			on: mock(() => () => {}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		const mockJobQueue = {
			enqueue: mock(() => ({ id: 'job-id', queue: 'session.title_generation' })),
			listJobs: mock(() => []),
		} as unknown as JobQueueRepository;

		const mockJobProcessor = {
			register: mock(() => {}),
			start: mock(() => {}),
			stop: mock(async () => {}),
		} as unknown as JobQueueProcessor;

		sessionManager = new SessionManager(
			mockDb,
			mockMessageHub,
			mockAuthManager,
			mockSettingsManager,
			mockEventBus,
			{
				defaultModel: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
				workspaceRoot: '/tmp/ws',
				disableWorktrees: true,
			} as Parameters<typeof SessionManager>[5],
			mockJobQueue,
			mockJobProcessor
		);
	});

	afterEach(async () => {
		try {
			await sessionManager.cleanup();
		} catch {
			// ignore
		}
	});

	it('registerSession() makes session findable via getSessionAsync() without DB load', async () => {
		const session = makeSession('sm-registered');
		const agent = makeAgentSession(session);

		sessionManager.registerSession(agent);

		// getSessionAsync() should return the registered instance directly
		const result = await sessionManager.getSessionAsync('sm-registered');
		expect(result).toBe(agent);

		// DB was not consulted (getSession mock returns null by default)
		expect(mockDb.getSession).not.toHaveBeenCalled();
	});

	it('unregisterSession() removes session so getSessionAsync() falls through to DB', async () => {
		const session = makeSession('sm-unregistered');
		const agent = makeAgentSession(session);

		sessionManager.registerSession(agent);

		// Confirm it's registered
		const before = await sessionManager.getSessionAsync('sm-unregistered');
		expect(before).toBe(agent);

		// Unregister
		sessionManager.unregisterSession('sm-unregistered');

		// Now getSessionAsync() must fall through to DB (returns null since DB mock returns null)
		const after = await sessionManager.getSessionAsync('sm-unregistered');
		expect(after).toBeNull();
		expect(mockDb.getSession).toHaveBeenCalledWith('sm-unregistered');
	});

	it('unregisterSession() clears in-flight load lock via SessionCache.remove()', async () => {
		// Arrange: DB returns a session so getSessionAsync can start a load
		const session = makeSession('sm-lock-test');
		(mockDb.getSession as ReturnType<typeof mock>).mockImplementation(() => session);

		// Start async load — creates the lock in the underlying SessionCache
		const loadPromise = sessionManager.getSessionAsync('sm-lock-test');

		// Unregister while load is in-flight
		sessionManager.unregisterSession('sm-lock-test');

		await loadPromise;

		// After unregister + load completion, session must NOT be in cache
		// (getSessionAsync() must go to DB again for any subsequent call)
		(mockDb.getSession as ReturnType<typeof mock>).mockImplementation(() => null);
		const afterResult = await sessionManager.getSessionAsync('sm-lock-test');
		expect(afterResult).toBeNull();
	});
});
