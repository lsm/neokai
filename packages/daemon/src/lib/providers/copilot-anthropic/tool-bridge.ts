/**
 * Tool-use bridge — maps Anthropic tool definitions to Copilot SDK Tool objects
 * and bridges tool_use / tool_result across two separate HTTP requests.
 *
 * ## Protocol mapping
 *
 * Anthropic tool-use protocol (client-side):
 *   Request 1: { tools: [toolA], messages: [...] }
 *     ← Response 1 (SSE): content_block { type:"tool_use", id, name, input }
 *                          stop_reason: "tool_use"
 *   Request 2: { messages: [..., tool_use, { type:"tool_result", tool_use_id: id }] }
 *     ← Response 2 (SSE): continued stream → stop_reason: "end_turn"
 *
 * Copilot SDK tool protocol (embedded in streaming session):
 *   session.send(prompt)
 *     → tool handler called: (args, invocation) => Promise<result>
 *       [handler suspends — waits for tool_result]
 *     → handler resumed with result → model continues streaming
 *
 * The bridge connects these two: the tool handler emits a tool_use SSE block,
 * ends the HTTP response, then suspends.  When Request 2 arrives its
 * tool_result is routed here via resolveToolResult(), resuming the handler.
 */

import type { Tool, ToolInvocation } from '@github/copilot-sdk';
import type { ServerResponse } from 'node:http';
import type { AnthropicTool } from './types.js';
import { AnthropicStreamWriter } from './sse.js';

/** How long (ms) a suspended tool handler waits for a tool_result before timing out. */
const TOOL_RESULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// ToolBridgeRegistry
// ---------------------------------------------------------------------------

/**
 * Manages the active SSE response and pending tool-handler Promises for one
 * Copilot session.
 *
 * Lifecycle:
 * 1. Created when a session is created (with tools).
 * 2. `setActiveResponse()` is called at the start of each streaming request.
 * 3. When the Copilot model calls a tool, the tool handler calls
 *    `emitToolUseAndWait()` which writes the SSE tool_use block and suspends.
 * 4. The next HTTP request calls `resolveToolResult()` to resume the handler.
 * 5. `rejectAll()` is called on error or session release to clean up.
 */
export class ToolBridgeRegistry {
	private pending = new Map<
		string,
		{
			resolve: (result: string) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	private activeWriter: AnthropicStreamWriter | null = null;
	private activeRes: ServerResponse | null = null;

	/** Callback invoked when a tool_use block has been emitted (and response ended). */
	private onToolUseEmitted: ((toolCallId: string) => void) | null = null;

	/** Callback invoked when a pending tool call ID is registered. */
	private onPendingToolCall: ((toolCallId: string) => void) | null = null;

	// ---------------------------------------------------------------------------
	// Response management
	// ---------------------------------------------------------------------------

	/** Set the active SSE writer + response for the current HTTP request. */
	setActiveResponse(writer: AnthropicStreamWriter, res: ServerResponse): void {
		this.activeWriter = writer;
		this.activeRes = res;
	}

	/** Clear the active response (called after tool_use SSE is emitted). */
	clearActiveResponse(): void {
		this.activeWriter = null;
		this.activeRes = null;
	}

	// ---------------------------------------------------------------------------
	// Callbacks used by the streaming loop
	// ---------------------------------------------------------------------------

	/** Register a callback to be notified when a tool_use is emitted (response ended). */
	setOnToolUseEmitted(cb: (toolCallId: string) => void): void {
		this.onToolUseEmitted = cb;
	}

	/** Register a callback to be notified when a pending tool call ID is stored. */
	setOnPendingToolCall(cb: (toolCallId: string) => void): void {
		this.onPendingToolCall = cb;
	}

	// ---------------------------------------------------------------------------
	// Tool handler core
	// ---------------------------------------------------------------------------

	/**
	 * Called from a Copilot SDK tool handler.
	 *
	 * 1. Captures the active SSE writer/response.
	 * 2. Emits a `tool_use` SSE block and ends the HTTP response.
	 * 3. Suspends until `resolveToolResult()` is called with the matching ID.
	 * 4. Returns the tool result string to the Copilot SDK so the model can continue.
	 */
	async emitToolUseAndWait(
		toolCallId: string,
		toolName: string,
		toolInput: unknown
	): Promise<string> {
		const writer = this.activeWriter;
		const res = this.activeRes;

		if (!writer || !res) {
			throw new Error(
				`ToolBridgeRegistry: no active SSE response when tool "${toolName}" was called. ` +
					'This is a bug — setActiveResponse() must be called before session.send().'
			);
		}

		// Clear first so the close-handler on req cannot double-write.
		this.clearActiveResponse();

		// Write the tool_use SSE block and end the response.
		writer.sendToolUse(res, toolCallId, toolName, toolInput);

		// Notify the streaming loop that the response has been ended.
		this.onToolUseEmitted?.(toolCallId);

		// Suspend until the tool_result arrives from the next HTTP request.
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(toolCallId);
				reject(new Error(`Tool call "${toolName}" (${toolCallId}) timed out waiting for result`));
			}, TOOL_RESULT_TIMEOUT_MS);

			this.pending.set(toolCallId, { resolve, reject, timer });
			// Notify ConversationManager so it can route the next request here.
			this.onPendingToolCall?.(toolCallId);
		});
	}

	// ---------------------------------------------------------------------------
	// Tool result routing
	// ---------------------------------------------------------------------------

	/**
	 * Route a tool_result from the client to the suspended tool handler.
	 *
	 * @returns `true` if there was a matching pending handler, `false` otherwise.
	 */
	resolveToolResult(toolCallId: string, result: string): boolean {
		const pending = this.pending.get(toolCallId);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pending.delete(toolCallId);
		pending.resolve(result);
		return true;
	}

	/**
	 * Reject all pending tool handlers (called on session error or release).
	 */
	rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	/** `true` when there are tool handlers suspended waiting for results. */
	hasPending(): boolean {
		return this.pending.size > 0;
	}

	/** IDs of all currently pending tool calls. */
	pendingIds(): string[] {
		return [...this.pending.keys()];
	}
}

// ---------------------------------------------------------------------------
// mapAnthropicToolsToSdkTools
// ---------------------------------------------------------------------------

/**
 * Convert Anthropic tool definitions into Copilot SDK `Tool` objects.
 *
 * Each tool handler uses the registry to emit a `tool_use` SSE block and
 * suspend until the API caller provides the corresponding `tool_result`.
 *
 * `overridesBuiltInTool: true` is set on all tools so that Copilot CLI
 * built-in tools with the same name (e.g. "bash") are overridden rather than
 * causing a registration error.  For tool names that do not clash with a
 * built-in the flag is harmless.
 */
export function mapAnthropicToolsToSdkTools(
	tools: AnthropicTool[],
	registry: ToolBridgeRegistry
): Tool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description ?? `Tool: ${tool.name}`,
		parameters: tool.input_schema,
		overridesBuiltInTool: true,
		handler: async (args: unknown, invocation: ToolInvocation) => {
			const result = await registry.emitToolUseAndWait(invocation.toolCallId, tool.name, args);
			return { textResultForLlm: result, resultType: 'success' as const };
		},
	}));
}
