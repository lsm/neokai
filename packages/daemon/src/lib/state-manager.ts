/**
 * StateManager - Server-side state coordinator
 *
 * Manages authoritative state and broadcasts changes to clients
 * via fine-grained state channels
 *
 * FIX: Uses EventBus to listen for internal events instead of
 * being directly called by SessionManager (breaks circular dependency)
 */

import type { MessageHub, EventBus } from '@liuboer/shared';
import type { SessionManager } from './session-manager';
import type { AuthManager } from './auth-manager';
import type { Config } from '../config';
import { Logger } from './logger';
import type {
	SessionsState,
	SystemState,
	GlobalStateSnapshot,
	SessionStateSnapshot,
	SessionState,
	SDKMessagesState,
	AgentProcessingState,
	SessionsUpdate,
	SDKMessagesUpdate,
} from '@liuboer/shared';
import type { Session, ContextInfo } from '@liuboer/shared';
import { STATE_CHANNELS } from '@liuboer/shared';

const VERSION = '0.1.0';
const CLAUDE_SDK_VERSION = '0.1.37';
const startTime = Date.now();

export class StateManager {
	// FIX: Per-channel versioning instead of global version
	private channelVersions = new Map<string, number>();
	private logger = new Logger('StateManager');

	constructor(
		private messageHub: MessageHub,
		private sessionManager: SessionManager,
		private authManager: AuthManager,
		private config: Config,
		private eventBus: EventBus // FIX: Listen to EventBus for changes
	) {
		this.setupHandlers();
		this.setupEventListeners(); // FIX: Listen to internal events
	}

	/**
	 * FIX: Setup EventBus listeners for internal events
	 *
	 * StateManager listens to events from SessionManager/AuthManager
	 * and broadcasts state changes to clients. This breaks the circular
	 * dependency where SessionManager had to call StateManager directly.
	 */
	private setupEventListeners(): void {
		// Session lifecycle events
		this.eventBus.on('session:created', async (data) => {
			this.logger.log(
				'Received session:created event, broadcasting delta for session:',
				data.session.id
			);
			this.logger.log('Session data:', JSON.stringify(data.session, null, 2));

			// Broadcast state channel delta
			await this.broadcastSessionsDelta({
				added: [data.session],
				timestamp: Date.now(),
			});

			// Publish session.created event for subscribers
			this.logger.log(' Publishing session.created event with data:', {
				sessionId: data.session.id,
			});
			await this.messageHub.publish(
				'session.created',
				{ sessionId: data.session.id },
				{ sessionId: 'global' }
			);
			this.logger.log(' session.created event published');

			this.logger.log(' Delta broadcasted for session:', data.session.id);
		});

		this.eventBus.on('session:updated', async (data) => {
			// Broadcast unified session state
			await this.broadcastSessionStateChange(data.sessionId);

			// Also update global sessions list
			const updatedSession = this.sessionManager
				.listSessions()
				.find((s) => s.id === data.sessionId);
			if (updatedSession) {
				await this.broadcastSessionsDelta({
					updated: [updatedSession],
					timestamp: Date.now(),
				});
			}

			// Publish session.updated event for subscribers
			await this.messageHub.publish(
				'session.updated',
				{ sessionId: data.sessionId },
				{ sessionId: 'global' }
			);
		});

		this.eventBus.on('session:deleted', async (data) => {
			await this.broadcastSessionsDelta({
				removed: [data.sessionId],
				timestamp: Date.now(),
			});

			// Publish session.deleted event for subscribers
			await this.messageHub.publish(
				'session.deleted',
				{ sessionId: data.sessionId },
				{ sessionId: 'global' }
			);
		});

		// Auth events - broadcast unified system state
		this.eventBus.on('auth:changed', async () => {
			await this.broadcastSystemChange();
		});

		// Agent state events - broadcast unified session state
		this.eventBus.on(
			'agent-state:changed',
			async (data: { sessionId: string; state: AgentProcessingState }) => {
				await this.broadcastSessionStateChange(data.sessionId);
			}
		);

		// Commands events - broadcast unified session state
		this.eventBus.on(
			'commands:updated',
			async (data: { sessionId: string; commands: string[] }) => {
				await this.broadcastSessionStateChange(data.sessionId);
			}
		);

		// Context events - broadcast context updates AND unified session state
		// This enables real-time context tracking during streaming
		this.eventBus.on(
			'context:updated',
			async (data: { sessionId: string; contextInfo: ContextInfo }) => {
				// Publish dedicated context.updated event for clients
				// This is the primary channel for real-time context updates
				await this.messageHub.publish('context.updated', data.contextInfo, {
					sessionId: data.sessionId,
				});

				// Also update unified session state (for clients using state channels)
				await this.broadcastSessionStateChange(data.sessionId);
			}
		);

		// Compaction events - notify UI when auto-compaction starts/finishes
		// This allows the UI to lock the input and show progress
		this.eventBus.on(
			'context:compacting',
			async (data: { sessionId: string; trigger: 'manual' | 'auto' }) => {
				this.logger.log(`Context compacting (${data.trigger}) for session: ${data.sessionId}`);
				await this.messageHub.publish(
					'context.compacting',
					{ trigger: data.trigger },
					{ sessionId: data.sessionId }
				);
			}
		);

		this.eventBus.on(
			'context:compacted',
			async (data: { sessionId: string; trigger: 'manual' | 'auto'; preTokens: number }) => {
				this.logger.log(
					`Context compacted (${data.trigger}) for session: ${data.sessionId}, pre-tokens: ${data.preTokens}`
				);
				await this.messageHub.publish(
					'context.compacted',
					{ trigger: data.trigger, preTokens: data.preTokens },
					{ sessionId: data.sessionId }
				);
			}
		);
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
		this.messageHub.handle(STATE_CHANNELS.GLOBAL_SNAPSHOT, async () => {
			return await this.getGlobalSnapshot();
		});

		// Session state snapshot
		this.messageHub.handle(STATE_CHANNELS.SESSION_SNAPSHOT, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.getSessionSnapshot(sessionId);
		});

