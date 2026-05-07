/**
 * ExternalEventStore — persistent retry-aware source-level dedup
 * and per-subscription delivery lifecycle.
 *
 * Owns two tables introduced by the External Event Bus design:
 *
 *   • `space_external_events` — one row per `(spaceId, source, dedupeKey)` with
 *     a state machine (`published` → `routed` → `delivered`/`failed` etc.).
 *   • `space_external_event_deliveries` — per-subscription delivery rows, keyed
 *     by `(eventId, deliveryKey)`, used by the router to advance source events
 *     to terminal `delivered` only when every expected delivery succeeds.
 *
 * Source-agnostic: nothing in this file is GitHub-specific. Topic format is
 * validated by `topic-validator.ts`; payload is opaque JSON.
 *
 * See docs/plans/design-external-event-bus-for-space-workflow-nodes.md.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import {
	type DeliveryFailure,
	type DeliveryTarget,
	type ExternalEvent,
	type ExternalEventDeliveryRecord,
	type ExternalEventDeliveryState,
	type ExternalEventRecord,
	type ExternalEventState,
	type StoreResult,
	TERMINAL_DELIVERY_STATES,
	TERMINAL_EVENT_STATES,
} from './types';
import { validateGlobPattern, validateSource } from './topic-validator';

interface ExternalEventRow {
	id: string;
	space_id: string;
	source: string;
	topic: string;
	dedupe_key: string;
	occurred_at: number;
	ingested_at: number;
	source_event_id: string | null;
	pr_number: number | null;
	repo_owner: string | null;
	repo_name: string | null;
	branch: string | null;
	summary: string;
	external_url: string | null;
	payload_json: string;
	routed_task_id: string | null;
	state: ExternalEventState;
	created_at: number;
	updated_at: number;
}

interface ExternalEventDeliveryRow {
	event_id: string;
	delivery_key: string;
	workflow_run_id: string;
	task_id: string;
	node_id: string;
	agent_name: string;
	state: ExternalEventDeliveryState;
	failure_reason: string | null;
	delivered_at: number | null;
	updated_at: number;
}

export class ExternalEventValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExternalEventValidationError';
	}
}

export class ExternalEventStore {
	constructor(private readonly db: BunDatabase) {}

	// ---------------------------------------------------------------------------
	// Source event lifecycle
	// ---------------------------------------------------------------------------

	/**
	 * Idempotently store an external event for source-level dedup.
	 *
	 * - First observation: inserts a new row (state `published`) and returns
	 *   `{ duplicate: false, terminal: false, event }` with the caller-supplied id.
	 * - Duplicate of a *terminal* prior observation: returns
	 *   `{ duplicate: true, terminal: true, event }` carrying the original id.
	 *   The caller is expected to short-circuit publication.
	 * - Duplicate of a *retryable* prior observation (`published`, `routed`,
	 *   `delivery_failed`): returns `{ duplicate: true, terminal: false, event }`
	 *   carrying the original id so delivery can retry.
	 *
	 * Validation: topic must satisfy `validateGlobPattern` (literal — no `*`
	 * needed but allowed by the same shape), source must be a known extension
	 * identifier, and `(spaceId, dedupeKey)` must be present.
	 */
	store(event: ExternalEvent): StoreResult {
		this.validate(event);
		const now = Date.now();

		const insert = this.db.prepare(
			`INSERT INTO space_external_events (
				id, space_id, source, topic, dedupe_key,
				occurred_at, ingested_at, source_event_id,
				pr_number, repo_owner, repo_name, branch,
				summary, external_url, payload_json, routed_task_id,
				state, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?,
				?, ?, ?,
				?, ?, ?, ?,
				?, ?, ?, ?,
				'published', ?, ?
			)
			ON CONFLICT(space_id, source, dedupe_key) DO NOTHING`
		);

		const result = insert.run(
			event.id,
			event.spaceId,
			event.source,
			event.topic,
			event.dedupeKey,
			event.occurredAt,
			event.ingestedAt,
			event.sourceEventId ?? null,
			event.prNumber ?? null,
			event.repoOwner ?? null,
			event.repoName ?? null,
			event.branch ?? null,
			event.summary,
			event.externalUrl ?? null,
			JSON.stringify(event.payload ?? {}),
			event.routedTaskId ?? null,
			now,
			now
		);

		if (result.changes > 0) {
			return { event: { ...event }, duplicate: false, terminal: false };
		}

		// Conflict — load the canonical row and decide based on its current state.
		const existing = this.getByDedupe(event.spaceId, event.source, event.dedupeKey);
		if (!existing) {
			// Theoretically impossible — INSERT was rejected by the unique
			// constraint but the row no longer exists. Treat as fresh insert
			// retry; surface as a hard error so callers see the inconsistency.
			throw new Error(
				`ExternalEventStore.store: conflict reported but no canonical row found ` +
					`for (${event.spaceId}, ${event.source}, ${event.dedupeKey})`
			);
		}

		return {
			event: existing.event,
			duplicate: true,
			terminal: TERMINAL_EVENT_STATES.has(existing.state),
		};
	}

	/** Return the source event row by its primary id, or `null`. */
	getById(eventId: string): ExternalEventRecord | null {
		const row = this.db.prepare(`SELECT * FROM space_external_events WHERE id = ?`).get(eventId) as
			| ExternalEventRow
			| undefined;
		return row ? rowToRecord(row) : null;
	}

	/** Return the source event row by `(spaceId, source, dedupeKey)`, or `null`. */
	getByDedupe(spaceId: string, source: string, dedupeKey: string): ExternalEventRecord | null {
		const row = this.db
			.prepare(
				`SELECT * FROM space_external_events
				 WHERE space_id = ? AND source = ? AND dedupe_key = ?`
			)
			.get(spaceId, source, dedupeKey) as ExternalEventRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	/**
	 * Mark the source event terminal `delivered` if **every** expected delivery
	 * row is in state `delivered`. No-op if the source event is already
	 * terminal, or if any delivery is non-terminal or terminal-failed.
	 *
	 * This is the only path that can promote a source event to `delivered`.
	 */
	markEventDeliveredIfAllDeliveriesDelivered(eventId: string): void {
		const event = this.getById(eventId);
		if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;

		const rows = this.db
			.prepare(`SELECT state FROM space_external_event_deliveries WHERE event_id = ?`)
			.all(eventId) as Pick<ExternalEventDeliveryRow, 'state'>[];

		// Defensive: if no expected deliveries were ever registered, this is not
		// "all delivered" — the router should call `markEventIgnored` instead.
		if (rows.length === 0) return;

		for (const row of rows) {
			if (row.state !== 'delivered') return;
		}

		this.updateEventState(eventId, 'delivered');
	}

	/**
	 * Mark the source event terminal `failed` if **any** delivery row is
	 * terminal `failed`. No-op if the source event is already terminal.
	 *
	 * This guarantees a partially-failed source event is never reclassified as
	 * `delivered` by a later successful subscription.
	 */
	markEventFailedIfAnyDeliveryTerminalFailed(eventId: string): void {
		const event = this.getById(eventId);
		if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;

		const failed = this.db
			.prepare(
				`SELECT 1 FROM space_external_event_deliveries
				 WHERE event_id = ? AND state = 'failed' LIMIT 1`
			)
			.get(eventId);

		if (failed) {
			this.updateEventState(eventId, 'failed');
		}
	}

	/**
	 * Mark the source event terminal `failed` if **every** delivery row is in a
	 * terminal state (delivered or failed) AND at least one is `failed`. Used
	 * after retry-budget exhaustion / run-terminal-cleanup so duplicate source
	 * observations do not restart an exhausted delivery.
	 */
	markEventFailedIfAllDeliveriesTerminal(eventId: string): void {
		const event = this.getById(eventId);
		if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;

		const rows = this.db
			.prepare(`SELECT state FROM space_external_event_deliveries WHERE event_id = ?`)
			.all(eventId) as Pick<ExternalEventDeliveryRow, 'state'>[];
		if (rows.length === 0) return;

		let sawFailure = false;
		for (const row of rows) {
			if (!TERMINAL_DELIVERY_STATES.has(row.state)) return;
			if (row.state === 'failed') sawFailure = true;
		}

		if (sawFailure) {
			this.updateEventState(eventId, 'failed');
		}
	}

	/**
	 * Force the source event to terminal `failed`. Used by the router when it
	 * cannot enrich/dispatch the event at all (e.g. enrichment hard error).
	 *
	 * `failure.terminal=false` is rejected — calling `markEventFailed` is a
	 * terminal action by definition. Routes that want to retry should not call
	 * this method.
	 */
	markEventFailed(eventId: string, failure: DeliveryFailure): void {
		if (!failure.terminal) {
			throw new Error(
				`markEventFailed requires failure.terminal=true (got false; reason="${failure.reason}")`
			);
		}
		const event = this.getById(eventId);
		if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;
		this.updateEventState(eventId, 'failed');
	}

	/**
	 * Mark the source event terminal `ignored`. Called when no subscriptions
	 * matched, or when scope checks rejected every matching subscription.
	 */
	markEventIgnored(
		eventId: string,
		_reason: 'no_matching_subscriptions' | 'no_scope_eligible_subscriptions'
	): void {
		const event = this.getById(eventId);
		if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;
		this.updateEventState(eventId, 'ignored');
	}

	/**
	 * Move the event to a non-terminal state (`routed`, `delivery_failed`).
	 * Used by the router to track progress between `published` and the
	 * eventual terminal transition. No-op if already terminal.
	 */
	updateEventState(eventId: string, state: ExternalEventState): void {
		const event = this.getById(eventId);
		if (!event) return;
		if (TERMINAL_EVENT_STATES.has(event.state) && event.state !== state) {
			// Never overwrite a terminal state with a different terminal/non-terminal
			// state. This protects against late retries reclassifying a finalized event.
			return;
		}
		this.db
			.prepare(`UPDATE space_external_events SET state = ?, updated_at = ? WHERE id = ?`)
			.run(state, Date.now(), eventId);
	}

	// ---------------------------------------------------------------------------
	// Per-subscription delivery lifecycle
	// ---------------------------------------------------------------------------

	/**
	 * Idempotently register the delivery row expected for an event/subscription.
	 *
	 * Implemented as `INSERT OR IGNORE` because retryable source duplicates and
	 * router retries can prepare the same `(eventId, deliveryKey)` more than
	 * once. Existing terminal rows are preserved.
	 */
	registerExpectedDelivery(eventId: string, deliveryKey: string, target: DeliveryTarget): void {
		if (!this.getById(eventId)) {
			throw new Error(`registerExpectedDelivery: unknown source event id "${eventId}"`);
		}
		const now = Date.now();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO space_external_event_deliveries (
					event_id, delivery_key, workflow_run_id, task_id, node_id, agent_name,
					state, failure_reason, delivered_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`
			)
			.run(
				eventId,
				deliveryKey,
				target.workflowRunId,
				target.taskId,
				target.nodeId,
				target.agentName,
				now
			);
	}

	/** Returns true when the delivery row is already terminal and should be skipped. */
	isDeliveryTerminal(eventId: string, deliveryKey: string): boolean {
		const row = this.db
			.prepare(
				`SELECT state FROM space_external_event_deliveries
				 WHERE event_id = ? AND delivery_key = ?`
			)
			.get(eventId, deliveryKey) as Pick<ExternalEventDeliveryRow, 'state'> | undefined;
		if (!row) return false;
		return TERMINAL_DELIVERY_STATES.has(row.state);
	}

	/**
	 * Look up the source event id for a registered delivery key.
	 *
	 * Throws if the delivery key is not registered — the router uses this to
	 * recover the source event id when only the delivery key is in scope (e.g.
	 * a fired retry timer keyed by delivery_key only). Ambiguity is logically
	 * impossible because delivery_key embeds the event id in current callers,
	 * but the API is intentionally event-aware to support future composite keys.
	 */
	getEventIdForDeliveryKey(deliveryKey: string): string {
		const row = this.db
			.prepare(
				`SELECT event_id FROM space_external_event_deliveries WHERE delivery_key = ? LIMIT 1`
			)
			.get(deliveryKey) as Pick<ExternalEventDeliveryRow, 'event_id'> | undefined;
		if (!row) {
			throw new Error(
				`getEventIdForDeliveryKey: no delivery row for delivery_key="${deliveryKey}"`
			);
		}
		return row.event_id;
	}

	/** Mark the delivery row terminal `delivered`. No-op if already terminal. */
	markDeliveryDelivered(eventId: string, deliveryKey: string): void {
		const now = Date.now();
		this.db
			.prepare(
				`UPDATE space_external_event_deliveries
				 SET state = 'delivered', failure_reason = NULL, delivered_at = ?, updated_at = ?
				 WHERE event_id = ? AND delivery_key = ?
				 AND state NOT IN ('delivered', 'failed')`
			)
			.run(now, now, eventId, deliveryKey);
	}

	/**
	 * Mark the delivery row failed.
	 *
	 * `failure.terminal=true` advances to terminal `failed`. `failure.terminal=false`
	 * keeps the row in `pending` (retryable) but updates `failure_reason` for
	 * diagnostics — the row remains eligible for the router's next retry pass.
	 *
	 * No-op if the row is already terminal.
	 */
	markDeliveryFailed(eventId: string, deliveryKey: string, failure: DeliveryFailure): void {
		const now = Date.now();
		const newState: ExternalEventDeliveryState = failure.terminal ? 'failed' : 'pending';
		this.db
			.prepare(
				`UPDATE space_external_event_deliveries
				 SET state = ?, failure_reason = ?, updated_at = ?
				 WHERE event_id = ? AND delivery_key = ?
				 AND state NOT IN ('delivered', 'failed')`
			)
			.run(newState, failure.reason, now, eventId, deliveryKey);
	}

	/** List delivery rows for an event (for diagnostics and tests). */
	listDeliveries(eventId: string): ExternalEventDeliveryRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_external_event_deliveries WHERE event_id = ? ORDER BY delivery_key`
			)
			.all(eventId) as ExternalEventDeliveryRow[];
		return rows.map(deliveryRowToRecord);
	}

	getDelivery(eventId: string, deliveryKey: string): ExternalEventDeliveryRecord | null {
		const row = this.db
			.prepare(
				`SELECT * FROM space_external_event_deliveries
				 WHERE event_id = ? AND delivery_key = ?`
			)
			.get(eventId, deliveryKey) as ExternalEventDeliveryRow | undefined;
		return row ? deliveryRowToRecord(row) : null;
	}

	// ---------------------------------------------------------------------------
	// Validation
	// ---------------------------------------------------------------------------

	private validate(event: ExternalEvent): void {
		if (!event.id || typeof event.id !== 'string') {
			throw new ExternalEventValidationError('ExternalEvent.id is required');
		}
		if (!event.spaceId || typeof event.spaceId !== 'string') {
			throw new ExternalEventValidationError('ExternalEvent.spaceId is required');
		}
		if (!event.dedupeKey || typeof event.dedupeKey !== 'string') {
			throw new ExternalEventValidationError('ExternalEvent.dedupeKey is required');
		}

		const sourceCheck = validateSource(event.source);
		if (!sourceCheck.valid) {
			throw new ExternalEventValidationError(`ExternalEvent.source invalid: ${sourceCheck.reason}`);
		}

		const topicCheck = validateGlobPattern(event.topic);
		if (!topicCheck.valid) {
			throw new ExternalEventValidationError(`ExternalEvent.topic invalid: ${topicCheck.reason}`);
		}

		// Topic literal must start with the declared source.
		const firstSegment = event.topic.split('/')[0];
		if (firstSegment !== event.source) {
			throw new ExternalEventValidationError(
				`ExternalEvent.topic first segment "${firstSegment}" must equal source "${event.source}"`
			);
		}

		if (typeof event.occurredAt !== 'number' || !Number.isFinite(event.occurredAt)) {
			throw new ExternalEventValidationError('ExternalEvent.occurredAt must be a finite number');
		}
		if (typeof event.ingestedAt !== 'number' || !Number.isFinite(event.ingestedAt)) {
			throw new ExternalEventValidationError('ExternalEvent.ingestedAt must be a finite number');
		}
		if (typeof event.summary !== 'string') {
			throw new ExternalEventValidationError('ExternalEvent.summary must be a string');
		}
		if (typeof event.payload !== 'object' || event.payload === null) {
			throw new ExternalEventValidationError('ExternalEvent.payload must be an object');
		}
	}
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToRecord(row: ExternalEventRow): ExternalEventRecord {
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(row.payload_json) as Record<string, unknown>;
	} catch {
		// Corrupted payload — return an empty object so the rest of the
		// metadata (state, dedupe key, etc.) remains usable. The router can
		// decide whether to terminalize the event or skip delivery.
		payload = {};
	}

	const event: ExternalEvent = {
		id: row.id,
		spaceId: row.space_id,
		source: row.source,
		topic: row.topic,
		dedupeKey: row.dedupe_key,
		occurredAt: row.occurred_at,
		ingestedAt: row.ingested_at,
		summary: row.summary,
		payload,
	};
	if (row.source_event_id !== null) event.sourceEventId = row.source_event_id;
	if (row.pr_number !== null) event.prNumber = row.pr_number;
	if (row.repo_owner !== null) event.repoOwner = row.repo_owner;
	if (row.repo_name !== null) event.repoName = row.repo_name;
	if (row.branch !== null) event.branch = row.branch;
	if (row.external_url !== null) event.externalUrl = row.external_url;
	if (row.routed_task_id !== null) event.routedTaskId = row.routed_task_id;

	return {
		event,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function deliveryRowToRecord(row: ExternalEventDeliveryRow): ExternalEventDeliveryRecord {
	return {
		eventId: row.event_id,
		deliveryKey: row.delivery_key,
		workflowRunId: row.workflow_run_id,
		taskId: row.task_id,
		nodeId: row.node_id,
		agentName: row.agent_name,
		state: row.state,
		failureReason: row.failure_reason,
		deliveredAt: row.delivered_at,
		updatedAt: row.updated_at,
	};
}
