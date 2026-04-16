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

/** A task has transitioned to `blocked` and requires judgment. */
export interface TaskBlockedEvent {
	kind: 'task_blocked';
	/** Space the task belongs to. */
	spaceId: string;
	/** Task that is blocked. */
	taskId: string;
	/** Human-readable reason the task is blocked. */
	reason: string;
	/** ISO-8601 timestamp when the event was emitted. */
	timestamp: string;
}

/** A workflow run has transitioned to `blocked` (e.g. a transition condition failed). */
export interface WorkflowRunBlockedEvent {
	kind: 'workflow_run_blocked';
	/** Space the workflow run belongs to. */
	spaceId: string;
	/** Workflow run that is blocked. */
	runId: string;
	/** Human-readable reason the run is blocked. */
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

/**
 * A stuck agent (alive but never called report_result) was auto-completed by the runtime.
 *
 * Emitted after the task is transitioned to `completed` with a system-generated result.
 * Consumers can use this to log warnings or inform the Space Agent.
 */
export interface AgentAutoCompletedEvent {
	kind: 'agent_auto_completed';
	/** Space the task belongs to. */
	spaceId: string;
	/** Task that was auto-completed. */
	taskId: string;
	/** Milliseconds elapsed since the task started (i.e. how long it was stuck). */
	elapsedMs: number;
	/** ISO-8601 timestamp when the event was emitted. */
	timestamp: string;
}

/**
 * A Task Agent session crashed unexpectedly.
 *
 * Emitted when `isTaskAgentAlive()` returns `false` for an in-progress task
 * that had a live Task Agent session. The task is transitioned to
 * `blocked` so a human can investigate and retry.
 */
export interface AgentCrashEvent {
	kind: 'agent_crash';
	/** Space the task belongs to. */
	spaceId: string;
	/** Task whose agent session crashed. */
	taskId: string;
	/** ISO-8601 timestamp when the crash was detected. */
	timestamp: string;
}

/** A blocked execution is being automatically retried by the runtime. */
export interface TaskRetryEvent {
	kind: 'task_retry';
	/** Space the task belongs to. */
	spaceId: string;
	/** Task being retried. */
	taskId: string;
	/** The workflow run ID containing the retried execution. */
	runId: string;
	/** Human-readable reason the execution was originally blocked. */
	originalReason: string;
	/** Which retry attempt this is (1-based). */
	attemptNumber: number;
	/** Maximum retry attempts before final escalation. */
	maxAttempts: number;
	/** ISO-8601 timestamp when the retry was initiated. */
	timestamp: string;
}

/** A blocked workflow run has exhausted automatic retries and needs human/Space Agent attention. */
export interface WorkflowRunNeedsAttentionEvent {
	kind: 'workflow_run_needs_attention';
	/** Space the workflow run belongs to. */
	spaceId: string;
	/** Workflow run that needs attention. */
	runId: string;
	/** Task associated with the blocked run. */
	taskId: string;
	/** Human-readable reason the run is blocked. */
	reason: string;
	/** Number of automatic retries that were attempted. */
	retriesExhausted: number;
	/** ISO-8601 timestamp when the event was emitted. */
	timestamp: string;
}

/** A workflow run has reached a terminal state (done, cancelled, or blocked). */
export interface WorkflowRunCompletedEvent {
	kind: 'workflow_run_completed';
	/** Space the workflow run belongs to. */
	spaceId: string;
	/** Workflow run that completed. */
	runId: string;
	/**
	 * Final status of the run — a terminal subset of `WorkflowRunStatus`.
	 * `'blocked'` represents a run that ended due to an unrecoverable
	 * error or condition gate failure.
	 */
	status: 'done' | 'cancelled' | 'blocked';
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
 *     case 'task_blocked':
 *       // event is TaskBlockedEvent
 *       break;
 *     case 'workflow_run_blocked':
 *       // event is WorkflowRunBlockedEvent
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
	| TaskBlockedEvent
	| WorkflowRunBlockedEvent
	| TaskTimeoutEvent
	| WorkflowRunCompletedEvent
	| AgentAutoCompletedEvent
	| AgentCrashEvent
	| TaskRetryEvent
	| WorkflowRunNeedsAttentionEvent;

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