		// Unified system state handler
		this.messageHub.handle(STATE_CHANNELS.GLOBAL_SYSTEM, async () => {
			return await this.getSystemState();
		});

		// Individual channel requests (for on-demand refresh)
		this.messageHub.handle(STATE_CHANNELS.GLOBAL_SESSIONS, async () => {
			return await this.getSessionsState();
		});

		// Session-specific channel requests
		this.messageHub.handle(STATE_CHANNELS.SESSION, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.getSessionState(sessionId);
		});

		this.messageHub.handle(STATE_CHANNELS.SESSION_SDK_MESSAGES, async (data) => {
			const { sessionId, since } = data as { sessionId: string; since?: number };
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
		const [sessions, system] = await Promise.all([this.getSessionsState(), this.getSystemState()]);

		return {
			sessions,
			system,
			meta: {
				channel: 'global',
				sessionId: 'global',
				lastUpdate: Date.now(),
				version: this.channelVersions.get('global') || 0,
			},
		};
	}

	/**
	 * Get unified system state (auth + config + health)
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

			timestamp: Date.now(),
		};
	}

	private async getSessionsState(): Promise<SessionsState> {
		const sessions = this.sessionManager.listSessions();
		return {
			sessions,
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

		return {
			session: sessionData,
			agent: agentState,
			commands: {
				availableCommands: commands,
			},
			context: contextInfo,
			timestamp: Date.now(),
		};
	}

	private async getSDKMessagesState(sessionId: string, since?: number): Promise<SDKMessagesState> {
		const agentSession = await this.sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Use 'since' for incremental sync on reconnection
		const sdkMessages = agentSession.getSDKMessages(100, undefined, since);

		return {
			sdkMessages,
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

		await this.messageHub.publish(STATE_CHANNELS.GLOBAL_SESSIONS, state, {
			sessionId: 'global',
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
		this.logger.log(' Broadcasting to channel:', channel);
		this.logger.log(' Delta payload:', JSON.stringify({ ...update, version }, null, 2));
		await this.messageHub.publish(channel, { ...update, version }, { sessionId: 'global' });
		this.logger.log(' Delta published successfully to:', channel);
	}

	/**
	 * Broadcast unified system state change (auth + config + health)
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSystemChange(): Promise<void> {
		const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SYSTEM);
		const state = { ...(await this.getSystemState()), version };

		await this.messageHub.publish(STATE_CHANNELS.GLOBAL_SYSTEM, state, {
			sessionId: 'global',
		});
	}

	/**
	 * Broadcast unified session state change (metadata + agent + commands + context)
	 * NEW: Replaces broadcastSessionMetaChange/broadcastAgentStateChange/broadcastCommandsChange/broadcastContextChange
	 * FIX: Uses per-channel versioning
	 */
	async broadcastSessionStateChange(sessionId: string): Promise<void> {
		try {
			const version = this.incrementVersion(`${STATE_CHANNELS.SESSION}:${sessionId}`);
			const state = { ...(await this.getSessionState(sessionId)), version };

			await this.messageHub.publish(STATE_CHANNELS.SESSION, state, {
				sessionId,
			});
		} catch (error) {
			// Session may have been deleted or database may be closed during cleanup
			// This is expected behavior, don't throw
			if (process.env.TEST_VERBOSE) {
				console.warn(
					`[StateManager] Failed to broadcast session state for ${sessionId}:`,
					error instanceof Error ? error.message : error
				);
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

		await this.messageHub.publish(STATE_CHANNELS.SESSION_SDK_MESSAGES, state, {
			sessionId,
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
		await this.messageHub.publish(
			`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
			{ ...update, version },
			{ sessionId }
		);
	}
}
