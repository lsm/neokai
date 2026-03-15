/**
 * ConversationManager — tracks active Copilot sessions that are suspended
 * waiting for tool results.
 *
 * ## Why this exists
 *
 * The Anthropic API is stateless: every HTTP request carries the full message
 * history.  Tool use requires two requests:
 *
 *   Request 1: user prompt → model decides to call a tool
 *              → SSE: tool_use block, stop_reason: "tool_use"
 *   Request 2: tool_result in messages → model continues
 *              → SSE: more text, stop_reason: "end_turn"
 *
 * Between these requests the Copilot session must remain alive (its tool
 * handler Promise is still pending).  ConversationManager stores active
 * sessions keyed by their pending tool_call_id so Request 2 can find the
 * right session and resume it.
 *
 * ## Session reuse scope
 *
 * Only tool-use continuations reuse sessions.  Plain text responses use a
 * fresh session per request (session-per-request model avoids cross-session
 * contamination when a NeoKai chat session makes many independent calls).
 */

import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import type { AnthropicMessage, AnthropicTool } from './types.js';
import { extractToolResultIds, extractToolResultContent } from './prompt.js';
import { mapAnthropicToolsToSdkTools, ToolBridgeRegistry } from './tool-bridge.js';
import { Logger } from '../../logger.js';

const logger = new Logger('copilot-anthropic-conversation');

/** Inactive conversations are released after this many ms with no activity. */
const CONVERSATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveConversation {
	readonly session: CopilotSession;
	readonly registry: ToolBridgeRegistry;
}

export interface ToolResult {
	toolUseId: string;
	result: string;
}

// ---------------------------------------------------------------------------
// ConversationManager
// ---------------------------------------------------------------------------

export class ConversationManager {
	/** Maps pending tool_call_id → the conversation that is waiting for it. */
	private byToolCallId = new Map<string, ActiveConversation>();
	/** TTL timers keyed by conversation (using object identity). */
	private cleanupTimers = new Map<ActiveConversation, ReturnType<typeof setTimeout>>();

	// ---------------------------------------------------------------------------
	// Look-up
	// ---------------------------------------------------------------------------

	/**
	 * If the messages array ends with `tool_result` blocks that match a pending
	 * tool call, return the active conversation and the tool results to deliver.
	 * Returns `undefined` when this is a brand-new conversation.
	 */
	findContinuation(messages: AnthropicMessage[]):
		| {
				conv: ActiveConversation;
				toolResults: ToolResult[];
		  }
		| undefined {
		const ids = extractToolResultIds(messages);
		if (ids.length === 0) return undefined;

		for (const id of ids) {
			const conv = this.byToolCallId.get(id);
			if (!conv) continue;

			const toolResults: ToolResult[] = [];
			for (const toolUseId of ids) {
				const result = extractToolResultContent(messages, toolUseId);
				if (result !== undefined) {
					toolResults.push({ toolUseId, result });
				}
			}
			return { conv, toolResults };
		}
		return undefined;
	}

	// ---------------------------------------------------------------------------
	// Registration
	// ---------------------------------------------------------------------------

	/**
	 * Create a new conversation: instantiate a fresh Copilot session with the
	 * incoming Anthropic tool definitions registered as SDK external tools.
	 */
	async createConversation(
		client: CopilotClient,
		model: string,
		systemMessage: string | undefined,
		tools: AnthropicTool[],
		cwd: string
	): Promise<ActiveConversation> {
		const registry = new ToolBridgeRegistry();

		// Wire up: when the registry gets a pending tool call, register it here.
		registry.setOnPendingToolCall((toolCallId) => {
			this.byToolCallId.set(toolCallId, conv);
			this.scheduleCleanup(conv);
		});

		const sdkTools = mapAnthropicToolsToSdkTools(tools, registry);
		const toolNames = tools.map((t) => t.name);

		const session = await client.createSession({
			clientName: 'neokai-copilot-anthropic',
			model,
			streaming: true,
			// No disk persistence for bridged sessions — state is managed here.
			infiniteSessions: { enabled: false },
			workingDirectory: cwd,
			tools: sdkTools,
			// Restrict the model to only the caller-registered tools so it cannot
			// use Copilot's built-in bash/file tools autonomously.
			availableTools: toolNames,
			...(systemMessage
				? { systemMessage: { mode: 'replace' as const, content: systemMessage } }
				: {}),
			onPermissionRequest: () => Promise.resolve({ kind: 'approved' as const }),
			onUserInputRequest: () =>
				Promise.resolve({ answer: 'User input is not available in API mode.', wasFreeform: true }),
			hooks: {},
		});

		// conv is referenced inside the registry callback above so declare it with
		// a late-binding trick (immediately assigned below).
		const conv: ActiveConversation = { session, registry };
		// Patch: re-register the callback now that `conv` is defined.
		// (The previous registration used `conv` before it was initialized —
		//  we overwrite it here with the correct reference.)
		registry.setOnPendingToolCall((toolCallId) => {
			this.byToolCallId.set(toolCallId, conv);
			this.scheduleCleanup(conv);
		});

		return conv;
	}

	// ---------------------------------------------------------------------------
	// Deliver tool results
	// ---------------------------------------------------------------------------

	/**
	 * Route tool results from a follow-up HTTP request to the suspended handlers.
	 * Removes the tool_call_id mapping after delivery.
	 */
	deliverToolResults(conv: ActiveConversation, toolResults: ToolResult[]): void {
		for (const { toolUseId, result } of toolResults) {
			this.byToolCallId.delete(toolUseId);
			conv.registry.resolveToolResult(toolUseId, result);
		}
		// Cancel any TTL cleanup — the conversation is still active.
		this.cancelCleanup(conv);
	}

	// ---------------------------------------------------------------------------
	// Release
	// ---------------------------------------------------------------------------

	/**
	 * Release a completed conversation: disconnect the session, reject any
	 * still-pending tool calls, and remove all routing entries.
	 */
	async releaseConversation(conv: ActiveConversation): Promise<void> {
		this.cancelCleanup(conv);

		// Remove all tool_call_id entries for this conversation.
		for (const [id, c] of this.byToolCallId) {
			if (c === conv) this.byToolCallId.delete(id);
		}

		conv.registry.rejectAll(new Error('Conversation released'));

		await conv.session.disconnect().catch((err: unknown) => {
			logger.warn('Error disconnecting conversation session:', err);
		});
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private scheduleCleanup(conv: ActiveConversation): void {
		this.cancelCleanup(conv);
		const timer = setTimeout(() => {
			this.cleanupTimers.delete(conv);
			logger.warn('Conversation TTL expired — releasing stale session');
			this.releaseConversation(conv).catch(() => {});
		}, CONVERSATION_TTL_MS);
		this.cleanupTimers.set(conv, timer);
	}

	private cancelCleanup(conv: ActiveConversation): void {
		const timer = this.cleanupTimers.get(conv);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.cleanupTimers.delete(conv);
		}
	}
}
