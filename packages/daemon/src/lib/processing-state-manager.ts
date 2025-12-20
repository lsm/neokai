/**
 * ProcessingStateManager - Agent processing state machine
 *
 * Manages the state transitions:
 * idle → queued → processing (phases: initializing/thinking/streaming/finalizing) → idle | interrupted
 *
 * Enhanced with streaming phase tracking for fine-grained progress updates.
 * Now persists state to database for recovery after restarts.
 */

import type { AgentProcessingState, EventBus } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { isSDKAssistantMessage, isToolUseBlock } from '@liuboer/shared/sdk/type-guards';
import type { Database } from '../storage/database';
import { Logger } from './logger';

type StreamingPhase = 'initializing' | 'thinking' | 'streaming' | 'finalizing';

export class ProcessingStateManager {
	private processingState: AgentProcessingState = { status: 'idle' };
	private streamingPhase: StreamingPhase = 'initializing';
	private streamingStartedAt: number | null = null;
	private logger: Logger;
	private onIdleCallback?: () => Promise<void>;

	constructor(
		private sessionId: string,
		private eventBus: EventBus,
		private db: Database
	) {
		this.logger = new Logger(`ProcessingStateManager ${sessionId}`);
	}

	/**
	 * Set callback to execute when state transitions to idle
	 * Used for deferred restarts and other idle-triggered actions
	 */
	setOnIdleCallback(callback: () => Promise<void>): void {
		this.onIdleCallback = callback;
	}

	/**
	 * Restore processing state from database
	 * Called on session initialization to recover state after restart
	 */
	restoreFromDatabase(): void {
		const session = this.db.getSession(this.sessionId);
		if (!session?.processingState) {
			this.logger.log('No persisted processing state found, starting with idle');
			return;
		}

		try {
			const restoredState = JSON.parse(session.processingState) as AgentProcessingState;

			// Only restore if state is not idle or interrupted
			// After restart, we should reset to idle for safety
			if (restoredState.status === 'processing' || restoredState.status === 'queued') {
				this.logger.log('Restored processing state from database:', restoredState);
				this.logger.log('Resetting to idle after restart for safety');
				this.processingState = { status: 'idle' };
			} else {
				this.processingState = restoredState;
				this.logger.log('Restored processing state from database:', restoredState);
			}
		} catch (error) {
			this.logger.warn('Failed to parse persisted processing state:', error);
			this.processingState = { status: 'idle' };
		}
	}

	/**
	 * Persist current processing state to database
	 * DB-first pattern: save to DB, then broadcast via EventBus
	 */
	private persistToDatabase(): void {
		try {
			const serialized = JSON.stringify(this.processingState);
			this.db.updateSession(this.sessionId, {
				processingState: serialized,
			});
		} catch (error) {
			this.logger.error('Failed to persist processing state to database:', error);
		}
	}

	/**
	 * Get current processing state
	 */
	getState(): AgentProcessingState {
		return this.processingState;
	}

	/**
	 * Check if currently processing
	 */
	isProcessing(): boolean {
		return this.processingState.status === 'processing';
	}

	/**
	 * Check if idle
	 */
	isIdle(): boolean {
		return this.processingState.status === 'idle';
	}

	/**
	 * Set state to idle
	 */
	async setIdle(): Promise<void> {
		await this.setState({ status: 'idle' });

		// Execute idle callback if set (e.g., for deferred restarts)
		if (this.onIdleCallback) {
			try {
				await this.onIdleCallback();
			} catch (error) {
				this.logger.error('Error in onIdle callback:', error);
				// Don't re-throw - callback errors shouldn't break state transitions
			}
		}
	}

	/**
	 * Set state to queued
	 */
	async setQueued(messageId: string): Promise<void> {
		await this.setState({ status: 'queued', messageId });
	}

	/**
	 * Set state to processing
	 */
	async setProcessing(messageId: string, phase: StreamingPhase = 'initializing'): Promise<void> {
		this.streamingPhase = phase;
		if (phase === 'streaming' && !this.streamingStartedAt) {
			this.streamingStartedAt = Date.now();
		}

		await this.setState({
			status: 'processing',
			messageId,
			phase: this.streamingPhase,
			streamingStartedAt: this.streamingStartedAt ?? undefined,
		});
	}

	/**
	 * Set state to interrupted
	 */
	async setInterrupted(): Promise<void> {
		await this.setState({ status: 'interrupted' });
	}

	/**
	 * Update the streaming phase (only valid during processing)
	 */
	async updatePhase(phase: StreamingPhase): Promise<void> {
		if (this.processingState.status !== 'processing') {
			this.logger.warn(`Cannot update phase to ${phase} - not in processing state`);
			return;
		}

		this.streamingPhase = phase;

		// Track when streaming actually started
		if (phase === 'streaming' && !this.streamingStartedAt) {
			this.streamingStartedAt = Date.now();
		}

		this.processingState = {
			status: 'processing',
			messageId: this.processingState.messageId,
			phase: this.streamingPhase,
			streamingStartedAt: this.streamingStartedAt ?? undefined,
		};

		// DB-first: Persist to database before broadcasting
		this.persistToDatabase();

		// Broadcast updated state via unified session:updated event
		await this.eventBus.emit('session:updated', {
			sessionId: this.sessionId,
			source: 'processing-state',
		});

		this.logger.log(`Streaming phase changed to: ${phase}`);
	}

	/**
	 * Auto-detect phase from SDK message type
	 * Called during SDK message processing to automatically update phase
	 */
	async detectPhaseFromMessage(message: SDKMessage): Promise<void> {
		if (this.processingState.status !== 'processing') {
			return; // Only detect during processing
		}

		if (message.type === 'stream_event') {
			// We're actively streaming content deltas
			if (this.streamingPhase !== 'streaming') {
				await this.updatePhase('streaming');
			}
		} else if (isSDKAssistantMessage(message)) {
			// Assistant message indicates thinking/tool use phase
			const hasToolUse = message.message.content.some(isToolUseBlock);

			if (hasToolUse && this.streamingPhase === 'initializing') {
				// Transition from initializing to thinking when we see tool use
				await this.updatePhase('thinking');
			} else if (
				!hasToolUse &&
				this.streamingPhase === 'initializing' &&
				message.message.content.some(
					(block: unknown) =>
						typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
				)
			) {
				// If we get a text response without tool use, we're likely about to stream
				await this.updatePhase('thinking');
			}
		} else if (message.type === 'result') {
			// Final result - move to finalizing phase briefly before idle
			if (this.streamingPhase !== 'finalizing') {
				await this.updatePhase('finalizing');
			}
		}
	}

	/**
	 * Internal state setter with event emission
	 * DB-first pattern: save to DB, then broadcast via EventBus
	 */
	private async setState(newState: AgentProcessingState): Promise<void> {
		// If transitioning to idle or interrupted, reset phase tracking
		if (newState.status === 'idle' || newState.status === 'interrupted') {
			this.streamingPhase = 'initializing';
			this.streamingStartedAt = null;
		}

		this.processingState = newState;

		// DB-first: Persist to database before broadcasting
		this.persistToDatabase();

		// Emit event via EventBus (StateManager will broadcast unified session state)
		await this.eventBus.emit('session:updated', {
			sessionId: this.sessionId,
			source: 'processing-state',
		});

		this.logger.log(`Agent state changed:`, newState);
	}
}
