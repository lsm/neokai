/**
 * SessionNotificationSink — production NotificationSink implementation.
 *
 * Formats SpaceNotificationEvents into structured messages and injects them
 * into the Space Agent session via `sessionFactory.injectMessage()`.
 *
 * ## Delivery mode: `'next_turn'`
 *
 * Notifications use `deliveryMode: 'next_turn'` for non-blocking injection:
 * - If the Space Agent session is **idle**: the message is enqueued immediately
 *   and the agent processes it on the next turn.
 * - If the Space Agent session is **busy** (actively streaming a response or
 *   has a message queued): the message is persisted to the DB with status
 *   `'saved'` and automatically replayed once the current turn completes.
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
import type { AutonomyLevel } from '@neokai/shared';
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
	 * Defaults to `'supervised'` if not provided.
	 */
	autonomyLevel?: AutonomyLevel;
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
	private readonly autonomyLevel: AutonomyLevel;

	constructor(config: SessionNotificationSinkConfig) {
		this.sessionFactory = config.sessionFactory;
		this.sessionId = config.sessionId;
		this.autonomyLevel = config.autonomyLevel ?? 'supervised';
	}

	async notify(event: SpaceNotificationEvent): Promise<void> {
		const message = formatEventMessage(event, this.autonomyLevel);
		try {
			await this.sessionFactory.injectMessage(this.sessionId, message, {
				deliveryMode: 'next_turn',
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
export function formatEventMessage(
	event: SpaceNotificationEvent,
	autonomyLevel: AutonomyLevel
): string {
	switch (event.kind) {
		case 'task_needs_attention':
			return formatTaskNeedsAttention(event, autonomyLevel);
		case 'workflow_run_needs_attention':
			return formatWorkflowRunNeedsAttention(event, autonomyLevel);
		case 'task_timeout':
			return formatTaskTimeout(event, autonomyLevel);
		case 'workflow_run_completed':
			return formatWorkflowRunCompleted(event, autonomyLevel);
	}
}

function formatTaskNeedsAttention(
	event: {
		kind: 'task_needs_attention';
		spaceId: string;
		taskId: string;
		reason: string;
		timestamp: string;
	},
	autonomyLevel: AutonomyLevel
): string {
	const humanReadable = `Task ${event.taskId} in space ${event.spaceId} needs attention: ${event.reason}`;
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

function formatWorkflowRunNeedsAttention(
	event: {
		kind: 'workflow_run_needs_attention';
		spaceId: string;
		runId: string;
		reason: string;
		timestamp: string;
	},
	autonomyLevel: AutonomyLevel
): string {
	const humanReadable = `Workflow run ${event.runId} in space ${event.spaceId} needs attention: ${event.reason}`;
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
	autonomyLevel: AutonomyLevel
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
		status: 'completed' | 'cancelled' | 'needs_attention';
		summary?: string;
		timestamp: string;
	},
	autonomyLevel: AutonomyLevel
): string {
	const statusLabel =
		event.status === 'completed'
			? 'completed successfully'
			: event.status === 'cancelled'
				? 'was cancelled'
				: 'ended and needs attention';
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
