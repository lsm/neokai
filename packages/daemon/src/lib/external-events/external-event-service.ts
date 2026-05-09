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
	[key: string]: unknown;
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
			// Retryable duplicate — the new observation may carry more complete
			// metadata (e.g. PR number filled in on a later webhook). Re-run the
			// resolver so enrichment can advance; if still unresolvable, re-emit
			// the stale canonical payload so failed subscribers recover.
			return await this._handleRetryableDuplicate(event, storeResult.event);
		}

		// First observation — attempt enrichment.
		return await this._handleFirstObservation(event);
	}

	/**
	 * Handle a first-observation (non-duplicate) event.
	 *
	 * Always publishes `externalEvent.published` so subscribers see every newly
	 * stored event, even when resolution is `ignored` (incomplete metadata).
	 *
	 * Persistence ordering: state/routedTaskId are written BEFORE the bus
	 * event is published so subscribers that read from ExternalEventStore see
	 * the enriched canonical row.
	 */
	private async _handleFirstObservation(event: ExternalEvent): Promise<PublishResult> {
		const resolution = await this.resolver.resolve(event);

		if (resolution.type === 'ignored') {
			// Publish before returning so diagnostics/metrics subscribers see it.
			await this._publishBusEvent(event, undefined);
			// Do NOT mark terminal — incomplete metadata may be filled in on a
			// later re-observation with the same dedupeKey. Leaving the event in
			// `published` keeps it eligible for retry.
			return { outcome: 'ignored', eventId: event.id };
		}

		if (resolution.type === 'ambiguous') {
			// Publish before terminalizing so subscribers see the event.
			await this._publishBusEvent(event, undefined);
			this.store.markEventAmbiguous(event.id);
			return { outcome: 'ignored', eventId: event.id };
		}

		if (resolution.type === 'unknown') {
			// Publish before returning so subscribers see the event.
			await this._publishBusEvent(event, undefined);
			// Do NOT mark terminal — a matching task may be created later.
			// Leaving the event in `published` keeps it eligible for retry.
			return { outcome: 'ignored', eventId: event.id };
		}

		// Enriched — persist the resolved task id and advance state BEFORE
		// publishing so subscribers reading from the store see the enriched row.
		this.store.setRoutedTaskId(event.id, resolution.routedTaskId);
		this.store.updateEventState(event.id, 'routed');
		await this._publishBusEvent(event, resolution.routedTaskId);

		return {
			outcome: 'published',
			eventId: event.id,
			routedTaskId: resolution.routedTaskId,
		};
	}

	/**
	 * Handle a retryable duplicate.
	 *
	 * Re-runs the resolver on the *new* event (which may have more complete
	 * metadata). If enrichment succeeds, persists it and returns `published`.
	 * Otherwise re-emits the canonical bus payload so failed subscribers recover.
	 *
	 * For `unknown`/`ambiguous` resolutions on a duplicate, the event is
	 * terminalized (mirroring the first-observation path) so it is not re-emitted
	 * indefinitely on every duplicate observation.
	 */
	private async _handleRetryableDuplicate(
		newEvent: ExternalEvent,
		canonicalEvent: ExternalEvent
	): Promise<PublishResult> {
		const resolution = await this.resolver.resolve(newEvent);

		if (resolution.type === 'enriched') {
			// New observation enriched the previously unresolvable event.
			// Only advance state if the canonical event has not already progressed
			// past `routed` (e.g. to `delivery_failed`). Backward transitions are
			// rejected by updateEventState.
			const canonicalRec = this.store.getById(canonicalEvent.id);
			const canAdvanceState =
				canonicalRec != null && !['routed', 'delivery_failed'].includes(canonicalRec.state);
			this.store.setRoutedTaskId(canonicalEvent.id, resolution.routedTaskId);
			if (canAdvanceState) {
				this.store.updateEventState(canonicalEvent.id, 'routed');
			}
			await this._publishBusEvent(canonicalEvent, resolution.routedTaskId);
			return {
				outcome: 'published',
				eventId: canonicalEvent.id,
				routedTaskId: resolution.routedTaskId,
			};
		}

		if (resolution.type === 'ambiguous') {
			this.store.markEventAmbiguous(canonicalEvent.id);
			await this._publishBusEvent(canonicalEvent, canonicalEvent.routedTaskId);
			return {
				outcome: 'retryable_duplicate',
				eventId: canonicalEvent.id,
				routedTaskId: canonicalEvent.routedTaskId ?? undefined,
			};
		}

		if (resolution.type === 'unknown') {
			// Do NOT terminalize — a matching task may be created later.
			// Re-emit the canonical payload so failed subscribers recover.
			await this._publishBusEvent(canonicalEvent, canonicalEvent.routedTaskId);
			return {
				outcome: 'retryable_duplicate',
				eventId: canonicalEvent.id,
				routedTaskId: canonicalEvent.routedTaskId ?? undefined,
			};
		}

		// `ignored` — re-emit the canonical payload so failed subscribers recover.
		await this._publishBusEvent(canonicalEvent, canonicalEvent.routedTaskId);
		return {
			outcome: 'retryable_duplicate',
			eventId: canonicalEvent.id,
			routedTaskId: canonicalEvent.routedTaskId ?? undefined,
		};
	}

	/**
	 * Helper to publish `externalEvent.published` with the given routedTaskId.
	 */
	private async _publishBusEvent(
		event: ExternalEvent,
		routedTaskId: string | undefined
	): Promise<void> {
		await this.bus.publish('externalEvent.published', {
			sessionId: event.spaceId,
			spaceId: event.spaceId,
			eventId: event.id,
			source: event.source,
			topic: event.topic,
			dedupeKey: event.dedupeKey,
			routedTaskId,
		});
	}
}
