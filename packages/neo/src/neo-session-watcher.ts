/**
 * NeoSessionWatcher - Watches session state changes for Neo
 *
 * Monitors worker sessions and notifies Neo of state changes:
 * - turn_completed (idle): Agent finished processing
 * - waiting_for_input: Agent needs user response
 * - processing: Agent is actively working
 * - error: Agent encountered an error
 */

import type { MessageHub, SessionState, PendingUserQuestion } from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { STATE_CHANNELS } from '@neokai/shared';

/**
 * Handlers for session state change events
 */
export interface SessionEventHandlers {
	/** Called when agent turn completes (status becomes 'idle') */
	onTurnCompleted: (sessionId: string, state: SessionState) => Promise<void>;
	/** Called when agent needs user input */
	onWaitingForInput: (sessionId: string, question: PendingUserQuestion) => Promise<void>;
	/** Called when agent starts/is processing */
	onProcessing: (sessionId: string, phase: string) => Promise<void>;
	/** Called when agent encounters an error */
	onError: (sessionId: string, error: { message: string }) => Promise<void>;
}

/**
 * NeoSessionWatcher - Monitors session state changes via MessageHub
 *
 * Usage:
 * ```typescript
 * const watcher = new NeoSessionWatcher(hub, {
 *   onTurnCompleted: async (sessionId, state) => { ... },
 *   onWaitingForInput: async (sessionId, question) => { ... },
 *   onProcessing: async (sessionId, phase) => { ... },
 *   onError: async (sessionId, error) => { ... },
 * });
 *
 * await watcher.watchSession('session-123');
 * // Later...
 * await watcher.unwatchSession('session-123');
 * ```
 */
export class NeoSessionWatcher {
	private subscriptions: Map<string, () => void> = new Map();
	private logger: Logger;

	constructor(
		private hub: MessageHub,
		private handlers: SessionEventHandlers
	) {
		this.logger = new Logger('neo-session-watcher');
	}

	/**
	 * Start watching a session for state changes
	 *
	 * 1. Joins the session room for event routing
	 * 2. Subscribes to state.session events
	 * 3. Fetches initial state
	 */
	async watchSession(sessionId: string): Promise<void> {
		// Don't double-subscribe
		if (this.subscriptions.has(sessionId)) {
			this.logger.debug(`Already watching session: ${sessionId}`);
			return;
		}

		// 1. Join session channel for event routing
		await this.hub.joinChannel(`session:${sessionId}`);

		// 2. Subscribe to state.session events
		const unsub = this.hub.onEvent<SessionState>(STATE_CHANNELS.SESSION, (state) => {
			// Only handle events for sessions we're watching
			if (state.sessionInfo?.id === sessionId) {
				this.handleStateChange(sessionId, state).catch((error) => {
					this.logger.error(`Error handling state change for ${sessionId}:`, error);
				});
			}
		});

		this.subscriptions.set(sessionId, unsub);
		this.logger.debug(`Started watching session: ${sessionId}`);

		// 3. Fetch initial state
		try {
			const initialState = await this.hub.request<SessionState>('state.session', { sessionId });
			await this.handleStateChange(sessionId, initialState);
		} catch (error) {
			this.logger.warn(`Could not fetch initial state for ${sessionId}:`, error);
		}
	}

	/**
	 * Stop watching a session
	 */
	async unwatchSession(sessionId: string): Promise<void> {
		const unsub = this.subscriptions.get(sessionId);
		if (unsub) {
			unsub();
			this.subscriptions.delete(sessionId);
		}
		await this.hub.leaveChannel(`session:${sessionId}`);
		this.logger.debug(`Stopped watching session: ${sessionId}`);
	}

	/**
	 * Handle a session state change
	 */
	private async handleStateChange(sessionId: string, state: SessionState): Promise<void> {
		const { agentState, error } = state;

		// Check for error state first
		if (error) {
			await this.handlers.onError(sessionId, {
				message: error.message,
			});
			return;
		}

		// Dispatch based on agent status
		switch (agentState.status) {
			case 'idle':
				await this.handlers.onTurnCompleted(sessionId, state);
				break;

			case 'waiting_for_input':
				if (agentState.pendingQuestion) {
					await this.handlers.onWaitingForInput(sessionId, agentState.pendingQuestion);
				}
				break;

			case 'processing':
				await this.handlers.onProcessing(sessionId, agentState.phase || 'unknown');
				break;

			case 'queued':
				// Queued is a sub-state of processing, treat as processing with 'queued' phase
				await this.handlers.onProcessing(sessionId, 'queued');
				break;

			case 'interrupted':
				// Interrupted is like idle - agent stopped
				await this.handlers.onTurnCompleted(sessionId, state);
				break;

			default:
				this.logger.debug(`Unknown agent status: ${(agentState as { status: string }).status}`);
		}
	}

	/**
	 * Stop watching all sessions
	 */
	async unwatchAll(): Promise<void> {
		const sessionIds = Array.from(this.subscriptions.keys());

		await Promise.all(
			sessionIds.map(async (sessionId) => {
				const unsub = this.subscriptions.get(sessionId);
				if (unsub) {
					unsub();
				}
				await this.hub.leaveChannel(`session:${sessionId}`);
			})
		);

		this.subscriptions.clear();
		this.logger.debug(`Stopped watching all sessions (${sessionIds.length})`);
	}

	/**
	 * Get list of currently watched session IDs
	 */
	getWatchedSessions(): string[] {
		return Array.from(this.subscriptions.keys());
	}

	/**
	 * Check if a session is being watched
	 */
	isWatching(sessionId: string): boolean {
		return this.subscriptions.has(sessionId);
	}
}
