/**
 * Unit tests for the Codex Anthropic Bridge — translator module
 */

import { describe, expect, it } from 'bun:test';
import {
	buildDynamicTools,
	toCodexToolName,
	buildToolNameReverseMap,
	extractSystemText,
	extractContentText,
	isToolResultContinuation,
	extractToolResults,
	buildConversationText,
	pingSSE,
	messageStartSSE,
	contentBlockStartTextSSE,
	contentBlockStartToolUseSSE,
	textDeltaSSE,
	inputJsonDeltaSSE,
	contentBlockStopSSE,
	messageDeltaSSE,
	messageStopSSE,
	type AnthropicMessage,
	type AnthropicTool,
} from '../../../../src/lib/providers/codex-anthropic-bridge/translator';

// ---------------------------------------------------------------------------
// buildDynamicTools
// ---------------------------------------------------------------------------

describe('buildDynamicTools', () => {
	it('converts Anthropic tools to Codex Dynamic Tools format', () => {
		const tools: AnthropicTool[] = [
			{
				name: 'bash',
				description: 'Run a shell command',
				input_schema: { type: 'object', properties: { command: { type: 'string' } } },
			},
		];
		const result = buildDynamicTools(tools);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			name: 'bash',
			description: 'Run a shell command',
			inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
			deferLoading: false,
		});
	});

	it('uses empty string for missing description', () => {
		const tools: AnthropicTool[] = [{ name: 'read_file', input_schema: { type: 'object' } }];
		const [tool] = buildDynamicTools(tools);
		expect(tool.description).toBe('');
	});

	it('returns empty array for empty input', () => {
		expect(buildDynamicTools([])).toEqual([]);
	});

	it('translates MCP tool names with __ to single _ for Codex', () => {
		const tools: AnthropicTool[] = [
			{
				name: 'mcp__mockserver__echo',
				description: 'Echo a message',
				input_schema: { type: 'object' },
			},
		];
		const [tool] = buildDynamicTools(tools);
		// Codex rejects __ (double underscore) as reserved; translate to single _
		expect(tool.name).toBe('mcp_mockserver_echo');
	});
});

// ---------------------------------------------------------------------------
// toCodexToolName
// ---------------------------------------------------------------------------

describe('toCodexToolName', () => {
	it('leaves names without __ unchanged', () => {
		expect(toCodexToolName('bash')).toBe('bash');
		expect(toCodexToolName('read_file')).toBe('read_file');
	});

	it('replaces __ with _ in MCP-style names', () => {
		expect(toCodexToolName('mcp__server__tool')).toBe('mcp_server_tool');
		expect(toCodexToolName('mcp__mockserver__echo')).toBe('mcp_mockserver_echo');
	});

	it('replaces all occurrences of __', () => {
		expect(toCodexToolName('a__b__c')).toBe('a_b_c');
	});
});

// ---------------------------------------------------------------------------
// buildToolNameReverseMap
// ---------------------------------------------------------------------------

describe('buildToolNameReverseMap', () => {
	it('returns empty map when no names contain __', () => {
		const map = buildToolNameReverseMap(['bash', 'read_file']);
		expect(map.size).toBe(0);
	});

	it('maps codex name back to original for MCP tools', () => {
		const map = buildToolNameReverseMap(['bash', 'mcp__server__tool', 'mcp__other__fn']);
		expect(map.get('mcp_server_tool')).toBe('mcp__server__tool');
		expect(map.get('mcp_other_fn')).toBe('mcp__other__fn');
		expect(map.has('bash')).toBe(false);
	});

	it('throws on collision when two names translate to the same codex name', () => {
		// mcp__a_b__c → mcp_a_b_c
		// mcp__a__b_c → mcp_a_b_c (same result — collision)
		expect(() => buildToolNameReverseMap(['mcp__a_b__c', 'mcp__a__b_c'])).toThrow(
			/collision.*mcp_a_b_c/
		);
	});

	it('throws when a translated name conflicts with an untranslated name', () => {
		// mcp__server__tool → mcp_server_tool (collision with existing unchanged name)
		expect(() => buildToolNameReverseMap(['mcp_server_tool', 'mcp__server__tool'])).toThrow(
			/collision.*mcp_server_tool/
		);
	});
});

// ---------------------------------------------------------------------------
// extractSystemText
// ---------------------------------------------------------------------------

