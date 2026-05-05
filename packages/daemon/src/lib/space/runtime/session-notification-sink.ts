/**
 * SessionNotificationSink — production NotificationSink implementation.
 *
 * Formats SpaceNotificationEvents into structured messages and injects them
 * into the Space Agent session via `sessionFactory.injectMessage()`.
 *
 * ## Delivery mode: `'defer'`
 *
 * Notifications use `deliveryMode: 'defer'` for non-blocking injection:
 * - If the Space Agent session is **idle**: the message is enqueued immediately
 *   and the agent processes it on the next turn.
 * - If the Space Agent session is **busy** (actively streaming a response or
 *   has a message queued): the message is persisted to the DB with status
 *   `'deferred'` and automatically replayed once the current turn completes.
 *
 * This ensures notifications are never dropped and never interrupt the agent
 * mid-response. The trade-off is a possible short delay if the agent is busy,
 * which is acceptable for event-driven coordination messages.
 *
 * ## Message format
 *
 * Messages use a `[TASK_EVENT]` prefix followed by structured JSON for reliable
 * prompt parsing, plus a human-readable summary for context. The space's
 * autonomy level is always included so the agent knows how much it can act
 * autonomously without human approval.
 */

import type { NotificationSink, SpaceNotificationEvent } from './notification-sink';
import type { SessionFactory } from '../../room/runtime/task-group-manager';
import type { SpaceAutonomyLevel } from '@neokai/shared/types/space';
import { Logger } from '../../logger';

const log = new Logger('session-notification-sink');

export interface SessionNotificationSinkConfig {
	/** The SessionFactory used to inject messages into sessions. */
	sessionFactory: SessionFactory;
	/**
	 * The session ID of the Space Agent's global session (e.g. the `spaces:global`
	 * session that receives coordination notifications).
	 */
	sessionId: string;
	/**
	 * The autonomy level for this space. Included in every notification message
	 * so the agent has context for how much it can act without human approval.
	 *
	 * Defaults to `1` (most supervised) if not provided.
	 */
	autonomyLevel?: SpaceAutonomyLevel;
}

/**
 * Production `NotificationSink` that formats events into human+LLM-readable
 * messages and injects them into the Space Agent session.
 *
 * Use `NullNotificationSink` instead when no Space Agent session is active.
 */
export class SessionNotificationSink implements NotificationSink {
	private readonly sessionFactory: SessionFactory;
	private readonly sessionId: string;
	private readonly autonomyLevel: SpaceAutonomyLevel;

	constructor(config: SessionNotificationSinkConfig) {
		this.sessionFactory = config.sessionFactory;
		this.sessionId = config.sessionId;
		this.autonomyLevel = config.autonomyLevel ?? 1;
	}

