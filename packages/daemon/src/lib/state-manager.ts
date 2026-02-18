/**
 * StateManager - Server-side state coordinator
 *
 * Manages authoritative state and broadcasts changes to clients
 * via fine-grained state channels.
 *
 * ARCHITECTURE: Event-sourced state management
 * - StateManager maintains its own state from EventBus events
 * - Publishers include their data in events (no fetching from sources)
 * - This ensures full decoupling between components via EventBus
 * - Broadcasts immediately on event (no debouncing needed - LLM is slow)
 */

import type { MessageHub, AgentProcessingState } from '@neokai/shared';
import type { DaemonHub } from './daemon-hub';
import type { SessionManager } from './session-manager';
import type { AuthManager } from './auth-manager';
import type { SettingsManager } from './settings-manager';
import type { Config } from '../config';
import { Logger } from './logger';
import type {
	SessionsState,
	SystemState,
	SettingsState,
	GlobalStateSnapshot,
	SessionStateSnapshot,
	SessionState,
	SDKMessagesState,
	SessionsUpdate,
	SDKMessagesUpdate,
} from '@neokai/shared';
import type { Session, ContextInfo } from '@neokai/shared';
import { STATE_CHANNELS } from '@neokai/shared';

const VERSION = '0.1.1';
const CLAUDE_SDK_VERSION = '0.1.37';
const startTime = Date.now();

export class StateManager {
	// FIX: Per-channel versioning instead of global version
	private channelVersions = new Map<string, number>();
	private logger = new Logger('StateManager');

	// Track API connection state (updated via broadcasts from ErrorManager)
	private apiConnectionState: import('@neokai/shared').ApiConnectionState = {
		status: 'connected',
		timestamp: Date.now(),
	};

	// Event-sourced state caches (updated from EventBus events)
	// This enables full decoupling - StateManager doesn't fetch from AgentSession
	private sessionCache = new Map<string, Session>();
	private processingStateCache = new Map<string, AgentProcessingState>();
	private commandsCache = new Map<string, string[]>();
	private contextCache = new Map<string, ContextInfo>();
	private errorCache = new Map<
		string,
		{ message: string; details?: unknown; occurredAt: number } | null
	>();

	constructor(
		private messageHub: MessageHub,
		private sessionManager: SessionManager,
		private authManager: AuthManager,
		private settingsManager: SettingsManager,
		private config: Config,
		private eventBus: DaemonHub
	) {
		this.setupHandlers();
		this.setupEventListeners();
	}

