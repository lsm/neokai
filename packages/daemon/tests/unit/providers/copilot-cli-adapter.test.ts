/**
 * Unit tests for GitHub Copilot CLI Adapter
 *
 * Tests pure conversion functions that translate between NeoKai SDK format
 * and GitHub Copilot CLI NDJSON format. No subprocess spawning.
 */

import { describe, expect, it } from 'bun:test';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { UUID } from 'crypto';
import {
	extractTextFromUserMessage,
	parseCopilotJsonlEvent,
	copilotMessageToSdkAssistant,
	copilotResultToSdkResult,
	createCopilotStreamEvent,
	createCopilotSystemInitMessage,
	type CopilotMessageData,
	type CopilotResultData,
} from '../../../src/lib/providers/copilot-cli-adapter';

// ---------------------------------------------------------------------------
// extractTextFromUserMessage
// ---------------------------------------------------------------------------

describe('extractTextFromUserMessage', () => {
	it('should return string content as-is', () => {
		const msg: SDKUserMessage = {
			type: 'user',
			uuid: '00000000-0000-0000-0000-000000000001' as UUID,
			session_id: 'test-session',
			message: { role: 'user', content: 'Hello, world!' },
			parent_tool_use_id: null,
		};
		expect(extractTextFromUserMessage(msg)).toBe('Hello, world!');
	});

	it('should extract text from a single text block', () => {
		const msg: SDKUserMessage = {
			type: 'user',
			uuid: '00000000-0000-0000-0000-000000000002' as UUID,
			session_id: 'test-session',
			message: {
				role: 'user',
				content: [{ type: 'text', text: 'Single text block' }],
			},
			parent_tool_use_id: null,
		};
		expect(extractTextFromUserMessage(msg)).toBe('Single text block');
	});

	it('should join multiple text blocks with newlines', () => {
		const msg: SDKUserMessage = {
			type: 'user',
			uuid: '00000000-0000-0000-0000-000000000003' as UUID,
			session_id: 'test-session',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'First part' },
					{ type: 'text', text: 'Second part' },
				],
			},
			parent_tool_use_id: null,
		};
		expect(extractTextFromUserMessage(msg)).toBe('First part\nSecond part');
	});

	it('should skip non-text blocks (images)', () => {
		const msg: SDKUserMessage = {
			type: 'user',
			uuid: '00000000-0000-0000-0000-000000000004' as UUID,
			session_id: 'test-session',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'Look at this' },
					{
						type: 'image',
						source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
					},
				],
			},
			parent_tool_use_id: null,
		};
		expect(extractTextFromUserMessage(msg)).toBe('Look at this');
	});

	it('should skip tool_result blocks', () => {
		const msg: SDKUserMessage = {
			type: 'user',
			uuid: '00000000-0000-0000-0000-000000000005' as UUID,
			session_id: 'test-session',
			message: {
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'tool-123',
						content: 'Tool output',
					},
				],
			},
			parent_tool_use_id: null,
		};
		expect(extractTextFromUserMessage(msg)).toBe('');
	});

	it('should return empty string for empty content array', () => {
		const msg: SDKUserMessage = {
			type: 'user',
			uuid: '00000000-0000-0000-0000-000000000006' as UUID,
			session_id: 'test-session',
			message: { role: 'user', content: [] },
			parent_tool_use_id: null,
		};
		expect(extractTextFromUserMessage(msg)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// parseCopilotJsonlEvent
// ---------------------------------------------------------------------------

describe('parseCopilotJsonlEvent', () => {
	it('should parse a valid NDJSON event', () => {
		const line = JSON.stringify({
			type: 'assistant.message_delta',
			data: { delta: 'Hello' },
			id: 'evt-001',
			timestamp: '2026-03-14T00:00:00.000Z',
			ephemeral: true,
		});
		const result = parseCopilotJsonlEvent(line);
		expect(result).not.toBeNull();
		expect(result?.type).toBe('assistant.message_delta');
		expect((result?.data as { delta: string }).delta).toBe('Hello');
		expect(result?.ephemeral).toBe(true);
	});

	it('should return null for empty line', () => {
		expect(parseCopilotJsonlEvent('')).toBeNull();
		expect(parseCopilotJsonlEvent('   ')).toBeNull();
		expect(parseCopilotJsonlEvent('\n')).toBeNull();
	});

	it('should return null for invalid JSON', () => {
		expect(parseCopilotJsonlEvent('{invalid json}')).toBeNull();
		expect(parseCopilotJsonlEvent('not json at all')).toBeNull();
	});

	it('should return null for JSON without type field', () => {
		const line = JSON.stringify({ data: { delta: 'Hello' }, id: 'evt-001' });
		expect(parseCopilotJsonlEvent(line)).toBeNull();
	});

	it('should return null for non-object JSON', () => {
		expect(parseCopilotJsonlEvent('"just a string"')).toBeNull();
		expect(parseCopilotJsonlEvent('42')).toBeNull();
		expect(parseCopilotJsonlEvent('null')).toBeNull();
	});

	it('should parse result event', () => {
		const line = JSON.stringify({
			type: 'result',
			data: {
				sessionId: 'session_abc123',
				exitCode: 0,
				usage: { premiumRequests: 1, totalApiDurationMs: 5234 },
			},
			id: 'result-001',
			timestamp: '2026-03-14T00:00:05.234Z',
		});
		const result = parseCopilotJsonlEvent(line);
		expect(result?.type).toBe('result');
		const data = result?.data as { sessionId: string; exitCode: number };
		expect(data.sessionId).toBe('session_abc123');
		expect(data.exitCode).toBe(0);
	});

	it('should handle events with parentId', () => {
		const line = JSON.stringify({
			type: 'assistant.turn_end',
			data: {},
			id: 'evt-002',
			timestamp: '2026-03-14T00:00:00.000Z',
			parentId: 'turn_xyz',
		});
		const result = parseCopilotJsonlEvent(line);
		expect(result?.parentId).toBe('turn_xyz');
	});
});

// ---------------------------------------------------------------------------
// copilotMessageToSdkAssistant
// ---------------------------------------------------------------------------

describe('copilotMessageToSdkAssistant', () => {
	it('should convert text content to SDK assistant message', () => {
		const data: CopilotMessageData = {
			content: [{ type: 'text', text: 'Here is my response.' }],
		};
		const result = copilotMessageToSdkAssistant(data, 'session-1');
		expect(result.type).toBe('assistant');
		expect(result.session_id).toBe('session-1');
		expect(result.parent_tool_use_id).toBeNull();
		expect(result.message.role).toBe('assistant');
		const content = result.message.content as Array<{ type: string; text?: string }>;
		expect(content[0]).toEqual({ type: 'text', text: 'Here is my response.' });
	});

	it('should map toolRequests to tool_use blocks', () => {
		const data: CopilotMessageData = {
			content: [{ type: 'text', text: 'Running bash...' }],
			toolRequests: [{ id: 'tool_abc', name: 'bash', arguments: { command: 'ls -la' } }],
		};
		const result = copilotMessageToSdkAssistant(data, 'session-1');
		const content = result.message.content as Array<{
			type: string;
			id?: string;
			name?: string;
			input?: Record<string, unknown>;
		}>;
		const toolUse = content.find((b) => b.type === 'tool_use');
		expect(toolUse).toBeDefined();
		expect(toolUse?.id).toBe('tool_abc');
		expect(toolUse?.name).toBe('bash');
		expect(toolUse?.input).toEqual({ command: 'ls -la' });
	});

	it('should prepend reasoningText as a thinking block', () => {
		const data: CopilotMessageData = {
			content: [{ type: 'text', text: 'Answer' }],
			reasoningText: 'Let me analyze this carefully.',
		};
		const result = copilotMessageToSdkAssistant(data, 'session-1');
		const content = result.message.content as Array<{ type: string; text?: string }>;
		expect(content[0].type).toBe('text');
		expect(content[0].text).toBe('<thinking>Let me analyze this carefully.</thinking>');
		expect(content[1].text).toBe('Answer');
	});

	it('should handle empty content and toolRequests', () => {
		const data: CopilotMessageData = {};
		const result = copilotMessageToSdkAssistant(data, 'session-1');
		const content = result.message.content as Array<unknown>;
		expect(content).toHaveLength(0);
	});

	it('should generate unique UUIDs for each call', () => {
		const data: CopilotMessageData = { content: [{ type: 'text', text: 'hi' }] };
		const r1 = copilotMessageToSdkAssistant(data, 's');
		const r2 = copilotMessageToSdkAssistant(data, 's');
		expect(r1.uuid).not.toBe(r2.uuid);
	});

	it('should handle multiple content blocks', () => {
		const data: CopilotMessageData = {
			content: [
				{ type: 'text', text: 'Part 1' },
				{ type: 'text', text: 'Part 2' },
			],
		};
		const result = copilotMessageToSdkAssistant(data, 'session-1');
		const content = result.message.content as Array<{ type: string; text?: string }>;
		expect(content).toHaveLength(2);
		expect(content[0].text).toBe('Part 1');
		expect(content[1].text).toBe('Part 2');
	});

	it('should skip non-text content blocks', () => {
		const data: CopilotMessageData = {
			content: [
				{ type: 'text', text: 'Valid text' },
				{ type: 'image_url', text: undefined }, // Not a text block
			],
		};
		const result = copilotMessageToSdkAssistant(data, 'session-1');
		const content = result.message.content as Array<{ type: string }>;
		// Only the text block and no image block should be in content
		const textBlocks = content.filter((b) => b.type === 'text');
		expect(textBlocks).toHaveLength(1);
	});

	it('should handle toolRequests with no arguments', () => {
		const data: CopilotMessageData = {
			toolRequests: [{ id: 'tool_xyz', name: 'list_files' }],
		};
		const result = copilotMessageToSdkAssistant(data, 'session-1');
		const content = result.message.content as Array<{
			type: string;
			input?: Record<string, unknown>;
		}>;
		const toolUse = content.find((b) => b.type === 'tool_use');
		expect(toolUse?.input).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// copilotResultToSdkResult
// ---------------------------------------------------------------------------

describe('copilotResultToSdkResult', () => {
	it('should create a success result message when exitCode is 0', () => {
		const data: CopilotResultData = {
			sessionId: 'session_abc',
			exitCode: 0,
			usage: { premiumRequests: 1, totalApiDurationMs: 5000 },
		};
		const result = copilotResultToSdkResult(data, 'session-1', 6000, 1, 'Done!');
		expect(result.type).toBe('result');
		expect(result.is_error).toBe(false);
		expect(result.subtype).toBe('success');
		if (result.subtype === 'success') {
			expect(result.result).toBe('Done!');
			expect(result.stop_reason).toBe('end_turn');
		}
		expect(result.duration_api_ms).toBe(5000); // from usage
		expect(result.total_cost_usd).toBe(0);
	});

	it('should create an error result message when exitCode is non-zero', () => {
		const data: CopilotResultData = { exitCode: 1 };
		const result = copilotResultToSdkResult(data, 'session-1', 1000, 0, '', 'Permission denied');
		expect(result.is_error).toBe(true);
		expect(result.subtype).toBe('error_during_execution');
		if (result.subtype === 'error_during_execution') {
			expect(result.errors[0]).toBe('Permission denied');
		}
	});

	it('should use stderrText as error message when provided', () => {
		const data: CopilotResultData = { exitCode: 2 };
		const result = copilotResultToSdkResult(
			data,
			'session-1',
			1000,
			0,
			'',
			'Command not found: copilot'
		);
		if (result.subtype === 'error_during_execution') {
			expect(result.errors[0]).toBe('Command not found: copilot');
		}
	});

	it('should use default error message when exitCode is non-zero and no stderr', () => {
		const data: CopilotResultData = { exitCode: 130 };
		const result = copilotResultToSdkResult(data, 'session-1', 1000, 0, '');
		if (result.subtype === 'error_during_execution') {
			expect(result.errors[0]).toContain('130');
		}
	});

	it('should use process duration when CLI does not report totalApiDurationMs', () => {
		const data: CopilotResultData = { exitCode: 0 };
		const result = copilotResultToSdkResult(data, 'session-1', 3000, 1, 'Result');
		expect(result.duration_ms).toBe(3000);
		expect(result.duration_api_ms).toBe(3000); // falls back to durationMs
	});

	it('should set session_id correctly', () => {
		const data: CopilotResultData = { exitCode: 0 };
		const result = copilotResultToSdkResult(data, 'my-session', 100, 1, 'ok');
		expect(result.session_id).toBe('my-session');
	});

	it('should zero out token counts (not available from CLI)', () => {
		const data: CopilotResultData = { exitCode: 0 };
		const result = copilotResultToSdkResult(data, 's', 100, 1, 'ok');
		expect(result.usage.input_tokens).toBe(0);
		expect(result.usage.output_tokens).toBe(0);
	});

	it('should include num_turns in result', () => {
		const data: CopilotResultData = { exitCode: 0 };
		const result = copilotResultToSdkResult(data, 's', 100, 3, 'ok');
		expect(result.num_turns).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// createCopilotStreamEvent
// ---------------------------------------------------------------------------

describe('createCopilotStreamEvent', () => {
	it('should create a stream_event message', () => {
		const msg = createCopilotStreamEvent('session-1', 'hello');
		expect(msg.type).toBe('stream_event');
		expect(msg.session_id).toBe('session-1');
		expect(msg.parent_tool_use_id).toBeNull();
	});

	it('should embed the delta text in the event', () => {
		const msg = createCopilotStreamEvent('session-1', 'world');
		const streamMsg = msg as { type: 'stream_event'; event: { delta: { text: string } } };
		expect(streamMsg.event.delta.text).toBe('world');
	});

	it('should generate unique UUIDs', () => {
		const m1 = createCopilotStreamEvent('s', 'a');
		const m2 = createCopilotStreamEvent('s', 'b');
		expect(m1.uuid).not.toBe(m2.uuid);
	});
});

// ---------------------------------------------------------------------------
// createCopilotSystemInitMessage
// ---------------------------------------------------------------------------

describe('createCopilotSystemInitMessage', () => {
	it('should create a system init message', () => {
		const msg = createCopilotSystemInitMessage('session-1', {
			model: 'claude-sonnet-4.6',
			cwd: '/workspace',
			tools: [],
			maxTurns: 10,
		});
		expect(msg.type).toBe('system');
		expect(msg.subtype).toBe('init');
		expect(msg.session_id).toBe('session-1');
		expect(msg.model).toBe('claude-sonnet-4.6');
		expect(msg.cwd).toBe('/workspace');
		expect(msg.claude_code_version).toBe('copilot-cli-adapter');
	});

	it('should use default permissionMode when not specified', () => {
		const msg = createCopilotSystemInitMessage('s', {
			model: 'm',
			cwd: '/c',
			tools: [],
			maxTurns: 1,
		});
		expect(msg.permissionMode).toBe('default');
	});

	it('should use provided permissionMode', () => {
		const msg = createCopilotSystemInitMessage('s', {
			model: 'm',
			cwd: '/c',
			tools: [],
			maxTurns: 1,
			permissionMode: 'bypassPermissions',
		});
		expect(msg.permissionMode).toBe('bypassPermissions');
	});

	it('should have empty tools list (CLI manages its own tools)', () => {
		const msg = createCopilotSystemInitMessage('s', {
			model: 'm',
			cwd: '/c',
			tools: [{ name: 'read_file', description: 'Read', inputSchema: {} }],
			maxTurns: 1,
		});
		// Tools are not forwarded to CLI — it uses its own built-in tools
		expect(msg.tools).toEqual([]);
	});
});
