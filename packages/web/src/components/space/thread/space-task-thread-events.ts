import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import {
	type ContentBlock,
	isSDKAssistantMessage,
	isSDKRateLimitEvent,
	isSDKResultMessage,
	isSDKSystemMessage,
	isSDKToolProgressMessage,
	isSDKUserMessage,
	isTextBlock,
	isThinkingBlock,
	isToolUseBlock,
} from '@neokai/shared/sdk/type-guards';
import type { SpaceTaskThreadMessageRow } from '../../../hooks/useSpaceTaskMessages';

export type SpaceTaskThreadEventKind =
	| 'thinking'
	| 'tool'
	| 'subagent'
	| 'text'
	| 'user'
	| 'system'
	| 'result'
	| 'rate_limit'
	| 'progress'
	| 'unknown';

export type SpaceTaskThreadRenderMode = 'verbose' | 'compact' | 'roster';

export interface ParsedThreadRow {
	id: string | number;
	sessionId: string | null;
	label: string;
	taskId: string;
	taskTitle: string;
	createdAt: number;
	message: SDKMessage | null;
	fallbackText: string | null;
}

export interface SpaceTaskThreadEvent {
	id: string;
	label: string;
	taskId: string;
	taskTitle: string;
	sessionId: string | null;
	createdAt: number;
	kind: SpaceTaskThreadEventKind;
	title: string;
	summary: string;
	message?: SDKMessage | null;
	systemSubtype?: string;
	resultSubtype?: string;
	isError?: boolean;
}

function oneLine(value: string, max = 180): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	if (!collapsed) return '';
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function normalizeMultiline(value: string): string {
	return value.replace(/\r\n/g, '\n').trim();
}

function summarizeInputValue(value: unknown): string {
	if (value == null) return 'none';
	if (typeof value === 'string') return oneLine(value, 120);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const compact = value
			.slice(0, 2)
			.map((item) => summarizeInputValue(item))
			.join(', ');
		return value.length > 2 ? `[${compact}, +${value.length - 2}]` : `[${compact}]`;
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj);
		if (keys.length === 0) return '{}';
		if (typeof obj.query === 'string') return `query: ${oneLine(obj.query, 120)}`;
		const fields = keys.slice(0, 2).join(', ');
		return keys.length > 2 ? `{${fields}, +${keys.length - 2}}` : `{${fields}}`;
	}
	return oneLine(String(value), 120);
}

function summarizeToolInput(input: Record<string, unknown>): string {
	const keys = Object.keys(input);
	if (keys.length === 0) return 'No input';

	const entries = keys.slice(0, 3).map((key) => `${key}: ${summarizeInputValue(input[key])}`);
	const summary = entries.join(' · ');
	return keys.length > 3 ? `${summary} · +${keys.length - 3} fields` : summary;
}

function extractUserText(message: Extract<SDKMessage, { type: 'user' }>): string {
	const content = message.message?.content;
	if (typeof content === 'string') return oneLine(content);
	if (!Array.isArray(content)) return '';

	const textParts: string[] = [];
	for (const block of content) {
		const blockObj = block as Record<string, unknown>;
		if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
			textParts.push(blockObj.text);
		}
	}
	return oneLine(textParts.join(' '));
}

function extractAssistantEvents(
	row: ParsedThreadRow,
	message: Extract<SDKMessage, { type: 'assistant' }>
) {
	const events: SpaceTaskThreadEvent[] = [];
	const content = Array.isArray(message.message?.content)
		? (message.message.content as ContentBlock[])
		: [];

	for (let idx = 0; idx < content.length; idx += 1) {
		const block = content[idx];
		const eventId = `${String(row.id)}-assistant-${idx}`;

		if (isThinkingBlock(block)) {
			events.push({
				id: eventId,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'thinking',
				title: 'Thinking',
				summary: oneLine(block.thinking),
			});
			continue;
		}

		if (isToolUseBlock(block)) {
			const isSubagent = block.name === 'Task';
			const input = (block.input ?? {}) as Record<string, unknown>;
			const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent';
			const description = typeof input.description === 'string' ? input.description : '';
			const toolSummary =
				isSubagent && description
					? `${subagentType} · ${oneLine(description)}`
					: summarizeToolInput(input);

			events.push({
				id: eventId,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: isSubagent ? 'subagent' : 'tool',
				title: isSubagent ? 'Sub-agent' : `Tool · ${block.name}`,
				summary: toolSummary || block.name,
			});
			continue;
		}

		if (isTextBlock(block)) {
			const text = normalizeMultiline(block.text);
			if (!text) continue;
			events.push({
				id: eventId,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'text',
				title: row.label,
				summary: text,
				message,
			});
		}
	}

	if (events.length === 0) {
		events.push({
			id: `${String(row.id)}-assistant-empty`,
			label: row.label,
			taskId: row.taskId,
			taskTitle: row.taskTitle,
			sessionId: row.sessionId,
			createdAt: row.createdAt,
			kind: 'text',
			title: row.label,
			summary: 'Assistant updated context',
			message,
		});
	}

	return events;
}

