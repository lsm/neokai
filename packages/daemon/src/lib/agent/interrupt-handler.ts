/**
 * InterruptHandler - Handles query interruption
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Interrupt state management
 * - Abort controller signaling
 * - SDK interrupt() integration
 * - Queue cleanup
 * - State transitions during interrupt
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { MessageHub } from '@liuboer/shared';
import { Logger } from '../logger';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';

/**
 * Dependencies required for InterruptHandler
 */
export interface InterruptHandlerDependencies {
	sessionId: string;
	messageHub: MessageHub;
	messageQueue: MessageQueue;
	stateManager: ProcessingStateManager;
	logger: Logger;

	// State accessors
	getQueryObject: () => Query | null;
	setQueryObject: (q: Query | null) => void;
	getQueryPromise: () => Promise<void> | null;
	getQueryAbortController: () => AbortController | null;
	setQueryAbortController: (c: AbortController | null) => void;
}

/**
 * Handles interrupt operations for AgentSession
 */
export class InterruptHandler {
	private deps: InterruptHandlerDependencies;

	// Interrupt completion tracking
	private interruptPromise: Promise<void> | null = null;
	private interruptResolve: (() => void) | null = null;

	constructor(deps: InterruptHandlerDependencies) {
		this.deps = deps;
	}

	/**
	 * Get the current interrupt promise (for waiting in ensureQueryStarted)
	 */
	getInterruptPromise(): Promise<void> | null {
		return this.interruptPromise;
	}

	/**
	 * Handle interrupt request
	 * Uses official SDK interrupt() method
	 */
	async handleInterrupt(): Promise<void> {
		const { sessionId, messageHub, messageQueue, stateManager, logger } = this.deps;

		const currentState = stateManager.getState();
		logger.log(`Handling interrupt (current state: ${currentState.status})...`);

		// Edge case: already idle or interrupted
		if (currentState.status === 'idle' || currentState.status === 'interrupted') {
			logger.log(`Already ${currentState.status}, skipping interrupt`);
			return;
		}

		// Create interrupt completion promise
		const interruptCompletePromise = new Promise<void>((resolve) => {
			this.interruptResolve = resolve;
		});
		this.interruptPromise = interruptCompletePromise;

		try {
			// Set state to 'interrupted' immediately
			await stateManager.setInterrupted();

			// Clear pending messages in queue
			const queueSize = messageQueue.size();
			if (queueSize > 0) {
				logger.log(`Clearing ${queueSize} queued messages`);
				messageQueue.clear();
			}

			// STEP 1: Abort the query to break the for-await loop
			const abortController = this.deps.getQueryAbortController();
			if (abortController) {
				logger.log('Aborting query controller to break for-await loop...');
				abortController.abort();
				this.deps.setQueryAbortController(null);
			}

			// STEP 2: Call SDK interrupt()
			const queryObject = this.deps.getQueryObject();
			if (queryObject && typeof queryObject.interrupt === 'function') {
				try {
					logger.log('Calling SDK interrupt()...');
					await queryObject.interrupt();
					logger.log('SDK interrupt() completed successfully');
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					logger.warn('SDK interrupt() failed (may be expected):', errorMessage);
				}
			} else {
				logger.log('No query object, interrupt complete (queue cleared)');
			}

			// STEP 3: Wait for old query to finish
			const queryPromise = this.deps.getQueryPromise();
			if (queryPromise) {
				logger.log('Waiting for old query to finish...');
				try {
					await Promise.race([queryPromise, new Promise((resolve) => setTimeout(resolve, 200))]);
					logger.log('Old query finished or timeout reached');
				} catch (error) {
					logger.warn('Error waiting for old query:', error);
				}
			}

			// STEP 4: Clear queryObject
			this.deps.setQueryObject(null);
			logger.log('Cleared queryObject reference');

			// STEP 5: Stop the message queue
			messageQueue.stop();
			logger.log('Stopped message queue to allow immediate query restart');

			// Publish interrupt event
			await messageHub.publish('session.interrupted', {}, { sessionId });

			// Set state back to idle
			await stateManager.setIdle();
			logger.log('Interrupt complete, state reset to idle');
		} finally {
			// Always resolve the interrupt promise
			if (this.interruptResolve) {
				this.interruptResolve();
				this.interruptResolve = null;
			}
			this.interruptPromise = null;
			logger.log('Interrupt promise resolved');
		}
	}
}
