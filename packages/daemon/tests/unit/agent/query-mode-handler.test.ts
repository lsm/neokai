/**
 * QueryModeHandler Tests
 *
 * Tests for query mode operations (Manual/Auto-queue).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
	QueryModeHandler,
	type QueryModeHandlerContext,
} from '../../../src/lib/agent/query-mode-handler';
import type { Session } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { MessageQueue } from '../../../src/lib/agent/message-queue';
import type { Logger } from '../../../src/lib/logger';

describe('QueryModeHandler', () => {
	let handler: QueryModeHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockDaemonHub: DaemonHub;
	let mockMessageQueue: MessageQueue;
	let mockLogger: Logger;

	let getMessagesByStatusSpy: ReturnType<typeof mock>;
	let updateMessageStatusSpy: ReturnType<typeof mock>;
	let emitSpy: ReturnType<typeof mock>;
	let enqueueWithIdSpy: ReturnType<typeof mock>;
	let ensureQueryStartedSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
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

		getMessagesByStatusSpy = mock(() => []);
		updateMessageStatusSpy = mock(() => {});
		mockDb = {
			getMessagesByStatus: getMessagesByStatusSpy,
			updateMessageStatus: updateMessageStatusSpy,
		} as unknown as Database;

		emitSpy = mock(async () => {});
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		enqueueWithIdSpy = mock(async () => {});
		mockMessageQueue = {
			enqueueWithId: enqueueWithIdSpy,
		} as unknown as MessageQueue;

		mockLogger = {
			log: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {}),
			info: mock(() => {}),
		} as unknown as Logger;

		ensureQueryStartedSpy = mock(async () => {});
	});

	function createContext(): QueryModeHandlerContext {
		return {
			session: mockSession,
			db: mockDb,
			daemonHub: mockDaemonHub,
			messageQueue: mockMessageQueue,
			logger: mockLogger,
			ensureQueryStarted: ensureQueryStartedSpy,
		};
	}

	function createHandler(): QueryModeHandler {
		return new QueryModeHandler(createContext());
	}

	describe('constructor', () => {
		it('should create handler with dependencies', () => {
			handler = createHandler();
			expect(handler).toBeDefined();
		});
	});

	describe('handleQueryTrigger', () => {
		it('should return success with 0 messages if no saved messages', async () => {
			getMessagesByStatusSpy.mockReturnValue([]);
			handler = createHandler();

			const result = await handler.handleQueryTrigger();

			expect(result).toEqual({ success: true, messageCount: 0 });
			expect(mockLogger.log).toHaveBeenCalledWith('No saved messages to send');
		});

		it('should update message status to queued', async () => {
			const savedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'user',
					message: { role: 'user', content: 'Hello' },
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			await handler.handleQueryTrigger();

			expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'queued');
		});

		it('should emit messages.statusChanged event', async () => {
			const savedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'user',
					message: { role: 'user', content: 'Hello' },
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			await handler.handleQueryTrigger();

			expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
				sessionId: 'test-session-id',
				messageIds: ['db-1'],
				status: 'queued',
			});
		});

		it('should call ensureQueryStarted', async () => {
			const savedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'user',
					message: { role: 'user', content: 'Hello' },
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			await handler.handleQueryTrigger();

			expect(ensureQueryStartedSpy).toHaveBeenCalled();
		});

		it('should enqueue messages with string content', async () => {
			const savedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'user',
					message: { role: 'user', content: 'Hello world' },
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			await handler.handleQueryTrigger();

			expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Hello world');
		});

		it('should enqueue messages with array content', async () => {
			const savedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'user',
					message: {
						role: 'user',
						content: [
							{ type: 'text', text: 'Line 1' },
							{ type: 'text', text: 'Line 2' },
						],
					},
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			await handler.handleQueryTrigger();

			expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Line 1\nLine 2');
		});

		it('should skip non-user messages', async () => {
			const savedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'assistant',
					message: { role: 'assistant', content: [] },
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			await handler.handleQueryTrigger();

			expect(enqueueWithIdSpy).not.toHaveBeenCalled();
		});

		it('should skip messages without content', async () => {
			const savedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'user',
					message: { role: 'user' }, // No content
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			await handler.handleQueryTrigger();

			expect(enqueueWithIdSpy).not.toHaveBeenCalled();
		});

		it('should return error on failure', async () => {
			getMessagesByStatusSpy.mockImplementation(() => {
				throw new Error('Database error');
			});
			handler = createHandler();

			const result = await handler.handleQueryTrigger();

			expect(result).toEqual({
				success: false,
				messageCount: 0,
				error: 'Database error',
			});
			expect(mockLogger.error).toHaveBeenCalledWith('Failed to trigger query:', expect.any(Error));
		});

		it('should return message count on success', async () => {
			const savedMessages: SDKMessage[] = [
				{ dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'Hello' } },
				{ dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'World' } },
			] as unknown as SDKMessage[];
			getMessagesByStatusSpy.mockReturnValue(savedMessages);
			handler = createHandler();

			const result = await handler.handleQueryTrigger();

			expect(result).toEqual({ success: true, messageCount: 2 });
		});
	});

	describe('sendQueuedMessagesOnTurnEnd', () => {
		it('should return early if no queued messages', async () => {
			getMessagesByStatusSpy.mockReturnValue([]);
			handler = createHandler();

			await handler.sendQueuedMessagesOnTurnEnd();

			expect(mockLogger.log).toHaveBeenCalledWith('No queued messages to send on turn end');
			expect(enqueueWithIdSpy).not.toHaveBeenCalled();
		});

		it('should enqueue queued messages', async () => {
			const queuedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'user',
					message: { role: 'user', content: 'Queued message' },
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(queuedMessages);
			handler = createHandler();

			await handler.sendQueuedMessagesOnTurnEnd();

			expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Queued message');
		});

		it('should skip non-user messages', async () => {
			const queuedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-1',
					type: 'system',
					subtype: 'init',
				} as unknown as SDKMessage,
			];
			getMessagesByStatusSpy.mockReturnValue(queuedMessages);
			handler = createHandler();

			await handler.sendQueuedMessagesOnTurnEnd();

			expect(enqueueWithIdSpy).not.toHaveBeenCalled();
		});

		it('should handle errors gracefully', async () => {
			getMessagesByStatusSpy.mockImplementation(() => {
				throw new Error('Database error');
			});
			handler = createHandler();

			// Should not throw
			await handler.sendQueuedMessagesOnTurnEnd();

			expect(mockLogger.error).toHaveBeenCalledWith(
				'Failed to send queued messages on turn end:',
				expect.any(Error)
			);
		});

		it('should process multiple queued messages', async () => {
			const queuedMessages: SDKMessage[] = [
				{ dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'First' } },
				{
					dbId: 'db-2',
					uuid: 'uuid-2',
					type: 'user',
					message: { role: 'user', content: 'Second' },
				},
			] as unknown as SDKMessage[];
			getMessagesByStatusSpy.mockReturnValue(queuedMessages);
			handler = createHandler();

			await handler.sendQueuedMessagesOnTurnEnd();

			expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
			expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'First');
			expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-2', 'Second');
		});
	});
});