describe('extractSystemText', () => {
	it('returns empty string for undefined', () => {
		expect(extractSystemText(undefined)).toBe('');
	});

	it('returns string as-is', () => {
		expect(extractSystemText('be helpful')).toBe('be helpful');
	});

	it('joins array blocks with newline', () => {
		const result = extractSystemText([
			{ type: 'text', text: 'line one' },
			{ type: 'text', text: 'line two' },
		]);
		expect(result).toBe('line one\nline two');
	});
});

// ---------------------------------------------------------------------------
// extractContentText
// ---------------------------------------------------------------------------

describe('extractContentText', () => {
	it('returns string content as-is', () => {
		expect(extractContentText('hello world')).toBe('hello world');
	});

	it('joins text blocks', () => {
		const result = extractContentText([
			{ type: 'text', text: 'foo' },
			{ type: 'text', text: 'bar' },
		]);
		expect(result).toBe('foobar');
	});

	it('ignores non-text blocks', () => {
		const result = extractContentText([
			{ type: 'text', text: 'before' },
			{ type: 'tool_use', id: 'x', name: 'bash', input: {} },
			{ type: 'text', text: 'after' },
		] as AnthropicMessage['content']);
		expect(result).toBe('beforeafter');
	});
});

// ---------------------------------------------------------------------------
// isToolResultContinuation
// ---------------------------------------------------------------------------

describe('isToolResultContinuation', () => {
	it('returns false for empty messages', () => {
		expect(isToolResultContinuation([])).toBe(false);
	});

	it('returns false for plain user message', () => {
		const msgs: AnthropicMessage[] = [{ role: 'user', content: 'hello' }];
		expect(isToolResultContinuation(msgs)).toBe(false);
	});

	it('returns false when last message is assistant', () => {
		const msgs: AnthropicMessage[] = [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'world' },
		];
		expect(isToolResultContinuation(msgs)).toBe(false);
	});

	it('returns true when last user message has tool_result', () => {
		const msgs: AnthropicMessage[] = [
			{ role: 'user', content: 'calculate' },
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'c1', name: 'calc', input: {} }],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'c1', content: '42' }],
			},
		];
		expect(isToolResultContinuation(msgs)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// extractToolResults
// ---------------------------------------------------------------------------

describe('extractToolResults', () => {
	it('returns empty array when no tool_result blocks', () => {
		const msgs: AnthropicMessage[] = [{ role: 'user', content: 'hello' }];
		expect(extractToolResults(msgs)).toEqual([]);
	});

	it('extracts string content', () => {
		const msgs: AnthropicMessage[] = [
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result text' }],
			},
		];
		expect(extractToolResults(msgs)).toEqual([{ toolUseId: 'call-1', text: 'result text' }]);
	});

	it('joins array content blocks', () => {
		const msgs: AnthropicMessage[] = [
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'call-2',
						content: [
							{ type: 'text', text: 'part A' },
							{ type: 'text', text: ' part B' },
						],
					},
				],
			},
		];
		const [result] = extractToolResults(msgs);
		expect(result.text).toBe('part A part B');
	});
});

// ---------------------------------------------------------------------------
// buildConversationText
// ---------------------------------------------------------------------------

describe('buildConversationText', () => {
	it('returns just the user message for a single-turn conversation', () => {
		const msgs: AnthropicMessage[] = [{ role: 'user', content: 'hello' }];
		expect(buildConversationText(msgs)).toBe('hello');
	});

	it('wraps system prompt in <system> tags', () => {
		const msgs: AnthropicMessage[] = [{ role: 'user', content: 'hi' }];
		const text = buildConversationText(msgs, 'be helpful');
		expect(text).toContain('<system>\nbe helpful\n</system>');
		expect(text).toContain('hi');
	});

	it('includes prior conversation history', () => {
		const msgs: AnthropicMessage[] = [
			{ role: 'user', content: 'What is 2+2?' },
			{ role: 'assistant', content: '4' },
			{ role: 'user', content: 'Why?' },
		];
		const text = buildConversationText(msgs);
		expect(text).toContain('<conversation>');
		expect(text).toContain('User: What is 2+2?');
		expect(text).toContain('Assistant: 4');
		expect(text).toContain('</conversation>');
		expect(text).toContain('Why?');
	});
});

