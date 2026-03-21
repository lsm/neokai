/**
 * NotificationSink — interface for Space Runtime to push structured events
 * to consumers such as the Space Agent session or test harnesses.
 *
 * SpaceRuntime calls `notify()` after mechanical processing whenever a state
 * change requires judgment or awareness (e.g. a task hits `needs_attention`,
 * a workflow run completes, or a task times out).
 *
 * Consumers that don't need notifications can use `NullNotificationSink`.
 */

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/** A task has transitioned to `needs_attention` and requires judgment. */
export interface TaskNeedsAttentionEvent {
	kind: 'task_needs_attention';
	/** Space the task belongs to. */
	spaceId: string;
	/** Task that needs attention. */
	taskId: string;
	/** Human-readable reason the task needs attention. */
	reason: string;
	/** ISO-8601 timestamp when the event was emitted. */
	timestamp: string;
}

/** A workflow run has transitioned to `needs_attention` (e.g. a transition condition failed). */
export interface WorkflowRunNeedsAttentionEvent {
	kind: 'workflow_run_needs_attention';
	/** Space the workflow run belongs to. */
	spaceId: string;
	/** Workflow run that needs attention. */
	runId: string;
	/** Human-readable reason the run needs attention. */
	reason: string;
	/** ISO-8601 timestamp when the event was emitted. */
	timestamp: string;
}

/** A task has been running longer than the configured timeout threshold. */
export interface TaskTimeoutEvent {
	kind: 'task_timeout';
	/** Space the task belongs to. */
	spaceId: string;
	/** Task that has exceeded its time threshold. */
	taskId: string;
	/** Elapsed milliseconds since the task started. */
	elapsedMs: number;
	/** ISO-8601 timestamp when the event was emitted. */
	timestamp: string;
}

/** A workflow run has reached a terminal state (completed, cancelled, or needs_attention). */
export interface WorkflowRunCompletedEvent {
	kind: 'workflow_run_completed';
	/** Space the workflow run belongs to. */
	spaceId: string;
	/** Workflow run that completed. */
	runId: string;
	/**
	 * Final status of the run — a terminal subset of `WorkflowRunStatus`.
	 * `'needs_attention'` represents a run that ended due to an unrecoverable
	 * error or condition gate failure.
	 */
	status: 'completed' | 'cancelled' | 'needs_attention';
	/** Optional summary of what the run accomplished. */
	summary?: string;
	/** ISO-8601 timestamp when the event was emitted. */
	timestamp: string;
}

/**
 * Discriminated union of all structured notification events emitted by
 * `SpaceRuntime`. Use the `kind` field to narrow to a specific event type.
 *
 * @example
 * ```ts
 * function handleEvent(event: SpaceNotificationEvent) {
 *   switch (event.kind) {
 *     case 'task_needs_attention':
 *       // event is TaskNeedsAttentionEvent
 *       break;
 *     case 'workflow_run_needs_attention':
 *       // event is WorkflowRunNeedsAttentionEvent
 *       break;
 *     case 'task_timeout':
 *       // event is TaskTimeoutEvent
 *       break;
 *     case 'workflow_run_completed':
 *       // event is WorkflowRunCompletedEvent
 *       break;
 *   }
 * }
 * ```
 */
export type SpaceNotificationEvent =
	| TaskNeedsAttentionEvent
	| WorkflowRunNeedsAttentionEvent
	| TaskTimeoutEvent
	| WorkflowRunCompletedEvent;

// ---------------------------------------------------------------------------
// NotificationSink interface
// ---------------------------------------------------------------------------

/**
 * Receives structured notification events from `SpaceRuntime`.
 *
 * Implementations must be non-blocking from the runtime's perspective —
 * the runtime awaits the returned promise but does not retry on failure.
 * Implementations should handle their own errors internally.
 */
export interface NotificationSink {
	/**
	 * Called by `SpaceRuntime` when an event occurs that may require
	 * judgment or awareness from a consumer.
	 *
	 * @param event - The structured notification event.
	 */
	notify(event: SpaceNotificationEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// NullNotificationSink — no-op implementation
// ---------------------------------------------------------------------------

/**
 * No-op `NotificationSink` implementation.
 *
 * Use this as the default when no real consumer is connected (e.g. in unit
 * tests that don't care about notifications, or before the Space Agent session
 * has been provisioned).
 */
export class NullNotificationSink implements NotificationSink {
	notify(_event: SpaceNotificationEvent): Promise<void> {
		return Promise.resolve();
	}
}
