import type { SDKMessage } from '@neokai/shared/sdk';

export interface MessageSearchParams {
	query: string;
	sessionId?: string;
	limit?: number;
	offset?: number;
	from?: number;
	to?: number;
	messageType?: string;
}

export interface MessageSearchLoadTarget {
	sessionId: string;
	before?: number;
}

export interface MessageSearchResult {
	kind: 'message' | 'task';
	sourceId: string;
	messageId?: string;
	sessionId?: string;
	taskId?: string;
	spaceId?: string;
	taskNumber?: number;
	messageType?: string;
	title: string;
	snippet: string;
	timestamp: number;
	loadTarget?: MessageSearchLoadTarget;
	rank: number;
}

export interface MessageSearchResponse {
	results: MessageSearchResult[];
	limit: number;
	offset: number;
}

export function extractVisibleSearchText(message: SDKMessage | Record<string, unknown>): string {
	const parts: string[] = [];
	const msg = message as Record<string, unknown>;
	const sdkMessage = msg.message as Record<string, unknown> | undefined;
	const content = sdkMessage?.content;

	if (typeof content === 'string') {
		parts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === 'text' && typeof block.text === 'string') {
				parts.push(block.text);
			} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
				parts.push(block.thinking);
			}
		}
	}

	if (msg.type === 'result' && typeof msg.result === 'string') {
		parts.push(msg.result);
	}

	if (msg.type === 'neokai_action') {
		for (const key of ['title', 'message', 'question', 'prompt', 'action']) {
			const value = msg[key];
			if (typeof value === 'string') parts.push(value);
		}
	}

	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join('\n\n');
}

export function buildFtsQuery(query: string): string {
	const terms = query
		.trim()
		.split(/\s+/)
		.map((term) => term.replaceAll('"', '""').replace(/[^\p{L}\p{N}_-]/gu, ''))
		.filter(Boolean)
		.slice(0, 12);
	return terms.map((term) => `"${term}"*`).join(' ');
}
