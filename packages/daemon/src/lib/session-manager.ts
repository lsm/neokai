import type { Session } from '@liuboer/shared';
import type { MessageHub, EventBus } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import { Database } from '../storage/database';
import { AgentSession } from './agent-session';
import type { AuthManager } from './auth-manager';

export class SessionManager {
	private sessions: Map<string, AgentSession> = new Map();

	// FIX: Session lazy-loading race condition
	private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();
	private debug: boolean;

	// Cache for dynamic model loading (global, shared across all sessions)
	private static modelLoadingPromise: Promise<void> | null = null;
	private static modelsLoaded = false;

	constructor(
		private db: Database,
		private messageHub: MessageHub,
		private authManager: AuthManager,
		private eventBus: EventBus, // FIX: Use EventBus instead of StateManager
		private config: {
			defaultModel: string;
			maxTokens: number;
			temperature: number;
			workspaceRoot: string;
		}
	) {
		// Only enable debug logs in development mode, not in test mode
		this.debug = process.env.NODE_ENV === 'development';
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log(...args);
		}
	}

	private error(...args: unknown[]): void {
		if (this.debug) {
			console.error(...args);
		}
	}

	async createSession(params: {
		workspacePath?: string;
		initialTools?: string[];
		config?: Partial<Session['config']>;
	}): Promise<string> {
		const sessionId = generateUUID();

		const sessionWorkspacePath = params.workspacePath || this.config.workspaceRoot;

		// Load dynamic models and pick a validated model ID
		const modelId = await this.getValidatedModelId(params.config?.model);

		const session: Session = {
			id: sessionId,
			title: `Session ${new Date().toLocaleString()}`,
			workspacePath: sessionWorkspacePath,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: modelId, // Use validated model ID from SDK
				maxTokens: params.config?.maxTokens || this.config.maxTokens,
				temperature: params.config?.temperature || this.config.temperature,
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

		// Save to database
		this.db.createSession(session);

		// Create agent session with MessageHub, EventBus, and auth function
		const agentSession = new AgentSession(session, this.db, this.messageHub, this.eventBus, () =>
			this.authManager.getCurrentApiKey()
		);

		this.sessions.set(sessionId, agentSession);

		// Emit event via EventBus (StateManager will handle publishing to MessageHub)
		this.log('[SessionManager] Emitting session:created event for session:', sessionId);
		await this.eventBus.emit('session:created', { session });
		this.log('[SessionManager] Event emitted, returning sessionId:', sessionId);

		return sessionId;
	}

	/**
	 * Ensure dynamic models are loaded globally (one-time operation)
	 */
	private async ensureModelsLoaded(): Promise<void> {
		// Already loaded
		if (SessionManager.modelsLoaded) {
			return;
		}

		// Loading in progress, wait for it
		if (SessionManager.modelLoadingPromise) {
			await SessionManager.modelLoadingPromise;
			return;
		}

		// Start loading
		SessionManager.modelLoadingPromise = this.loadDynamicModels();

		try {
			await SessionManager.modelLoadingPromise;
			SessionManager.modelsLoaded = true;
		} catch (error) {
			this.log('[SessionManager] Failed to load dynamic models:', error);
			// Reset so it can be retried
			SessionManager.modelLoadingPromise = null;
		}
	}

	/**
	 * Load dynamic models from SDK (one-time operation for app lifecycle)
	 */
	private async loadDynamicModels(): Promise<void> {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		const { getSupportedModelsFromQuery } = await import('./model-service');

		this.log('[SessionManager] Loading dynamic models from SDK...');

		// Create a temporary query to fetch models
		const tmpQuery = query({
			prompt: '',
			options: {
				model: this.config.defaultModel,
				cwd: this.config.workspaceRoot,
				maxTurns: 0,
			},
		});

		try {
			// Get models from SDK and cache globally
			await getSupportedModelsFromQuery(tmpQuery, 'global');
			this.log('[SessionManager] Dynamic models loaded successfully');
		} finally {
			// Always cleanup
			try {
				await tmpQuery.interrupt();
			} catch {
				// Ignore
			}
		}
	}

	/**
	 * Get a validated model ID by using cached dynamic models
	 * Falls back to static model if dynamic loading failed or is unavailable
	 */
	private async getValidatedModelId(requestedModel?: string): Promise<string> {
		// Try to ensure models are loaded (with timeout)
		try {
			await Promise.race([
				this.ensureModelsLoaded(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
			]);
		} catch {
			this.log('[SessionManager] Model loading timeout or failed, using static fallback');
		}

		// Try to get from dynamic models
		try {
			const { getAvailableModels } = await import('./model-service');
			const availableModels = getAvailableModels('global');

			if (availableModels.length > 0) {
				// If a specific model was requested, validate it
				if (requestedModel) {
					const found = availableModels.find(
						(m) => m.id === requestedModel || m.alias === requestedModel
					);
					if (found) {
						this.log(`[SessionManager] Using requested model: ${found.id}`);
						return found.id;
					}
				}

				// Find default model (prefer Sonnet)
				const defaultModel =
					availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

				if (defaultModel) {
					this.log(`[SessionManager] Using default model from SDK: ${defaultModel.id}`);
					return defaultModel.id;
				}
			}
		} catch (error) {
			this.log('[SessionManager] Error getting dynamic models:', error);
		}

		// Fallback to static model
		const fallbackModel = requestedModel || this.config.defaultModel;
		this.log(`[SessionManager] Using static fallback model: ${fallbackModel}`);
		return fallbackModel;
	}

	/**
	 * Get session (with lazy-loading race condition fix)
	 *
	 * FIX: Prevents multiple simultaneous loads of the same session
	 * which would create duplicate Claude API connections
	 */
	getSession(sessionId: string): AgentSession | null {
		// Check in-memory first
		if (this.sessions.has(sessionId)) {
			return this.sessions.get(sessionId)!;
		}

		// Check if load already in progress
		const loadInProgress = this.sessionLoadLocks.get(sessionId);
		if (loadInProgress) {
			// Wait for the load to complete (this is sync, so we throw an error)
			// Callers should use getSessionAsync() for concurrent access
			throw new Error(
				`Session ${sessionId} is being loaded. Use getSessionAsync() for concurrent access.`
			);
		}

		// Load synchronously (for backward compatibility)
		const session = this.db.getSession(sessionId);
		if (!session) return null;

		// Create agent session with MessageHub, EventBus, and auth function
		const agentSession = new AgentSession(session, this.db, this.messageHub, this.eventBus, () =>
			this.authManager.getCurrentApiKey()
		);
		this.sessions.set(sessionId, agentSession);

		return agentSession;
	}

	/**
	 * Get session asynchronously (preferred for concurrent access)
	 *
	 * FIX: Handles concurrent requests properly with locking
	 */
	async getSessionAsync(sessionId: string): Promise<AgentSession | null> {
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
		const loadPromise = this.loadSessionFromDB(sessionId);
		this.sessionLoadLocks.set(sessionId, loadPromise);

		try {
			const agentSession = await loadPromise;
			if (agentSession) {
				this.sessions.set(sessionId, agentSession);
			}
			return agentSession;
		} finally {
			this.sessionLoadLocks.delete(sessionId);
		}
	}

	/**
	 * Load session from database (private helper)
	 */
	private async loadSessionFromDB(sessionId: string): Promise<AgentSession | null> {
		const session = this.db.getSession(sessionId);
		if (!session) return null;

		// Create agent session with MessageHub, EventBus, and auth function
		return new AgentSession(session, this.db, this.messageHub, this.eventBus, () =>
			this.authManager.getCurrentApiKey()
		);
	}

	listSessions(): Session[] {
		return this.db.listSessions();
	}

	async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
		this.db.updateSession(sessionId, updates);

		// Update in-memory session if exists
		const agentSession = this.sessions.get(sessionId);
		if (agentSession) {
			agentSession.updateMetadata(updates);
		}

		// FIX: Emit event via EventBus
		await this.eventBus.emit('session:updated', { sessionId, updates });
	}

	async deleteSession(sessionId: string): Promise<void> {
		// Transaction-like cleanup with proper error handling
		const agentSession = this.sessions.get(sessionId);
		let dbDeleted = false;

		try {
			// 1. Cleanup resources (can fail)
			if (agentSession) {
				await agentSession.cleanup();
			}

			// 2. Delete from DB (can fail)
			this.db.deleteSession(sessionId);
			dbDeleted = true;

			// 3. Remove from memory (shouldn't fail)
			this.sessions.delete(sessionId);

			// 4. Notify clients (can fail, but don't rollback)
			try {
				await this.messageHub.publish(
					`session.deleted`,
					{ sessionId, reason: 'deleted' },
					{ sessionId: 'global' }
				);

				// Emit event via EventBus
				await this.eventBus.emit('session:deleted', { sessionId });
			} catch (error) {
				this.error('[SessionManager] Failed to broadcast deletion:', error);
				// Don't rollback - session is already deleted
			}
		} catch (error) {
			// Rollback if DB delete failed
			if (!dbDeleted) {
				this.error('[SessionManager] Session deletion failed:', error);
				throw error;
			}

			// If cleanup failed but DB delete succeeded, log but don't rollback
			this.error('[SessionManager] Session deleted but cleanup failed:', error);
		}
	}

	getActiveSessions(): number {
		return this.sessions.size;
	}

	getTotalSessions(): number {
		return this.db.listSessions().length;
	}

	/**
	 * Cleanup all sessions (called during shutdown)
	 */
	async cleanup(): Promise<void> {
		this.log(`[SessionManager] Cleaning up ${this.sessions.size} active sessions...`);

		// Cleanup all in-memory sessions
		for (const [sessionId, agentSession] of this.sessions) {
			try {
				agentSession.cleanup();
			} catch (error) {
				this.error(`[SessionManager] Error cleaning up session ${sessionId}:`, error);
			}
		}

		// Clear session map
		this.sessions.clear();
		this.log(`[SessionManager] All sessions cleaned up`);
	}
}