export function parseThreadRow(row: SpaceTaskThreadMessageRow): ParsedThreadRow {
	try {
		const parsed = JSON.parse(row.content) as SDKMessage;
		const withTimestamp = {
			...(parsed as Record<string, unknown>),
			timestamp: row.createdAt,
		} as unknown as SDKMessage;

		return {
			id: row.id,
			sessionId: row.sessionId,
			label: row.label,
			taskId: row.taskId,
			taskTitle: row.taskTitle,
			createdAt: row.createdAt,
			message: withTimestamp,
			fallbackText: null,
		};
	} catch {
		return {
			id: row.id,
			sessionId: row.sessionId,
			label: row.label,
			taskId: row.taskId,
			taskTitle: row.taskTitle,
			createdAt: row.createdAt,
			message: null,
			fallbackText: row.content,
		};
	}
}

export function buildThreadEvents(parsedRows: ParsedThreadRow[]): SpaceTaskThreadEvent[] {
	const events: SpaceTaskThreadEvent[] = [];

	for (const row of parsedRows) {
		if (!row.message) {
			events.push({
				id: `${String(row.id)}-fallback`,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'unknown',
				title: 'Raw',
				summary: oneLine(row.fallbackText ?? ''),
				message: row.message,
			});
			continue;
		}

		if (isSDKAssistantMessage(row.message)) {
			events.push(...extractAssistantEvents(row, row.message));
			continue;
		}

		if (isSDKUserMessage(row.message)) {
			events.push({
				id: `${String(row.id)}-user`,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'user',
				title: 'User',
				summary: extractUserText(row.message) || 'User message',
				message: row.message,
			});
			continue;
		}

		if (isSDKToolProgressMessage(row.message)) {
			const progressSummary = oneLine(
				`${row.message.tool_name} · ${Math.max(0, Math.round(row.message.elapsed_time_seconds))}s`
			);
			events.push({
				id: `${String(row.id)}-progress`,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'progress',
				title: 'Tool Progress',
				summary: progressSummary,
				message: row.message,
			});
			continue;
		}

		if (isSDKResultMessage(row.message)) {
			events.push({
				id: `${String(row.id)}-result`,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'result',
				title: row.message.subtype === 'success' ? 'Completed' : 'Error',
				summary: `${row.message.usage.input_tokens}→${row.message.usage.output_tokens} tokens`,
				message: row.message,
				resultSubtype: row.message.subtype,
				isError: row.message.subtype !== 'success',
			});
			continue;
		}

		if (isSDKRateLimitEvent(row.message)) {
			const rateLimitInfo = row.message.rate_limit_info;
			// Only surface hard-rejected rate-limit states in compact/roster feeds.
			// `allowed` / `allowed_warning` are informational noise here, even if
			// overageStatus contains warnings or restrictions.
			const isRejected = rateLimitInfo.status === 'rejected';
			const rateLimitType = rateLimitInfo.rateLimitType
				? rateLimitInfo.rateLimitType.replace(/_/g, ' ')
				: 'rate limit';
			events.push({
				id: `${String(row.id)}-rate-limit`,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'rate_limit',
				title: 'Rate Limit',
				summary: `${rateLimitType} · ${rateLimitInfo.status}`,
				message: row.message,
				isError: isRejected,
			});
			continue;
		}

		if (isSDKSystemMessage(row.message)) {
			const subtype = row.message.subtype ?? 'system';
			let summary = subtype.replace(/_/g, ' ');

			if (subtype === 'task_progress' && 'description' in row.message) {
				summary = oneLine(String(row.message.description ?? 'task progress'));
			} else if (subtype === 'task_notification' && 'summary' in row.message) {
				summary = oneLine(String(row.message.summary ?? 'task notification'));
			} else if (subtype === 'status' && 'status' in row.message) {
				summary = oneLine(String(row.message.status ?? 'status updated'));
			}

			events.push({
				id: `${String(row.id)}-system`,
				label: row.label,
				taskId: row.taskId,
				taskTitle: row.taskTitle,
				sessionId: row.sessionId,
				createdAt: row.createdAt,
				kind: 'system',
				title: 'System',
				summary,
				message: row.message,
				systemSubtype: subtype,
			});
			continue;
		}

		events.push({
			id: `${String(row.id)}-unknown`,
			label: row.label,
			taskId: row.taskId,
			taskTitle: row.taskTitle,
			sessionId: row.sessionId,
			createdAt: row.createdAt,
			kind: 'unknown',
			title: String(row.message.type),
			summary: oneLine(JSON.stringify(row.message)),
			message: row.message,
		});
	}

	return events;
}
