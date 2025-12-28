/**
 * QueryLifecycleManager - Manages SDK query lifecycle operations
 *
 * Extracted from AgentSession to consolidate query restart/reset logic.
 * Handles:
 * - Stopping message queue
 * - Interrupting current query
 * - Waiting for query termination
 * - Clearing query state
 * - Starting fresh query
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { MessageQueue } from './message-queue';
import { Logger } from '../logger';

const DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
const RESET_TERMINATION_TIMEOUT_MS = 3000;

export class QueryLifecycleManager {
	private logger: Logger;

	constructor(
		private sessionId: string,
		private messageQueue: MessageQueue,
		private getQueryObject: () => Query | null,
		private setQueryObject: (q: Query | null) => void,
		private getQueryPromise: () => Promise<void> | null,
		private setQueryPromise: (p: Promise<void> | null) => void,
		private startStreamingQuery: () => Promise<void>
	) {
		this.logger = new Logger(`QueryLifecycleManager ${sessionId}`);
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

		// 1. Stop the message queue (no new messages processed)
		this.messageQueue.stop();
		this.logger.log('Message queue stopped');

		// 2. Interrupt current query
		const queryObject = this.getQueryObject();
		if (queryObject && typeof queryObject.interrupt === 'function') {
			try {
				await queryObject.interrupt();
				this.logger.log('Query interrupted successfully');
			} catch (error) {
				this.logger.warn('Query interrupt failed:', error);
				// Continue - query might already be stopped
			}
		}

		// 3. Wait for termination
		const queryPromise = this.getQueryPromise();
		if (queryPromise) {
			try {
				const promiseToAwait = catchQueryErrors
					? queryPromise.catch((e) => {
							this.logger.warn('Query promise rejected during cleanup:', e);
						})
					: queryPromise;

				await Promise.race([
					promiseToAwait,
					new Promise((resolve) => setTimeout(resolve, timeoutMs)),
				]);
				this.logger.log('Previous query terminated');
			} catch (error) {
				this.logger.warn('Error waiting for query termination:', error);
			}
		}

		// 4. Clear references
		this.setQueryObject(null);
		this.setQueryPromise(null);
	}

	/**
	 * Restart the query (stop + start)
	 *
	 * Used when MCP settings change and SDK needs to reload settings.local.json
	 */
	async restart(): Promise<void> {
		this.logger.log('Executing query restart...');

		try {
			await this.stop();
			await this.startStreamingQuery();
			this.logger.log('Query restarted successfully with fresh settings');
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error('Failed to restart query:', error);
			throw new Error(`Query restart failed: ${errorMessage}`);
		}
	}

	/**
	 * Full reset with additional cleanup
	 *
	 * Used for user-initiated "Reset Agent" that needs to:
	 * - Clear pending messages
	 * - Reset circuit breaker
	 * - Notify clients
	 *
	 * @returns Result indicating success or failure
	 */
	async reset(options?: {
		restartAfter?: boolean;
		onBeforeStop?: () => Promise<void>;
		onAfterStop?: () => Promise<void>;
		onAfterRestart?: () => Promise<void>;
	}): Promise<{ success: boolean; error?: string }> {
		const { restartAfter = true, onBeforeStop, onAfterStop, onAfterRestart } = options ?? {};

		try {
			// Execute pre-stop cleanup (e.g., clear pending messages, reset flags)
			if (onBeforeStop) {
				await onBeforeStop();
			}

			// Stop the query with shorter timeout and catch errors
			await this.stop({
				timeoutMs: RESET_TERMINATION_TIMEOUT_MS,
				catchQueryErrors: true,
			});

			// Execute post-stop actions (e.g., reset state to idle)
			if (onAfterStop) {
				await onAfterStop();
			}

			// Optionally restart
			if (restartAfter) {
				this.logger.log('Starting fresh query...');
				// Small delay to ensure process cleanup completes
				await new Promise((resolve) => setTimeout(resolve, 100));
				await this.startStreamingQuery();
				this.logger.log('Fresh query started successfully');
			}

			// Execute post-restart actions (e.g., notify clients)
			if (onAfterRestart) {
				await onAfterRestart();
			}

			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error('Query reset failed:', error);
			return { success: false, error: errorMessage };
		}
	}
}
