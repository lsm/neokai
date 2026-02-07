/**
 * QueryLifecycleManager - Manages SDK query lifecycle operations
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Stopping message queue
 * - Interrupting current query
 * - Waiting for query termination
 * - Clearing query state
 * - Starting fresh query
 * - Full reset with cost tracking, state management, and client notification
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { MessageContent, Session, MessageHub } from '@neokai/shared';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { SDKMessageHandler } from './sdk-message-handler';
import type { InterruptHandler } from './interrupt-handler';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { ErrorManager } from '../error-manager';
import { ErrorCategory } from '../error-manager';
import { Logger } from '../logger';
import { validateAndRepairSDKSession } from '../sdk-session-file-manager';

const DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
const RESET_TERMINATION_TIMEOUT_MS = 3000;

/**
 * Context interface - what QueryLifecycleManager needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface QueryLifecycleManagerContext {
	readonly session: Session;
	readonly messageQueue: MessageQueue;
	readonly db: Database;
	readonly messageHub: MessageHub;
	readonly daemonHub: DaemonHub;
	readonly stateManager: ProcessingStateManager;
	readonly messageHandler: SDKMessageHandler;
	readonly interruptHandler: InterruptHandler;
	readonly errorManager: ErrorManager;

	// Mutable SDK query state
	queryObject: Query | null;
	queryPromise: Promise<void> | null;
	firstMessageReceived: boolean;

	// Mutable session state
	pendingRestartReason: 'settings.local.json' | null;

	// Method to start the streaming query
	startStreamingQuery(): Promise<void>;

	// Cleanup support
	setCleaningUp(value: boolean): void;
	cleanupEventSubscriptions(): void;
	clearModelsCache(): Promise<void>;
}

export class QueryLifecycleManager {
	private logger: Logger;

	constructor(private ctx: QueryLifecycleManagerContext) {
		this.logger = new Logger(`QueryLifecycleManager ${ctx.session.id}`);
	}

	/**
	 * Stop the current query
	 *
	 * Shared logic for restart and reset operations:
	 * 1. Stop message queue
	 * 2. Interrupt current query
	 * 3. Wait for termination (with timeout)
	 * 4. Clear query references
	 */
	async stop(options?: { timeoutMs?: number; catchQueryErrors?: boolean }): Promise<void> {
		const { timeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS, catchQueryErrors = false } = options ?? {};
		const { messageQueue } = this.ctx;

		// 1. Stop the message queue (no new messages processed)
		messageQueue.stop();

		// 2. Interrupt current query (only if transport is ready)
		// ProcessTransport must be ready before calling interrupt() - otherwise we get
		// "ProcessTransport is not ready for writing" error that corrupts session state
		const queryObject = this.ctx.queryObject;
		if (queryObject && typeof queryObject.interrupt === 'function') {
			if (this.ctx.firstMessageReceived) {
				try {
					await queryObject.interrupt();
				} catch {
					// Continue - query might already be stopped
				}
			}
			// Else: Transport not ready - skip interrupt, just clear references
		}

		// 3. Wait for termination
		const queryPromise = this.ctx.queryPromise;
		if (queryPromise) {
			try {
				const promiseToAwait = catchQueryErrors
					? queryPromise.catch(() => {
							// Ignore errors during cleanup
						})
					: queryPromise;

				await Promise.race([
					promiseToAwait,
					new Promise((resolve) => setTimeout(resolve, timeoutMs)),
				]);
			} catch {
				// Ignore errors during termination
			}
		}

		// 4. Clear references
		this.ctx.queryObject = null;
		this.ctx.queryPromise = null;
	}

	/**
	 * Restart the query (stop + start)
	 *
	 * Used when MCP settings change and SDK needs to reload settings.local.json
	 */
	async restart(): Promise<void> {
		try {
			await this.stop();
			await this.ctx.startStreamingQuery();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			throw new Error(`Query restart failed: ${errorMessage}`);
		}
	}

	/**
	 * Full reset with additional cleanup
	 *
	 * Used for user-initiated "Reset Agent" that needs to:
	 * - Clear pending messages
	 * - Reset circuit breaker
	 * - Preserve cost tracking
	 * - Notify clients
	 *
	 * @returns Result indicating success or failure
	 */
	async reset(options?: { restartAfter?: boolean }): Promise<{ success: boolean; error?: string }> {
		const { restartAfter = true } = options ?? {};
		const { session, db, messageQueue, messageHub, daemonHub, stateManager, messageHandler } =
			this.ctx;

		// Early return if no query is running
		if (!this.ctx.queryObject && !this.ctx.queryPromise) {
			messageQueue.clear();
			this.ctx.pendingRestartReason = null;
			messageHandler.resetCircuitBreaker();
			await stateManager.setIdle();
			return { success: true };
		}

		try {
			// Pre-stop: Preserve cost tracking
			const lastSdkCost = session.metadata?.lastSdkCost || 0;
			const costBaseline = session.metadata?.costBaseline || 0;
			if (lastSdkCost > 0) {
				session.metadata = {
					...session.metadata,
					costBaseline: costBaseline + lastSdkCost,
					lastSdkCost: 0,
				};
				db.updateSession(session.id, { metadata: session.metadata });
			}

			// Pre-stop: Clear pending messages and reset flags
			messageQueue.clear();
			this.ctx.pendingRestartReason = null;
			messageHandler.resetCircuitBreaker();
			await daemonHub.emit('session.errorClear', { sessionId: session.id });

			// Stop the query with shorter timeout and catch errors
			await this.stop({
				timeoutMs: RESET_TERMINATION_TIMEOUT_MS,
				catchQueryErrors: true,
			});

			// Post-stop: Reset state
			this.ctx.firstMessageReceived = false;
			await stateManager.setIdle();

			// Optionally restart
			if (restartAfter) {
				// Small delay to ensure process cleanup completes
				await new Promise((resolve) => setTimeout(resolve, 100));
				await this.ctx.startStreamingQuery();
			}

			// Post-restart: Notify clients
			await messageHub.publish(
				'session.reset',
				{ message: 'Agent has been reset and is ready for new messages' },
				{ sessionId: session.id }
			);

			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error('Query reset failed:', error);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Ensure query is started
	 *
	 * Waits for any pending interrupt, validates SDK session file,
	 * and starts the streaming query if not already running.
	 */
	async ensureQueryStarted(): Promise<void> {
		const { session, db, messageQueue, interruptHandler } = this.ctx;

		// Wait for any pending interrupt
		const interruptPromise = interruptHandler.getInterruptPromise();
		if (interruptPromise) {
			try {
				await Promise.race([interruptPromise, new Promise((r) => setTimeout(r, 5000))]);
			} catch {
				// Ignore interrupt errors
			}
		}

		if (messageQueue.isRunning()) {
			return;
		}

		// Validate SDK session file
		if (session.sdkSessionId) {
			validateAndRepairSDKSession(session.workspacePath, session.sdkSessionId, session.id, db);
		}

		await this.ctx.startStreamingQuery();
	}

	/**
	 * Start query and enqueue message
	 *
	 * Ensures query is started, sets queued state, and enqueues the message.
	 * Handles errors with automatic retry for timeout errors.
	 */
	async startQueryAndEnqueue(
		messageId: string,
		messageContent: string | MessageContent[]
	): Promise<void> {
		const { session, messageQueue, stateManager, errorManager, daemonHub } = this.ctx;

		await this.ensureQueryStarted();
		await stateManager.setQueued(messageId);

		messageQueue.enqueueWithId(messageId, messageContent).catch(async (error) => {
			if (error instanceof Error && error.message === 'Interrupted by user') {
				return;
			}

			const isTimeoutError = error instanceof Error && error.name === 'MessageQueueTimeoutError';
			await errorManager.handleError(
				session.id,
				error as Error,
				isTimeoutError ? ErrorCategory.TIMEOUT : ErrorCategory.MESSAGE,
				isTimeoutError
					? 'The SDK is not responding. Click "Reset Agent" to recover.'
					: 'Failed to process message. Please try again.',
				stateManager.getState(),
				{ messageId }
			);

			if (isTimeoutError) {
				try {
					await this.reset({ restartAfter: true });
					await stateManager.setQueued(messageId);
					messageQueue.enqueueWithId(messageId, messageContent).catch(async () => {
						await stateManager.setIdle();
					});
				} catch {
					await stateManager.setIdle();
				}
			} else {
				await stateManager.setIdle();
			}
		});

		daemonHub.emit('message.sent', { sessionId: session.id }).catch(() => {});
	}

	/**
	 * Restart query if not currently processing
	 *
	 * If currently processing, defers the restart until idle.
	 * Used when settings change and SDK needs to reload.
	 */
	async restartQuery(): Promise<void> {
		const { messageQueue, stateManager } = this.ctx;

		if (!messageQueue.isRunning() || !this.ctx.queryObject) {
			return;
		}

		const currentState = stateManager.getState();
		if (currentState.status === 'processing') {
			this.ctx.pendingRestartReason = 'settings.local.json';
			return;
		}

		await this.restart();
	}

	/**
	 * Execute deferred restart if one is pending
	 *
	 * Called when agent becomes idle to complete deferred restarts.
	 */
	async executeDeferredRestartIfPending(): Promise<void> {
		if (!this.ctx.pendingRestartReason) {
			return;
		}

		const _reason = this.ctx.pendingRestartReason;
		this.ctx.pendingRestartReason = null;

		try {
			await this.restart();
		} catch {
			// Log but don't throw - deferred restart is best-effort
		}
	}

	/**
	 * Full cleanup of the query lifecycle
	 *
	 * Stops event subscriptions, clears caches, and stops the query.
	 * Called when session is being destroyed.
	 */
	async cleanup(): Promise<void> {
		this.ctx.setCleaningUp(true);

		// Phase 1: Unsubscribe from events
		this.ctx.cleanupEventSubscriptions();

		// Phase 2: Clear models cache
		try {
			await this.ctx.clearModelsCache();
		} catch {}

		// Phase 3: Stop query
		try {
			await this.stop({ timeoutMs: 15000, catchQueryErrors: true });
			await new Promise((r) => setTimeout(r, 1000));
		} catch {
			// Ignore cleanup errors
		}
	}
}
