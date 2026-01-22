/**
 * EventSubscriptionSetup - Sets up DaemonHub event subscriptions
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Model switch request subscription
 * - Interrupt request subscription
 * - Reset request subscription
 * - Message persisted subscription
 * - Query trigger subscription
 * - Send queued on turn end subscription
 */

import type { DaemonHub } from '../daemon-hub';
import { Logger } from '../logger';

/**
 * Event handlers that will be called when events occur
 */
export interface EventHandlers {
	onModelSwitchRequest: (
		model: string
	) => Promise<{ success: boolean; model: string; error?: string }>;
	onInterruptRequest: () => Promise<void>;
	onResetRequest: (restartQuery: boolean) => Promise<{ success: boolean; error?: string }>;
	onMessagePersisted: (messageId: string, messageContent: unknown) => Promise<void>;
	onQueryTrigger: () => Promise<{ success: boolean; messageCount: number; error?: string }>;
	onSendQueuedOnTurnEnd: () => Promise<void>;
}

/**
 * Sets up DaemonHub event subscriptions for AgentSession
 */
export class EventSubscriptionSetup {
	private sessionId: string;
	private daemonHub: DaemonHub;
	private logger: Logger;
	private unsubscribers: Array<() => void> = [];

	constructor(sessionId: string, daemonHub: DaemonHub, logger: Logger) {
		this.sessionId = sessionId;
		this.daemonHub = daemonHub;
		this.logger = logger;
	}

	/**
	 * Setup all event subscriptions
	 */
	setup(handlers: EventHandlers): void {
		const { sessionId, daemonHub, logger } = this;

		// Model switch request handler
		const unsubModelSwitch = daemonHub.on(
			'model.switchRequest',
			async ({ sessionId: sid, model }) => {
				logger.log(`Received model.switchRequest for model: ${model}`);
				const result = await handlers.onModelSwitchRequest(model);

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
				logger.log('Received agent.interruptRequest');
				await handlers.onInterruptRequest();
				await daemonHub.emit('agent.interrupted', { sessionId: sid });
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubInterrupt);

		// Reset query request handler
		const unsubReset = daemonHub.on(
			'agent.resetRequest',
			async ({ sessionId: sid, restartQuery }) => {
				logger.log(`Received agent.resetRequest (restartQuery: ${restartQuery})`);
				const result = await handlers.onResetRequest(restartQuery ?? true);

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
				logger.log(`Received message.persisted event (messageId: ${data.messageId})`);
				await handlers.onMessagePersisted(data.messageId, data.messageContent);
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubMessagePersisted);

		// Query trigger handler (Manual mode)
		const unsubQueryTrigger = daemonHub.on(
			'query.trigger',
			async () => {
				logger.log('Received query.trigger event');
				await handlers.onQueryTrigger();
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubQueryTrigger);

		// Send queued messages on turn end (Auto-queue mode)
		const unsubSendQueuedOnTurnEnd = daemonHub.on(
			'query.sendQueuedOnTurnEnd',
			async () => {
				logger.log('Received query.sendQueuedOnTurnEnd event');
				await handlers.onSendQueuedOnTurnEnd();
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubSendQueuedOnTurnEnd);

		logger.log('DaemonHub subscriptions initialized with session filtering');
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
