/**
 * SessionStore - Unified session state management with single subscription source
 *
 * ARCHITECTURE: Fixes subscription storm by consolidating all session subscriptions
 * into a single store with promise-chain locking for atomic session switches.
 *
 * Key features:
 * - Single subscription source (replaces StateChannel + useSessionSubscriptions)
 * - Promise-chain lock for atomic session switching
 * - 4 subscriptions per session (reduced from 7)
 * - 8 operations per switch (reduced from 50+)
 *
 * Signals (reactive state):
 * - activeSessionId: Current session ID
 * - sessionState: Unified session state (sessionInfo, agentState, commandsData, contextInfo, error)
 * - sdkMessages: SDK message array
 * - streamingEvents: Current streaming events (cleared on completion)
 *
 * Computed accessors (derived state):
 * - sessionInfo, agentState, contextInfo, commandsData, error, isCompacting, isWorking
 */

import { signal, computed } from '@preact/signals';
import type { Session, ContextInfo, AgentProcessingState, SessionState } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { isSDKStreamEvent } from '@liuboer/shared/sdk/type-guards';
import { connectionManager } from './connection-manager';
import { slashCommandsSignal } from './signals';
import { toast } from './toast';
import type { StructuredError } from '../types/error';

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>;

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

	/** Streaming events accumulator (cleared when stream completes) */
	readonly streamingEvents = signal<StreamEvent[]>([]);

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
	readonly error = computed<{ message: string; details?: unknown; occurredAt: number } | null>(
		() => this.sessionState.value?.error || null
	);

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

	/** Seen message UUIDs for deduplication */
	private seenMessageUuids = new Set<string>();

	// ========================================
	// Session Selection (with Promise-Chain Lock)
	// ========================================

	/**
	 * Select a session with atomic subscription management
	 *
	 * Uses promise-chain locking to prevent race conditions:
	 * - Each select() waits for previous select() to complete
	 * - Unsubscribe → Update state → Subscribe happens atomically
	 * - Reduces subscription operations from 50+ to 8 per switch
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
		this.streamingEvents.value = [];
		this.seenMessageUuids.clear();

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
	 * Only 4 subscriptions: sdk.message, state.session, state.sdkMessages, state.sdkMessages.delta
	 */
	private async startSubscriptions(sessionId: string): Promise<void> {
		try {
			const hub = await connectionManager.getHub();

			// 1. SDK message subscription (for streaming and real-time updates)
			const unsubSDKMessage = hub.subscribeOptimistic<SDKMessage>(
				'sdk.message',
				(message) => {
					// Handle stream events
					if (isSDKStreamEvent(message)) {
						this.streamingEvents.value = [...this.streamingEvents.value, message];
					} else {
						// Clear streaming on result
						if (message.type === 'result' && message.subtype === 'success') {
							this.streamingEvents.value = [];
						}

						// Deduplicate and store non-stream messages
						if (message.uuid && !this.seenMessageUuids.has(message.uuid)) {
							this.seenMessageUuids.add(message.uuid);
						}
					}
				},
				{ sessionId }
			);
			this.cleanupFunctions.push(unsubSDKMessage);

			// 2. Session state subscription (unified: metadata + agent + commands + context + error)
			const unsubSessionState = hub.subscribeOptimistic<SessionState>(
				'state.session',
				(state) => {
					this.sessionState.value = state;

					// Sync slash commands signal (for autocomplete)
					if (state.commandsData?.availableCommands) {
						slashCommandsSignal.value = state.commandsData.availableCommands;
					}

					// Handle error (show toast)
					if (state.error) {
						toast.error(state.error.message);
					}
				},
				{ sessionId }
			);
			this.cleanupFunctions.push(unsubSessionState);

			// 3. SDK messages full state
			const unsubSDKMessages = hub.subscribeOptimistic<{ sdkMessages: SDKMessage[] }>(
				'state.sdkMessages',
				(state) => {
					this.sdkMessages.value = state.sdkMessages || [];
				},
				{ sessionId }
			);
			this.cleanupFunctions.push(unsubSDKMessages);

			// 4. SDK messages delta (for incremental updates)
			const unsubSDKMessagesDelta = hub.subscribeOptimistic<{ added?: SDKMessage[] }>(
				'state.sdkMessages.delta',
				(delta) => {
					if (delta.added?.length) {
						this.sdkMessages.value = [...this.sdkMessages.value, ...delta.added];
					}
				},
				{ sessionId }
			);
			this.cleanupFunctions.push(unsubSDKMessagesDelta);
		} catch (err) {
			console.error('[SessionStore] Failed to start subscriptions:', err);
			toast.error('Failed to connect to daemon');
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
}

/** Singleton session store instance */
export const sessionStore = new SessionStore();
