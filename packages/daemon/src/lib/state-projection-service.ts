/**
 * StateProjectionService - Pure state projection and read-model service
 *
 * Maintains authoritative state caches from internal events and serves
 * state snapshots via public read methods. All client delivery, RPC
 * handlers, and event forwarding are handled by ClientEventBridge.
 *
 * ARCHITECTURE: Event-sourced state projection
 * - StateProjectionService maintains its own state from InternalEventBus events
 * - Publishers include their data in events (no fetching from sources)
 * - This ensures full decoupling between components via the event bus
 * - Broadcasts/RPC handlers are in ClientEventBridge
 *
 * MIGRATION NOTE: Broadcast methods and RPC handler registrations were moved
 * to ClientEventBridge. channelVersions are exposed via a public interface
 * so ClientEventBridge can manage versioned state broadcasts.
 * See docs/plans/internal-event-command-query-architecture.md (M4, M5).
 */

import type { AgentProcessingState } from '@neokai/shared';
import type { SessionManager } from './session-manager';
import type { AuthManager } from './auth-manager';
import type { SettingsManager } from './settings-manager';
import type { Config } from '../config';
import type { Database } from '../storage/database';
import { Logger } from './logger';
import type {
	SessionsState,
	SystemState,
	SettingsState,
	GlobalStateSnapshot,
	SessionStateSnapshot,
	SessionState,
	SDKMessagesState,
} from '@neokai/shared';
import type { Session } from '@neokai/shared';
import { STATE_CHANNELS } from '@neokai/shared';
import { SDKMessageRepository } from '../storage/repositories/sdk-message-repository';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus';

const VERSION = '0.1.1';
const CLAUDE_SDK_VERSION = '0.1.37';
const startTime = Date.now();

/**
 * Interface for version management, exposed so ClientEventBridge can
 * increment channel versions for its broadcasts.
 */
export interface ChannelVersionSource {
	incrementVersion(channel: string): number;
	getVersion(channel: string): number;
	deleteVersion(channel: string): void;
}

export class StateProjectionService implements ChannelVersionSource {
	// Per-channel versioning — shared with ClientEventBridge for versioned broadcasts
	private channelVersions = new Map<string, number>();
	private logger = new Logger('StateProjectionService');

	// Track API connection state (updated via broadcasts from ErrorManager)
	private apiConnectionState: import('@neokai/shared').ApiConnectionState = {
		status: 'connected',
		timestamp: Date.now(),
	};

	// Event-sourced state caches (updated from InternalEventBus events)
	// This enables full decoupling - StateProjectionService doesn't fetch from AgentSession
	private sessionCache = new Map<string, Session>();
	private processingStateCache = new Map<string, AgentProcessingState>();
	private commandsCache = new Map<string, string[]>();
	private errorCache = new Map<
		string,
		{ message: string; details?: unknown; occurredAt: number } | null
	>();

	constructor(
		private sessionManager: SessionManager,
		private authManager: AuthManager,
		private settingsManager: SettingsManager,
		private config: Config,
		private db?: Database,
		private internalEventBus?: InternalEventBus<DaemonInternalEventMap>
	) {
		this.setupEventBusSubscriptions();
	}

	// ========================================
	// ChannelVersionSource interface
	// ========================================

	/**
	 * Increment and return the version for a specific channel.
	 * Used by ClientEventBridge for versioned state broadcasts.
	 */
	incrementVersion(channel: string): number {
		const current = this.channelVersions.get(channel) || 0;
		const next = current + 1;
		this.channelVersions.set(channel, next);
		return next;
	}

	/**
	 * Get current version for a channel (without incrementing).
	 */
	getVersion(channel: string): number {
		return this.channelVersions.get(channel) || 0;
	}

	/**
	 * Delete version tracking for a channel (used during session cleanup).
	 */
	deleteVersion(channel: string): void {
		this.channelVersions.delete(channel);
	}

