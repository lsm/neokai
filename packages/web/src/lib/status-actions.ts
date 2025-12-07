/**
 * Status Actions Utility
 *
 * Extracts meaningful action verbs from SDK messages for the status indicator
 * Maps tool names and SDK events to human-readable action phrases
 */

import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';

// Fallback actions when we can't determine specific tool/action
const FALLBACK_ACTIONS = [
	'Thinking...',
	'Processing...',
	'Working...',
	'Analyzing...',
	'Considering...',
	'Computing...',
];

// Map tool names to action verbs (Claude Code style)
const TOOL_ACTION_MAP: Record<string, string> = {
	Read: 'Reading files...',
	Write: 'Writing files...',
	Edit: 'Editing files...',
	Bash: 'Running command...',
	Grep: 'Searching code...',
	Glob: 'Finding files...',
	Task: 'Starting agent...',
	WebFetch: 'Fetching web content...',
	WebSearch: 'Searching web...',
	SlashCommand: 'Running command...',
	NotebookEdit: 'Editing notebook...',
	// MCP tools
	mcp__chrome_devtools__take_snapshot: 'Taking snapshot...',
	mcp__chrome_devtools__click: 'Clicking element...',
	mcp__chrome_devtools__fill: 'Filling form...',
	mcp__chrome_devtools__navigate_page: 'Navigating page...',
	mcp__shadcn__search_items_in_registries: 'Searching components...',
	mcp__shadcn__view_items_in_registries: 'Viewing components...',
};

// Track last used fallback index to rotate through them
let lastFallbackIndex = -1;

/**
 * Get next random fallback action (rotates through list)
 */
function getNextFallbackAction(): string {
	lastFallbackIndex = (lastFallbackIndex + 1) % FALLBACK_ACTIONS.length;
	return FALLBACK_ACTIONS[lastFallbackIndex];
}

/**
 * Extract action from tool name
 */
function getActionFromToolName(toolName: string): string | null {
	// Check exact match first
	if (TOOL_ACTION_MAP[toolName]) {
		return TOOL_ACTION_MAP[toolName];
	}

	// Check if it starts with any known tool name (for MCP tools with prefixes)
	for (const [key, value] of Object.entries(TOOL_ACTION_MAP)) {
		if (toolName.includes(key)) {
			return value;
		}
	}

	// Try to extract readable name from MCP tools
	if (toolName.startsWith('mcp__')) {
		const parts = toolName.split('__');
		if (parts.length >= 3) {
			// mcp__service__action -> "Action..."
			const action = parts[parts.length - 1]
				.split('_')
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(' ');
			return `${action}...`;
		}
	}

	return null;
}

/**
 * Extract action verb from SDK message
 * Returns null if no specific action can be determined
 */
export function extractActionFromMessage(message: SDKMessage): string | null {
	// Assistant messages with tool use
	if (message.type === 'assistant' && Array.isArray(message.message.content)) {
		for (const block of message.message.content) {
			if (block.type === 'tool_use' && block.name) {
				const action = getActionFromToolName(block.name);
				if (action) return action;
			}
		}
	}

	// Stream events
	if (message.type === 'stream_event') {
		const { event } = message;

		// Content block start - check if it's thinking
		if (event.type === 'content_block_start') {
			if (event.content_block?.type === 'thinking') {
				return 'Thinking...';
			}
			if (event.content_block?.type === 'tool_use' && event.content_block.name) {
				const action = getActionFromToolName(event.content_block.name);
				if (action) return action;
			}
		}

		// Content block delta - check if it's text
		if (event.type === 'content_block_delta') {
			if (event.delta?.type === 'text_delta') {
				return 'Writing...';
			}
		}
	}

	return null;
}

/**
 * Get current action for status indicator
 * Uses extracted action from message or falls back to rotating list
 */
export function getCurrentAction(
	latestMessage: SDKMessage | null,
	isProcessing: boolean
): string | undefined {
	if (!isProcessing) {
		return undefined;
	}

	// Try to extract action from latest message
	if (latestMessage) {
		const extracted = extractActionFromMessage(latestMessage);
		if (extracted) {
			return extracted;
		}
	}

	// Fallback to rotating actions
	return getNextFallbackAction();
}
