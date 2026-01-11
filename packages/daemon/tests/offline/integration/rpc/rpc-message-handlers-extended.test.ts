/**
 * Extended Message RPC Handlers Tests (Offline)
 *
 * Additional tests for:
 * - session.export (markdown and JSON formats)
 * - message.removeOutput
 * - Format functions coverage
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';

describe('Message RPC Handlers - Extended', () => {
	let handlers: Map<string, Function>;
	let mockMessageHub: {
		handle: ReturnType<typeof mock>;
		publish: ReturnType<typeof mock>;
	};
	let mockSessionManager: {
		getSessionAsync: ReturnType<typeof mock>;
		getSession: ReturnType<typeof mock>;
		getSessionFromDB: ReturnType<typeof mock>;
		markOutputRemoved: ReturnType<typeof mock>;
	};

	beforeAll(() => {
		handlers = new Map();
		mockMessageHub = {
			handle: mock((method: string, handler: Function) => {
				handlers.set(method, handler);
			}),
			publish: mock(async () => {}),
		};

		const mockUserMessage = {
			type: 'user' as const,
			message: {
				role: 'user' as const,
				content: 'Hello, world!',
			},
			uuid: 'msg-1',
		};

		const mockUserMessageWithBlocks = {
			type: 'user' as const,
			message: {
				role: 'user' as const,
				content: [
					{ type: 'text', text: 'Hello with image' },
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
				],
			},
			uuid: 'msg-user-blocks',
		};

		const mockAssistantMessage = {
			type: 'assistant' as const,
			message: {
				role: 'assistant' as const,
				content: [
					{ type: 'text', text: 'This is my response.' },
					{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/test.txt' } },
					{ type: 'thinking', thinking: 'Let me think about this...' },
				],
			},
			uuid: 'msg-2',
		};

		const mockResultMessageSuccess = {
			type: 'result' as const,
			subtype: 'success',
			uuid: 'msg-result-1',
		};

		const mockResultMessageError = {
			type: 'result' as const,
			subtype: 'error',
			errors: ['Something went wrong', 'Another error'],
			uuid: 'msg-result-2',
		};

		// Message type that should be skipped
		const mockSystemMessage = {
			type: 'system' as const,
			message: { content: 'System message' },
			uuid: 'msg-system',
		};

		const mockSDKMessages = [
			mockUserMessage,
			mockAssistantMessage,
			mockResultMessageSuccess,
			mockResultMessageError,
			mockUserMessageWithBlocks,
			mockSystemMessage,
		];

		const mockSession = {
			id: 'test-session',
			title: 'Test Session',
			config: { model: 'claude-sonnet-4-5-20250929' },
			createdAt: '2024-01-01T00:00:00Z',
			workspacePath: '/test/workspace',
		};

		mockSessionManager = {
			getSessionAsync: mock(async (sessionId: string) => {
				if (sessionId === 'valid-session' || sessionId === 'test-session') {
					return {
						getSDKMessages: mock(() => mockSDKMessages),
						getSDKMessageCount: mock(() => mockSDKMessages.length),
						getSessionData: mock(() => mockSession),
						getSDKSessionId: mock(() => 'sdk-session-123'),
					};
				}
				return null;
			}),
			getSession: mock((sessionId: string) => {
				if (sessionId === 'valid-session') {
					return {
						getSDKSessionId: mock(() => 'sdk-session-123'),
					};
				}
				return null;
			}),
			getSessionFromDB: mock((sessionId: string) => {
				if (sessionId === 'valid-session') {
					return {
						workspacePath: '/test/workspace',
					};
				}
				return null;
			}),
			markOutputRemoved: mock(async () => {}),
		};

		setupMessageHandlers(
			mockMessageHub as unknown as Parameters<typeof setupMessageHandlers>[0],
			mockSessionManager as unknown as Parameters<typeof setupMessageHandlers>[1]
		);
	});

	describe('session.export', () => {
		test('should register handler', () => {
			expect(handlers.has('session.export')).toBe(true);
		});

		test('should export session as JSON', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'json',
			});

			expect(result.session).toBeDefined();
			expect(result.messages).toBeDefined();
			expect(Array.isArray(result.messages)).toBe(true);
		});

		test('should export session as markdown by default', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
			});

			expect(result.markdown).toBeDefined();
			expect(typeof result.markdown).toBe('string');
			// Check markdown structure
			expect(result.markdown).toContain('# Test Session');
			expect(result.markdown).toContain('**Session ID:**');
			expect(result.markdown).toContain('**Model:**');
		});

		test('should export session as markdown explicitly', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toBeDefined();
			expect(typeof result.markdown).toBe('string');
		});

		test('should format user messages in markdown', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toContain('## User');
			expect(result.markdown).toContain('Hello, world!');
		});

		test('should format user messages with image blocks', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toContain('Hello with image');
			expect(result.markdown).toContain('*[Image attached]*');
		});

		test('should format assistant messages in markdown', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toContain('## Assistant');
			expect(result.markdown).toContain('This is my response.');
		});

		test('should format tool use blocks in markdown', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toContain('### Tool Use: read_file');
			expect(result.markdown).toContain('```json');
			expect(result.markdown).toContain('path');
		});

		test('should format thinking blocks in markdown', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toContain('<details>');
			expect(result.markdown).toContain('<summary>Thinking</summary>');
			expect(result.markdown).toContain('Let me think about this...');
		});

		test('should format result success messages in markdown', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toContain('## Result');
			expect(result.markdown).toContain('*Query completed successfully*');
		});

		test('should format result error messages in markdown', async () => {
			const handler = handlers.get('session.export')!;
			const result = await handler({
				sessionId: 'valid-session',
				format: 'markdown',
			});

			expect(result.markdown).toContain('*Error: error*');
			expect(result.markdown).toContain('Something went wrong');
		});

		test('should throw for invalid session', async () => {
			const handler = handlers.get('session.export')!;
			await expect(
				handler({
					sessionId: 'invalid',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('message.removeOutput', () => {
		test('should register handler', () => {
			expect(handlers.has('message.removeOutput')).toBe(true);
		});

		test('should throw for non-existent session', async () => {
			const handler = handlers.get('message.removeOutput')!;
			await expect(
				handler({
					sessionId: 'invalid',
					messageUuid: 'msg-1',
				})
			).rejects.toThrow('Session not found');
		});
	});
});
