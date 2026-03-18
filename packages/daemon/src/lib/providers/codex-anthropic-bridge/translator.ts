/**
 * Codex Anthropic Bridge — Translator
 *
 * Converts between Anthropic Messages API types and Codex Dynamic Tools format.
 * Provides SSE builder helpers for emitting Anthropic-format streaming events.
 */

// ---------------------------------------------------------------------------
// Anthropic Messages API types (minimal subset needed by the bridge)
// ---------------------------------------------------------------------------

export type AnthropicContentBlockText = {
	type: 'text';
	text: string;
};

export type AnthropicContentBlockToolUse = {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
};

export type AnthropicContentBlockToolResult = {
	type: 'tool_result';
	tool_use_id: string;
	content: string | Array<{ type: 'text'; text: string }>;
};

export type AnthropicContentBlock =
	| AnthropicContentBlockText
	| AnthropicContentBlockToolUse
	| AnthropicContentBlockToolResult;

export type AnthropicMessage = {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
};

export type AnthropicRequest = {
	model: string;
	messages: AnthropicMessage[];
	system?: string | Array<{ type: 'text'; text: string }>;
	tools?: AnthropicTool[];
	max_tokens?: number;
	stream?: boolean;
};

// ---------------------------------------------------------------------------
// Codex Dynamic Tools format
// ---------------------------------------------------------------------------

export type CodexDynamicTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	deferLoading: boolean;
};

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Codex app-server reserves tool name prefixes that contain `__` (double underscore).
 * MCP tool names use the convention `mcp__<server>__<tool>` which triggers this
 * restriction. Translate `__` → `_` before registering with Codex and reverse the
 * mapping when Codex calls the tool back.
 *
 * Example: `mcp__myserver__echo` → registered as `mcp_myserver_echo`
 *          Codex calls back with `mcp_myserver_echo` → restored to `mcp__myserver__echo`
 */
export function toCodexToolName(name: string): string {
	return name.replaceAll('__', '_');
}

/**
 * Build a map from codex tool name → original tool name for reverse lookup on
 * tool call interception. Only names that were translated (contained `__`) are included.
 *
 * Throws if two original names produce the same Codex name after translation (fail-fast
 * collision detection).  Example of a collision: `mcp__a_b__c` and `mcp__a__b_c` both
 * translate to `mcp_a_b_c`.  Callers must rename one of the conflicting tools before
 * registering them with the bridge.
 */
export function buildToolNameReverseMap(originalNames: string[]): Map<string, string> {
	const map = new Map<string, string>();
	/** codexName → first original name that produced it (for collision messages) */
	const seen = new Map<string, string>();

	for (const name of originalNames) {
		const codexName = toCodexToolName(name);
		const existing = seen.get(codexName);
		if (existing !== undefined && existing !== name) {
			throw new Error(
				`Tool name collision: "${existing}" and "${name}" both translate to ` +
					`"${codexName}" for Codex. Rename one of the tools to avoid the conflict.`
			);
		}
		seen.set(codexName, name);
		if (codexName !== name) {
			map.set(codexName, name);
		}
	}
	return map;
}

/** Convert Anthropic tools to Codex Dynamic Tools format. */
export function buildDynamicTools(tools: AnthropicTool[]): CodexDynamicTool[] {
	return tools.map((t) => ({
		name: toCodexToolName(t.name),
		description: t.description ?? '',
		inputSchema: t.input_schema,
		deferLoading: false,
	}));
}

/** Extract plain text from an Anthropic system field. */
export function extractSystemText(system: AnthropicRequest['system'] | undefined): string {
	if (!system) return '';
	if (typeof system === 'string') return system;
	return system.map((b) => b.text).join('\n');
}

/** Extract plain text from an Anthropic message content field. */
export function extractContentText(content: AnthropicMessage['content']): string {
	if (typeof content === 'string') return content;
	return content
		.filter((b): b is AnthropicContentBlockText => b.type === 'text')
		.map((b) => b.text)
		.join('');
}

/**
 * Check whether the last user message contains tool_result blocks.
 * Used to distinguish tool-continuation requests from new conversation turns.
 */
