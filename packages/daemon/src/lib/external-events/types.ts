/**
 * External Event Bus — shared types
 *
 * Source-agnostic types for external events that flow through the daemon's
 * external-event subsystem. GitHub is one source among many — the same shapes
 * are reused for future Slack / Jira / CI integrations. Source-specific
 * concerns (HMAC, repo configuration, polling) live in extension modules; the
 * core bus only sees `ExternalEvent`s.
 *
 * See docs/plans/design-external-event-bus-for-space-workflow-nodes.md.
 */

/**
 * A normalized external event on the bus.
 *
 * `dedupeKey` is the stable source-level identity used by `ExternalEventStore`
 * to recognize the same external event across webhook + polling observations.
 * It must be stable across observations of the same external event from any
 * channel and unique within `(spaceId, source)`.
 */
export interface ExternalEvent {
	/** Unique event ID (UUID) assigned by the extension for this publication. */
	id: string;
	/** Space this event belongs to. Required to prevent cross-space delivery. */
	spaceId: string;
	/** Fully qualified topic: 'github/owner/repo/resource.action'. */
	topic: string;
	/** Timestamp when the event occurred at the source (epoch ms). */
	occurredAt: number;
	/** Timestamp when the event was accepted by the extension (epoch ms). */
	ingestedAt: number;
	/** Source extension identifier (e.g. 'github'). */
	source: string;
	/** Optional source-native event id / delivery id for diagnostics. */
	sourceEventId?: string;
	/** Optional PR number used by core task resolution (GitHub). */
	prNumber?: number;
	/** Repository owner (lowercase) for repo-scoped matching. */
	repoOwner?: string;
	/** Repository name (lowercase) for repo-scoped matching. */
	repoName?: string;
	/** Branch name, if available. */
	branch?: string;
	/** Human-readable summary for agent consumption. */
	summary: string;
	/** External URL (e.g. GitHub PR link). */
	externalUrl?: string;
	/** Structured source payload — extension-specific, not constrained. */
	payload: Record<string, unknown>;
	/**
	 * Stable source-level identity used by bus dedup. Must be stable across
	 * webhook and polling observations of the same external event.
	 */
	dedupeKey: string;
	/**
	 * Core enrichment filled by `ExternalEventTaskResolver` after publication.
	 * Adapters should leave this unset unless the source itself has a trusted
	 * first-party task id.
	 */
	routedTaskId?: string;
}

/**
 * Lifecycle states for the source event row in `space_external_events`.
 *
 * Retryable: `published`, `routed`, `delivery_failed` — source duplicates
 * re-emit so delivery can retry.
 *
 * Terminal: `delivered`, `failed`, `ignored`, `ambiguous` — source duplicates
 * are short-circuited.
 */
export type ExternalEventState =
	| 'published'
	| 'routed'
	| 'delivered'
	| 'delivery_failed'
	| 'failed'
	| 'ignored'
	| 'ambiguous';

export const TERMINAL_EVENT_STATES: ReadonlySet<ExternalEventState> = new Set<ExternalEventState>([
	'delivered',
	'failed',
	'ignored',
	'ambiguous',
]);

export const RETRYABLE_EVENT_STATES: ReadonlySet<ExternalEventState> = new Set<ExternalEventState>([
	'published',
	'routed',
	'delivery_failed',
]);

/**
 * Lifecycle states for a per-subscription delivery row in
 * `space_external_event_deliveries`.
 *
 * `pending`: registered, not yet attempted or attempt may retry.
 * `delivered` (terminal): command-bus injection succeeded.
 * `failed` (terminal): retry budget exhausted, scope mismatch, node cancellation, etc.
 */
export type ExternalEventDeliveryState = 'pending' | 'delivered' | 'failed';

export const TERMINAL_DELIVERY_STATES: ReadonlySet<ExternalEventDeliveryState> =
	new Set<ExternalEventDeliveryState>(['delivered', 'failed']);

/**
 * Stored event row, including current state. Useful for diagnostics and tests.
 */
export interface ExternalEventRecord {
	event: ExternalEvent;
	state: ExternalEventState;
	createdAt: number;
	updatedAt: number;
}

/**
 * Stored delivery row. The `(eventId, deliveryKey)` pair is the row's primary key.
 */
export interface ExternalEventDeliveryRecord {
	eventId: string;
	deliveryKey: string;
	workflowRunId: string;
	taskId: string;
	nodeId: string;
	agentName: string;
	state: ExternalEventDeliveryState;
	failureReason: string | null;
	deliveredAt: number | null;
	updatedAt: number;
}

/**
 * Result of a `store()` call.
 *
 * - `duplicate=false` — first observation of this `(spaceId, source, dedupeKey)`.
 *   The returned `event` is the caller's input (with the caller-supplied id).
 * - `duplicate=true, terminal=true` — already terminal; caller should short-circuit.
 *   The returned `event` carries the *original* event id (so callers refer to the
 *   canonical row, not the duplicate they just submitted).
 * - `duplicate=true, terminal=false` — retryable duplicate; caller may re-emit.
 *   The returned `event` carries the *original* event id.
 */
export interface StoreResult {
	event: ExternalEvent;
	duplicate: boolean;
	terminal: boolean;
}

/**
 * Target identity of a delivery, captured at expected-delivery registration time.
 */
export interface DeliveryTarget {
	workflowRunId: string;
	taskId: string;
	nodeId: string;
	agentName: string;
}

export interface DeliveryFailure {
	/** Whether the failure is terminal (`true`) or transient (`false`, retryable). */
	terminal: boolean;
	/** Free-form failure reason for diagnostics (logged + persisted). */
	reason: string;
}