	/**
	 * Setup EventBus listeners for internal events
	 *
	 * ARCHITECTURE: Event-sourced state management
	 * - Publishers include their data in events
	 * - StateManager caches this data (no fetching from sources)
	 * - Broadcasts immediately to clients (no debouncing)
	 */
	private setupEventListeners(): void {
		// API connection state updates from ErrorManager
		this.eventBus.on('api.connection', (data) => {
			this.apiConnectionState = data as import('@neokai/shared').ApiConnectionState;
			this.broadcastSystemChange().catch((err: unknown) => {
				this.logger.error('Failed to broadcast system state after API connection change:', err);
			});
		});

		// Session created - cache and broadcast
		this.eventBus.on('session.created', async (data) => {
			const { session } = data;

			// Cache session and initial processing state
			this.sessionCache.set(session.id, session);
			this.processingStateCache.set(session.id, { status: 'idle' });

			// Broadcast delta
			await this.broadcastSessionsDelta({
				added: [session],
				timestamp: Date.now(),
			});

			// Publish session.created event
			this.messageHub.event('session.created', { sessionId: session.id }, { channel: 'global' });
		});

		// Session updated - update cache from event data and broadcast immediately
		this.eventBus.on('session.updated', async (data) => {
			const { sessionId, session, processingState } = data;

			// Update caches from event data (decoupled - no fetching)
			// FIX: Only merge into existing cache entries, don't create new entries from partial data
			// This prevents sidebar cost display from resetting to $0.00 when clicking sessions.
			// Initial full session data comes from getSessionsState() which reads from DB.
			if (session) {
				const existing = this.sessionCache.get(sessionId);
				if (existing) {
					this.sessionCache.set(sessionId, { ...existing, ...session });
				}
				// Skip storing partial session data if no existing entry - broadcastSessionUpdateFromCache
				// will handle this case by skipping the broadcast
			}
			if (processingState) {
				this.processingStateCache.set(sessionId, processingState);
			}

			// Broadcast immediately (no debouncing - LLM is slow enough)
			await this.broadcastSessionUpdateFromCache(sessionId);
		});

		// Session deleted - clear cache and broadcast
		this.eventBus.on('session.deleted', async (data) => {
			const { sessionId } = data;

			// Clear caches
			this.sessionCache.delete(sessionId);
			this.processingStateCache.delete(sessionId);
			this.commandsCache.delete(sessionId);
			this.contextCache.delete(sessionId);

			// Broadcast
			await this.broadcastSessionsDelta({
				removed: [sessionId],
				timestamp: Date.now(),
			});
			this.messageHub.event('session.deleted', { sessionId }, { channel: 'global' });
		});

		// Auth events
		this.eventBus.on('auth.changed', async () => {
			await this.broadcastSystemChange();
		});

		// Settings events
		this.eventBus.on('settings.updated', async () => {
			await this.broadcastSettingsChange();
		});

		// Sessions filter changed (when showArchived setting changes)
		this.eventBus.on('sessions.filterChanged', async () => {
			await this.broadcastSessionsChange();
		});

		// Commands updated - cache and broadcast
		this.eventBus.on(
			'commands.updated',
			async (data: { sessionId: string; commands: string[] }) => {
				this.commandsCache.set(data.sessionId, data.commands);
				await this.broadcastSessionStateChange(data.sessionId);
			}
		);

		// Context updated - cache and broadcast
		this.eventBus.on(
			'context.updated',
			async (data: { sessionId: string; contextInfo: ContextInfo }) => {
				this.contextCache.set(data.sessionId, data.contextInfo);

				// Publish dedicated context.updated event
				this.messageHub.event('context.updated', data.contextInfo, {
					channel: `session:${data.sessionId}`,
				});

				// Also update unified session state
				await this.broadcastSessionStateChange(data.sessionId);
			}
		);

		// Session error events - update error cache and broadcast via state.session
		// This folds the separate session.error event into the unified session state
		this.eventBus.on(
			'session.error',
			async (data: { sessionId: string; error: string; details?: unknown }) => {
				// Update error cache
				this.errorCache.set(data.sessionId, {
					message: data.error,
					details: data.details,
					occurredAt: Date.now(),
				});

				// Broadcast updated session state (includes error)
				await this.broadcastSessionStateChange(data.sessionId);
			}
		);

		// Clear error when session becomes idle or processing continues successfully
		this.eventBus.on('session.errorClear', async (data: { sessionId: string }) => {
			this.errorCache.set(data.sessionId, null);
			await this.broadcastSessionStateChange(data.sessionId);
		});
	}