	/**
	 * Subscribe to InternalEventBus for state-cache updates.
	 *
	 * ARCHITECTURE: Event-sourced state projection
	 * - Publishers include their data in events
	 * - StateProjectionService caches this data (no fetching from sources)
	 * - Broadcasts are handled by ClientEventBridge, not this service
	 */
	private setupEventBusSubscriptions(): void {
		if (!this.internalEventBus) {
			this.logger.warn(
				'No InternalEventBus provided; state projection will not receive cache updates'
			);
			return;
		}

		// API connection state updates from ErrorManager
		this.internalEventBus.subscribe(
			'api.connection',
			(data) => {
				this.apiConnectionState = data as import('@neokai/shared').ApiConnectionState;
			},
			{ subscriberName: 'StateProjectionService.apiConnection' }
		);

		// Session created - cache only
		this.internalEventBus.subscribe(
			'session.created',
			(data) => {
				const { session } = data as unknown as { session: Session };
				this.sessionCache.set(session.id, session);
				this.processingStateCache.set(session.id, { status: 'idle' });
			},
			{ subscriberName: 'StateProjectionService.sessionCreated' }
		);

		// Session updated - update cache from event data
		this.internalEventBus.subscribe(
			'session.updated',
			(data) => {
				const { namespaceId, session, processingState } = data as unknown as {
					namespaceId: string;
					session?: Partial<Session>;
					processingState?: AgentProcessingState;
				};

				// Update caches from event data (decoupled - no fetching)
				// Only merge into existing cache entries, don't create new entries from partial data
				// This prevents sidebar cost display from resetting to $0.00 when clicking sessions.
				// Initial full session data comes from getSessionsState() which reads from DB.
				if (session) {
					const existing = this.sessionCache.get(namespaceId);
					if (existing) {
						this.sessionCache.set(namespaceId, { ...existing, ...session });
					}
				}
				if (processingState) {
					this.processingStateCache.set(namespaceId, processingState);
				}
			},
			{ subscriberName: 'StateProjectionService.sessionUpdated' }
		);

		// Session deleted - clear caches and channelVersions
		this.internalEventBus.subscribe(
			'session.deleted',
			(data) => {
				const { namespaceId } = data as unknown as { namespaceId: string };

				// Clear caches
				this.sessionCache.delete(namespaceId);
				this.processingStateCache.delete(namespaceId);
				this.commandsCache.delete(namespaceId);
				this.errorCache.delete(namespaceId);

				// Clean up channelVersions for deleted session
				this.channelVersions.delete(`${STATE_CHANNELS.SESSION}:${namespaceId}`);
				this.channelVersions.delete(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:${namespaceId}`);
				this.channelVersions.delete(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:${namespaceId}`);
			},
			{ subscriberName: 'StateProjectionService.sessionDeleted' }
		);

		// Settings updated - cache only (broadcast handled by ClientEventBridge)
		this.internalEventBus.subscribe(
			'settings.updated',
			() => {
				// No cache to update for settings — settings are read from SettingsManager
				// The broadcast is handled by ClientEventBridge
			},
			{ subscriberName: 'StateProjectionService.settingsUpdated' }
		);

		// Commands updated - cache only
		this.internalEventBus.subscribe(
			'commands.updated',
			(data) => {
				const { namespaceId, commands } = data as unknown as {
					namespaceId: string;
					commands: string[];
				};
				this.commandsCache.set(namespaceId, commands);
			},
			{ subscriberName: 'StateProjectionService.commandsUpdated' }
		);

		// Session error events - cache only
		this.internalEventBus.subscribe(
			'session.error',
			(data) => {
				const { namespaceId, error, details } = data as unknown as {
					namespaceId: string;
					error: string;
					details?: unknown;
				};
				this.errorCache.set(namespaceId, {
					message: error,
					details,
					occurredAt: Date.now(),
				});
			},
			{ subscriberName: 'StateProjectionService.sessionError' }
		);

		// Clear error when session becomes idle or processing continues successfully
		this.internalEventBus.subscribe(
			'session.errorClear',
			(data) => {
				const { namespaceId } = data as unknown as { namespaceId: string };
				this.errorCache.set(namespaceId, null);
			},
			{ subscriberName: 'StateProjectionService.sessionErrorClear' }
		);
	}

