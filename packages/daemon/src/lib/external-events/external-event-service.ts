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
			// Retryable duplicate — re-emit the bus event so failed subscribers
			// from the first observation get another chance.
			await this.bus.publish('externalEvent.published', {
				sessionId: storeResult.event.spaceId,
				spaceId: storeResult.event.spaceId,
				eventId: storeResult.event.id,
				source: storeResult.event.source,
				topic: storeResult.event.topic,
				dedupeKey: storeResult.event.dedupeKey,
				routedTaskId: storeResult.event.routedTaskId,
			});
			return {
				outcome: 'retryable_duplicate',
				eventId: storeResult.event.id,
				routedTaskId: storeResult.event.routedTaskId ?? undefined,
			};
		}

		// First observation — attempt enrichment.
		const resolution = await this.resolver.resolve(event);

		if (resolution.type === 'ignored') {
			// Do NOT mark terminal — incomplete metadata may be filled in on a
			// later re-observation with the same dedupeKey. Leaving the event in
			// `published` keeps it eligible for retry.
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

		// Enriched — persist the resolved task id before advancing state.
		this.store.setRoutedTaskId(event.id, resolution.routedTaskId);
		this.store.updateEventState(event.id, 'routed');

		// Publish the fact on the internal bus so subscribers (router, metrics,
		// diagnostics) can react without polling the DB.
		await this.bus.publish('externalEvent.published', {
			sessionId: event.spaceId,
			spaceId: event.spaceId,
			eventId: event.id,
			source: event.source,
			topic: event.topic,
			dedupeKey: event.dedupeKey,
			routedTaskId: resolution.routedTaskId,
		});

		return {
			outcome: 'published',
			eventId: event.id,
			routedTaskId: resolution.routedTaskId,
		};
	}
}
