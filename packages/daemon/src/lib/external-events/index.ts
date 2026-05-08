/**
 * External Event Bus — public exports.
 *
 * Source-agnostic primitives consumed by extension publishers, the
 * `ExternalEventService`, the `ExternalEventRouter`, and tests. GitHub-specific
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
	KNOWN_SOURCES,
	type ValidationResult,
} from './topic-validator';
export { ExternalEventStore, ExternalEventValidationError } from './external-event-store';