	async notify(event: SpaceNotificationEvent): Promise<void> {
		const message = formatEventMessage(event, this.autonomyLevel);
		try {
			await this.sessionFactory.injectMessage(this.sessionId, message, {
				deliveryMode: 'defer',
				origin: 'system',
				isSyntheticMessage: true,
			});
		} catch (err) {
			// Session not found or unavailable — log warning, do not propagate.
			// SpaceRuntime must not fail its tick loop due to notification errors.
			log.warn(
				`[SessionNotificationSink] Failed to inject notification into session ${this.sessionId} (event: ${event.kind}): ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------------------

/**
 * Format a `SpaceNotificationEvent` into a structured message string suitable
 * for injection into the Space Agent session.
 *
 * The message has three sections:
 * 1. `[TASK_EVENT] <kind>` — machine-parseable prefix + event kind
 * 2. Human-readable summary with context
 * 3. JSON payload for structured processing + autonomy level
 */
// Exported for use in tests that build realistic [TASK_EVENT] messages.
export function formatEventMessage(
	event: SpaceNotificationEvent,
	autonomyLevel: SpaceAutonomyLevel
): string {
	switch (event.kind) {
		case 'task_blocked':
			return formatTaskBlocked(event, autonomyLevel);
		case 'workflow_run_blocked':
			return formatWorkflowRunBlocked(event, autonomyLevel);
		case 'task_timeout':
			return formatTaskTimeout(event, autonomyLevel);
		case 'workflow_run_completed':
			return formatWorkflowRunCompleted(event, autonomyLevel);
		case 'workflow_run_reopened':
			return formatWorkflowRunReopened(event, autonomyLevel);
		case 'agent_auto_completed':
			return formatAgentAutoCompleted(event, autonomyLevel);
		case 'agent_crash':
			return formatAgentCrash(event, autonomyLevel);
		case 'agent_idle_non_terminal':
			return formatAgentIdleNonTerminal(event, autonomyLevel);
		case 'task_retry':
			return formatTaskRetry(event, autonomyLevel);
		case 'workflow_run_needs_attention':
			return formatWorkflowRunNeedsAttention(event, autonomyLevel);
		case 'task_awaiting_approval':
			return formatTaskAwaitingApproval(event, autonomyLevel);
	}
}

function formatTaskBlocked(
	event: {
		kind: 'task_blocked';
		spaceId: string;
		taskId: string;
		reason: string;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const humanReadable = `Task ${event.taskId} in space ${event.spaceId} is blocked: ${event.reason}`;
	const payload = {
		kind: event.kind,
		spaceId: event.spaceId,
		taskId: event.taskId,
		reason: event.reason,
		timestamp: event.timestamp,
		autonomyLevel,
	};
	return buildMessage(event.kind, humanReadable, payload);
}

function formatWorkflowRunBlocked(
	event: {
		kind: 'workflow_run_blocked';
		spaceId: string;
		runId: string;
		reason: string;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const humanReadable = `Workflow run ${event.runId} in space ${event.spaceId} is blocked: ${event.reason}`;
	const payload = {
		kind: event.kind,
		spaceId: event.spaceId,
		runId: event.runId,
		reason: event.reason,
		timestamp: event.timestamp,
		autonomyLevel,
	};
	return buildMessage(event.kind, humanReadable, payload);
}

function formatTaskTimeout(
	event: {
		kind: 'task_timeout';
		spaceId: string;
		taskId: string;
		elapsedMs: number;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const elapsedMin = Math.round(event.elapsedMs / 60000);
	const humanReadable = `Task ${event.taskId} in space ${event.spaceId} has been running for ${elapsedMin} minute(s) and may be stuck.`;
	const payload = {
		kind: event.kind,
		spaceId: event.spaceId,
		taskId: event.taskId,
		elapsedMs: event.elapsedMs,
		timestamp: event.timestamp,
		autonomyLevel,
	};
	return buildMessage(event.kind, humanReadable, payload);
}

function formatWorkflowRunCompleted(
	event: {
		kind: 'workflow_run_completed';
		spaceId: string;
		runId: string;
		status: 'done' | 'cancelled' | 'blocked';
		summary?: string;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const statusLabel =
		event.status === 'done'
			? 'completed successfully'
			: event.status === 'cancelled'
				? 'was cancelled'
				: 'ended and is blocked';
	const summaryPart = event.summary ? ` Summary: ${event.summary}` : '';
	const humanReadable = `Workflow run ${event.runId} in space ${event.spaceId} ${statusLabel}.${summaryPart}`;
	const payload: Record<string, unknown> = {
		kind: event.kind,
		spaceId: event.spaceId,
		runId: event.runId,
		status: event.status,
		timestamp: event.timestamp,
		autonomyLevel,
	};
	if (event.summary !== undefined) {
		payload['summary'] = event.summary;
	}
	return buildMessage(event.kind, humanReadable, payload);
}

function formatWorkflowRunReopened(
	event: {
		kind: 'workflow_run_reopened';
		spaceId: string;
		runId: string;
		fromStatus: 'done' | 'cancelled';
		reason: string;
		by: string;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const humanReadable =
		`Workflow run ${event.runId} in space ${event.spaceId} was reopened from '${event.fromStatus}' ` +
		`back to 'in_progress' (by: ${event.by}). Reason: ${event.reason}. ` +
		`A previously-finished task is active again; completion actions will not re-fire.`;
	const payload = {
		kind: event.kind,
		spaceId: event.spaceId,
		runId: event.runId,
		fromStatus: event.fromStatus,
		reason: event.reason,
		by: event.by,
		timestamp: event.timestamp,
		autonomyLevel,
	};
	return buildMessage(event.kind, humanReadable, payload);
}

function formatAgentAutoCompleted(
	event: {
		kind: 'agent_auto_completed';
		spaceId: string;
		taskId: string;
		elapsedMs: number;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const elapsedMinutes = Math.round(event.elapsedMs / 60_000);
	const humanReadable =
		`Task ${event.taskId} in space ${event.spaceId} was auto-completed after ${elapsedMinutes} minute(s) ` +
		`because the agent did not set task.reportedStatus within the configured timeout.`;
	return buildMessage(event.kind, humanReadable, {
		kind: event.kind,
		spaceId: event.spaceId,
		taskId: event.taskId,
		elapsedMs: event.elapsedMs,
		timestamp: event.timestamp,
		autonomyLevel,
	});
}

function formatAgentCrash(
	event: {
		kind: 'agent_crash';
		spaceId: string;
		taskId: string;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const humanReadable =
		`Task ${event.taskId} in space ${event.spaceId} encountered an agent crash. ` +
		`The task has been marked as blocked. ` +
		`Please investigate and retry the task when ready.`;
	const payload = {
		kind: event.kind,
		spaceId: event.spaceId,
		taskId: event.taskId,
		failureReason: 'agentCrash',
		timestamp: event.timestamp,
		autonomyLevel,
	};
	return buildMessage(event.kind, humanReadable, payload);
}

function formatAgentIdleNonTerminal(
	event: {
		kind: 'agent_idle_non_terminal';
		spaceId: string;
		taskId: string;
		runId: string;
		executionId: string;
		nodeId: string;
		agentName: string;
		reason: string;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const humanReadable =
		`Node ${event.nodeId} (${event.agentName}) in workflow run ${event.runId} went idle with a non-terminal last message. ` +
		`The runtime will not advance the workflow from this idle state. Reason: ${event.reason}`;
	return buildMessage(event.kind, humanReadable, {
		kind: event.kind,
		spaceId: event.spaceId,
		taskId: event.taskId,
		runId: event.runId,
		executionId: event.executionId,
		nodeId: event.nodeId,
		agentName: event.agentName,
		reason: event.reason,
		timestamp: event.timestamp,
		autonomyLevel,
	});
}

function formatTaskRetry(
	event: {
		kind: 'task_retry';
		spaceId: string;
		taskId: string;
		runId: string;
		originalReason: string;
		attemptNumber: number;
		maxAttempts: number;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const humanReadable =
		`Task ${event.taskId} in space ${event.spaceId} was blocked (reason: ${event.originalReason}). ` +
		`The runtime is automatically retrying (attempt ${event.attemptNumber}/${event.maxAttempts}). ` +
		`The blocked node execution has been reset to pending and will be re-spawned.`;
	return buildMessage(event.kind, humanReadable, {
		kind: event.kind,
		spaceId: event.spaceId,
		taskId: event.taskId,
		runId: event.runId,
		originalReason: event.originalReason,
		attemptNumber: event.attemptNumber,
		maxAttempts: event.maxAttempts,
		timestamp: event.timestamp,
		autonomyLevel,
	});
}

function formatWorkflowRunNeedsAttention(
	event: {
		kind: 'workflow_run_needs_attention';
		spaceId: string;
		runId: string;
		taskId: string;
		reason: string;
		retriesExhausted: number;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const humanReadable =
		`Workflow run ${event.runId} in space ${event.spaceId} needs attention. ` +
		`The runtime exhausted ${event.retriesExhausted} automatic retry attempt(s). ` +
		`Reason: ${event.reason}. ` +
		`Please investigate and take action: retry with updated instructions, reassign, cancel, or escalate to the human.`;
	return buildMessage(event.kind, humanReadable, {
		kind: event.kind,
		spaceId: event.spaceId,
		runId: event.runId,
		taskId: event.taskId,
		reason: event.reason,
		retriesExhausted: event.retriesExhausted,
		timestamp: event.timestamp,
		autonomyLevel,
	});
}

function formatTaskAwaitingApproval(
	event: {
		kind: 'task_awaiting_approval';
		spaceId: string;
		taskId: string;
		actionId: string;
		actionName: string;
		actionDescription?: string;
		actionType: 'script' | 'instruction' | 'mcp_call';
		requiredLevel: number;
		spaceLevel: number;
		autonomyLevel: number;
		timestamp: string;
	},
	autonomyLevel: SpaceAutonomyLevel
): string {
	const descPart = event.actionDescription ? ` — ${event.actionDescription}` : '';
	const humanReadable =
		`Task ${event.taskId} in space ${event.spaceId} is awaiting approval for completion action ` +
		`'${event.actionName}' (type: ${event.actionType})${descPart}. ` +
		`Requires autonomy ${event.requiredLevel}, space is at ${event.spaceLevel}. ` +
		`Review the action and approve or reject to resume the task.`;
	const payload: Record<string, unknown> = {
		kind: event.kind,
		spaceId: event.spaceId,
		taskId: event.taskId,
		actionId: event.actionId,
		actionName: event.actionName,
		actionType: event.actionType,
		requiredLevel: event.requiredLevel,
		spaceLevel: event.spaceLevel,
		timestamp: event.timestamp,
		autonomyLevel,
	};
	if (event.actionDescription !== undefined) {
		payload['actionDescription'] = event.actionDescription;
	}
	return buildMessage(event.kind, humanReadable, payload);
}

function buildMessage(
	kind: string,
	humanReadable: string,
	payload: Record<string, unknown>
): string {
	return [
		`[TASK_EVENT] ${kind}`,
		'',
		humanReadable,
		'',
		`Autonomy level: ${payload['autonomyLevel']}`,
		'',
		'```json',
		JSON.stringify(payload, null, 2),
		'```',
	].join('\n');
}
