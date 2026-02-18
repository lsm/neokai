/**
 * Message RPC Handlers
 */

import type { MessageHub } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import {
	isSDKAssistantMessage,
	isSDKUserMessage,
	isSDKUserMessageReplay,
	isSDKResultMessage,
	isTextBlock,
	isToolUseBlock,
	isThinkingBlock,
	type ContentBlock,
} from '@neokai/shared/sdk';
import type { SessionManager } from '../session-manager';
import { removeToolResultFromSessionFile } from '../sdk-session-file-manager';

export function setupMessageHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
	// Remove large task output from a message to reduce session size
	// This modifies the .jsonl file in ~/.claude/projects/ (SDK session storage)
	// No SDK initialization required - only file system operations
	messageHub.onRequest('message.removeOutput', async (data) => {
		const { sessionId: targetSessionId, messageUuid } = data as {
			sessionId: string;
			messageUuid: string;
		};

		// Get session metadata from database (no SDK initialization needed)
		const session = sessionManager.getSessionFromDB(targetSessionId);

		if (!session) {
			throw new Error('Session not found');
		}

		// Try to get SDK session ID from active session if available
		let sdkSessionId: string | null = null;
		const agentSession = sessionManager.getSession(targetSessionId);
		if (agentSession) {
			sdkSessionId = agentSession.getSDKSessionId();
		}

		// Remove tool_result from the .jsonl file
		// Pass both SDK session ID and NeoKai session ID for fallback search
		const success = removeToolResultFromSessionFile(
			session.workspacePath,
			sdkSessionId,
			messageUuid,
			targetSessionId
		);

		if (!success) {
			throw new Error('Failed to remove output from SDK session file');
		}

		// Mark output as removed in session metadata (for UI warning)
		await sessionManager.markOutputRemoved(targetSessionId, messageUuid);

		// Broadcast update via state channel to refresh UI
		// The client will reload messages after receiving this update
		messageHub.event(
			'sdk.message.updated',
			{ sessionId: targetSessionId, messageUuid },
			{ channel: `session:${targetSessionId}` }
		);

		return { success: true };
	});

	messageHub.onRequest('message.sdkMessages', async (data) => {
		const {
			sessionId: targetSessionId,
			limit,
			before,
			since,
		} = data as {
			sessionId: string;
			limit?: number;
			before?: number; // Cursor: get messages older than this timestamp
			since?: number; // Get messages newer than this timestamp
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);

		if (!agentSession) {
			throw new Error('Session not found');
		}

		const { messages: sdkMessages, hasMore } = agentSession.getSDKMessages(limit, before, since);
		return { sdkMessages, hasMore };
	});

	// Get total message count for a session (useful for pagination UI)
	messageHub.onRequest('message.count', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);

		if (!agentSession) {
			throw new Error('Session not found');
		}

		const count = agentSession.getSDKMessageCount();
		return { count };
	});

	// Export session to markdown or JSON
	messageHub.onRequest('session.export', async (data) => {
		const { sessionId: targetSessionId, format = 'markdown' } = data as {
			sessionId: string;
			format?: 'markdown' | 'json';
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);

		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Get all SDK messages (no limit)
		const { messages: sdkMessages } = agentSession.getSDKMessages(10000);
		const sessionData = agentSession.getSessionData();

		if (format === 'json') {
			return {
				session: sessionData,
				messages: sdkMessages,
			};
		}

		// Convert to markdown
		const markdown = convertToMarkdown(sessionData, sdkMessages);
		return { markdown };
	});
}

/**
 * Convert session and SDK messages to markdown format
 */
function convertToMarkdown(
	session: {
		id: string;
		title?: string;
		config: { model: string };
		createdAt: string;
	},
	messages: SDKMessage[]
): string {
	const lines: string[] = [];

	// Header
	lines.push(`# ${session.title || 'Untitled Session'}`);
	lines.push('');
	lines.push(`**Session ID:** ${session.id}`);
	lines.push(`**Model:** ${session.config.model}`);
	lines.push(`**Created:** ${session.createdAt}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	// Messages
	for (const msg of messages) {
		const formatted = formatMessage(msg);
		if (formatted) {
			lines.push(formatted);
			lines.push('');
		}
	}

	return lines.join('\n');
}

/**
 * Format a single SDK message to markdown
 */
function formatMessage(msg: SDKMessage): string | null {
	if (isSDKUserMessage(msg) || isSDKUserMessageReplay(msg)) {
		return formatUserMessage(msg);
	}

	if (isSDKAssistantMessage(msg)) {
		return formatAssistantMessage(msg);
	}

	if (isSDKResultMessage(msg)) {
		return formatResultMessage(msg);
	}

	// Skip other message types (system, stream_event, tool_progress, etc.)
	return null;
}

/**
 * Format user message to markdown
 */
function formatUserMessage(msg: Extract<SDKMessage, { type: 'user' }>): string {
	const lines: string[] = [];
	lines.push('## User');
	lines.push('');

	const content = msg.message?.content;
	if (typeof content === 'string') {
		lines.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (block.type === 'text') {
				lines.push(block.text);
			} else if (block.type === 'image') {
				lines.push('*[Image attached]*');
			}
		}
	}

	return lines.join('\n');
}

/**
 * Format assistant message to markdown
 */
function formatAssistantMessage(msg: Extract<SDKMessage, { type: 'assistant' }>): string {
	const lines: string[] = [];
	lines.push('## Assistant');
	lines.push('');

	const content = msg.message?.content;
	if (Array.isArray(content)) {
		for (const block of content as ContentBlock[]) {
			if (isTextBlock(block)) {
				lines.push(block.text);
				lines.push('');
			} else if (isToolUseBlock(block)) {
				lines.push(`### Tool Use: ${block.name}`);
				lines.push('');
				lines.push('```json');
				lines.push(JSON.stringify(block.input, null, 2));
				lines.push('```');
				lines.push('');
			} else if (isThinkingBlock(block)) {
				lines.push('<details>');
				lines.push('<summary>Thinking</summary>');
				lines.push('');
				lines.push(block.thinking);
				lines.push('');
				lines.push('</details>');
				lines.push('');
			}
		}
	}

	return lines.join('\n');
}

/**
 * Format result message to markdown
 */
function formatResultMessage(msg: Extract<SDKMessage, { type: 'result' }>): string {
	const lines: string[] = [];
	lines.push('## Result');
	lines.push('');

	if (msg.subtype === 'success') {
		lines.push('*Query completed successfully*');
	} else {
		lines.push(`*Error: ${msg.subtype}*`);
		// Error result messages have 'errors' array
		const errorMsg = msg as { errors?: string[] };
		if (errorMsg.errors && errorMsg.errors.length > 0) {
			lines.push('');
			lines.push('```');
			lines.push(errorMsg.errors.join('\n'));
			lines.push('```');
		}
	}

	return lines.join('\n');
}
