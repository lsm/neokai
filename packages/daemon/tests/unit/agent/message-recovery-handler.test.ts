/**
 * MessageRecoveryHandler Tests
 *
 * Tests for recovering orphaned messages.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { MessageRecoveryHandler } from '../../../src/lib/agent/message-recovery-handler';
import type { Session } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { Database } from '../../../src/storage/database';
import type { Logger } from '../../../src/lib/logger';

describe('MessageRecoveryHandler', () => {
	let handler: MessageRecoveryHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockLogger: Logger;

	let getMessagesByStatusSpy: ReturnType<typeof mock>;
	let getSDKMessagesSpy: ReturnType<typeof mock>;
	let updateMessageStatusSpy: ReturnType<typeof mock>;

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
		getSDKMessagesSpy = mock(() => ({ messages: [], hasMore: false }));
		updateMessageStatusSpy = mock(() => {});
		mockDb = {
			getMessagesByStatus: getMessagesByStatusSpy,
			getSDKMessages: getSDKMessagesSpy,
			updateMessageStatus: updateMessageStatusSpy,
		} as unknown as Database;

		mockLogger = {
			log: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {}),
			info: mock(() => {}),
		} as unknown as Logger;

		handler = new MessageRecoveryHandler(mockSession, mockDb, mockLogger);
	});

	describe('constructor', () => {
		it('should create handler with dependencies', () => {
			expect(handler).toBeDefined();
		});
	});

	describe('recoverOrphanedSentMessages', () => {
		it('should return early if no stuck messages', () => {
			getMessagesByStatusSpy.mockReturnValue([]);

			handler.recoverOrphanedSentMessages();

			expect(getSDKMessagesSpy).not.toHaveBeenCalled();
			expect(updateMessageStatusSpy).not.toHaveBeenCalled();
		});

		it('should check both queued and sent messages', () => {
			getMessagesByStatusSpy.mockReturnValue([]);

			handler.recoverOrphanedSentMessages();

			expect(getMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'queued');
			expect(getMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'sent');
		});

		it('should find orphaned user messages without system:init response', () => {
			const queuedUserMessage: SDKMessage = {
				dbId: 'db-1',
				uuid: 'uuid-12345678',
				type: 'user',
				message: { role: 'user', content: 'Hello' },
				timestamp: 2000,
			} as unknown as SDKMessage;

			// First call returns queued messages, second returns empty sent
			getMessagesByStatusSpy.mockReturnValueOnce([queuedUserMessage]).mockReturnValueOnce([]);

			// All messages including system:init
			const systemInitMessage: SDKMessage = {
				dbId: 'db-0',
				uuid: 'init-uuid',
				type: 'system',
				subtype: 'init',
				timestamp: 1000,
			} as unknown as SDKMessage;

			getSDKMessagesSpy.mockReturnValue({ messages: [systemInitMessage], hasMore: false });

			handler.recoverOrphanedSentMessages();

			// User message timestamp (2000) > system:init timestamp (1000) = orphaned
			expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'saved');
		});

		it('should not recover messages that have system:init after them', () => {
			const queuedUserMessage: SDKMessage = {
				dbId: 'db-1',
				uuid: 'uuid-12345678',
				type: 'user',
				message: { role: 'user', content: 'Hello' },
				timestamp: 1000,
			} as unknown as SDKMessage;

			getMessagesByStatusSpy.mockReturnValueOnce([queuedUserMessage]).mockReturnValueOnce([]);

			// System:init came AFTER the user message
			const systemInitMessage: SDKMessage = {
				dbId: 'db-0',
				uuid: 'init-uuid',
				type: 'system',
				subtype: 'init',
				timestamp: 2000,
			} as unknown as SDKMessage;

			getSDKMessagesSpy.mockReturnValue({ messages: [systemInitMessage], hasMore: false });

			handler.recoverOrphanedSentMessages();

			// User message timestamp (1000) < system:init timestamp (2000) = not orphaned
			expect(updateMessageStatusSpy).not.toHaveBeenCalled();
		});

		it('should skip non-user messages', () => {
			const assistantMessage: SDKMessage = {
				dbId: 'db-1',
				uuid: 'uuid-12345678',
				type: 'assistant',
				message: { role: 'assistant', content: [] },
				timestamp: 2000,
			} as unknown as SDKMessage;

			getMessagesByStatusSpy.mockReturnValueOnce([assistantMessage]).mockReturnValueOnce([]);

			getSDKMessagesSpy.mockReturnValue({ messages: [], hasMore: false });

			handler.recoverOrphanedSentMessages();

			expect(updateMessageStatusSpy).not.toHaveBeenCalled();
		});

		it('should recover multiple orphaned messages', () => {
			const queuedMessages: SDKMessage[] = [
				{
					dbId: 'db-1',
					uuid: 'uuid-11111111',
					type: 'user',
					message: { role: 'user', content: 'First' },
					timestamp: 2000,
				} as unknown as SDKMessage,
				{
					dbId: 'db-2',
					uuid: 'uuid-22222222',
					type: 'user',
					message: { role: 'user', content: 'Second' },
					timestamp: 3000,
				} as unknown as SDKMessage,
			];

			getMessagesByStatusSpy.mockReturnValueOnce(queuedMessages).mockReturnValueOnce([]);

			const systemInitMessage: SDKMessage = {
				dbId: 'db-0',
				uuid: 'init-uuid',
				type: 'system',
				subtype: 'init',
				timestamp: 1000,
			} as unknown as SDKMessage;

			getSDKMessagesSpy.mockReturnValue({ messages: [systemInitMessage], hasMore: false });

			handler.recoverOrphanedSentMessages();

			expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2'], 'saved');
		});

		it('should handle errors gracefully', () => {
			getMessagesByStatusSpy.mockImplementation(() => {
				throw new Error('Database error');
			});

			// Should not throw
			handler.recoverOrphanedSentMessages();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to recover orphaned sent messages:',
				expect.any(Error)
			);
		});

		it('should handle messages without timestamps', () => {
			const queuedUserMessage: SDKMessage = {
				dbId: 'db-1',
				uuid: 'uuid-12345678',
				type: 'user',
				message: { role: 'user', content: 'Hello' },
				// No timestamp
			} as unknown as SDKMessage;

			getMessagesByStatusSpy.mockReturnValueOnce([queuedUserMessage]).mockReturnValueOnce([]);

			getSDKMessagesSpy.mockReturnValue({ messages: [], hasMore: false });

			handler.recoverOrphanedSentMessages();

			// With no system:init (latestInitTimestamp = 0) and message timestamp = 0,
			// the message is NOT orphaned (0 > 0 is false)
			expect(updateMessageStatusSpy).not.toHaveBeenCalled();
		});

		it('should handle messages without uuid', () => {
			const queuedUserMessage: SDKMessage = {
				dbId: 'db-1',
				// No uuid
				type: 'user',
				message: { role: 'user', content: 'Hello' },
				timestamp: 2000,
			} as unknown as SDKMessage;

			getMessagesByStatusSpy.mockReturnValueOnce([queuedUserMessage]).mockReturnValueOnce([]);

			getSDKMessagesSpy.mockReturnValue({ messages: [], hasMore: false });

			handler.recoverOrphanedSentMessages();

			expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'saved');
		});

		it('should find latest system:init timestamp', () => {
			const queuedUserMessage: SDKMessage = {
				dbId: 'db-1',
				uuid: 'uuid-12345678',
				type: 'user',
				message: { role: 'user', content: 'Hello' },
				timestamp: 2500,
			} as unknown as SDKMessage;

			getMessagesByStatusSpy.mockReturnValueOnce([queuedUserMessage]).mockReturnValueOnce([]);

			// Multiple system:init messages
			const systemInitMessages: SDKMessage[] = [
				{
					dbId: 'db-0',
					uuid: 'init-1',
					type: 'system',
					subtype: 'init',
					timestamp: 1000,
				} as unknown as SDKMessage,
				{
					dbId: 'db-0',
					uuid: 'init-2',
					type: 'system',
					subtype: 'init',
					timestamp: 3000, // Latest
				} as unknown as SDKMessage,
				{
					dbId: 'db-0',
					uuid: 'init-3',
					type: 'system',
					subtype: 'init',
					timestamp: 2000,
				} as unknown as SDKMessage,
			];

			getSDKMessagesSpy.mockReturnValue({ messages: systemInitMessages, hasMore: false });

			handler.recoverOrphanedSentMessages();

			// User message timestamp (2500) < latest system:init (3000) = not orphaned
			expect(updateMessageStatusSpy).not.toHaveBeenCalled();
		});
	});
});
