/**
 * Tests for Gemini Format Converter
 *
 * Tests the Anthropic Messages API ↔ Gemini Code Assist format translation.
 */

import { describe, expect, it } from 'bun:test';
import {
	anthropicToGemini,
	convertModelId,
	convertMessages,
	convertSystem,
	convertTools,
	convertSchema,
	convertToolChoice,
	convertFinishReason,
	createStreamState,
	extractTextFromCandidate,
	extractFunctionCallsFromCandidate,
	type GeminiContent,
	type GeminiCandidate,
} from '../../../../src/lib/providers/gemini/format-converter.js';
import type {
	AnthropicRequest,
	AnthropicTool,
} from '../../../../src/lib/providers/codex-anthropic-bridge/translator.js';

describe('Gemini Format Converter', () => {
	// -------------------------------------------------------------------------
	// convertModelId
	// -------------------------------------------------------------------------

	describe('convertModelId', () => {
		it('passes through Gemini model IDs unchanged', () => {
			expect(convertModelId('gemini-2.5-pro')).toBe('gemini-2.5-pro');
			expect(convertModelId('gemini-2.5-flash')).toBe('gemini-2.5-flash');
		});

		it('maps Anthropic model IDs to Gemini equivalents', () => {
			expect(convertModelId('sonnet')).toBe('gemini-2.5-pro');
			expect(convertModelId('opus')).toBe('gemini-2.5-pro');
			expect(convertModelId('haiku')).toBe('gemini-2.5-flash');
			expect(convertModelId('default')).toBe('gemini-2.5-pro');
		});

		it('defaults unknown models to gemini-2.5-pro', () => {
			expect(convertModelId('unknown-model')).toBe('gemini-2.5-pro');
		});
	});

	// -------------------------------------------------------------------------
	// convertMessages
	// -------------------------------------------------------------------------

	describe('convertMessages', () => {
		it('converts simple text messages', () => {
			const messages = [
				{ role: 'user' as const, content: 'Hello' },
				{ role: 'assistant' as const, content: 'Hi there' },
			];

			const contents = convertMessages(messages);

			expect(contents).toHaveLength(2);
			expect(contents[0]).toEqual({
				role: 'user',
				parts: [{ text: 'Hello' }],
			});
			expect(contents[1]).toEqual({
				role: 'model', // assistant → model
				parts: [{ text: 'Hi there' }],
			});
		});

		it('converts content block messages', () => {
			const messages = [
				{
					role: 'user' as const,
					content: [{ type: 'text' as const, text: 'Hello from blocks' }],
				},
			];

			const contents = convertMessages(messages);

			expect(contents).toHaveLength(1);
			expect(contents[0]).toEqual({
				role: 'user',
				parts: [{ text: 'Hello from blocks' }],
			});
		});

		it('converts tool_use blocks to functionCall parts', () => {
			const messages = [
				{
					role: 'assistant' as const,
					content: [
						{ type: 'text' as const, text: 'Let me check that.' },
						{
							type: 'tool_use' as const,
							id: 'toolu_123',
							name: 'get_weather',
							input: { city: 'SF' },
						},
					],
				},
			];

			const contents = convertMessages(messages);

			expect(contents).toHaveLength(1);
			expect(contents[0].role).toBe('model');
			expect(contents[0].parts).toHaveLength(2);
			expect(contents[0].parts[0]).toEqual({ text: 'Let me check that.' });
			expect(contents[0].parts[1]).toEqual({
				functionCall: { name: 'get_weather', args: { city: 'SF' } },
			});
		});

		it('converts tool_result blocks to functionResponse parts in user turn', () => {
			const messages = [
				{
					role: 'user' as const,
					content: [
						{
							type: 'tool_result' as const,
							tool_use_id: 'toolu_123',
							content: '72°F, sunny',
						},
					],
				},
			];

			const contents = convertMessages(messages);

			// Tool results should be in a user-turn with functionResponse
			expect(contents).toHaveLength(1);
			expect(contents[0].role).toBe('user');
			expect(contents[0].parts[0].functionResponse).toBeDefined();
			expect(contents[0].parts[0].functionResponse!.response).toEqual({
				result: '72°F, sunny',
			});
		});

		it('converts tool_result with content blocks', () => {
			const messages = [
				{
					role: 'user' as const,
					content: [
						{
							type: 'tool_result' as const,
							tool_use_id: 'toolu_456',
							content: [
								{ type: 'text' as const, text: 'Line 1' },
								{ type: 'text' as const, text: 'Line 2' },
							],
						},
					],
				},
			];

			const contents = convertMessages(messages);

			expect(contents[0].parts[0].functionResponse!.response).toEqual({
				result: 'Line 1Line 2',
			});
		});

		it('maps tool_result to the original function name from prior tool_use block', () => {
			const messages = [
				{
					role: 'assistant' as const,
					content: [
						{
							type: 'tool_use' as const,
							id: 'toolu_abc123',
							name: 'read_file',
							input: { path: '/src/index.ts' },
						},
					],
				},
				{
					role: 'user' as const,
					content: [
						{
							type: 'tool_result' as const,
							tool_use_id: 'toolu_abc123',
							content: 'export const hello = "world";',
						},
					],
				},
			];

			const contents = convertMessages(messages);

			// The functionResponse should use "read_file", not a fabricated name
			expect(contents).toHaveLength(2);
			const functionResponse = contents[1].parts[0].functionResponse;
			expect(functionResponse).toBeDefined();
			expect(functionResponse!.name).toBe('read_file');
			expect(functionResponse!.response).toEqual({
				result: 'export const hello = "world";',
			});
		});

		it('falls back to extracted name when tool_use_id has no matching tool_use block', () => {
			const messages = [
				{
					role: 'user' as const,
					content: [
						{
							type: 'tool_result' as const,
							tool_use_id: 'orphan_id_999',
							content: 'orphaned result',
						},
					],
				},
			];

			const contents = convertMessages(messages);

			// Should use extractToolNameFromId fallback
			expect(contents[0].parts[0].functionResponse!.name).toBe('tool_orphan_i');
		});
	});

	// -------------------------------------------------------------------------
	// convertSystem
	// -------------------------------------------------------------------------

	describe('convertSystem', () => {
		it('converts string system prompt', () => {
			const result = convertSystem('You are a helpful assistant.');
			expect(result).toEqual({
				parts: [{ text: 'You are a helpful assistant.' }],
			});
		});

		it('converts array system prompt', () => {
			const result = convertSystem([
				{ type: 'text', text: 'Part 1.' },
				{ type: 'text', text: 'Part 2.' },
			]);
			expect(result).toEqual({
				parts: [{ text: 'Part 1.\nPart 2.' }],
			});
		});

		it('returns undefined for empty system prompt', () => {
			expect(convertSystem(undefined)).toBeUndefined();
			expect(convertSystem('')).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// convertTools
	// -------------------------------------------------------------------------

	describe('convertTools', () => {
		it('converts Anthropic tools to Gemini function declarations', () => {
			const tools: AnthropicTool[] = [
				{
					name: 'get_weather',
					description: 'Get the weather for a city',
					input_schema: {
						type: 'object',
						properties: {
							city: { type: 'string', description: 'City name' },
						},
						required: ['city'],
					},
				},
			];

			const result = convertTools(tools);

			expect(result).toHaveLength(1);
			expect(result[0].functionDeclarations).toHaveLength(1);
			expect(result[0].functionDeclarations![0]).toEqual({
				name: 'get_weather',
				description: 'Get the weather for a city',
				parameters: {
					type: 'object',
					properties: {
						city: { type: 'string', description: 'City name' },
					},
					required: ['city'],
				},
			});
		});

		it('returns empty array for no tools', () => {
			expect(convertTools(undefined)).toEqual([]);
			expect(convertTools([])).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// convertSchema
	// -------------------------------------------------------------------------

	describe('convertSchema', () => {
		it('removes additionalProperties', () => {
			const schema = {
				type: 'object',
				properties: { name: { type: 'string' } },
				additionalProperties: false,
			};

			const result = convertSchema(schema);
			expect(result.additionalProperties).toBeUndefined();
		});

		it('converts oneOf to anyOf', () => {
			const schema = {
				oneOf: [{ type: 'string' }, { type: 'number' }],
			};

			const result = convertSchema(schema);
			expect(result.oneOf).toBeUndefined();
			expect(result.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
		});

		it('recursively converts nested properties', () => {
			const schema = {
				type: 'object',
				properties: {
					nested: {
						type: 'object',
						properties: {
							inner: { type: 'string', additionalProperties: true },
						},
					},
				},
			};

			const result = convertSchema(schema);
			const nestedProps = result.properties!.nested as Record<string, unknown>;
			const innerProps = (nestedProps.properties as Record<string, Record<string, unknown>>).inner;
			expect(innerProps.additionalProperties).toBeUndefined();
		});

		it('recursively converts array items', () => {
			const schema = {
				type: 'array',
				items: {
					type: 'object',
					properties: { name: { type: 'string' } },
					additionalProperties: false,
				},
			};

			const result = convertSchema(schema);
			const items = result.items as Record<string, unknown>;
			expect(items.additionalProperties).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// convertToolChoice
	// -------------------------------------------------------------------------

	describe('convertToolChoice', () => {
		it('converts auto mode', () => {
			const result = convertToolChoice({ type: 'auto' });
			expect(result).toEqual({
				functionCallingConfig: { mode: 'AUTO' },
			});
		});

		it('converts none mode', () => {
			const result = convertToolChoice({ type: 'none' });
			expect(result).toEqual({
				functionCallingConfig: { mode: 'NONE' },
			});
		});

		it('converts any mode', () => {
			const result = convertToolChoice({ type: 'any' });
			expect(result).toEqual({
				functionCallingConfig: { mode: 'ANY' },
			});
		});

		it('converts tool mode with name', () => {
			const result = convertToolChoice({ type: 'tool', name: 'get_weather' });
			expect(result).toEqual({
				functionCallingConfig: {
					mode: 'ANY',
					allowedFunctionNames: ['get_weather'],
				},
			});
		});

		it('returns undefined for no tool choice', () => {
			expect(convertToolChoice(undefined)).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// convertFinishReason
	// -------------------------------------------------------------------------

	describe('convertFinishReason', () => {
		it('converts Gemini finish reasons to Anthropic stop reasons', () => {
			expect(convertFinishReason('STOP')).toBe('end_turn');
			expect(convertFinishReason('MAX_TOKENS')).toBe('max_tokens');
			expect(convertFinishReason('SAFETY')).toBe('max_tokens');
			expect(convertFinishReason('RECITATION')).toBe('end_turn');
			expect(convertFinishReason(undefined)).toBe('end_turn');
			expect(convertFinishReason('UNKNOWN')).toBe('end_turn');
		});
	});

	// -------------------------------------------------------------------------
	// createStreamState
	// -------------------------------------------------------------------------

	describe('createStreamState', () => {
		it('initializes stream state with defaults', () => {
			const state = createStreamState('gemini-2.5-pro');

			expect(state.model).toBe('gemini-2.5-pro');
			expect(state.messageId).toMatch(/^msg_/);
			expect(state.contentBlockIndex).toBe(0);
			expect(state.currentToolUseId).toBeNull();
			expect(state.inputTokens).toBe(0);
			expect(state.outputTokens).toBe(0);
			expect(state.finished).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// extractTextFromCandidate
	// -------------------------------------------------------------------------

	describe('extractTextFromCandidate', () => {
		it('extracts text from a Gemini candidate', () => {
			const candidate: GeminiCandidate = {
				content: {
					role: 'model',
					parts: [{ text: 'Hello' }, { text: ' World' }],
				},
			};

			expect(extractTextFromCandidate(candidate)).toBe('Hello World');
		});

		it('returns empty string for candidate with no text parts', () => {
			const candidate: GeminiCandidate = {
				content: {
					role: 'model',
					parts: [{ functionCall: { name: 'test', args: {} } }],
				},
			};

			expect(extractTextFromCandidate(candidate)).toBe('');
		});

		it('returns empty string for candidate with no content', () => {
			expect(extractTextFromCandidate({})).toBe('');
			expect(extractTextFromCandidate({ content: undefined })).toBe('');
		});
	});

	// -------------------------------------------------------------------------
	// extractFunctionCallsFromCandidate
	// -------------------------------------------------------------------------

	describe('extractFunctionCallsFromCandidate', () => {
		it('extracts function calls from a Gemini candidate', () => {
			const candidate: GeminiCandidate = {
				content: {
					role: 'model',
					parts: [
						{ functionCall: { name: 'get_weather', args: { city: 'SF' } } },
						{ functionCall: { name: 'get_time', args: { tz: 'PST' } } },
					],
				},
			};

			const calls = extractFunctionCallsFromCandidate(candidate);
			expect(calls).toHaveLength(2);
			expect(calls[0]).toEqual({ name: 'get_weather', args: { city: 'SF' } });
			expect(calls[1]).toEqual({ name: 'get_time', args: { tz: 'PST' } });
		});

		it('returns empty array for candidate with no function calls', () => {
			const candidate: GeminiCandidate = {
				content: {
					role: 'model',
					parts: [{ text: 'Hello' }],
				},
			};

			expect(extractFunctionCallsFromCandidate(candidate)).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// anthropicToGemini (full request conversion)
	// -------------------------------------------------------------------------

	describe('anthropicToGemini', () => {
		it('converts a complete Anthropic request', () => {
			const request: AnthropicRequest = {
				model: 'gemini-2.5-pro',
				messages: [{ role: 'user', content: 'What is the weather?' }],
				system: 'You are a helpful weather assistant.',
				tools: [
					{
						name: 'get_weather',
						description: 'Get weather',
						input_schema: { type: 'object', properties: { city: { type: 'string' } } },
					},
				],
				max_tokens: 4096,
				stream: true,
			};

			const result = anthropicToGemini(request);

			expect(result.model).toBe('gemini-2.5-pro');
			expect(result.request.contents).toHaveLength(1);
			expect(result.request.systemInstruction).toEqual({
				parts: [{ text: 'You are a helpful weather assistant.' }],
			});
			expect(result.request.tools).toHaveLength(1);
			expect(result.request.generationConfig?.maxOutputTokens).toBe(4096);
		});

		it('converts a minimal request', () => {
			const request: AnthropicRequest = {
				model: 'haiku',
				messages: [{ role: 'user', content: 'Hi' }],
			};

			const result = anthropicToGemini(request);

			expect(result.model).toBe('gemini-2.5-flash');
			expect(result.request.contents).toHaveLength(1);
			expect(result.request.systemInstruction).toBeUndefined();
			expect(result.request.tools).toBeUndefined();
			expect(result.request.generationConfig).toBeUndefined();
		});

		it('includes project and session options', () => {
			const request: AnthropicRequest = {
				model: 'gemini-2.5-pro',
				messages: [{ role: 'user', content: 'Hi' }],
			};

			const result = anthropicToGemini(request, {
				project: 'my-project',
				sessionId: 'sess-123',
			});

			expect(result.project).toBe('my-project');
		});
	});
});
