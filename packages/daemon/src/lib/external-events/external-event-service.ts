/**
 * ExternalEventService — source-agnostic external event publishing and task enrichment.
 *
 * Implements `ExternalEventPublisher`:
 *   - Validates source/topic contracts via `ExternalEventStore`.
 *   - Stores/dedupes via `ExternalEventStore`.
 *   - Enriches events through `ExternalEventTaskResolver`.
 *   - Publishes `externalEvent.published` on `InternalEventBus` with a space-scoped
 *     channel/payload.
 *
 * No session injection happens in this service — routing/delivery is the router's
 * responsibility (a later task).
 */

import type { InternalEventBus } from '../internal-event-bus';
import type { ExternalEventStore } from './external-event-store';
import type { ExternalEventTaskResolver } from './external-event-task-resolver';
import type { ExternalEvent } from './types';

export type PublishOutcome = 'published' | 'duplicate_terminal' | 'retryable_duplicate' | 'ignored';

export interface PublishResult {
	outcome: PublishOutcome;
	/** The canonical event id (original id for duplicates, caller id otherwise). */
	eventId: string;
	/** Enriched routedTaskId when resolution succeeded; undefined otherwise. */
	routedTaskId?: string;
}

export interface ExternalEventPublisher {
	publish(event: ExternalEvent): Promise<PublishResult>;
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
	routedTaskId?: string;
}

export class ExternalEventService implements ExternalEventPublisher {
	constructor(
		private readonly store: ExternalEventStore,
		private readonly resolver: ExternalEventTaskResolver,
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
			return {
				outcome: 'retryable_duplicate',
				eventId: storeResult.event.id,
			};
		}

		// First observation — attempt enrichment.
		const resolution = await this.resolver.resolve(event);

		if (resolution.type === 'ignored') {
			this.store.markEventIgnored(event.id, 'no_matching_subscriptions');
			return { outcome: 'ignored', eventId: event.id };
		}

		if (resolution.type === 'ambiguous') {
			this.store.markEventAmbiguous(event.id);
			return { outcome: 'ignored', eventId: event.id };
		}

		if (resolution.type === 'unknown') {
			this.store.markEventAmbiguous(event.id);
			return { outcome: 'ignored', eventId: event.id };
		}

		// Enriched — update the stored event with the resolved task id.
		const enrichedEvent: ExternalEvent = {
			...event,
			routedTaskId: resolution.routedTaskId,
		};

		// Update the DB row with the resolved routed_task_id.
		this.store.updateEventState(event.id, 'routed');

		// Publish the fact on the internal bus so subscribers (router, metrics,
		// diagnostics) can react without polling the DB.
		await this.bus.publish('externalEvent.published', {
			sessionId: event.spaceId,
			spaceId: event.spaceId,
			eventId: enrichedEvent.id,
			source: enrichedEvent.source,
			topic: enrichedEvent.topic,
			dedupeKey: enrichedEvent.dedupeKey,
			routedTaskId: enrichedEvent.routedTaskId,
		});

		return {
			outcome: 'published',
			eventId: enrichedEvent.id,
			routedTaskId: enrichedEvent.routedTaskId,
		};
	}
}