	/**
	 * Broadcast session update from cached state (event-sourced)
	 *
	 * ARCHITECTURE: No debouncing, no fetching from AgentSession
	 * - Uses cached state from EventBus events
	 * - Broadcasts immediately (LLM processing is slow enough)
	 * - Full decoupling via EventBus
	 */
	private async broadcastSessionUpdateFromCache(sessionId: string): Promise<void> {
		try {
			// Get cached session data
			const session = this.sessionCache.get(sessionId);

			// Get cached processing state (default to idle if not cached)
			const processingState = this.processingStateCache.get(sessionId) || {
				status: 'idle' as const,
			};

			// CRITICAL: Always broadcast session state change, even if session is not cached
			// This ensures agent state (stop/send button) is always in sync with server
			// broadcastSessionStateChange has a fallback mechanism using cached processing state
			await this.broadcastSessionStateChange(sessionId);

			// Skip sessions delta update if session is not cached
			// (we need session data for sidebar updates)
			if (!session) {
				return;
			}

			// Also update global sessions list delta (for sidebar)
			// Check if session should be filtered out based on current settings
			const settings = this.settingsManager.getGlobalSettings();
			const isArchived = session.status === 'archived';
			const shouldBeFiltered = isArchived && !settings.showArchived;

			if (shouldBeFiltered) {
				// If session is archived and showArchived is false, remove it from client lists
				await this.broadcastSessionsDelta({
					removed: [sessionId],
					timestamp: Date.now(),
				});

				// Also broadcast full sessions state to update hasArchivedSessions flag
				await this.broadcastSessionsChange();
			} else {
				// Merge processing state into session for delta broadcast
				// This allows sidebar to show processing status without per-session subscriptions
				// Note: Session.processingState is typed as string (DB serialized), but we send
				// the object directly for client-side use. Type assertion is intentional.
				const sessionWithState = {
					...session,
					processingState,
				};

				await this.broadcastSessionsDelta({
					updated: [sessionWithState as unknown as Session],
					timestamp: Date.now(),
				});

				// If this is a newly archived session, broadcast full sessions state
				// to update hasArchivedSessions flag (in case this is the first archived session)
				if (isArchived) {
					await this.broadcastSessionsChange();
				}
			}
		} catch (error) {
			// Session may have been deleted during update
			this.logger.warn(`Failed to broadcast session update for ${sessionId}:`, error);
		}
	}

	/**
	 * FIX: Get and increment version for a specific channel
	 */
	private incrementVersion(channel: string): number {
		const current = this.channelVersions.get(channel) || 0;
		const next = current + 1;
		this.channelVersions.set(channel, next);
		return next;
	}

	/**
	 * Setup RPC handlers for state snapshots
	 */
	private setupHandlers(): void {
		// Global state snapshot
		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SNAPSHOT, async () => {
			return await this.getGlobalSnapshot();
		});

