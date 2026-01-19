/**
 * SessionStore - Unified session state management with pure WebSocket architecture
 *
 * ARCHITECTURE: Pure WebSocket (no REST API)
 * - Initial state: Fetched via RPC over WebSocket on session select
 * - Updates: Real-time via state channel subscriptions
 * - Pagination: Loaded via RPC over WebSocket
 * - Single subscription source (replaces StateChannel + useSessionSubscriptions)
 * - Promise-chain lock for atomic session switching
 * - 2 subscriptions per session (state.session + state.sdkMessages.delta)
 * - 6 operations per switch (reduced from 50+)
 *
 * Signals (reactive state):
 * - activeSessionId: Current session ID
 * - sessionState: Unified session state (sessionInfo, agentState, commandsData, contextInfo, error)
 * - sdkMessages: SDK message array
 *
 * Computed accessors (derived state):
 * - sessionInfo, agentState, contextInfo, commandsData, error, isCompacting, isWorking
 */

import { signal, computed } from '@preact/signals';
import type { Session, ContextInfo, AgentProcessingState, SessionState } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { connectionManager } from './connection-manager';
import { slashCommandsSignal } from './signals';
import { toast } from './toast';
import type { StructuredError } from '../types/error';

class SessionStore {
	// ========================================
	// Core Signals
	// ========================================

	/** Current active session ID */
	readonly activeSessionId = signal<string | null>(null);

	/** Unified session state from state.session channel */
	readonly sessionState = signal<SessionState | null>(null);

	/** SDK messages from state.sdkMessages channel */
	readonly sdkMessages = signal<SDKMessage[]>([]);

	// ========================================
	// Computed Accessors
	// ========================================

	/** Session info (metadata) */
	readonly sessionInfo = computed<Session | null>(
		() => this.sessionState.value?.sessionInfo || null
	);

	/** Agent processing state */
	readonly agentState = computed<AgentProcessingState>(
		() => this.sessionState.value?.agentState || { status: 'idle' }
	);

	/** Context info (token usage) */
	readonly contextInfo = computed<ContextInfo | null>(
		() => this.sessionState.value?.contextInfo || null
	);

	/** Available slash commands */
	readonly commandsData = computed<string[]>(
		() => this.sessionState.value?.commandsData?.availableCommands || []
	);

	/** Session error state */
	readonly error = computed<{
		message: string;
		details?: unknown;
		occurredAt: number;
	} | null>(() => this.sessionState.value?.error || null);

	/** Is currently compacting context */
	readonly isCompacting = computed<boolean>(() => {
		const state = this.agentState.value;
		return state.status === 'processing' && 'isCompacting' in state && state.isCompacting === true;
	});

	/** Is agent currently working (processing or queued) */
	readonly isWorking = computed<boolean>(() => {
		const state = this.agentState.value;
		return state.status === 'processing' || state.status === 'queued';
	});

	// ========================================
	// Private State
	// ========================================

	/** Promise-chain lock for atomic session switching */
	private selectPromise: Promise<void> = Promise.resolve();

	/** Subscription cleanup functions */
	private cleanupFunctions: Array<() => void> = [];

	/** Track the session switch time to avoid showing stale errors */
	private sessionSwitchTime: number = 0;

	// ========================================
	// Session Selection (with Promise-Chain Lock)
	// ========================================

	/**
	 * Select a session with atomic subscription management
	 *
	 * Uses promise-chain locking to prevent race conditions:
	 * - Each select() waits for previous select() to complete
	 * - Unsubscribe → Update state → Subscribe happens atomically
	 * - Reduces subscription operations from 50+ to 6 per switch
	 */
	select(sessionId: string | null): Promise<void> {
		// Chain the new selection onto the previous one
		this.selectPromise = this.selectPromise.then(() => this.doSelect(sessionId));
		return this.selectPromise;
	}

	/**
	 * Internal selection logic (called within promise chain)
	 */
	private async doSelect(sessionId: string | null): Promise<void> {
		// Skip if already on this session
		if (this.activeSessionId.value === sessionId) {
			return;
		}

		// 1. Stop current subscriptions
		await this.stopSubscriptions();

		// 2. Clear state
		this.sessionState.value = null;
		this.sdkMessages.value = [];
		// Record session switch time to only show errors that occur AFTER this point
		// This prevents showing stale errors that were already in the session state
		this.sessionSwitchTime = Date.now();

		// 3. Update active session
		this.activeSessionId.value = sessionId;

		// 4. Start new subscriptions if session selected
		if (sessionId) {
			await this.startSubscriptions(sessionId);
		}
	}

	// ========================================
	// Subscription Management
	// ========================================

