/**
 * Unit tests for Pi-Mono Adapter
 *
 * Tests the conversion functions that translate between NeoKai SDK format
 * and pi-ai/pi-agent-core formats.
 */

import { describe, expect, it } from 'bun:test';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { UUID } from 'crypto';
import {
	sdkToAgentMessage,
	convertToAgentTools,
	piAiToSdkAssistant,
} from '../../../src/lib/providers/pimono-adapter';

describe('Pi-Mono Adapter', () => {
	describe('sdkToAgentMessage', () => {
		it('should convert string content to user message', () => {
			const sdkMessage: SDKUserMessage = {
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000001' as UUID,
				session_id: 'test-session',
				message: {
					role: 'user',
					content: 'Hello, world!',
				},
			};

			const result = sdkToAgentMessage(sdkMessage);
			expect(result.role).toBe('user');
			expect(result.content).toBe('Hello, world!');
		});

		it('should convert single text block array to string', () => {
			const sdkMessage: SDKUserMessage = {
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000002' as UUID,
				session_id: 'test-session',
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'Single text block' }],
				},
			};

			const result = sdkToAgentMessage(sdkMessage);
			expect(result.role).toBe('user');
			// Single text block should be flattened to string
			expect(result.content).toBe('Single text block');
		});

		it('should convert multiple text blocks to content array', () => {
			const sdkMessage: SDKUserMessage = {
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
			};

			const result = sdkToAgentMessage(sdkMessage);
			expect(result.role).toBe('user');
			expect(Array.isArray(result.content)).toBe(true);
			const content = result.content as Array<{ type: string; text: string }>;
			expect(content).toHaveLength(2);
			expect(content[0].text).toBe('First part');
			expect(content[1].text).toBe('Second part');
		});

		it('should handle text and image blocks together', () => {
			const sdkMessage: SDKUserMessage = {
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000004' as UUID,
				session_id: 'test-session',
				message: {
					role: 'user',
					content: [
						{ type: 'text', text: 'Look at this image' },
						{
							type: 'image',
							source: {
								type: 'base64',
								media_type: 'image/png',
								data: 'base64data',
							},
						},
					],
				},
			};

			const result = sdkToAgentMessage(sdkMessage);
			expect(result.role).toBe('user');
			expect(Array.isArray(result.content)).toBe(true);
			const content = result.content as Array<{ type: string }>;
			expect(content).toHaveLength(2);
			expect(content[0].type).toBe('text');
			expect(content[1].type).toBe('image');
		});

		it('should convert tool_result block to pi-ai toolResult message', () => {
			const sdkMessage: SDKUserMessage = {
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000005' as UUID,
				session_id: 'test-session',
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tool-123',
							content: 'Tool output result',
							is_error: false,
						},
					],
				},
			};

			const result = sdkToAgentMessage(sdkMessage);
			expect(result.role).toBe('toolResult');
		});

		it('should handle empty content array', () => {
			const sdkMessage: SDKUserMessage = {
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000006' as UUID,
				session_id: 'test-session',
				message: {
					role: 'user',
					content: [],
				},
			};

			const result = sdkToAgentMessage(sdkMessage);
			expect(result.role).toBe('user');
			expect(result.content).toBe('');
		});
	});

	describe('convertToAgentTools', () => {
		it('should convert ToolDefinition to AgentTool', () => {
			const tools = [
				{
					name: 'read_file',
					description: 'Read a file from disk',
					inputSchema: {
						type: 'object',
						properties: { path: { type: 'string' } },
					},
				},
			];

			const agentTools = convertToAgentTools(tools);
			expect(agentTools).toHaveLength(1);
			expect(agentTools[0].name).toBe('read_file');
			expect(agentTools[0].description).toBe('Read a file from disk');
			expect(agentTools[0].label).toBe('read_file');
		});

		it('should convert multiple tools', () => {
			const tools = [
				{
					name: 'read_file',
					description: 'Read a file',
					inputSchema: { type: 'object' },
				},
				{
					name: 'write_file',
					description: 'Write a file',
					inputSchema: { type: 'object' },
				},
				{
					name: 'list_dir',
					description: 'List directory',
					inputSchema: { type: 'object' },
				},
			];

			const agentTools = convertToAgentTools(tools);
			expect(agentTools).toHaveLength(3);
			expect(agentTools.map((t) => t.name)).toEqual(['read_file', 'write_file', 'list_dir']);
		});

		it('should invoke tool executor callback', async () => {
			const tools = [
				{
					name: 'test_tool',
					description: 'A test tool',
					inputSchema: { type: 'object' },
				},
			];

			const executor = async (name: string, input: Record<string, unknown>, id: string) => {
				return { output: `Executed ${name} with id ${id}`, isError: false };
			};

			const agentTools = convertToAgentTools(tools, executor);
			const result = await agentTools[0].execute('call-1', { param: 'value' });
			expect(result.content[0].text).toContain('Executed test_tool');
		});

		it('should return error when no executor provided', async () => {
			const tools = [
				{
					name: 'test_tool',
					description: 'A test tool',
					inputSchema: { type: 'object' },
				},
			];

			const agentTools = convertToAgentTools(tools);
			const result = await agentTools[0].execute('call-1', {});
			expect(result.content[0].text).toContain('Error');
		});

		it('should handle executor errors gracefully', async () => {
			const tools = [
				{
					name: 'failing_tool',
					description: 'A failing tool',
					inputSchema: { type: 'object' },
				},
			];

			const executor = async () => {
				throw new Error('Tool execution failed');
			};

			const agentTools = convertToAgentTools(tools, executor);
			const result = await agentTools[0].execute('call-1', {});
			expect(result.content[0].text).toContain('Tool execution failed');
		});

		it('should mark error results from executor', async () => {
			const tools = [
				{
					name: 'error_tool',
					description: 'A tool that returns an error',
					inputSchema: { type: 'object' },
				},
			];

			const executor = async () => {
				return { output: 'Something went wrong', isError: true };
			};

			const agentTools = convertToAgentTools(tools, executor);
			const result = await agentTools[0].execute('call-1', {});
			expect(result.content[0].text).toContain('[Tool Error]');
			expect(result.content[0].text).toContain('Something went wrong');
		});
	});

	describe('piAiToSdkAssistant', () => {
		it('should convert text content blocks', () => {
			const content = [{ type: 'text' as const, text: 'Hello from the assistant!' }];

			const result = piAiToSdkAssistant(content, 'session-1');
			expect(result.type).toBe('assistant');
			expect(result.session_id).toBe('session-1');
			expect(result.message.role).toBe('assistant');
			expect(Array.isArray(result.message.content)).toBe(true);
			const msgContent = result.message.content as Array<{ type: string; text: string }>;
			expect(msgContent[0]).toEqual({ type: 'text', text: 'Hello from the assistant!' });
		});

		it('should convert tool call content blocks', () => {
			const content = [
				{
					type: 'toolCall' as const,
					id: 'tool-call-1',
					name: 'read_file',
					arguments: { path: '/test.txt' },
				},
			];

			const result = piAiToSdkAssistant(content, 'session-1');
			const msgContent = result.message.content as Array<{
				type: string;
				id?: string;
				name?: string;
				input?: Record<string, unknown>;
			}>;
			expect(msgContent[0].type).toBe('tool_use');
			expect(msgContent[0].id).toBe('tool-call-1');
			expect(msgContent[0].name).toBe('read_file');
			expect(msgContent[0].input).toEqual({ path: '/test.txt' });
		});

		it('should wrap thinking blocks in tags', () => {
			const content = [{ type: 'thinking' as const, thinking: 'Let me think about this...' }];

			const result = piAiToSdkAssistant(content, 'session-1');
			const msgContent = result.message.content as Array<{ type: string; text: string }>;
			expect(msgContent[0].type).toBe('text');
			expect(msgContent[0].text).toBe('<thinking>Let me think about this...</thinking>');
		});

		it('should generate unique UUIDs', () => {
			const content = [{ type: 'text' as const, text: 'test' }];
			const result1 = piAiToSdkAssistant(content, 'session-1');
			const result2 = piAiToSdkAssistant(content, 'session-1');
			expect(result1.uuid).not.toBe(result2.uuid);
		});

		it('should set parent_tool_use_id when provided', () => {
			const content = [{ type: 'text' as const, text: 'Tool response' }];
			const result = piAiToSdkAssistant(content, 'session-1', 'parent-tool-123');
			expect(result.parent_tool_use_id).toBe('parent-tool-123');
		});

		it('should set null parent_tool_use_id by default', () => {
			const content = [{ type: 'text' as const, text: 'test' }];
			const result = piAiToSdkAssistant(content, 'session-1');
			expect(result.parent_tool_use_id).toBeNull();
		});

		it('should handle mixed content types', () => {
			const content = [
				{ type: 'text' as const, text: 'Before tool call' },
				{
					type: 'toolCall' as const,
					id: 'tc-1',
					name: 'bash',
					arguments: { command: 'ls' },
				},
				{ type: 'text' as const, text: 'After tool call' },
			];

			const result = piAiToSdkAssistant(content, 'session-1');
			const msgContent = result.message.content as Array<{ type: string }>;
			expect(msgContent).toHaveLength(3);
			expect(msgContent[0].type).toBe('text');
			expect(msgContent[1].type).toBe('tool_use');
			expect(msgContent[2].type).toBe('text');
		});

		it('should include error when provided', () => {
			const content = [{ type: 'text' as const, text: 'Error occurred' }];
			const result = piAiToSdkAssistant(content, 'session-1', null, 'server_error');
			expect(result.error).toBe('server_error');
		});
	});
});
