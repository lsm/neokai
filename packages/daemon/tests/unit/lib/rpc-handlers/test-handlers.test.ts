/**
 * Test Handlers Tests
 *
 * Tests for the test-only RPC handlers used in E2E testing.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupTestHandlers } from '../../../../src/lib/rpc-handlers/test-handlers';
import type { MessageHub } from '@liuboer/shared';
import type { Database } from '../../../../src/storage/database';
import type { SDKMessage } from '@liuboer/shared/sdk';

describe('Test Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockDb: Database;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
			publish: mock(async () => {}),
		} as unknown as MessageHub;

		// Mock Database
		mockDb = {
			saveSDKMessage: mock(() => {}),
		} as unknown as Database;

		// Setup handlers
		setupTestHandlers(mockMessageHub, mockDb);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register test.injectSDKMessage handler', () => {
			expect(handlers.has('test.injectSDKMessage')).toBe(true);
		});

		it('should register test.broadcastDelta handler', () => {
			expect(handlers.has('test.broadcastDelta')).toBe(true);
		});
	});

	describe('test.injectSDKMessage', () => {
		it('should save SDK message to database', async () => {
			const message: SDKMessage = {
				uuid: 'test-uuid-123',
				type: 'text',
				content: [{ type: 'text', text: 'Hello, world!' }],
			};

			const result = (await callHandler('test.injectSDKMessage', {
				sessionId: 'test-session-id',
				message,
			})) as { success: boolean; uuid: string };

			expect(mockDb.saveSDKMessage).toHaveBeenCalledWith('test-session-id', message);
			expect(result.success).toBe(true);
			expect(result.uuid).toBe('test-uuid-123');
		});

		it('should publish state.sdkMessages.delta event with timestamp', async () => {
			const message: SDKMessage = {
				uuid: 'delta-uuid-456',
				type: 'text',
				content: [{ type: 'text', text: 'Delta message' }],
			};

			await callHandler('test.injectSDKMessage', {
				sessionId: 'session-123',
				message,
			});

			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'state.sdkMessages.delta',
				expect.objectContaining({
					added: expect.arrayContaining([
						expect.objectContaining({
							uuid: 'delta-uuid-456',
							type: 'text',
							timestamp: expect.any(Number),
						}),
					]),
					timestamp: expect.any(Number),
				}),
				{ sessionId: 'session-123' }
			);
		});

		it('should return success response with uuid', async () => {
			const message: SDKMessage = {
				uuid: 'response-uuid-789',
				type: 'tool_use',
				name: 'test-tool',
			} as SDKMessage;

			const result = (await callHandler('test.injectSDKMessage', {
				sessionId: 'any-session',
				message,
			})) as { success: boolean; uuid: string };

			expect(result).toEqual({
				success: true,
				uuid: 'response-uuid-789',
			});
		});

		it('should handle assistant message type', async () => {
			const message: SDKMessage = {
				uuid: 'assistant-uuid',
				type: 'assistant',
				message: { content: 'Assistant response' },
			} as unknown as SDKMessage;

			const result = (await callHandler('test.injectSDKMessage', {
				sessionId: 'session-abc',
				message,
			})) as { success: boolean; uuid: string };

			expect(mockDb.saveSDKMessage).toHaveBeenCalled();
			expect(result.success).toBe(true);
		});
	});

	describe('test.broadcastDelta', () => {
		it('should publish delta to specified channel', async () => {
			const deltaData = { messages: [{ id: 1, text: 'Test' }] };

			const result = (await callHandler('test.broadcastDelta', {
				sessionId: 'broadcast-session',
				channel: 'state.session.delta',
				data: deltaData,
			})) as { success: boolean };

			expect(mockMessageHub.publish).toHaveBeenCalledWith('state.session.delta', deltaData, {
				sessionId: 'broadcast-session',
			});
			expect(result.success).toBe(true);
		});

		it('should broadcast to different channels', async () => {
			await callHandler('test.broadcastDelta', {
				sessionId: 'session-1',
				channel: 'state.sdkMessages.delta',
				data: { added: [], timestamp: 123 },
			});

			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'state.sdkMessages.delta',
				{ added: [], timestamp: 123 },
				{ sessionId: 'session-1' }
			);
		});

		it('should handle complex delta data', async () => {
			const complexData = {
				added: [{ uuid: '1', type: 'text' }],
				updated: [{ uuid: '2', status: 'completed' }],
				removed: ['3', '4'],
				metadata: {
					version: 1,
					timestamp: Date.now(),
				},
			};

			const result = (await callHandler('test.broadcastDelta', {
				sessionId: 'complex-session',
				channel: 'state.custom.delta',
				data: complexData,
			})) as { success: boolean };

			expect(mockMessageHub.publish).toHaveBeenCalledWith('state.custom.delta', complexData, {
				sessionId: 'complex-session',
			});
			expect(result.success).toBe(true);
		});

		it('should return success response', async () => {
			const result = (await callHandler('test.broadcastDelta', {
				sessionId: 'any-session',
				channel: 'test.channel',
				data: {},
			})) as { success: boolean };

			expect(result).toEqual({ success: true });
		});
	});
});
