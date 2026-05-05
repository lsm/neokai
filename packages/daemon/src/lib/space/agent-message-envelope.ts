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
 * Format an inter-agent runtime message envelope.
 *
 * Agents pass only the raw body to their messaging tools; runtime delivery code
 * calls this helper immediately before injecting the message into the receiver's
 * session so the transcript records sender identity and concise reply guidance.
 */
export function formatAgentMessage(options: FormatAgentMessageOptions): string {
	const body = options.body;

	if (options.toLevel === 'space-agent') {
		const task = taskLabel(options.taskNumber);
		const taskId = options.taskId ? ` with task_id="${options.taskId}"` : '';
		return (
			`─── Message from ${options.fromAgentName}${task} ───\n\n` +
			`${body}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message_to_task${taskId}${replyTargetSuffix(options)}`
		);
	}

	if (options.fromLevel === 'space-agent') {
		return (
			`─── Message from Space Agent ───\n\n` +
			`${body}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "space-agent"`
		);
	}

	if (options.fromLevel === 'node-agent' && options.toLevel === 'node-agent') {
		return `─── Message from ${options.fromAgentName} ───\n\n${body}`;
	}

	if (options.fromLevel === 'node-agent' && options.toLevel === 'task-agent') {
		return (
			`─── Message from ${options.fromAgentName}${taskLabel(options.taskNumber)} ───\n\n` +
			`${body}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "${options.fromAgentName}"`
		);
	}

	if (options.fromLevel === 'task-agent' && options.toLevel === 'node-agent') {
		return (
			`─── Message from task-agent${taskLabel(options.taskNumber)} ───\n\n` +
			`${body}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "task-agent"`
		);
	}

	return `─── Message from ${options.fromAgentName} ───\n\n${body}`;
}