	/**
	 * Start subscriptions for a session
	 * Only 3 subscriptions: state.session, state.sdkMessages, state.sdkMessages.delta
	 *
	 * NOTE: sdk.message subscription removed - the SDK's query() with AsyncGenerator
	 * yields complete messages, not stream_event tokens. Messages arrive via
	 * state.sdkMessages and state.sdkMessages.delta channels.
	 *
	 * ARCHITECTURE: Pure WebSocket
	 * - Subscriptions set up handlers for future events
	 * - Initial state fetched via RPC calls (over same WebSocket)
	 * - No REST API calls needed
	 */
	private async startSubscriptions(sessionId: string): Promise<void> {
		try {
			const hub = await connectionManager.getHub();

			// 1. Session state subscription (unified: metadata + agent + commands + context + error)
			const unsubSessionState = hub.subscribeOptimistic<SessionState>(
				'state.session',
				(state) => {
					this.sessionState.value = state;

					// Sync slash commands signal (for autocomplete)
					if (state.commandsData?.availableCommands) {
						slashCommandsSignal.value = state.commandsData.availableCommands;
					}

					// Handle error (show toast only for NEW errors that occurred after session was opened)
					// Prevents showing stale errors from previous sessions or from before session switch
					if (state.error && state.error.occurredAt > this.sessionSwitchTime) {
						toast.error(state.error.message);
					}
				},
				{ sessionId }
			);
			this.cleanupFunctions.push(unsubSessionState);

			// 2. SDK messages delta (for incremental updates)
			// Set up BEFORE fetching initial state to avoid race conditions
			// FIX: Add deduplication to prevent double messages after Safari reconnection
			// This can happen when events are queued during reconnection and replayed,
			// while the server also resends them after subscription re-establishment.
			const unsubSDKMessagesDelta = hub.subscribeOptimistic<{
				added?: SDKMessage[];
			}>(
				'state.sdkMessages.delta',
				(delta) => {
					if (delta.added?.length) {
						// Deduplicate: only add messages not already in the list
						// Use `uuid` which is common to all SDKMessage types
						const existingIds = new Set(this.sdkMessages.value.map((m) => m.uuid));
						const newMessages = delta.added.filter((m) => !existingIds.has(m.uuid));
						if (newMessages.length > 0) {
							this.sdkMessages.value = [...this.sdkMessages.value, ...newMessages];
						}
					}
				},
				{ sessionId }
			);
			this.cleanupFunctions.push(unsubSDKMessagesDelta);

			// 3. Fetch initial state via RPC (pure WebSocket - no REST API)
			// This replaces the old REST API calls and state.sdkMessages subscription
			await this.fetchInitialState(hub, sessionId);
		} catch (err) {
			console.error('[SessionStore] Failed to start subscriptions:', err);
			toast.error('Failed to connect to daemon');
		}
	}

	/**
	 * Fetch initial state via RPC calls (pure WebSocket)
	 * Replaces REST API calls for session data and messages
	 */
	private async fetchInitialState(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		sessionId: string
	): Promise<void> {
		try {
			// Fetch session state and messages in parallel
			const [sessionState, messagesState] = await Promise.all([
				hub.call<SessionState>('state.session', { sessionId }),
				hub.call<{ sdkMessages: SDKMessage[] }>('state.sdkMessages', {
					sessionId,
				}),
			]);

			// Update signals with initial state
			if (sessionState) {
				this.sessionState.value = sessionState;
				if (sessionState.commandsData?.availableCommands) {
					slashCommandsSignal.value = sessionState.commandsData.availableCommands;
				}
			}

			if (messagesState?.sdkMessages) {
				// CRITICAL FIX: Merge instead of replace to preserve newer messages
				// that arrived via delta subscription during reconnection
				//
				// Root cause: When client reconnects, delta subscription becomes active
				// immediately (subscribeOptimistic), and fetchInitialState runs in parallel.
				// If newer messages arrive via delta BEFORE fetchInitialState completes,
				// a simple replace would lose those newer messages.
				//
				// Solution: Use the server's timestamp as the synchronization point.
				// Keep any existing messages that are newer than the server's snapshot,
				// then merge and deduplicate by UUID.

				const snapshotTimestamp = (messagesState as unknown as { timestamp?: number }).timestamp;
				const currentMessages = this.sdkMessages.value;

				if (snapshotTimestamp && currentMessages.length > 0) {
					// Preserve newer messages that arrived via delta during reconnection
					// Messages from DB have timestamp added, so we filter by it
					const newerMessages = currentMessages.filter(
						(m) => ((m as unknown as { timestamp?: number }).timestamp || 0) >= snapshotTimestamp
					);

					if (newerMessages.length > 0) {
						// Merge: server snapshot + newer delta messages
						const messageMap = new Map<string, SDKMessage>();

						// Add snapshot messages
						for (const msg of messagesState.sdkMessages) {
							if (msg.uuid) {
								messageMap.set(msg.uuid, msg);
							}
						}

						// Newer messages override (they're more recent)
						for (const msg of newerMessages) {
							if (msg.uuid) {
								messageMap.set(msg.uuid, msg);
							}
						}

						// Convert back to array, sorted by timestamp
						// Messages from DB have timestamp added, so we can sort by it
						this.sdkMessages.value = Array.from(messageMap.values()).sort(
							(a, b) =>
								((a as unknown as { timestamp?: number }).timestamp || 0) -
								((b as unknown as { timestamp?: number }).timestamp || 0)
						);
					} else {
						// No newer messages, use snapshot directly
						this.sdkMessages.value = messagesState.sdkMessages;
					}
				} else {
					// No timestamp in response or first load, use snapshot directly
					this.sdkMessages.value = messagesState.sdkMessages;
				}
			}
		} catch (err) {
			console.error('[SessionStore] Failed to fetch initial state:', err);
			// Don't show toast here - subscriptions are still active and will receive updates
		}
	}

