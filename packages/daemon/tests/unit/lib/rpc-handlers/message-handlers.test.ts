/**
 * Message Handlers Tests
 *
 * Tests for message RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';
import type { MessageHub, Session } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { SessionManager } from '../../../../src/lib/session-manager';

// Mock the sdk-session-file-manager module
mock.module('../../../../src/lib/sdk-session-file-manager', () => ({
	removeToolResultFromSessionFile: mock(() => true),
}));

describe('Message Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockAgentSession: {
		getSDKSessionId: ReturnType<typeof mock>;
		getSDKMessages: ReturnType<typeof mock>;
		getSDKMessageCount: ReturnType<typeof mock>;
		getSessionData: ReturnType<typeof mock>;
	};
	let mockSession: Session;

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
			publish: mock(async () => {}),
		} as unknown as MessageHub;

		// Mock session data
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
		};

		// Mock AgentSession
		mockAgentSession = {
			getSDKSessionId: mock(() => 'sdk-session-123'),
			getSDKMessages: mock(() => []),
			getSDKMessageCount: mock(() => 10),
			getSessionData: mock(() => mockSession),
		};

		// Mock SessionManager
		mockSessionManager = {
			getSessionAsync: mock(async () => mockAgentSession),
			getSession: mock(() => mockAgentSession),
			getSessionFromDB: mock(() => mockSession),
			markOutputRemoved: mock(async () => {}),
		} as unknown as SessionManager;

		// Setup handlers
		setupMessageHandlers(mockMessageHub, mockSessionManager);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all message handlers', () => {
			expect(handlers.has('message.removeOutput')).toBe(true);
			expect(handlers.has('message.sdkMessages')).toBe(true);
			expect(handlers.has('message.count')).toBe(true);
			expect(handlers.has('session.export')).toBe(true);
		});
	});

	describe('message.sdkMessages', () => {
		it('should return SDK messages', async () => {
			const mockMessages: SDKMessage[] = [
				{
					type: 'user',
					uuid: 'msg-1',
					message: { role: 'user', content: 'Hello' },
				} as unknown as SDKMessage,
			];
			mockAgentSession.getSDKMessages.mockReturnValue(mockMessages);

			const result = await callHandler('message.sdkMessages', {
				sessionId: 'test-session-id',
			});

			expect(result).toEqual({ sdkMessages: mockMessages });
		});

		it('should pass limit, before, and since parameters', async () => {
			await callHandler('message.sdkMessages', {
				sessionId: 'test-session-id',
				limit: 50,
				before: 1000,
				since: 500,
			});

			expect(mockAgentSession.getSDKMessages).toHaveBeenCalledWith(50, 1000, 500);
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('message.sdkMessages', { sessionId: 'nonexistent' })
			).rejects.toThrow('Session not found');
		});
	});

	describe('message.count', () => {
		it('should return message count', async () => {
			mockAgentSession.getSDKMessageCount.mockReturnValue(42);

			const result = await callHandler('message.count', {
				sessionId: 'test-session-id',
			});

			expect(result).toEqual({ count: 42 });
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('message.count', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.export', () => {
		it('should export session as markdown by default', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'user',
					uuid: 'msg-1',
					message: { role: 'user', content: 'Hello' },
				} as SDKMessage,
				{
					type: 'assistant',
					uuid: 'msg-2',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Hi there!' }],
					},
				} as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
			})) as { markdown: string };

			expect(result.markdown).toContain('# Test Session');
			expect(result.markdown).toContain('**Model:** claude-sonnet-4-20250514');
			expect(result.markdown).toContain('## User');
			expect(result.markdown).toContain('Hello');
			expect(result.markdown).toContain('## Assistant');
			expect(result.markdown).toContain('Hi there!');
		});

		it('should export session as JSON when specified', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'user',
					uuid: 'msg-1',
					message: { role: 'user', content: 'Hello' },
				} as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
				format: 'json',
			})) as { session: Session; messages: SDKMessage[] };

			expect(result.session).toEqual(mockSession);
			expect(result.messages).toHaveLength(1);
		});

		it('should format tool use blocks', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'assistant',
					uuid: 'msg-1',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'tool-1',
								name: 'Read',
								input: { file_path: '/test.txt' },
							},
						],
					},
				} as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
			})) as { markdown: string };

			expect(result.markdown).toContain('### Tool Use: Read');
			expect(result.markdown).toContain('"file_path"');
		});

		it('should format thinking blocks', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'assistant',
					uuid: 'msg-1',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'thinking',
								thinking: 'Let me think about this...',
							},
						],
					},
				} as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
			})) as { markdown: string };

			expect(result.markdown).toContain('<details>');
			expect(result.markdown).toContain('<summary>Thinking</summary>');
			expect(result.markdown).toContain('Let me think about this...');
		});

		it('should format result messages', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'result',
					subtype: 'success',
					uuid: 'msg-1',
					usage: { input_tokens: 100, output_tokens: 50 },
				} as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
			})) as { markdown: string };

			expect(result.markdown).toContain('## Result');
			expect(result.markdown).toContain('*Query completed successfully*');
		});

		it('should format error result messages', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'result',
					subtype: 'error',
					uuid: 'msg-1',
					errors: ['Something went wrong'],
				} as unknown as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
			})) as { markdown: string };

			expect(result.markdown).toContain('*Error: error*');
			expect(result.markdown).toContain('Something went wrong');
		});

		it('should handle user messages with array content', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'user',
					uuid: 'msg-1',
					message: {
						role: 'user',
						content: [
							{ type: 'text', text: 'Hello' },
							{ type: 'image', source: { data: 'base64...' } },
						],
					},
				} as unknown as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
			})) as { markdown: string };

			expect(result.markdown).toContain('Hello');
			expect(result.markdown).toContain('*[Image attached]*');
		});

		it('should skip system and other non-displayable messages', async () => {
			mockAgentSession.getSDKMessages.mockReturnValue([
				{
					type: 'system',
					subtype: 'init',
					uuid: 'msg-1',
				} as SDKMessage,
				{
					type: 'user',
					uuid: 'msg-2',
					message: { role: 'user', content: 'Hello' },
				} as SDKMessage,
			]);

			const result = (await callHandler('session.export', {
				sessionId: 'test-session-id',
			})) as { markdown: string };

			// Should have user message but no system message heading
			expect(result.markdown).toContain('## User');
			expect(result.markdown).not.toContain('## System');
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('session.export', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('message.removeOutput', () => {
		it('should throw if session not found in DB', async () => {
			(mockSessionManager.getSessionFromDB as ReturnType<typeof mock>).mockReturnValue(null);

			await expect(
				callHandler('message.removeOutput', {
					sessionId: 'nonexistent',
					messageUuid: 'msg-1',
				})
			).rejects.toThrow('Session not found');
		});

		it('should successfully remove output when session exists', async () => {
			const result = (await callHandler('message.removeOutput', {
				sessionId: 'test-session-id',
				messageUuid: 'msg-1',
			})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(mockSessionManager.markOutputRemoved).toHaveBeenCalledWith('test-session-id', 'msg-1');
			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'sdk.message.updated',
				{ sessionId: 'test-session-id', messageUuid: 'msg-1' },
				{ sessionId: 'test-session-id' }
			);
		});

		it('should get SDK session ID from active session if available', async () => {
			// Setup agent session to return SDK session ID
			mockAgentSession.getSDKSessionId.mockReturnValue('sdk-session-123');

			const result = (await callHandler('message.removeOutput', {
				sessionId: 'test-session-id',
				messageUuid: 'msg-1',
			})) as { success: boolean };

			expect(result.success).toBe(true);
			expect(mockSessionManager.getSession).toHaveBeenCalledWith('test-session-id');
			expect(mockAgentSession.getSDKSessionId).toHaveBeenCalled();
		});

		it('should throw when removal fails', async () => {
			// Import and mock the module to return false
			const sdkModule = await import('../../../../src/lib/sdk-session-file-manager');
			(sdkModule.removeToolResultFromSessionFile as ReturnType<typeof mock>).mockReturnValue(false);

			await expect(
				callHandler('message.removeOutput', {
					sessionId: 'test-session-id',
					messageUuid: 'msg-1',
				})
			).rejects.toThrow('Failed to remove output from SDK session file');

			// Reset mock to original behavior
			(sdkModule.removeToolResultFromSessionFile as ReturnType<typeof mock>).mockReturnValue(true);
		});
	});
});
