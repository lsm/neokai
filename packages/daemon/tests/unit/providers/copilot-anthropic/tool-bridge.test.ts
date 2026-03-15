/**
 * Tests for copilot-anthropic/tool-bridge.ts
 */

import { describe, expect, it } from 'bun:test';
import type { ServerResponse } from 'node:http';
import {
	ToolBridgeRegistry,
	mapAnthropicToolsToSdkTools,
} from '../../../../src/lib/providers/copilot-anthropic/tool-bridge';
import type { AnthropicTool } from '../../../../src/lib/providers/copilot-anthropic/types';
import { AnthropicStreamWriter } from '../../../../src/lib/providers/copilot-anthropic/sse';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes(): { written: string[]; ended: boolean; res: ServerResponse } {
	const written: string[] = [];
	let ended = false;
	const res = {
		writeHead: () => {},
		write: (chunk: string) => {
			written.push(chunk);
			return true;
		},
		end: () => {
			ended = true;
		},
	} as unknown as ServerResponse;
	return { written, ended, res };
}

// ---------------------------------------------------------------------------
// ToolBridgeRegistry
// ---------------------------------------------------------------------------

describe('ToolBridgeRegistry', () => {
	it('resolveToolResult returns false for unknown id', () => {
		const reg = new ToolBridgeRegistry();
		expect(reg.resolveToolResult('unknown', 'result')).toBe(false);
	});

	it('hasPending returns false initially', () => {
		const reg = new ToolBridgeRegistry();
		expect(reg.hasPending()).toBe(false);
	});

	it('emitToolUseAndWait resolves when resolveToolResult is called', async () => {
		const reg = new ToolBridgeRegistry();
		const writer = new AnthropicStreamWriter();
		const { res } = makeRes();
		writer.start(res, 'model');
		reg.setActiveResponse(writer, res);

		const promise = reg.emitToolUseAndWait('tc_1', 'bash', { command: 'ls' });
		expect(reg.hasPending()).toBe(true);
		expect(reg.pendingIds()).toContain('tc_1');

		const resolved = reg.resolveToolResult('tc_1', 'output here');
		expect(resolved).toBe(true);

		const result = await promise;
		expect(result).toBe('output here');
		expect(reg.hasPending()).toBe(false);
	});

	it('emitToolUseAndWait throws when no active response', async () => {
		const reg = new ToolBridgeRegistry();
		await expect(reg.emitToolUseAndWait('tc_1', 'bash', {})).rejects.toThrow(
			'no active SSE response'
		);
	});

	it('rejectAll rejects all pending promises', async () => {
		const reg = new ToolBridgeRegistry();
		const writer = new AnthropicStreamWriter();
		const { res } = makeRes();
		writer.start(res, 'model');
		reg.setActiveResponse(writer, res);
		const p1 = reg.emitToolUseAndWait('tc_1', 'bash', {});

		// emitToolUseAndWait cleared the active response after writing,
		// so set it again for the second call.
		const { res: res2 } = makeRes();
		const writer2 = new AnthropicStreamWriter();
		writer2.start(res2, 'model');
		reg.setActiveResponse(writer2, res2);
		const p2 = reg.emitToolUseAndWait('tc_2', 'read', {});

		// Attach catch handlers before rejectAll to prevent unhandled-rejection throws in Bun.
		void p1.catch(() => {});
		void p2.catch(() => {});
		reg.rejectAll(new Error('session closed'));

		await expect(p1).rejects.toThrow('session closed');
		await expect(p2).rejects.toThrow('session closed');
		expect(reg.hasPending()).toBe(false);
	});

	it('calls onToolUseEmitted callback after writing SSE', async () => {
		const reg = new ToolBridgeRegistry();
		const writer = new AnthropicStreamWriter();
		const { res } = makeRes();
		writer.start(res, 'model');
		reg.setActiveResponse(writer, res);

		let emittedId: string | null = null;
		reg.setOnToolUseEmitted((id) => {
			emittedId = id;
		});

		const promise = reg.emitToolUseAndWait('tc_x', 'myTool', {});
		expect(emittedId).toBe('tc_x');

		reg.resolveToolResult('tc_x', 'done');
		await promise;
	});

	it('calls onPendingToolCall callback when tool call is suspended', async () => {
		const reg = new ToolBridgeRegistry();
		const writer = new AnthropicStreamWriter();
		const { res } = makeRes();
		writer.start(res, 'model');
		reg.setActiveResponse(writer, res);

		let pendingId: string | null = null;
		reg.setOnPendingToolCall((id) => {
			pendingId = id;
		});

		const promise = reg.emitToolUseAndWait('tc_y', 'tool', {});
		expect(pendingId).toBe('tc_y');

		reg.resolveToolResult('tc_y', 'ok');
		await promise;
	});
});

// ---------------------------------------------------------------------------
// mapAnthropicToolsToSdkTools
// ---------------------------------------------------------------------------

describe('mapAnthropicToolsToSdkTools', () => {
	it('creates one SDK tool per Anthropic tool', () => {
		const tools: AnthropicTool[] = [
			{ name: 'bash', input_schema: { type: 'object' } },
			{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } },
		];
		const reg = new ToolBridgeRegistry();
		const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
		expect(sdkTools.length).toBe(2);
		expect(sdkTools[0].name).toBe('bash');
		expect(sdkTools[1].name).toBe('read_file');
	});

	it('sets overridesBuiltInTool on all tools', () => {
		const tools: AnthropicTool[] = [{ name: 'bash', input_schema: {} }];
		const reg = new ToolBridgeRegistry();
		const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
		expect(sdkTools[0].overridesBuiltInTool).toBe(true);
	});

	it('uses description from AnthropicTool when provided', () => {
		const tools: AnthropicTool[] = [
			{ name: 'myTool', description: 'does stuff', input_schema: {} },
		];
		const reg = new ToolBridgeRegistry();
		const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
		expect(sdkTools[0].description).toBe('does stuff');
	});

	it('falls back to "Tool: {name}" description when none provided', () => {
		const tools: AnthropicTool[] = [{ name: 'anon', input_schema: {} }];
		const reg = new ToolBridgeRegistry();
		const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
		expect(sdkTools[0].description).toBe('Tool: anon');
	});

	it('tool handler calls emitToolUseAndWait and resolves with tool result', async () => {
		const tools: AnthropicTool[] = [{ name: 'bash', input_schema: {} }];
		const reg = new ToolBridgeRegistry();
		const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);

		// Set up active response
		const writer = new AnthropicStreamWriter();
		const { res } = makeRes();
		writer.start(res, 'model');
		reg.setActiveResponse(writer, res);

		// Start the handler — it suspends
		const handlerResult = sdkTools[0].handler(
			{ command: 'echo hi' },
			{ sessionId: 's1', toolCallId: 'tc_1', toolName: 'bash', arguments: { command: 'echo hi' } }
		) as Promise<unknown>;

		// Resolve it
		reg.resolveToolResult('tc_1', 'hi\n');

		const result = await handlerResult;
		expect((result as Record<string, unknown>)['textResultForLlm']).toBe('hi\n');
	});
});