	/**
	 * Stop all current subscriptions
	 */
	private async stopSubscriptions(): Promise<void> {
		// Call all cleanup functions
		for (const cleanup of this.cleanupFunctions) {
			try {
				cleanup();
			} catch (err) {
				console.warn('[SessionStore] Cleanup error:', err);
			}
		}
		this.cleanupFunctions = [];
	}

	// ========================================
	// Refresh (for reconnection)
	// ========================================

	/**
	 * Refresh current session state from server
	 * FIX: Called after reconnection to sync agent state, context, etc.
	 *
	 * This ensures the status bar shows the correct agent state (Thinking, Streaming)
	 * instead of staying at "Online" after Safari background tab resume.
	 */
	async refresh(): Promise<void> {
		const sessionId = this.activeSessionId.value;
		if (!sessionId) {
			console.log('[SessionStore] No active session to refresh');
			return;
		}

		try {
			const hub = await connectionManager.getHub();
			await this.fetchInitialState(hub, sessionId);
			console.log('[SessionStore] State refreshed after reconnection');
		} catch (err) {
			console.error('[SessionStore] Failed to refresh state:', err);
			// Don't throw - subscriptions will still receive updates
		}
	}

	// ========================================
	// Error Handling
	// ========================================

	/**
	 * Clear current error
	 */
	clearError(): void {
		if (this.sessionState.value?.error) {
			this.sessionState.value = {
				...this.sessionState.value,
				error: null,
			};
		}
	}

	/**
	 * Get structured error details for error dialog
	 */
	getErrorDetails(): StructuredError | null {
		const error = this.error.value;
		if (!error?.details) return null;
		return error.details as StructuredError;
	}

	// ========================================
	// Message Management
	// ========================================

	/**
	 * Prepend older messages (for pagination)
	 * Used when loading older messages via RPC
	 */
	prependMessages(messages: SDKMessage[]): void {
		if (messages.length === 0) return;
		this.sdkMessages.value = [...messages, ...this.sdkMessages.value];
	}

	/**
	 * Get current message count (local)
	 */
	get messageCount(): number {
		return this.sdkMessages.value.length;
	}

	/**
	 * Get total message count from server via RPC
	 * Used for pagination to determine if more messages exist
	 */
	async getTotalMessageCount(): Promise<number> {
		const sessionId = this.activeSessionId.value;
		if (!sessionId) return 0;

		try {
			const hub = await connectionManager.getHub();
			const result = await hub.call<{ count: number }>('message.count', {
				sessionId,
			});
			return result?.count ?? 0;
		} catch (err) {
			console.error('[SessionStore] Failed to get message count:', err);
			return 0;
		}
	}

	/**
	 * Load older messages for pagination via RPC
	 * Returns the messages and whether more exist
	 */
	async loadOlderMessages(
		beforeTimestamp: number,
		limit = 100
	): Promise<{ messages: SDKMessage[]; hasMore: boolean }> {
		const sessionId = this.activeSessionId.value;
		if (!sessionId) return { messages: [], hasMore: false };

		try {
			const hub = await connectionManager.getHub();
			const result = await hub.call<{ sdkMessages: SDKMessage[] }>('message.sdkMessages', {
				sessionId,
				before: beforeTimestamp,
				limit,
			});

			const messages = result?.sdkMessages ?? [];
			return {
				messages,
				hasMore: messages.length === limit,
			};
		} catch (err) {
			console.error('[SessionStore] Failed to load older messages:', err);
			throw err;
		}
	}
}

/** Singleton session store instance */
export const sessionStore = new SessionStore();
