/**
 * Message RPC Handlers Tests
 */

import { describe, expect, it, beforeAll, mock } from 'bun:test';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';

describe('Message RPC Handlers', () => {
	let handlers: Map<string, Function>;
	let mockMessageHub: {
		handle: ReturnType<typeof mock>;
	};
	let mockSessionManager: {
		getSessionAsync: ReturnType<typeof mock>;
	};

	beforeAll(() => {
		handlers = new Map();
		mockMessageHub = {
			handle: mock((method: string, handler: Function) => {
				handlers.set(method, handler);
			}),
		};

		const mockSDKMessages = [
			{ type: 'user', message: { role: 'user', content: 'Hello' } },
			{ type: 'assistant', message: { role: 'assistant', content: 'Hi!' } },
		];

		mockSessionManager = {
			getSessionAsync: mock(async (sessionId: string) => {
				if (sessionId === 'valid-session') {
					return {
						getSDKMessages: mock(
							(_limit?: number, _before?: number, _since?: number) => mockSDKMessages
						),
						getSDKMessageCount: mock(() => mockSDKMessages.length),
					};
				}
				return null;
			}),
		};

		setupMessageHandlers(mockMessageHub, mockSessionManager);
	});

	describe('message.sdkMessages', () => {
		it('should register handler', () => {
			expect(handlers.has('message.sdkMessages')).toBe(true);
		});

		it('should get SDK messages', async () => {
			const handler = handlers.get('message.sdkMessages')!;
			const result = await handler({
				sessionId: 'valid-session',
			});

			expect(result.sdkMessages).toBeDefined();
			expect(Array.isArray(result.sdkMessages)).toBe(true);
			expect(result.sdkMessages).toHaveLength(2);
		});

		it('should support limit parameter', async () => {
			const handler = handlers.get('message.sdkMessages')!;
			const result = await handler({
				sessionId: 'valid-session',
				limit: 10,
			});

			expect(result.sdkMessages).toBeDefined();
		});

		it('should support before parameter for cursor-based pagination', async () => {
			const handler = handlers.get('message.sdkMessages')!;
			const result = await handler({
				sessionId: 'valid-session',
				before: Date.now(),
			});

			expect(result.sdkMessages).toBeDefined();
		});

		it('should support since parameter', async () => {
			const handler = handlers.get('message.sdkMessages')!;
			const result = await handler({
				sessionId: 'valid-session',
				since: Date.now() - 1000,
			});

			expect(result.sdkMessages).toBeDefined();
		});

		it('should support all parameters together', async () => {
			const handler = handlers.get('message.sdkMessages')!;
			const result = await handler({
				sessionId: 'valid-session',
				limit: 5,
				before: Date.now(),
				since: Date.now() - 10000,
			});

			expect(result.sdkMessages).toBeDefined();
		});

		it('should throw for invalid session', async () => {
			const handler = handlers.get('message.sdkMessages')!;
			await expect(
				handler({
					sessionId: 'invalid',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('message.count', () => {
		it('should register handler', () => {
			expect(handlers.has('message.count')).toBe(true);
		});

		it('should get message count', async () => {
			const handler = handlers.get('message.count')!;
			const result = await handler({
				sessionId: 'valid-session',
			});

			expect(result.count).toBeDefined();
			expect(result.count).toBe(2);
		});

		it('should throw for invalid session', async () => {
			const handler = handlers.get('message.count')!;
			await expect(
				handler({
					sessionId: 'invalid',
				})
			).rejects.toThrow('Session not found');
		});
	});
});
