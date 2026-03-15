/**
 * Anthropic SSE stream helpers.
 *
 * AnthropicStreamWriter writes the correct sequence of SSE events expected by
 * the Claude Agent SDK.  It tracks open text-blocks and handles both the
 * normal end-turn completion path and the tool-use suspension path.
 *
 * Adapted from copilot-sdk-proxy/claude/streaming.ts (MIT).
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Headers & low-level helper
// ---------------------------------------------------------------------------

export const SSE_HEADERS: Record<string, string> = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
	'X-Accel-Buffering': 'no',
};

export function sendEvent(res: ServerResponse, type: string, data: object): void {
	res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// AnthropicStreamWriter
// ---------------------------------------------------------------------------

/**
 * Stateful SSE writer for one Anthropic streaming response.
 *
 * Sequence guaranteed by `start()` → zero or more `flushDeltas()` →
 * one of `sendCompleted()` | `sendFailed()` | `sendToolUse()`.
 */
export class AnthropicStreamWriter {
	private textBlockStarted = false;
	private nextBlockIndex = 0;
	private textBlockIndex = 0;
	readonly messageId = `msg_${randomUUID()}`;

	private closeTextBlock(res: ServerResponse): void {
		if (this.textBlockStarted) {
			sendEvent(res, 'content_block_stop', {
				type: 'content_block_stop',
				index: this.textBlockIndex,
			});
			this.nextBlockIndex = this.textBlockIndex + 1;
			this.textBlockStarted = false;
		}
	}

	private ensureTextBlock(res: ServerResponse): void {
		if (!this.textBlockStarted) {
			this.textBlockIndex = this.nextBlockIndex;
			sendEvent(res, 'content_block_start', {
				type: 'content_block_start',
				index: this.textBlockIndex,
				content_block: { type: 'text', text: '' },
			});
			this.textBlockStarted = true;
		}
	}

	private sendEpilogue(res: ServerResponse, stopReason: string): void {
		sendEvent(res, 'message_delta', {
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 0 },
		});
		sendEvent(res, 'message_stop', { type: 'message_stop' });
	}

	/** Write the `message_start` preamble and set SSE response headers. */
	start(res: ServerResponse, model: string): void {
		res.writeHead(200, SSE_HEADERS);
		sendEvent(res, 'message_start', {
			type: 'message_start',
			message: {
				id: this.messageId,
				type: 'message',
				role: 'assistant',
				content: [],
				model,
				stop_reason: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
	}

	/** Flush accumulated text deltas to the stream. */
	flushDeltas(res: ServerResponse, deltas: string[]): void {
		if (deltas.length === 0) return;
		this.ensureTextBlock(res);
		for (const text of deltas) {
			sendEvent(res, 'content_block_delta', {
				type: 'content_block_delta',
				index: this.textBlockIndex,
				delta: { type: 'text_delta', text },
			});
		}
	}

	/** Emit a `tool_use` content block and end the SSE stream with `stop_reason: "tool_use"`.
	 *
	 * After this call the HTTP response is ended (`res.end()` is called).  The
	 * Copilot session remains alive — its tool handler is still suspended waiting
	 * for the tool result that will arrive in the next HTTP request.
	 */
	sendToolUse(res: ServerResponse, toolCallId: string, toolName: string, toolInput: unknown): void {
		this.closeTextBlock(res);
		const blockIndex = this.nextBlockIndex++;
		sendEvent(res, 'content_block_start', {
			type: 'content_block_start',
			index: blockIndex,
			content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} },
		});
		sendEvent(res, 'content_block_delta', {
			type: 'content_block_delta',
			index: blockIndex,
			delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
		});
		sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
		this.sendEpilogue(res, 'tool_use');
		res.end();
	}

	/**
	 * Emit an `end_turn` epilogue.
	 *
	 * Closes the open text block (if any) and sends the epilogue.  Does NOT
	 * force an empty text block when no text was ever emitted — tool-only
	 * responses have an empty `content` array which is valid per the spec.
	 */
	sendCompleted(res: ServerResponse): void {
		this.closeTextBlock(res);
		this.sendEpilogue(res, 'end_turn');
	}

	/** Emit an `end_turn` epilogue (best-effort — called on error paths). */
	sendFailed(res: ServerResponse): void {
		if (this.textBlockStarted) {
			sendEvent(res, 'content_block_stop', {
				type: 'content_block_stop',
				index: this.textBlockIndex,
			});
		}
		this.sendEpilogue(res, 'end_turn');
	}
}
