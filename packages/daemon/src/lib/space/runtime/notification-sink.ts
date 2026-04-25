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

/**
 * A task has paused at a completion action that requires approval because the
 * space's current autonomy level is below the action's `requiredLevel`.
 *
 * Emitted exactly once per pause. Space Agent consumers use this to surface a
 * review/approval UI or notify stakeholders. The event carries enough metadata
 * to render a banner ("Awaiting approval: Merge PR") without a second fetch,
 * but deliberately omits executable bodies (e.g. the `script` payload) —
 * consumers fetch workflow detail for those.
 */
export interface TaskAwaitingApprovalEvent {
	kind: 'task_awaiting_approval';
	/** Space the task belongs to. */
	spaceId: string;
	/** Task that paused awaiting approval. */
	taskId: string;
	/** ID of the completion action currently awaiting approval. */
	actionId: string;
	/** Human-readable name of the action (shown in approval UI). */
	actionName: string;
	/** Optional human-readable description of the action. */
	actionDescription?: string;
	/** Discriminator for the action's execution type. */
	actionType: 'script' | 'instruction' | 'mcp_call';
	/** Minimum autonomy level required to auto-execute this action. */
	requiredLevel: number;
	/** Space's autonomy level at the time the pause was emitted. */
	spaceLevel: number;
	/**
	 * Alias of `spaceLevel` preserved for API-schema convenience — consumers
	 * that prefer the more explicit name ("what is the space's autonomy level?")
	 * can read this instead.
	 */
	autonomyLevel: number;
	/** ISO-8601 timestamp when the event was emitted. */
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

/**
 * A previously-terminal workflow run (`done` or `cancelled`) has been reopened
 * back to `in_progress` because new inbound activity arrived before the parent
 * task was archived.
 *
 * Triggers include:
 * - Peer agent `send_message` to an agent in the run (`by: '<agentName>'`).
 * - User/task-agent message routed to an agent in the run (`by: 'user'`).
 * - Gate data changed via `write_gate` MCP tool (`by: 'gate:<gateId>'`).
 *
 * Archive is the only tombstone: once `SpaceTask.archivedAt` is set, the run
 * cannot be reopened and the ChannelRouter throws `ActivationError` instead of
 * emitting this event.
 *
 * Consumers (Space Agent, UI) should surface that a "finished" task is active
 * again — any prior post-approval audit artifacts remain valid, and the
 * runtime does NOT re-dispatch the post-approval router on subsequent
 * completions of the reopened run.
 */
export interface WorkflowRunReopenedEvent {
	kind: 'workflow_run_reopened';
	/** Space the workflow run belongs to. */
	spaceId: string;
	/** Workflow run that was reopened. */
	runId: string;
	/** Terminal status the run was in just before reopening. */
	fromStatus: 'done' | 'cancelled';
	/** Human-readable reason the run was reopened. */
	reason: string;
	/**
	 * Identifier for *who* / *what* caused the reopen:
	 * - `agent:<agentName>` — a peer agent sent a message.
	 * - `user` — a user message arrived.
	 * - `gate:<gateId>` — a gate's data changed.
	 */
	by: string;
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
	| WorkflowRunReopenedEvent
	| AgentAutoCompletedEvent
	| AgentCrashEvent
	| TaskRetryEvent
	| WorkflowRunNeedsAttentionEvent
	| TaskAwaitingApprovalEvent;

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
