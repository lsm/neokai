/**
 * Message RPC Handlers Tests
 */

import { describe, expect, it, beforeAll, mock } from 'bun:test';
import { setupMessageHandlers } from '../src/lib/rpc-handlers/message-handlers';

describe('Message RPC Handlers', () => {
	let handlers: Map<string, Function>;
	let mockMessageHub: any;
	let mockSessionManager: any;

	beforeAll(() => {
		handlers = new Map();
		mockMessageHub = {
			handle: mock((method: string, handler: Function) => {
				handlers.set(method, handler);
			}),
		};

		const mockMessages = [
			{ id: '1', role: 'user', content: 'Hello' },
			{ id: '2', role: 'assistant', content: 'Hi there!' },
		];

		const mockSDKMessages = [
			{ type: 'user', message: { role: 'user', content: 'Hello' } },
			{ type: 'assistant', message: { role: 'assistant', content: 'Hi!' } },
		];

		mockSessionManager = {
			getSessionAsync: mock(async (sessionId: string) => {
				if (sessionId === 'valid-session') {
					return {
						getMessages: mock((limit?: number, offset?: number) => mockMessages),
						getSDKMessages: mock((limit?: number, offset?: number, since?: number) => mockSDKMessages),
					};
				}
				return null;
			}),
		};

		setupMessageHandlers(mockMessageHub, mockSessionManager);
	});

	describe('message.list', () => {
		it('should register handler', () => {
			expect(handlers.has('message.list')).toBe(true);
		});

		it('should list messages for session', async () => {
			const handler = handlers.get('message.list')!;
			const result = await handler({
				sessionId: 'valid-session',
			});

			expect(result.messages).toBeDefined();
			expect(Array.isArray(result.messages)).toBe(true);
			expect(result.messages).toHaveLength(2);
		});

		it('should throw for invalid session', async () => {
			const handler = handlers.get('message.list')!;
			await expect(
				handler({
					sessionId: 'invalid',
				})
			).rejects.toThrow('Session not found');
		});
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

		it('should support offset parameter', async () => {
			const handler = handlers.get('message.sdkMessages')!;
			const result = await handler({
				sessionId: 'valid-session',
				offset: 5,
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
				offset: 0,
				since: Date.now(),
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
});
