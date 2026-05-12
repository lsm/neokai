/**
 * EventSubscriptionSetup - Sets up event subscriptions for AgentSession
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
 * - Send enqueued-on-turn-end subscription
 */

import type { Session, MessageContent } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Logger } from '../logger';
import { Logger as LoggerClass } from '../logger';
import type { ModelSwitchHandler } from './model-switch-handler';
import type { InterruptHandler } from './interrupt-handler';
import type { QueryModeHandler } from './query-mode-handler';

/**
 * Context interface - what EventSubscriptionSetup needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface EventSubscriptionSetupContext {
	readonly session: Session;
	readonly daemonHub: DaemonHub;
	readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;

	// Handler references for event delegation
	readonly modelSwitchHandler: ModelSwitchHandler;
	readonly interruptHandler: InterruptHandler;
	readonly queryModeHandler: QueryModeHandler;

	// Methods for event handling
	resetQuery(options?: {
		restartQuery?: boolean;
		hardReset?: boolean;
	}): Promise<{ success: boolean; error?: string }>;
	startQueryAndEnqueue(messageId: string, messageContent: string | MessageContent[]): Promise<void>;
}

/**
 * Sets up event subscriptions for AgentSession.
 *
 * Subscriptions are split between DaemonHub (for events whose publishers have
 * not yet been migrated) and InternalEventBus (for migrated events).
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
			internalEventBus,
			modelSwitchHandler,
			interruptHandler,
			queryModeHandler,
		} = this.ctx;
		const sessionId = session.id;

		// Model switch request handler — publisher not yet migrated, stays on DaemonHub
		const unsubModelSwitch = daemonHub.on(
			'model.switchRequest',
			async ({ sessionId: sid, model, provider }) => {
				if (!provider) {
					throw new Error('model.switchRequest event is missing required field: provider');
				}
				const result = await modelSwitchHandler.switchModel(model, provider);

				// Emit result via InternalEventBus
				await internalEventBus.publish('model.switched', {
					namespaceId: sid,
					sessionId: sid,
					success: result.success,
					model: result.model,
					error: result.error,
				});
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubModelSwitch);

		// Interrupt request handler — publisher not yet migrated, stays on DaemonHub
		const unsubInterrupt = daemonHub.on(
			'agent.interruptRequest',
			async ({ sessionId: sid }) => {
				await interruptHandler.handleInterrupt();
				await internalEventBus.publish('agent.interrupted', {
					namespaceId: 'global',
					sessionId: sid,
				});
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubInterrupt);

		// Reset query request handler — publisher not yet migrated, stays on DaemonHub
		const unsubReset = daemonHub.on(
			'agent.resetRequest',
			async ({ sessionId: sid, restartQuery }) => {
				const result = await this.ctx.resetQuery({
					restartQuery: restartQuery ?? true,
					hardReset: true,
				});

				await internalEventBus.publish('agent.reset', {
					namespaceId: sid,
					sessionId: sid,
					success: result.success,
					error: result.error,
				});
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubReset);

		// Message persisted handler — published via InternalEventBus
		const unsubMessagePersisted = internalEventBus.subscribe(
			'message.persisted',
			async (data) => {
				if (data.skipQueryStart) return;
				// Start query and enqueue message
				// Note: User messages in the DB serve as rewind points - no separate checkpoint tracking needed
				await this.ctx.startQueryAndEnqueue(
					data.messageId,
					data.messageContent as string | MessageContent[]
				);
			},
			{
				subscriberName: `EventSubscriptionSetup.messagePersisted.${sessionId}`,
				namespaceId: sessionId,
			}
		);
		this.unsubscribers.push(unsubMessagePersisted);

		// Query trigger handler (Manual mode) — published via InternalEventBus
		const unsubQueryTrigger = internalEventBus.subscribe(
			'query.trigger',
			async () => {
				await queryModeHandler.handleQueryTrigger();
			},
			{ subscriberName: `EventSubscriptionSetup.queryTrigger.${sessionId}`, namespaceId: sessionId }
		);
		this.unsubscribers.push(unsubQueryTrigger);

		// Send enqueued messages on turn end (auto-defer mode) — publisher not yet migrated
		const unsubSendEnqueuedOnTurnEnd = daemonHub.on(
			'query.sendEnqueuedOnTurnEnd',
			async () => {
				await queryModeHandler.sendEnqueuedMessagesOnTurnEnd();
			},
			{ sessionId }
		);
		this.unsubscribers.push(unsubSendEnqueuedOnTurnEnd);
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
