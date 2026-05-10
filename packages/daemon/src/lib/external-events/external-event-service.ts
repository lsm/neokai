/**
 * ExternalEventService — source-agnostic external event publishing.
 *
 * Implements `ExternalEventPublisher`:
 *   - Validates source/topic contracts via `ExternalEventStore`.
 *   - Stores/dedupes via `ExternalEventStore`.
 *   - Publishes `externalEvent.published` on `InternalEventBus` with a space-scoped
 *     channel/payload.
 *
 * No task resolution happens in this service — the event pipeline is intentionally
 * agnostic to task-system concerns. Task matching is the responsibility of
 * subscribers (e.g. the router, workflow nodes).
 *
 * No session injection happens in this service — routing/delivery is the router's
 * responsibility (a later task).
 */

import type { InternalEventBus } from '../internal-event-bus';
import type { ExternalEventStore } from './external-event-store';
import type { ExternalEvent } from './types';

export type PublishOutcome = 'published' | 'duplicate_terminal' | 'retryable_duplicate';

export interface PublishResult {
	outcome: PublishOutcome;
	/** The canonical event id (original id for duplicates, caller id otherwise). */
	eventId: string;
}

/**
 * Payload for `externalEvent.published` — emitted after a successful (non-duplicate)
 * store so subscribers can react to new external events.
 */
export interface ExternalEventPublishedPayload {
	sessionId: string;
	spaceId: string;
	eventId: string;
	source: string;
	topic: string;
	dedupeKey: string;
	[key: string]: unknown;
}

export interface ExternalEventPublisher {
	publish(event: ExternalEvent): Promise<PublishResult>;
}

export class ExternalEventService implements ExternalEventPublisher {
	constructor(
		private readonly store: ExternalEventStore,
		private readonly bus: InternalEventBus<{
			'externalEvent.published': ExternalEventPublishedPayload;
		}>
	) {}

	async publish(event: ExternalEvent): Promise<PublishResult> {
		const storeResult = this.store.store(event);

		if (storeResult.duplicate) {
			if (storeResult.terminal) {
				return {
					outcome: 'duplicate_terminal',
					eventId: storeResult.event.id,
				};
			}
			// Retryable duplicate — re-emit the canonical bus payload so failed
			// subscribers can recover.
			return await this._handleRetryableDuplicate(storeResult.event);
		}

		// First observation — publish the event.
		return await this._handleFirstObservation(event);
	}

	/**
	 * Handle a first-observation (non-duplicate) event.
	 *
	 * Always publishes `externalEvent.published` so subscribers see every newly
	 * stored event.
	 */
	private async _handleFirstObservation(event: ExternalEvent): Promise<PublishResult> {
		await this._publishBusEvent(event);
		return { outcome: 'published', eventId: event.id };
	}

	/**
	 * Handle a retryable duplicate.
	 *
	 * Re-emits the canonical bus payload so failed subscribers recover.
	 * The event stays in `published` state — terminalization is the router's
	 * responsibility after delivery completes or fails.
	 */
	private async _handleRetryableDuplicate(canonicalEvent: ExternalEvent): Promise<PublishResult> {
		await this._publishBusEvent(canonicalEvent);
		return {
			outcome: 'retryable_duplicate',
			eventId: canonicalEvent.id,
		};
	}

	/**
	 * Helper to publish `externalEvent.published`.
	 */
	private async _publishBusEvent(event: ExternalEvent): Promise<void> {
		await this.bus.publish('externalEvent.published', {
			sessionId: event.spaceId,
			spaceId: event.spaceId,
			eventId: event.id,
			source: event.source,
			topic: event.topic,
			dedupeKey: event.dedupeKey,
		});
	}
}