// ---------------------------------------------------------------------------
// SSE builders
// ---------------------------------------------------------------------------

describe('SSE builders', () => {
	function parseSSE(raw: string): { event: string; data: unknown } {
		const lines = raw.trim().split('\n');
		const event = lines[0].replace('event: ', '');
		const data = JSON.parse(lines[1].replace('data: ', ''));
		return { event, data };
	}

	it('pingSSE emits ping event', () => {
		const { event, data } = parseSSE(pingSSE());
		expect(event).toBe('ping');
		expect((data as { type: string }).type).toBe('ping');
	});

	it('messageStartSSE emits message_start with correct structure', () => {
		const { event, data } = parseSSE(messageStartSSE('msg_abc', 'gpt-4o', 25));
		expect(event).toBe('message_start');
		const msg = (
			data as { message: { id: string; model: string; usage: { input_tokens: number } } }
		).message;
		expect(msg.id).toBe('msg_abc');
		expect(msg.model).toBe('gpt-4o');
		expect(msg.usage.input_tokens).toBe(25);
	});

	it('contentBlockStartTextSSE emits text block at given index', () => {
		const { data } = parseSSE(contentBlockStartTextSSE(0));
		expect((data as { content_block: { type: string } }).content_block.type).toBe('text');
		expect((data as { index: number }).index).toBe(0);
	});

	it('contentBlockStartToolUseSSE emits tool_use block with id and name', () => {
		const { data } = parseSSE(contentBlockStartToolUseSSE(1, 'toolu_123', 'bash'));
		const block = (data as { content_block: { type: string; id: string; name: string } })
			.content_block;
		expect(block.type).toBe('tool_use');
		expect(block.id).toBe('toolu_123');
		expect(block.name).toBe('bash');
	});

	it('textDeltaSSE emits text_delta at given index', () => {
		const { data } = parseSSE(textDeltaSSE(0, 'hello'));
		const delta = (data as { delta: { type: string; text: string } }).delta;
		expect(delta.type).toBe('text_delta');
		expect(delta.text).toBe('hello');
	});

	it('inputJsonDeltaSSE emits input_json_delta', () => {
		const { data } = parseSSE(inputJsonDeltaSSE(1, '{"cmd":"ls"}'));
		const delta = (data as { delta: { type: string; partial_json: string } }).delta;
		expect(delta.type).toBe('input_json_delta');
		expect(delta.partial_json).toBe('{"cmd":"ls"}');
	});

	it('contentBlockStopSSE emits stop at given index', () => {
		const { data } = parseSSE(contentBlockStopSSE(2));
		expect((data as { type: string; index: number }).index).toBe(2);
	});

	it('messageDeltaSSE emits stop_reason and output tokens (plain number)', () => {
		const { data } = parseSSE(messageDeltaSSE('end_turn', 42));
		expect((data as { delta: { stop_reason: string } }).delta.stop_reason).toBe('end_turn');
		expect((data as { usage: { output_tokens: number } }).usage.output_tokens).toBe(42);
	});

	it('messageDeltaSSE accepts a usage object with actual token count', () => {
		const { data } = parseSSE(messageDeltaSSE('end_turn', { outputTokens: 99 }));
		expect((data as { delta: { stop_reason: string } }).delta.stop_reason).toBe('end_turn');
		expect((data as { usage: { output_tokens: number } }).usage.output_tokens).toBe(99);
	});

	it('messageDeltaSSE emits tool_use stop_reason (plain number)', () => {
		const { data } = parseSSE(messageDeltaSSE('tool_use', 10));
		expect((data as { delta: { stop_reason: string } }).delta.stop_reason).toBe('tool_use');
	});

	it('messageDeltaSSE emits tool_use stop_reason (usage object)', () => {
		const { data } = parseSSE(messageDeltaSSE('tool_use', { outputTokens: 10 }));
		expect((data as { delta: { stop_reason: string } }).delta.stop_reason).toBe('tool_use');
		expect((data as { usage: { output_tokens: number } }).usage.output_tokens).toBe(10);
	});

	it('messageStopSSE emits message_stop', () => {
		const { event, data } = parseSSE(messageStopSSE());
		expect(event).toBe('message_stop');
		expect((data as { type: string }).type).toBe('message_stop');
	});
});