export function isToolResultContinuation(messages: AnthropicMessage[]): boolean {
	const last = messages.at(-1);
	if (!last || last.role !== 'user') return false;
	if (typeof last.content === 'string') return false;
	return last.content.some((b) => b.type === 'tool_result');
}

export type ToolResult = {
	toolUseId: string;
	text: string;
};

/** Extract tool results from the last user message. */
export function extractToolResults(messages: AnthropicMessage[]): ToolResult[] {
	const last = messages.at(-1);
	if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
	return last.content
		.filter((b): b is AnthropicContentBlockToolResult => b.type === 'tool_result')
		.map((b) => ({
			toolUseId: b.tool_use_id,
			text: typeof b.content === 'string' ? b.content : b.content.map((c) => c.text).join(''),
		}));
}

/**
 * Build a single text string representing the full conversation for Codex.
 *
 * Codex receives one text message per turn. For multi-turn conversations
 * the full history is serialised as context prefix so Codex has the
 * necessary background. The last user message becomes the turn input.
 */
export function buildConversationText(messages: AnthropicMessage[], system?: string): string {
	const parts: string[] = [];

	if (system) {
		parts.push(`<system>\n${system}\n</system>`);
	}

	// All messages except the last user message become the conversation context.
	const history = messages.slice(0, -1);
	if (history.length > 0) {
		parts.push('<conversation>');
		for (const msg of history) {
			const role = msg.role === 'user' ? 'User' : 'Assistant';
			const text = extractContentText(msg.content);
			if (text) parts.push(`${role}: ${text}`);
		}
		parts.push('</conversation>');
	}

	// The last user message is the current input.
	const lastMsg = messages.at(-1);
	const currentText = lastMsg ? extractContentText(lastMsg.content) : '';
	parts.push(currentText);

	return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// SSE helpers — emit Anthropic streaming event strings
// ---------------------------------------------------------------------------

const SSE_SEP = '\n\n';

function sseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}${SSE_SEP}`;
}

export function pingSSE(): string {
	return sseEvent('ping', { type: 'ping' });
}

export function messageStartSSE(messageId: string, model: string, inputTokens: number): string {
	return sseEvent('message_start', {
		type: 'message_start',
		message: {
			id: messageId,
			type: 'message',
			role: 'assistant',
			content: [],
			model,
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: inputTokens, output_tokens: 1 },
		},
	});
}

export function contentBlockStartTextSSE(index: number): string {
	return sseEvent('content_block_start', {
		type: 'content_block_start',
		index,
		content_block: { type: 'text', text: '' },
	});
}

export function contentBlockStartToolUseSSE(
	index: number,
	toolUseId: string,
	name: string
): string {
	return sseEvent('content_block_start', {
		type: 'content_block_start',
		index,
		content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
	});
}

export function textDeltaSSE(index: number, text: string): string {
	return sseEvent('content_block_delta', {
		type: 'content_block_delta',
		index,
		delta: { type: 'text_delta', text },
	});
}

export function inputJsonDeltaSSE(index: number, partialJson: string): string {
	return sseEvent('content_block_delta', {
		type: 'content_block_delta',
		index,
		delta: { type: 'input_json_delta', partial_json: partialJson },
	});
}

export function contentBlockStopSSE(index: number): string {
	return sseEvent('content_block_stop', {
		type: 'content_block_stop',
		index,
	});
}

export function messageDeltaSSE(
	stopReason: 'end_turn' | 'tool_use' | 'max_tokens',
	outputTokens: number
): string {
	return sseEvent('message_delta', {
		type: 'message_delta',
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: outputTokens },
	});
}

export function messageStopSSE(): string {
	return sseEvent('message_stop', { type: 'message_stop' });
}

/** Anthropic-standard error types used in both HTTP envelopes and SSE error events. */
export type AnthropicErrorType =
	| 'invalid_request_error'
	| 'authentication_error'
	| 'not_found_error'
	| 'api_error'
	| 'overloaded_error';

export function errorSSE(errorType: AnthropicErrorType, message: string): string {
	return sseEvent('error', { type: 'error', error: { type: errorType, message } });
}