		// Session state snapshot
		this.messageHub.onRequest(STATE_CHANNELS.SESSION_SNAPSHOT, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.getSessionSnapshot(sessionId);
		});

		// Unified system state handler
		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SYSTEM, async () => {
			return await this.getSystemState();
		});

		// Individual channel requests (for on-demand refresh)
		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SESSIONS, async () => {
			return await this.getSessionsState();
		});

		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SETTINGS, async () => {
			return await this.getSettingsState();
		});

		// Session-specific channel requests
		this.messageHub.onRequest(STATE_CHANNELS.SESSION, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.getSessionState(sessionId);
		});

		this.messageHub.onRequest(STATE_CHANNELS.SESSION_SDK_MESSAGES, async (data) => {
			const { sessionId, since } = data as {
				sessionId: string;
				since?: number;
			};
			return await this.getSDKMessagesState(sessionId, since);
		});
	}

	// ========================================
	// Global State Getters
	// ========================================

	/**
	 * Get full global state snapshot
	 */
	async getGlobalSnapshot(): Promise<GlobalStateSnapshot> {
		const [sessions, system, settings] = await Promise.all([
			this.getSessionsState(),
			this.getSystemState(),
			this.getSettingsState(),
		]);

		return {
			sessions,
			system,
			settings,
			meta: {
				channel: 'global',
				sessionId: 'global',
				lastUpdate: Date.now(),
				version: this.channelVersions.get('global') || 0,
			},
		};
	}

	/**
	 * Get unified system state (auth + config + health + API connection)
	 * NEW: Replaces individual getAuthState/getConfigState/getHealthState
	 */
	private async getSystemState(): Promise<SystemState> {
		const authStatus = await this.authManager.getAuthStatus();

		return {
			// Version & build info
			version: VERSION,
			claudeSDKVersion: CLAUDE_SDK_VERSION,

			// Configuration
			defaultModel: this.config.defaultModel,
			maxSessions: this.config.maxSessions,
			storageLocation: this.config.dbPath,

			// Authentication
			auth: authStatus,

			// System health
			health: {
				status: 'ok' as const,
				version: VERSION,
				uptime: Date.now() - startTime,
				sessions: {
					active: this.sessionManager.getActiveSessions(),
					total: this.sessionManager.getTotalSessions(),
				},
			},

			// API connectivity (daemon <-> Claude API)
			apiConnection: this.apiConnectionState,

			timestamp: Date.now(),
		};
	}

	/**
	 * Get global settings state
	 */
	private async getSettingsState(): Promise<SettingsState> {
		return {
			settings: this.settingsManager.getGlobalSettings(),
			timestamp: Date.now(),
		};
	}

	private async getSessionsState(): Promise<SessionsState> {
		const allSessions = this.sessionManager.listSessions();
		const settings = this.settingsManager.getGlobalSettings();

		// Check if there are any archived sessions in the database
		const hasArchivedSessions = allSessions.some((s) => s.status === 'archived');

		// Filter out archived sessions unless showArchived is enabled
		const sessions = settings.showArchived
			? allSessions
			: allSessions.filter((s) => s.status !== 'archived');

		return {
			sessions,
			hasArchivedSessions,
			timestamp: Date.now(),
		};
	}

	// ========================================
	// Session State Getters
	// ========================================

	/**
	 * Get full session state snapshot
	 */
	async getSessionSnapshot(sessionId: string): Promise<SessionStateSnapshot> {
		const [session, sdkMessages] = await Promise.all([
			this.getSessionState(sessionId),
			this.getSDKMessagesState(sessionId),
		]);

		return {
			session,
			sdkMessages,
			meta: {
				channel: 'session',
				sessionId,
				lastUpdate: Date.now(),
				version: this.channelVersions.get(`session:${sessionId}`) || 0,
			},
		};
	}

	/**
	 * Get unified session state (metadata + agent + commands + context)
	 * NEW: Replaces getSessionMetaState/getAgentState/getCommandsState/getContextState
	 *
	 * Context info is now populated with real-time token usage data from streaming.
	 * During streaming, input_tokens from message_start represents total context consumption.
	 */
	private async getSessionState(sessionId: string): Promise<SessionState> {
		const agentSession = await this.sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Get all session state in one place
		const sessionData = agentSession.getSessionData();
		const agentState = agentSession.getProcessingState();
		const commands = await agentSession.getSlashCommands();

		// Get context info (populated during streaming, null before first message)
		const contextInfo = agentSession.getContextInfo();

		// Get error from cache (null if no error or error has been cleared)
		const error = this.errorCache.get(sessionId) || null;

		return {
			sessionInfo: sessionData,
			agentState: agentState,
			commandsData: {
				availableCommands: commands,
			},
			contextInfo: contextInfo,
			error: error,
			timestamp: Date.now(),
		};
	}

	private async getSDKMessagesState(sessionId: string, since?: number): Promise<SDKMessagesState> {
		const agentSession = await this.sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Use 'since' for incremental sync on reconnection
		const { messages: sdkMessages, hasMore } = agentSession.getSDKMessages(100, undefined, since);

		return {
			sdkMessages,
			hasMore,
			timestamp: Date.now(),
		};
	}

	// ========================================
	// State Change Broadcasters
	// ========================================

	/**
	 * Broadcast sessions list change (full update)
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSessionsChange(sessions?: Session[]): Promise<void> {
		const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SESSIONS);
		const state = sessions
			? { sessions, timestamp: Date.now(), version }
			: { ...(await this.getSessionsState()), version };

		this.messageHub.event(STATE_CHANNELS.GLOBAL_SESSIONS, state, {
			channel: 'global',
		});
	}

	/**
	 * Broadcast sessions delta update (more efficient for single changes)
	 * Only sends delta - clients not subscribed to deltas should subscribe to full channel
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSessionsDelta(update: SessionsUpdate): Promise<void> {
		const version = this.incrementVersion(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
		const channel = `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`;
		this.messageHub.event(channel, { ...update, version }, { channel: 'global' });
	}

	/**
	 * Broadcast unified system state change (auth + config + health)
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSystemChange(): Promise<void> {
		const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SYSTEM);
		const state = { ...(await this.getSystemState()), version };

		this.messageHub.event(STATE_CHANNELS.GLOBAL_SYSTEM, state, {
			channel: 'global',
		});
	}

	/**
	 * Broadcast global settings change
	 */
	async broadcastSettingsChange(): Promise<void> {
		const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SETTINGS);
		const state = { ...(await this.getSettingsState()), version };

		this.messageHub.event(STATE_CHANNELS.GLOBAL_SETTINGS, state, {
			channel: 'global',
		});
	}

	/**
	 * Broadcast unified session state change (metadata + agent + commands + context)
	 * NEW: Replaces broadcastSessionMetaChange/broadcastAgentStateChange/broadcastCommandsChange/broadcastContextChange
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSessionStateChange(sessionId: string): Promise<void> {
		const version = this.incrementVersion(`${STATE_CHANNELS.SESSION}:${sessionId}`);

		try {
			const state = { ...(await this.getSessionState(sessionId)), version };

			this.messageHub.event(STATE_CHANNELS.SESSION, state, {
				channel: `session:${sessionId}`,
			});
		} catch (error) {
			// Session may have been deleted or database may be closed during cleanup
			// This is expected behavior, don't throw
			// ALWAYS log to help diagnose state sync issues (e.g., button not updating after interrupt)
			this.logger.warn(
				`[StateManager] Failed to broadcast session state for ${sessionId}:`,
				error instanceof Error ? error.message : error
			);

			// If we have cached processing state, try to broadcast a minimal state update
			// This ensures UI state (like stop/send button) stays in sync even if full state fetch fails
			const cachedProcessingState = this.processingStateCache.get(sessionId);
			const cachedSession = this.sessionCache.get(sessionId);
			if (cachedProcessingState && cachedSession) {
				try {
					const fallbackState = {
						sessionInfo: cachedSession,
						agentState: cachedProcessingState,
						commandsData: { availableCommands: [] },
						contextInfo: null,
						error: null,
						timestamp: Date.now(),
						version,
					};
					this.messageHub.event(STATE_CHANNELS.SESSION, fallbackState, {
						channel: `session:${sessionId}`,
					});
				} catch (fallbackError) {
					this.logger.error(
						`[StateManager] Fallback broadcast also failed for ${sessionId}:`,
						fallbackError instanceof Error ? fallbackError.message : fallbackError
					);
				}
			}
		}
	}

	/**
	 * Broadcast SDK messages change
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSDKMessagesChange(sessionId: string): Promise<void> {
		const version = this.incrementVersion(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:${sessionId}`);
		const state = { ...(await this.getSDKMessagesState(sessionId)), version };

		this.messageHub.event(STATE_CHANNELS.SESSION_SDK_MESSAGES, state, {
			channel: `session:${sessionId}`,
		});
	}

	/**
	 * Broadcast SDK messages delta (single new message)
	 * Only sends delta - clients not subscribed to deltas should subscribe to full channel
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSDKMessagesDelta(sessionId: string, update: SDKMessagesUpdate): Promise<void> {
		const version = this.incrementVersion(
			`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:${sessionId}`
		);
		this.messageHub.event(
			`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
			{ ...update, version },
			{ channel: `session:${sessionId}` }
		);
	}
}
