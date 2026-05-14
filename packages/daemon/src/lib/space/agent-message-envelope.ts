export type AgentMessageLevel = 'space-agent' | 'task-agent' | 'node-agent';

export interface FormatAgentMessageOptions {
	fromLevel: AgentMessageLevel;
	fromAgentName: string;
	toLevel: AgentMessageLevel;
	body: string;
	/** Parent task UUID. Required for Space Agent reply instructions when known. */
	taskId?: string | null;
	/** Space-scoped task number for human-readable context. */
	taskNumber?: number | null;
	/** Sender/target node agent name for reply routing. */
	nodeId?: string | null;
	/**
	 * Session ID that should receive the reply when the target agent responds
	 * via `send_message({ target: 'space-agent' })`. When set, the routing
	 * layer delivers the reply to this session instead of the default
	 * `space:chat:${spaceId}`. Null/undefined means "use default routing".
	 */
	replyToSessionId?: string | null;
}

function taskLabel(taskNumber?: number | null): string {
	return typeof taskNumber === 'number' ? ` (task #${taskNumber})` : '';
}

function replyTargetSuffix(options: FormatAgentMessageOptions): string {
	if (options.fromLevel !== 'node-agent') return '';
	const target = options.nodeId ?? options.fromAgentName;
	return ` and target node "${target}"`;
}

/**
 * Build the reply-routing metadata footer appended to messages that carry
 * `replyToSessionId`. The footer is a machine-readable XML block that the
 * routing layer parses when the receiving agent replies via
 * `send_message({ target: 'space-agent' })`.
 */
function replyRoutingFooter(options: FormatAgentMessageOptions): string {
	if (!options.replyToSessionId) return '';
	return `\n\n<reply-routing replyToSessionId="${options.replyToSessionId}" />`;
}

/**
 * Format an inter-agent runtime message envelope.
 *
 * Agents pass only the raw body to their messaging tools; runtime delivery code
 * calls this helper immediately before injecting the message into the receiver's
 * session so the transcript records sender identity and concise reply guidance.
 *
 * When `replyToSessionId` is set, a `<reply-routing>` XML block is appended.
 * The routing layer extracts this when the agent replies via
 * `send_message({ target: 'space-agent' })` to deliver the reply back to the
 * originating session instead of the default `space:chat:${spaceId}`.
 */
export function formatAgentMessage(options: FormatAgentMessageOptions): string {
	const body = options.body;
	const footer = replyRoutingFooter(options);

	if (options.toLevel === 'space-agent') {
		const task = taskLabel(options.taskNumber);
		const taskId = options.taskId ? ` with task_id="${options.taskId}"` : '';
		return (
			`─── Message from ${options.fromAgentName}${task} ───\n\n` +
			`${body}${footer}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message_to_task${taskId}${replyTargetSuffix(options)}`
		);
	}

	if (options.fromLevel === 'space-agent') {
		return (
			`─── Message from Space Agent ───\n\n` +
			`${body}${footer}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "space-agent"`
		);
	}

	if (options.fromLevel === 'node-agent' && options.toLevel === 'node-agent') {
		return `─── Message from ${options.fromAgentName} ───\n\n${body}${footer}`;
	}

	if (options.fromLevel === 'node-agent' && options.toLevel === 'task-agent') {
		return (
			`─── Message from ${options.fromAgentName}${taskLabel(options.taskNumber)} ───\n\n` +
			`${body}${footer}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "${options.fromAgentName}"`
		);
	}

	if (options.fromLevel === 'task-agent' && options.toLevel === 'node-agent') {
		return (
			`─── Message from task-agent${taskLabel(options.taskNumber)} ───\n\n` +
			`${body}${footer}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "task-agent"`
		);
	}

	return `─── Message from ${options.fromAgentName} ───\n\n${body}${footer}`;
}

/**
 * Extract `replyToSessionId` from a message envelope's `<reply-routing>` footer.
 * Returns `null` when the footer is absent (no routing metadata).
 * Used by the pending-message flush path to recover routing after daemon restart.
 */
export function extractReplyToSessionId(message: string): string | null {
	const match = message.match(/<reply-routing replyToSessionId="([^"]+)" \/>/);
	return match ? match[1] : null;
}
