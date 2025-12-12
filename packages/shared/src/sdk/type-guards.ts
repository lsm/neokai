/**
 * Type guards for SDK message types
 *
 * These type guards enable type-safe discrimination of SDK message union types.
 */

import type { SDKMessage } from './sdk.d.ts';

// ============================================================================
// Message Type Guards
// ============================================================================

/**
 * Check if message is an Assistant message
 */
export function isSDKAssistantMessage(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'assistant' }> {
	return msg.type === 'assistant';
}

/**
 * Check if message is a User message
 */
export function isSDKUserMessage(msg: SDKMessage): msg is Extract<SDKMessage, { type: 'user' }> {
	const msgWithReplay = msg as SDKMessage & { isReplay?: boolean };
	return msg.type === 'user' && (!('isReplay' in msg) || msgWithReplay.isReplay === false);
}

/**
 * Check if message is a User message replay
 */
export function isSDKUserMessageReplay(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'user'; isReplay: true }> {
	return msg.type === 'user' && 'isReplay' in msg && msg.isReplay === true;
}

/**
 * Check if message is a Result message (any subtype)
 */
export function isSDKResultMessage(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'result' }> {
	return msg.type === 'result';
}

/**
 * Check if message is a successful Result message
 */
export function isSDKResultSuccess(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'result'; subtype: 'success' }> {
	return msg.type === 'result' && msg.subtype === 'success';
}

/**
 * Check if message is an error Result message
 */
export function isSDKResultError(msg: SDKMessage): msg is Extract<
	SDKMessage,
	{
		type: 'result';
		subtype:
			| 'error_during_execution'
			| 'error_max_turns'
			| 'error_max_budget_usd'
			| 'error_max_structured_output_retries';
	}
> {
	return msg.type === 'result' && msg.subtype !== 'success';
}

/**
 * Check if message is a System message (any subtype)
 */
export function isSDKSystemMessage(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'system' }> {
	return msg.type === 'system';
}

/**
 * Check if message is a System init message
 */
export function isSDKSystemInit(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
	return msg.type === 'system' && msg.subtype === 'init';
}

/**
 * Check if message is a compact boundary message
 */
export function isSDKCompactBoundary(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'system'; subtype: 'compact_boundary' }> {
	return msg.type === 'system' && msg.subtype === 'compact_boundary';
}

/**
 * Check if message is a status message
 */
export function isSDKStatusMessage(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'system'; subtype: 'status' }> {
	return msg.type === 'system' && msg.subtype === 'status';
}

/**
 * Check if message is a hook response message
 */
export function isSDKHookResponse(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'system'; subtype: 'hook_response' }> {
	return msg.type === 'system' && msg.subtype === 'hook_response';
}

/**
 * Check if message is a stream event (partial assistant message)
 */
export function isSDKStreamEvent(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'stream_event' }> {
	return msg.type === 'stream_event';
}

/**
 * Check if message is a tool progress message
 */
export function isSDKToolProgressMessage(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'tool_progress' }> {
	return msg.type === 'tool_progress';
}

/**
 * Check if message is an auth status message
 */
export function isSDKAuthStatusMessage(
	msg: SDKMessage
): msg is Extract<SDKMessage, { type: 'auth_status' }> {
	return msg.type === 'auth_status';
}

// ============================================================================
// Content Block Type Guards (for Assistant messages)
// ============================================================================

/**
 * Type for content blocks from APIAssistantMessage
 */
export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'thinking'; thinking: string };

/**
 * Check if content block is a text block
 */
export function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
	return block.type === 'text';
}

/**
 * Check if content block is a tool use block
 */
export function isToolUseBlock(
	block: ContentBlock
): block is Extract<ContentBlock, { type: 'tool_use' }> {
	return block.type === 'tool_use';
}

/**
 * Check if content block is a thinking block
 */
export function isThinkingBlock(
	block: ContentBlock
): block is Extract<ContentBlock, { type: 'thinking' }> {
	return block.type === 'thinking';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get a human-readable description of a message type
 */
export function getMessageTypeDescription(msg: SDKMessage): string {
	if (isSDKAssistantMessage(msg)) {
		return 'Assistant Response';
	}
	if (isSDKUserMessage(msg)) {
		return 'User Message';
	}
	if (isSDKUserMessageReplay(msg)) {
		return 'User Message (Replay)';
	}
	if (isSDKResultSuccess(msg)) {
		return 'Query Success';
	}
	if (isSDKResultError(msg)) {
		return `Query Error: ${msg.subtype.replace('error_', '')}`;
	}
	if (isSDKSystemInit(msg)) {
		return 'Session Initialized';
	}
	if (isSDKCompactBoundary(msg)) {
		return 'Compaction Boundary';
	}
	if (isSDKStatusMessage(msg)) {
		return `Status: ${msg.status || 'unknown'}`;
	}
	if (isSDKHookResponse(msg)) {
		return `Hook Response: ${msg.hook_name}`;
	}
	if (isSDKStreamEvent(msg)) {
		return 'Streaming Event';
	}
	if (isSDKToolProgressMessage(msg)) {
		return `Tool Progress: ${msg.tool_name}`;
	}
	if (isSDKAuthStatusMessage(msg)) {
		return 'Authentication Status';
	}
	return 'Unknown Message';
}

/**
 * Check if a message should be displayed to the user (vs internal system messages)
 */
export function isUserVisibleMessage(msg: SDKMessage): boolean {
	// User should see: assistant, user, result, tool_progress, auth_status, user replays (slash command responses), compaction messages
	// User should NOT see: stream events (these are intermediate), compact_boundary, compacting status
	if (isSDKStreamEvent(msg)) return false;

	// Hide compact_boundary system messages
	if (isSDKCompactBoundary(msg)) return false;

	// Hide compacting status messages
	if (isSDKStatusMessage(msg) && msg.status === 'compacting') return false;

	return true;
}
