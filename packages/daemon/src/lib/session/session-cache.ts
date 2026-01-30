/**
 * Session Cache Module
 *
 * In-memory session caching with lazy loading and race condition prevention:
 * - Map-based storage of AgentSession instances
 * - Lazy loading from database with locking to prevent duplicate SDK connections
 * - Cache invalidation on session deletion
 */

import type { Session } from '@neokai/shared';
import type { AgentSession } from '../agent/agent-session';

/**
 * Factory function type for creating AgentSession instances
 */
export type AgentSessionFactory = (session: Session) => AgentSession;

/**
 * Function type for loading session data from database
 */
export type SessionLoader = (sessionId: string) => Session | null;

export class SessionCache {
	private sessions: Map<string, AgentSession> = new Map();

	// FIX: Session lazy-loading race condition
	// Prevents multiple simultaneous loads of the same session
	// which would create duplicate Claude API connections
	private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();

	constructor(
		private createAgentSession: AgentSessionFactory,
		private loadFromDB: SessionLoader
	) {}

	/**
	 * Get session synchronously (with lazy-loading race condition fix)
	 *
	 * FIX: Prevents multiple simultaneous loads of the same session
	 * which would create duplicate Claude API connections
	 *
	 * @throws Error if session is currently being loaded - use getAsync() instead
	 */
	get(sessionId: string): AgentSession | null {
		// Check in-memory first
		if (this.sessions.has(sessionId)) {
			return this.sessions.get(sessionId)!;
		}

		// Check if load already in progress
		const loadInProgress = this.sessionLoadLocks.get(sessionId);
		if (loadInProgress) {
			// Wait for the load to complete (this is sync, so we throw an error)
			// Callers should use getAsync() for concurrent access
			throw new Error(
				`Session ${sessionId} is being loaded. Use getAsync() for concurrent access.`
			);
		}

		// Load synchronously (for backward compatibility)
		const session = this.loadFromDB(sessionId);
		if (!session) return null;

		// Create agent session
		const agentSession = this.createAgentSession(session);
		this.sessions.set(sessionId, agentSession);

		return agentSession;
	}

	/**
	 * Get session asynchronously (preferred for concurrent access)
	 *
	 * FIX: Handles concurrent requests properly with locking
	 */
	async getAsync(sessionId: string): Promise<AgentSession | null> {
		// Check in-memory first
		if (this.sessions.has(sessionId)) {
			return this.sessions.get(sessionId)!;
		}

		// Check if load already in progress
		const loadInProgress = this.sessionLoadLocks.get(sessionId);
		if (loadInProgress) {
			return await loadInProgress; // Wait for existing load
		}

		// Start new load with lock
		const loadPromise = this.loadSessionAsync(sessionId);
		this.sessionLoadLocks.set(sessionId, loadPromise);

		try {
			const agentSession = await loadPromise;
			if (agentSession) {
				this.sessions.set(sessionId, agentSession);
			}
			return agentSession;
		} catch (error) {
			// FIX: Log the specific error for debugging
			// When createAgentSession() throws, we need to know WHY
			console.error(`[SessionCache] Failed to load session ${sessionId}:`, error);
			// Return null instead of throwing so caller can handle gracefully
			return null;
		} finally {
			this.sessionLoadLocks.delete(sessionId);
		}
	}

	/**
	 * Load session from database (private helper)
	 */
	private async loadSessionAsync(sessionId: string): Promise<AgentSession | null> {
		const session = this.loadFromDB(sessionId);
		if (!session) return null;

		// Create agent session
		return this.createAgentSession(session);
	}

	/**
	 * Set a session in the cache
	 */
	set(sessionId: string, agentSession: AgentSession): void {
		this.sessions.set(sessionId, agentSession);
	}

	/**
	 * Remove a session from the cache
	 */
	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/**
	 * Check if a session exists in the cache
	 */
	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/**
	 * Get the count of active sessions in cache
	 */
	getActiveCount(): number {
		return this.sessions.size;
	}

	/**
	 * Clear all sessions from cache
	 */
	clear(): void {
		this.sessions.clear();
	}

	/**
	 * Get all sessions in the cache
	 */
	getAll(): Map<string, AgentSession> {
		return this.sessions;
	}

	/**
	 * Get all sessions as an iterator for cleanup operations
	 */
	*entries(): IterableIterator<[string, AgentSession]> {
		yield* this.sessions.entries();
	}
}
