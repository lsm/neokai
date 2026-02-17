/**
 * SDK Message Repository Tests
 *
 * Tests for SDK message CRUD operations, pagination, and query mode tracking.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	SDKMessageRepository,
	type SendStatus,
} from '../../../src/storage/repositories/sdk-message-repository';
import type { SDKMessage } from '@neokai/shared/sdk';

describe('SDKMessageRepository', () => {
	let db: Database;
	let repository: SDKMessageRepository;

	// Helper to create a user message
	function createUserMessage(content: string, uuid: string = crypto.randomUUID()): SDKMessage {
		return {
			type: 'user',
			uuid,
			message: {
				role: 'user',
				content: [{ type: 'text', text: content }],
			},
		} as SDKMessage;
	}

	// Helper to create an assistant message
	function createAssistantMessage(content: string, toolUseId?: string): SDKMessage {
		const blocks: Array<{ type: string; text?: string; id?: string }> = [
			{ type: 'text', text: content },
		];
		if (toolUseId) {
			blocks.push({ type: 'tool_use', id: toolUseId });
		}
		return {
			type: 'assistant',
			message: {
				role: 'assistant',
				content: blocks,
			},
		} as SDKMessage;
	}

	// Helper to create a subagent message
	function createSubagentMessage(content: string, parentToolUseId: string): SDKMessage {
		return {
			type: 'assistant',
			parent_tool_use_id: parentToolUseId,
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: content }],
			},
		} as SDKMessage;
	}

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT
			);
			CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);
			CREATE INDEX idx_sdk_messages_timestamp ON sdk_messages(timestamp);
		`);
		repository = new SDKMessageRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('saveSDKMessage', () => {
		it('should save a user message and return true', () => {
			const message = createUserMessage('Hello world');

			const result = repository.saveSDKMessage('session-1', message);

			expect(result).toBe(true);
		});

		it('should save an assistant message and return true', () => {
			const message = createAssistantMessage('Hello back');

			const result = repository.saveSDKMessage('session-1', message);

			expect(result).toBe(true);
		});

		it('should save message with subtype if present', () => {
			const message = {
				type: 'result',
				subtype: 'success',
				data: 'some data',
			} as SDKMessage;

			const result = repository.saveSDKMessage('session-1', message);

			expect(result).toBe(true);
		});

		it('should save messages for different sessions independently', () => {
			const msg1 = createUserMessage('Session 1 message');
			const msg2 = createUserMessage('Session 2 message');

			repository.saveSDKMessage('session-1', msg1);
			repository.saveSDKMessage('session-2', msg2);

			const session1Messages = repository.getSDKMessages('session-1');
			const session2Messages = repository.getSDKMessages('session-2');

			expect(session1Messages.length).toBe(1);
			expect(session2Messages.length).toBe(1);
		});
	});

	describe('getSDKMessages', () => {
		it('should return messages in chronological order', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const messages = repository.getSDKMessages('session-1');

			expect(messages.length).toBe(3);
			// Messages should be in chronological order (oldest first)
			const content0 = (
				messages[0] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			const content1 = (
				messages[1] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			const content2 = (
				messages[2] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			expect(content0?.[0]?.text).toBe('First');
			expect(content1?.[0]?.text).toBe('Second');
			expect(content2?.[0]?.text).toBe('Third');
		});

		it('should return empty array for non-existent session', () => {
			const messages = repository.getSDKMessages('non-existent');

			expect(messages).toEqual([]);
		});

		it('should respect the limit parameter', () => {
			for (let i = 0; i < 150; i++) {
				repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const messages = repository.getSDKMessages('session-1', 50);

			expect(messages.length).toBe(50);
		});

		it('should return messages before a timestamp (cursor pagination)', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const messages = repository.getSDKMessages('session-1', 100, middleTime);

			// Should only get messages before middleTime
			expect(messages.length).toBe(1);
			const content = (
				messages[0] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			expect(content?.[0]?.text).toBe('First');
		});

		it('should return messages after a timestamp', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const messages = repository.getSDKMessages('session-1', 100, undefined, middleTime);

			// Should only get messages after middleTime
			expect(messages.length).toBe(2);
		});

		it('should include subagent messages for matching tool use IDs', () => {
			const toolUseId = 'tool-use-123';
			repository.saveSDKMessage('session-1', createAssistantMessage('Task started', toolUseId));
			repository.saveSDKMessage('session-1', createSubagentMessage('Subagent work', toolUseId));
			repository.saveSDKMessage('session-1', createSubagentMessage('Another subagent', toolUseId));

			const messages = repository.getSDKMessages('session-1');

			// Should include both top-level and subagent messages
			expect(messages.length).toBe(3);
		});

		it('should exclude subagent messages without matching parent', () => {
			repository.saveSDKMessage('session-1', createAssistantMessage('No tool use'));
			repository.saveSDKMessage(
				'session-1',
				createSubagentMessage('Orphan subagent', 'non-existent-tool')
			);

			const messages = repository.getSDKMessages('session-1');

			// Only top-level message should be returned
			expect(messages.length).toBe(1);
		});

		it('should inject timestamp into returned messages', () => {
			repository.saveSDKMessage('session-1', createUserMessage('Test'));

			const messages = repository.getSDKMessages('session-1');

			expect(messages.length).toBe(1);
			expect((messages[0] as { timestamp?: number }).timestamp).toBeDefined();
			expect(typeof (messages[0] as { timestamp?: number }).timestamp).toBe('number');
		});
	});

	describe('getSDKMessagesByType', () => {
		it('should return only messages of specified type', () => {
			repository.saveSDKMessage('session-1', createUserMessage('User msg'));
			repository.saveSDKMessage('session-1', createAssistantMessage('Assistant msg'));

			const userMessages = repository.getSDKMessagesByType('session-1', 'user');

			expect(userMessages.length).toBe(1);
		});

		it('should filter by subtype when provided', () => {
			const successMessage = {
				type: 'result',
				subtype: 'success',
				data: 'success data',
			} as SDKMessage;
			const errorMessage = {
				type: 'result',
				subtype: 'error',
				error: 'error message',
			} as SDKMessage;

			repository.saveSDKMessage('session-1', successMessage);
			repository.saveSDKMessage('session-1', errorMessage);

			const successMessages = repository.getSDKMessagesByType('session-1', 'result', 'success');
			const errorMessages = repository.getSDKMessagesByType('session-1', 'result', 'error');

			expect(successMessages.length).toBe(1);
			expect(errorMessages.length).toBe(1);
		});

		it('should respect limit parameter', () => {
			for (let i = 0; i < 150; i++) {
				repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const messages = repository.getSDKMessagesByType('session-1', 'user', undefined, 50);

			expect(messages.length).toBe(50);
		});

		it('should return empty array for non-existent type', () => {
			repository.saveSDKMessage('session-1', createUserMessage('User msg'));

			const messages = repository.getSDKMessagesByType('session-1', 'nonexistent');

			expect(messages).toEqual([]);
		});
	});

	describe('getSDKMessageCount', () => {
		it('should return count of top-level messages', () => {
			repository.saveSDKMessage('session-1', createUserMessage('Msg 1'));
			repository.saveSDKMessage('session-1', createUserMessage('Msg 2'));
			repository.saveSDKMessage('session-1', createUserMessage('Msg 3'));

			const count = repository.getSDKMessageCount('session-1');

			expect(count).toBe(3);
		});

		it('should exclude subagent messages from count', () => {
			repository.saveSDKMessage('session-1', createAssistantMessage('Top level', 'tool-1'));
			repository.saveSDKMessage('session-1', createSubagentMessage('Subagent', 'tool-1'));

			const count = repository.getSDKMessageCount('session-1');

			expect(count).toBe(1);
		});

		it('should return 0 for non-existent session', () => {
			const count = repository.getSDKMessageCount('non-existent');

			expect(count).toBe(0);
		});
	});

	describe('saveUserMessage', () => {
		it('should save user message with sent status by default', () => {
			const message = createUserMessage('Test message');

			const id = repository.saveUserMessage('session-1', message);

			expect(id).toBeDefined();
			const savedMessages = repository.getMessagesByStatus('session-1', 'sent');
			expect(savedMessages.length).toBe(1);
		});

		it('should save user message with specified status', () => {
			const message = createUserMessage('Test message');

			repository.saveUserMessage('session-1', message, 'saved');

			const savedMessages = repository.getMessagesByStatus('session-1', 'saved');
			expect(savedMessages.length).toBe(1);
		});

		it('should save user message with queued status', () => {
			const message = createUserMessage('Test message');

			repository.saveUserMessage('session-1', message, 'queued');

			const queuedMessages = repository.getMessagesByStatus('session-1', 'queued');
			expect(queuedMessages.length).toBe(1);
		});

		it('should return unique message ID', () => {
			const message1 = createUserMessage('Message 1');
			const message2 = createUserMessage('Message 2');

			const id1 = repository.saveUserMessage('session-1', message1);
			const id2 = repository.saveUserMessage('session-1', message2);

			expect(id1).not.toBe(id2);
		});
	});

	describe('getMessagesByStatus', () => {
		it('should return messages with specified status', () => {
			const msg1 = createUserMessage('Saved message');
			const msg2 = createUserMessage('Sent message');
			repository.saveUserMessage('session-1', msg1, 'saved');
			repository.saveUserMessage('session-1', msg2, 'sent');

			const savedMessages = repository.getMessagesByStatus('session-1', 'saved');
			const sentMessages = repository.getMessagesByStatus('session-1', 'sent');

			expect(savedMessages.length).toBe(1);
			expect(sentMessages.length).toBe(1);
		});

		it('should return messages in chronological order', async () => {
			repository.saveUserMessage('session-1', createUserMessage('First'), 'saved');
			await new Promise((r) => setTimeout(r, 5));
			repository.saveUserMessage('session-1', createUserMessage('Second'), 'saved');
			await new Promise((r) => setTimeout(r, 5));
			repository.saveUserMessage('session-1', createUserMessage('Third'), 'saved');

			const messages = repository.getMessagesByStatus('session-1', 'saved');

			expect(messages.length).toBe(3);
			// Chronological order means oldest first
			const text0 = (
				(messages[0] as { message?: { content?: Array<{ type: string; text?: string }> } }).message
					?.content?.[0] as { text?: string }
			)?.text;
			const text1 = (
				(messages[1] as { message?: { content?: Array<{ type: string; text?: string }> } }).message
					?.content?.[0] as { text?: string }
			)?.text;
			const text2 = (
				(messages[2] as { message?: { content?: Array<{ type: string; text?: string }> } }).message
					?.content?.[0] as { text?: string }
			)?.text;
			expect(text0).toBe('First');
			expect(text1).toBe('Second');
			expect(text2).toBe('Third');
		});

		it('should include dbId and timestamp in returned messages', () => {
			repository.saveUserMessage('session-1', createUserMessage('Test'), 'saved');

			const messages = repository.getMessagesByStatus('session-1', 'saved');

			expect(messages.length).toBe(1);
			expect(messages[0].dbId).toBeDefined();
			expect(messages[0].timestamp).toBeDefined();
		});

		it('should return empty array for non-matching status', () => {
			repository.saveUserMessage('session-1', createUserMessage('Test'), 'saved');

			const queuedMessages = repository.getMessagesByStatus('session-1', 'queued');

			expect(queuedMessages).toEqual([]);
		});
	});

	describe('updateMessageStatus', () => {
		it('should update status for specified message IDs', () => {
			const id1 = repository.saveUserMessage('session-1', createUserMessage('Msg 1'), 'saved');
			const id2 = repository.saveUserMessage('session-1', createUserMessage('Msg 2'), 'saved');

			repository.updateMessageStatus([id1, id2], 'queued');

			const queuedMessages = repository.getMessagesByStatus('session-1', 'queued');
			expect(queuedMessages.length).toBe(2);
		});

		it('should not throw when given empty array', () => {
			expect(() => repository.updateMessageStatus([], 'sent')).not.toThrow();
		});

		it('should transition from saved to queued to sent', () => {
			const id = repository.saveUserMessage('session-1', createUserMessage('Test'), 'saved');

			repository.updateMessageStatus([id], 'queued');
			expect(repository.getMessagesByStatus('session-1', 'queued').length).toBe(1);

			repository.updateMessageStatus([id], 'sent');
			expect(repository.getMessagesByStatus('session-1', 'sent').length).toBe(1);
			expect(repository.getMessagesByStatus('session-1', 'queued').length).toBe(0);
		});
	});

	describe('getMessageCountByStatus', () => {
		it('should return count of messages with specified status', () => {
			repository.saveUserMessage('session-1', createUserMessage('Msg 1'), 'saved');
			repository.saveUserMessage('session-1', createUserMessage('Msg 2'), 'saved');
			repository.saveUserMessage('session-1', createUserMessage('Msg 3'), 'sent');

			const savedCount = repository.getMessageCountByStatus('session-1', 'saved');
			const sentCount = repository.getMessageCountByStatus('session-1', 'sent');

			expect(savedCount).toBe(2);
			expect(sentCount).toBe(1);
		});

		it('should return 0 for non-matching status', () => {
			repository.saveUserMessage('session-1', createUserMessage('Test'), 'saved');

			const count = repository.getMessageCountByStatus('session-1', 'queued');

			expect(count).toBe(0);
		});
	});

	describe('deleteMessagesAfter', () => {
		it('should delete messages after specified timestamp', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const deletedCount = repository.deleteMessagesAfter('session-1', middleTime);

			expect(deletedCount).toBe(2);
			expect(repository.getSDKMessageCount('session-1')).toBe(1);
		});

		it('should return 0 when no messages to delete', () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			const futureTime = Date.now() + 10000;

			const deletedCount = repository.deleteMessagesAfter('session-1', futureTime);

			expect(deletedCount).toBe(0);
		});

		it('should only delete from specified session', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('Session 1'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-2', createUserMessage('Session 2'));

			repository.deleteMessagesAfter('session-1', middleTime);

			expect(repository.getSDKMessageCount('session-2')).toBe(1);
		});
	});

	describe('deleteMessagesAtAndAfter', () => {
		it('should delete messages at and after specified timestamp (inclusive)', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));

			const deletedCount = repository.deleteMessagesAtAndAfter('session-1', middleTime);

			expect(deletedCount).toBe(1);
		});

		it('should return 0 when no messages to delete', () => {
			const futureTime = Date.now() + 10000;

			const deletedCount = repository.deleteMessagesAtAndAfter('session-1', futureTime);

			expect(deletedCount).toBe(0);
		});
	});

	describe('getUserMessages', () => {
		it('should return user messages with uuid, timestamp, and content', () => {
			const uuid = 'test-uuid-123';
			repository.saveSDKMessage('session-1', createUserMessage('Test message', uuid));

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages.length).toBe(1);
			expect(userMessages[0].uuid).toBe(uuid);
			expect(userMessages[0].content).toBe('Test message');
			expect(userMessages[0].timestamp).toBeDefined();
		});

		it('should return messages in chronological order', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages.length).toBe(3);
			expect(userMessages[0].content).toBe('First');
			expect(userMessages[1].content).toBe('Second');
			expect(userMessages[2].content).toBe('Third');
		});

		it('should return empty array for non-existent session', () => {
			const userMessages = repository.getUserMessages('non-existent');

			expect(userMessages).toEqual([]);
		});

		it('should only return user messages', () => {
			repository.saveSDKMessage('session-1', createUserMessage('User msg'));
			repository.saveSDKMessage('session-1', createAssistantMessage('Assistant msg'));

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages.length).toBe(1);
		});

		it('should handle string content', () => {
			const message: SDKMessage = {
				type: 'user',
				uuid: 'uuid-string-content',
				message: {
					role: 'user',
					content: 'Simple string content',
				},
			} as SDKMessage;
			repository.saveSDKMessage('session-1', message);

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages[0].content).toBe('Simple string content');
		});
	});

	describe('getUserMessageByUuid', () => {
		it('should return message by UUID', () => {
			const uuid = 'specific-uuid-456';
			repository.saveSDKMessage('session-1', createUserMessage('Target message', uuid));

			const message = repository.getUserMessageByUuid('session-1', uuid);

			expect(message).toBeDefined();
			expect(message?.uuid).toBe(uuid);
			expect(message?.content).toBe('Target message');
		});

		it('should return undefined for non-existent UUID', () => {
			const message = repository.getUserMessageByUuid('session-1', 'non-existent-uuid');

			expect(message).toBeUndefined();
		});

		it('should return undefined for wrong session', () => {
			const uuid = 'session-specific-uuid';
			repository.saveSDKMessage('session-1', createUserMessage('Session 1 message', uuid));

			const message = repository.getUserMessageByUuid('session-2', uuid);

			expect(message).toBeUndefined();
		});
	});

	describe('countMessagesAfter', () => {
		it('should count messages after timestamp', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const count = repository.countMessagesAfter('session-1', middleTime);

			expect(count).toBe(2);
		});

		it('should return 0 when no messages after timestamp', () => {
			repository.saveSDKMessage('session-1', createUserMessage('Only message'));
			const futureTime = Date.now() + 10000;

			const count = repository.countMessagesAfter('session-1', futureTime);

			expect(count).toBe(0);
		});

		it('should only count messages from specified session', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('Session 1'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-2', createUserMessage('Session 2'));

			const count = repository.countMessagesAfter('session-1', middleTime);

			expect(count).toBe(0);
		});
	});
});
