/**
 * EventSubscriptionSetup - Sets up DaemonHub event subscriptions
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Model switch request subscription
 * - Interrupt request subscription
 * - Reset request subscription
 * - Message persisted subscription
 * - Query trigger subscription
 * - Send queued on turn end subscription
 */

import type { Session, MessageContent } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Logger } from '../logger';
import { Logger as LoggerClass } from '../logger';
import type { ModelSwitchHandler } from './model-switch-handler';
import type { InterruptHandler } from './interrupt-handler';
import type { QueryModeHandler } from './query-mode-handler';
import type { CheckpointTracker } from './checkpoint-tracker';

/**
 * Context interface - what EventSubscriptionSetup needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface EventSubscriptionSetupContext {
	readonly session: Session;
	readonly daemonHub: DaemonHub;

	// Handler references for event delegation
	readonly modelSwitchHandler: ModelSwitchHandler;
	readonly interruptHandler: InterruptHandler;
	readonly queryModeHandler: QueryModeHandler;
	readonly checkpointTracker: CheckpointTracker;

	// Methods for event handling
	resetQuery(options?: { restartQuery?: boolean }): Promise<{ success: boolean; error?: string }>;
	startQueryAndEnqueue(messageId: string, messageContent: string | MessageContent[]): Promise<void>;
}

/**
 * Sets up DaemonHub event subscriptions for AgentSession
 */
export class EventSubscriptionSetup {
	private logger: Logger;
	private unsubscribers: Array<() => void> = [];

	constructor(private ctx: EventSubscriptionSetupContext) {
		this.logger = new LoggerClass(`EventSubscriptionSetup ${ctx.session.id}`);
	}

	/**
	 * Setup all event subscriptions
	 * Internally calls context methods for event handling
	 */
	setup(): void {
		const {
			session,
			daemonHub,
			modelSwitchHandler,
			interruptHandler,
			queryModeHandler,
			checkpointTracker,
		} = this.ctx;
		const sessionId = session.id;

		// Model switch request handler
		const unsubModelSwitch = daemonHub.on(
			'model.switchRequest',
			async ({ sessionId: sid, model }) => {
				this.logger.log(`Received model.switchRequest for model: ${model}`);
				const result = await modelSwitchHandler.switchModel(model);

				// Emit result
				await daemonHub.emit('model.switched', {
					sessionId: sid,
					success: result.success,
					model: result.model,
					error: result.error,
				});
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubModelSwitch);

		// Interrupt request handler
		const unsubInterrupt = daemonHub.on(
			'agent.interruptRequest',
			async ({ sessionId: sid }) => {
				this.logger.log('Received agent.interruptRequest');
				await interruptHandler.handleInterrupt();
				await daemonHub.emit('agent.interrupted', { sessionId: sid });
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubInterrupt);

		// Reset query request handler
		const unsubReset = daemonHub.on(
			'agent.resetRequest',
			async ({ sessionId: sid, restartQuery }) => {
				this.logger.log(`Received agent.resetRequest (restartQuery: ${restartQuery})`);
				const result = await this.ctx.resetQuery({ restartQuery: restartQuery ?? true });

				await daemonHub.emit('agent.reset', {
					sessionId: sid,
					success: result.success,
					error: result.error,
				});
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubReset);

		// Message persisted handler
		const unsubMessagePersisted = daemonHub.on(
			'message.persisted',
			async (data) => {
				this.logger.log(`Received message.persisted event (messageId: ${data.messageId})`);
				// Create checkpoint for the user message (enables rewind feature)
				checkpointTracker.createCheckpointFromUserMessage(
					data.messageId,
					data.messageContent as string
				);
				// Start query and enqueue message
				await this.ctx.startQueryAndEnqueue(
					data.messageId,
					data.messageContent as string | MessageContent[]
				);
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubMessagePersisted);

		// Query trigger handler (Manual mode)
		const unsubQueryTrigger = daemonHub.on(
			'query.trigger',
			async () => {
				this.logger.log('Received query.trigger event');
				await queryModeHandler.handleQueryTrigger();
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubQueryTrigger);

		// Send queued messages on turn end (Auto-queue mode)
		const unsubSendQueuedOnTurnEnd = daemonHub.on(
			'query.sendQueuedOnTurnEnd',
			async () => {
				this.logger.log('Received query.sendQueuedOnTurnEnd event');
				await queryModeHandler.sendQueuedMessagesOnTurnEnd();
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubSendQueuedOnTurnEnd);

		this.logger.log('DaemonHub subscriptions initialized with session filtering');
	}

	/**
	 * Cleanup all subscriptions
	 */
	cleanup(): void {
		for (const unsubscribe of this.unsubscribers) {
			try {
				unsubscribe();
			} catch (error) {
				this.logger.error('Error during unsubscribe:', error);
			}
		}
		this.unsubscribers = [];
	}
}
