/**
 * SDK Message Repository Integration Tests
 *
 * Tests for SDK message persistence and retrieval operations through the Database facade.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../src/storage/database';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { createTestSession } from './fixtures/database-test-utils';

describe('SDKMessageRepository', () => {
	let db: Database;
	const sessionId = 'test-session-id';

	beforeEach(async () => {
		db = new Database(':memory:');
		await db.initialize();

		// Create a test session first
		const session = createTestSession(sessionId);
		db.createSession(session);
	});

	afterEach(() => {
		db.close();
	});

	describe('saveSDKMessage', () => {
		it('should save a user message', () => {
			const message: SDKMessage = {
				type: 'user',
				uuid: 'msg-1',
				session_id: sessionId,
				message: { role: 'user', content: 'Hello' },
			} as SDKMessage;

			const result = db.saveSDKMessage(sessionId, message);

			expect(result).toBe(true);
			expect(db.getSDKMessageCount(sessionId)).toBe(1);
		});

		it('should save an assistant message', () => {
			const message: SDKMessage = {
				type: 'assistant',
				uuid: 'msg-2',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Hi there!' }],
				},
			} as SDKMessage;

			const result = db.saveSDKMessage(sessionId, message);

			expect(result).toBe(true);
		});

		it('should save a message with subtype', () => {
			const message: SDKMessage = {
				type: 'result',
				subtype: 'success',
				uuid: 'msg-3',
			} as SDKMessage;

			const result = db.saveSDKMessage(sessionId, message);

			expect(result).toBe(true);
		});

		it('should save multiple messages', () => {
			for (let i = 0; i < 5; i++) {
				const message: SDKMessage = {
					type: 'user',
					uuid: `msg-${i}`,
					session_id: sessionId,
					message: { role: 'user', content: `Message ${i}` },
				} as SDKMessage;
				db.saveSDKMessage(sessionId, message);
			}

			expect(db.getSDKMessageCount(sessionId)).toBe(5);
		});
	});

	describe('getSDKMessages', () => {
		beforeEach(() => {
			// Save some test messages
			for (let i = 0; i < 10; i++) {
				const message: SDKMessage = {
					type: 'user',
					uuid: `msg-${i}`,
					session_id: sessionId,
					message: { role: 'user', content: `Message ${i}` },
				} as SDKMessage;
				db.saveSDKMessage(sessionId, message);
			}
		});

		it('should return messages in chronological order', () => {
			const messages = db.getSDKMessages(sessionId);

			expect(messages.length).toBe(10);
			// Messages should be in chronological order (oldest to newest)
			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i] as { message: { content: string } };
				expect(msg.message.content).toBe(`Message ${i}`);
			}
		});

		it('should respect limit parameter', () => {
			const messages = db.getSDKMessages(sessionId, 5);

			expect(messages.length).toBe(5);
		});

		it('should return empty array for non-existent session', () => {
			const messages = db.getSDKMessages('non-existent-session');

			expect(messages).toEqual([]);
		});

		it('should inject timestamp into returned messages', () => {
			const messages = db.getSDKMessages(sessionId);

			expect(messages.length).toBeGreaterThan(0);
			for (const msg of messages) {
				expect((msg as unknown as { timestamp: number }).timestamp).toBeDefined();
				expect(typeof (msg as unknown as { timestamp: number }).timestamp).toBe('number');
			}
		});
	});

	describe('getSDKMessagesByType', () => {
		beforeEach(() => {
			// Save mixed message types
			db.saveSDKMessage(sessionId, {
				type: 'user',
				uuid: 'u1',
				message: { role: 'user', content: 'Hello' },
			} as SDKMessage);
			db.saveSDKMessage(sessionId, {
				type: 'assistant',
				uuid: 'a1',
				message: { role: 'assistant', content: [] },
			} as SDKMessage);
			db.saveSDKMessage(sessionId, {
				type: 'user',
				uuid: 'u2',
				message: { role: 'user', content: 'Another' },
			} as SDKMessage);
			db.saveSDKMessage(sessionId, {
				type: 'result',
				subtype: 'success',
				uuid: 'r1',
			} as SDKMessage);
			db.saveSDKMessage(sessionId, {
				type: 'result',
				subtype: 'error',
				uuid: 'r2',
			} as SDKMessage);
		});

		it('should filter by message type', () => {
			const userMessages = db.getSDKMessagesByType(sessionId, 'user');

			expect(userMessages.length).toBe(2);
			for (const msg of userMessages) {
				expect(msg.type).toBe('user');
			}
		});

		it('should filter by message type and subtype', () => {
			const successResults = db.getSDKMessagesByType(sessionId, 'result', 'success');

			expect(successResults.length).toBe(1);
			expect(successResults[0].type).toBe('result');
			expect((successResults[0] as { subtype: string }).subtype).toBe('success');
		});

		it('should respect limit parameter', () => {
			const messages = db.getSDKMessagesByType(sessionId, 'user', undefined, 1);

			expect(messages.length).toBe(1);
		});
	});

	describe('getSDKMessageCount', () => {
		it('should return 0 for empty session', () => {
			const count = db.getSDKMessageCount('empty-session');

			expect(count).toBe(0);
		});

		it('should return correct count', () => {
			for (let i = 0; i < 7; i++) {
				db.saveSDKMessage(sessionId, {
					type: 'user',
					uuid: `msg-${i}`,
					message: { role: 'user', content: `Message ${i}` },
				} as SDKMessage);
			}

			expect(db.getSDKMessageCount(sessionId)).toBe(7);
		});
	});

	describe('saveUserMessage with send status', () => {
		it('should save message with default sent status', () => {
			const message: SDKMessage = {
				type: 'user',
				uuid: 'msg-1',
				message: { role: 'user', content: 'Hello' },
			} as SDKMessage;

			const id = db.saveUserMessage(sessionId, message);

			expect(id).toBeDefined();
			expect(db.getSDKMessageCount(sessionId)).toBe(1);
		});

		it('should save message with saved status', () => {
			const message: SDKMessage = {
				type: 'user',
				uuid: 'msg-1',
				message: { role: 'user', content: 'Hello' },
			} as SDKMessage;

			db.saveUserMessage(sessionId, message, 'saved');

			const savedMessages = db.getMessagesByStatus(sessionId, 'saved');
			expect(savedMessages.length).toBe(1);
		});

		it('should save message with queued status', () => {
			const message: SDKMessage = {
				type: 'user',
				uuid: 'msg-1',
				message: { role: 'user', content: 'Hello' },
			} as SDKMessage;

			db.saveUserMessage(sessionId, message, 'queued');

			const queuedMessages = db.getMessagesByStatus(sessionId, 'queued');
			expect(queuedMessages.length).toBe(1);
		});
	});

	describe('getMessagesByStatus', () => {
		beforeEach(() => {
			db.saveUserMessage(
				sessionId,
				{
					type: 'user',
					uuid: 'msg-1',
					message: { role: 'user', content: 'Saved 1' },
				} as SDKMessage,
				'saved'
			);
			db.saveUserMessage(
				sessionId,
				{
					type: 'user',
					uuid: 'msg-2',
					message: { role: 'user', content: 'Queued 1' },
				} as SDKMessage,
				'queued'
			);
			db.saveUserMessage(
				sessionId,
				{
					type: 'user',
					uuid: 'msg-3',
					message: { role: 'user', content: 'Sent 1' },
				} as SDKMessage,
				'sent'
			);
		});

		it('should return messages by saved status', () => {
			const messages = db.getMessagesByStatus(sessionId, 'saved');

			expect(messages.length).toBe(1);
			expect((messages[0].message as { content: string }).content).toBe('Saved 1');
		});

		it('should return messages by queued status', () => {
			const messages = db.getMessagesByStatus(sessionId, 'queued');

			expect(messages.length).toBe(1);
			expect((messages[0].message as { content: string }).content).toBe('Queued 1');
		});

		it('should return messages by sent status', () => {
			const messages = db.getMessagesByStatus(sessionId, 'sent');

			expect(messages.length).toBe(1);
			expect((messages[0].message as { content: string }).content).toBe('Sent 1');
		});

		it('should include dbId and timestamp in returned messages', () => {
			const messages = db.getMessagesByStatus(sessionId, 'saved');

			expect(messages.length).toBeGreaterThan(0);
			expect(messages[0].dbId).toBeDefined();
			expect(messages[0].timestamp).toBeDefined();
		});
	});

	describe('updateMessageStatus', () => {
		it('should update message status', () => {
			const id = db.saveUserMessage(
				sessionId,
				{
					type: 'user',
					uuid: 'msg-1',
					message: { role: 'user', content: 'Test' },
				} as SDKMessage,
				'saved'
			);

			// Initially saved
			expect(db.getMessagesByStatus(sessionId, 'saved').length).toBe(1);
			expect(db.getMessagesByStatus(sessionId, 'queued').length).toBe(0);

			// Update to queued
			db.updateMessageStatus([id], 'queued');

			expect(db.getMessagesByStatus(sessionId, 'saved').length).toBe(0);
			expect(db.getMessagesByStatus(sessionId, 'queued').length).toBe(1);
		});

		it('should update multiple messages at once', () => {
			const id1 = db.saveUserMessage(
				sessionId,
				{
					type: 'user',
					uuid: 'msg-1',
					message: { role: 'user', content: 'Test 1' },
				} as SDKMessage,
				'saved'
			);
			const id2 = db.saveUserMessage(
				sessionId,
				{
					type: 'user',
					uuid: 'msg-2',
					message: { role: 'user', content: 'Test 2' },
				} as SDKMessage,
				'saved'
			);

			db.updateMessageStatus([id1, id2], 'sent');

			expect(db.getMessagesByStatus(sessionId, 'saved').length).toBe(0);
			expect(db.getMessagesByStatus(sessionId, 'sent').length).toBe(2);
		});

		it('should handle empty array', () => {
			// Should not throw
			db.updateMessageStatus([], 'sent');
		});
	});

	describe('getMessageCountByStatus', () => {
		beforeEach(() => {
			db.saveUserMessage(
				sessionId,
				{ type: 'user', uuid: 'msg-1', message: { role: 'user', content: '1' } } as SDKMessage,
				'saved'
			);
			db.saveUserMessage(
				sessionId,
				{ type: 'user', uuid: 'msg-2', message: { role: 'user', content: '2' } } as SDKMessage,
				'saved'
			);
			db.saveUserMessage(
				sessionId,
				{ type: 'user', uuid: 'msg-3', message: { role: 'user', content: '3' } } as SDKMessage,
				'queued'
			);
		});

		it('should return correct count for saved messages', () => {
			expect(db.getMessageCountByStatus(sessionId, 'saved')).toBe(2);
		});

		it('should return correct count for queued messages', () => {
			expect(db.getMessageCountByStatus(sessionId, 'queued')).toBe(1);
		});

		it('should return 0 for sent messages', () => {
			expect(db.getMessageCountByStatus(sessionId, 'sent')).toBe(0);
		});
	});

	describe('deleteMessagesAfter', () => {
		it('should delete messages after a timestamp', async () => {
			// Save messages with delays to ensure different timestamps
			db.saveSDKMessage(sessionId, {
				type: 'user',
				uuid: 'msg-1',
				message: { role: 'user', content: 'First' },
			} as SDKMessage);

			// Small delay to ensure different timestamp
			await new Promise((r) => setTimeout(r, 10));
			const middleTimestamp = Date.now();
			await new Promise((r) => setTimeout(r, 10));

			db.saveSDKMessage(sessionId, {
				type: 'user',
				uuid: 'msg-2',
				message: { role: 'user', content: 'Second' },
			} as SDKMessage);
			db.saveSDKMessage(sessionId, {
				type: 'user',
				uuid: 'msg-3',
				message: { role: 'user', content: 'Third' },
			} as SDKMessage);

			// Delete messages after middle timestamp
			const deletedCount = db.deleteMessagesAfter(sessionId, middleTimestamp);

			expect(deletedCount).toBe(2);
			expect(db.getSDKMessageCount(sessionId)).toBe(1);
		});

		it('should return 0 when no messages match', () => {
			db.saveSDKMessage(sessionId, {
				type: 'user',
				uuid: 'msg-1',
				message: { role: 'user', content: 'Test' },
			} as SDKMessage);

			// Future timestamp - no messages should be deleted
			const deletedCount = db.deleteMessagesAfter(sessionId, Date.now() + 100000);

			expect(deletedCount).toBe(0);
		});
	});
});
