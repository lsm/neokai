/**
 * External Event Bus — public exports.
 *
 * Source-agnostic primitives consumed by extension publishers, the
 * `ExternalEventService`, the workflow runtime, and tests. GitHub-specific
 * code lives under `./github` (added in a later task).
 */

export {
	type ExternalEvent,
	type ExternalEventState,
	type ExternalEventDeliveryState,
	type ExternalEventRecord,
	type ExternalEventDeliveryRecord,
	type DeliveryFailure,
	type DeliveryTarget,
	type StoreResult,
	TERMINAL_EVENT_STATES,
	TERMINAL_DELIVERY_STATES,
} from './types';
export {
	validateGlobPattern,
	validateSource,
	validateSubscriptionPattern,
	KNOWN_SOURCES,
	type ValidationResult,
} from './topic-validator';
export {
	ExternalEventStore,
	ExternalEventValidationError,
} from './external-event-store';
export {
	ExternalEventService,
	type ExternalEventPublisher,
	type PublishResult,
	type PublishOutcome,
	type ExternalEventPublishedPayload,
} from './external-event-service';
export { TopicTrie, isReceivingStatus } from './topic-trie';