	/**
	 * Get a minimal session state from caches only, without fetching from AgentSession.
	 * Used as a fallback by ClientEventBridge when the full getSessionState() fails
	 * (e.g., during teardown races or deleted sessions).
	 * Returns null if no cached data is available.
	 */
	getCachedSessionState(sessionId: string): import('@neokai/shared').SessionState | null {
		const cachedProcessingState = this.processingStateCache.get(sessionId);
		const cachedSession = this.sessionCache.get(sessionId);
		if (cachedProcessingState && cachedSession) {
			return {
				sessionInfo: cachedSession,
				agentState: cachedProcessingState,
				commandsData: { availableCommands: this.commandsCache.get(sessionId) || [] },
				error: this.errorCache.get(sessionId) || null,
				timestamp: Date.now(),
			};
		}
		return null;
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
	 */
	async getSystemState(): Promise<SystemState> {
		const authStatus = await this.authManager.getAuthStatus();

		return {
			// Version & build info
			version: VERSION,
			claudeSDKVersion: CLAUDE_SDK_VERSION,

			// Configuration
			defaultModel: this.config.defaultModel,
			maxSessions: this.config.maxSessions,
			storageLocation: this.config.dbPath,
			workspaceRoot: this.config.workspaceRoot,

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
	async getSettingsState(): Promise<SettingsState> {
		return {
			settings: this.settingsManager.getGlobalSettings(),
			timestamp: Date.now(),
		};
	}

	async getSessionsState(): Promise<SessionsState> {
		const settings = this.settingsManager.getGlobalSettings();

		// Check if there are any archived sessions in the database
		const allSessions = this.sessionManager.listSessions({ includeArchived: true });
		const hasArchivedSessions = allSessions.some((s) => s.status === 'archived');

		// Server-side filtering: only include archived when setting is enabled
		const sessions = settings.showArchived ? allSessions : this.sessionManager.listSessions();

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
	 *
	 * Context info is now populated with real-time token usage data from streaming.
	 * During streaming, input_tokens from message_start represents total context consumption.
	 */
	async getSessionState(sessionId: string): Promise<SessionState> {
		const agentSession = await this.sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			// Special handling for DB-only sessions (no AgentSession):
			// - Room sessions (ID format: "room:{roomId}") — created when room agent starts
			// - Conversation sessions (ID format: "conv:{roomId}:...") — task group timelines
			if (sessionId.startsWith('room:') || sessionId.startsWith('conv:')) {
				return {
					sessionInfo: null,
					agentState: { status: 'idle' },
					commandsData: { availableCommands: [] },
					error: null,
					timestamp: Date.now(),
				};
			}
			throw new Error('Session not found');
		}

		// Get all session state in one place
		const sessionData = agentSession.getSessionData();
		// Prefer event-sourced processingStateCache over the session's in-memory state.
		// Task agent sessions are managed by SpaceRuntimeService but may be
		// loaded separately into SessionCache (as "ghosts") when state.session is fetched.
		// The ghost's in-memory processingState becomes stale once the live session changes
		// state. processingStateCache is always up-to-date via session.updated events.
		const agentState =
			this.processingStateCache.get(sessionId) ?? agentSession.getProcessingState();
		const commands = await agentSession.getSlashCommands();

		// Get error from cache (null if no error or error has been cleared)
		const error = this.errorCache.get(sessionId) || null;

		return {
			sessionInfo: sessionData,
			agentState: agentState,
			commandsData: {
				availableCommands: commands,
			},
			error: error,
			timestamp: Date.now(),
		};
	}

	async getSDKMessagesState(sessionId: string, since?: number): Promise<SDKMessagesState> {
		const agentSession = await this.sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			// DB-only sessions: read directly from sdk_messages table
			// - Room sessions (room:*) may have no messages yet
			// - Conversation sessions (conv:*) have mirrored messages
			if ((sessionId.startsWith('room:') || sessionId.startsWith('conv:')) && this.db) {
				const sdkMessageRepo = new SDKMessageRepository(this.db.getDatabase());
				const { messages: sdkMessages, hasMore } = sdkMessageRepo.getSDKMessages(
					sessionId,
					100,
					undefined,
					since
				);
				return { sdkMessages, hasMore, timestamp: Date.now() };
			}
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
}
