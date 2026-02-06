/**
 * SDK Message Repository Unit Tests
 *
 * Tests for SDK message persistence and query operations.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SDKMessageRepository } from '../../../src/storage/repositories/sdk-message-repository';
import type { SDKMessage } from '@neokai/shared/sdk';

describe('SDKMessageRepository', () => {
	let db: Database;
	let repo: SDKMessageRepository;

	const createUserMessage = (content: string): SDKMessage =>
		({
			type: 'user',
			uuid: `user-${Date.now()}`,
			message: { role: 'user', content },
		}) as unknown as SDKMessage;

	beforeEach(() => {
		// Create in-memory database
		db = new Database(':memory:');

		// Create sdk_messages table
		db.run(`
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'sent'
			)
		`);

		repo = new SDKMessageRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	describe('saveSDKMessage', () => {
		it('should save a user message', () => {
			const message = createUserMessage('Hello');
			const result = repo.saveSDKMessage('session-1', message);

			expect(result).toBe(true);

			const messages = repo.getSDKMessages('session-1');
			expect(messages).toHaveLength(1);
			expect(messages[0].type).toBe('user');
		});

		it('should save message with subtype', () => {
			const message = {
				type: 'result',
				subtype: 'success',
				uuid: 'result-1',
			} as unknown as SDKMessage;

			repo.saveSDKMessage('session-1', message);

			const messages = repo.getSDKMessages('session-1');
			expect(messages).toHaveLength(1);
			expect(messages[0].type).toBe('result');
		});

		it('should return false on database error', () => {
			// Close db to simulate error
			const badDb = new Database(':memory:');
			badDb.close();
			const badRepo = new SDKMessageRepository(badDb);

			const message = createUserMessage('Hello');
			const result = badRepo.saveSDKMessage('session-1', message);

			expect(result).toBe(false);
		});
	});

	describe('getSDKMessages', () => {
		it('should return messages in chronological order', () => {
			// Save messages with different timestamps
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run(
				'1',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"First"}',
				'2024-01-01T00:00:00.000Z'
			);
			stmt.run(
				'2',
				'session-1',
				'assistant',
				null,
				'{"type":"assistant","content":"Second"}',
				'2024-01-01T00:01:00.000Z'
			);
			stmt.run(
				'3',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"Third"}',
				'2024-01-01T00:02:00.000Z'
			);

			const messages = repo.getSDKMessages('session-1');

			expect(messages).toHaveLength(3);
			// Should be in chronological order (oldest first)
			expect((messages[0] as Record<string, unknown>).content).toBe('First');
			expect((messages[2] as Record<string, unknown>).content).toBe('Third');
		});

		it('should respect limit parameter', () => {
			for (let i = 0; i < 10; i++) {
				repo.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const messages = repo.getSDKMessages('session-1', 5);
			expect(messages).toHaveLength(5);
		});

		it('should filter by before cursor', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run(
				'1',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"Old"}',
				'2024-01-01T00:00:00.000Z'
			);
			stmt.run(
				'2',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"New"}',
				'2024-01-02T00:00:00.000Z'
			);

			// Get messages before Jan 2
			const beforeMs = new Date('2024-01-02T00:00:00.000Z').getTime();
			const messages = repo.getSDKMessages('session-1', 100, beforeMs);

			expect(messages).toHaveLength(1);
			expect((messages[0] as Record<string, unknown>).content).toBe('Old');
		});

		it('should filter by since cursor', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run(
				'1',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"Old"}',
				'2024-01-01T00:00:00.000Z'
			);
			stmt.run(
				'2',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"New"}',
				'2024-01-02T00:00:00.000Z'
			);

			// Get messages since Jan 1
			const sinceMs = new Date('2024-01-01T00:00:00.000Z').getTime();
			const messages = repo.getSDKMessages('session-1', 100, undefined, sinceMs);

			expect(messages).toHaveLength(1);
			expect((messages[0] as Record<string, unknown>).content).toBe('New');
		});

		it('should return empty array for non-existent session', () => {
			const messages = repo.getSDKMessages('nonexistent');
			expect(messages).toEqual([]);
		});

		it('should inject timestamp into returned messages', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);
			stmt.run('1', 'session-1', 'user', null, '{"type":"user"}', '2024-01-01T12:00:00.000Z');

			const messages = repo.getSDKMessages('session-1');

			expect(messages[0]).toHaveProperty('timestamp');
			expect((messages[0] as Record<string, unknown>).timestamp).toBe(
				new Date('2024-01-01T12:00:00.000Z').getTime()
			);
		});
	});

	describe('getSDKMessagesByType', () => {
		beforeEach(() => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{"type":"user"}', '2024-01-01T00:00:00.000Z');
			stmt.run(
				'2',
				'session-1',
				'assistant',
				null,
				'{"type":"assistant"}',
				'2024-01-01T00:01:00.000Z'
			);
			stmt.run(
				'3',
				'session-1',
				'result',
				'success',
				'{"type":"result","subtype":"success"}',
				'2024-01-01T00:02:00.000Z'
			);
			stmt.run(
				'4',
				'session-1',
				'result',
				'error',
				'{"type":"result","subtype":"error"}',
				'2024-01-01T00:03:00.000Z'
			);
		});

		it('should filter by message type', () => {
			const messages = repo.getSDKMessagesByType('session-1', 'user');
			expect(messages).toHaveLength(1);
			expect(messages[0].type).toBe('user');
		});

		it('should filter by message type and subtype', () => {
			const messages = repo.getSDKMessagesByType('session-1', 'result', 'success');
			expect(messages).toHaveLength(1);
			expect(messages[0].type).toBe('result');
		});

		it('should respect limit', () => {
			const messages = repo.getSDKMessagesByType('session-1', 'result', undefined, 1);
			expect(messages).toHaveLength(1);
		});
	});

	describe('getSDKMessageCount', () => {
		it('should return correct count', () => {
			repo.saveSDKMessage('session-1', createUserMessage('1'));
			repo.saveSDKMessage('session-1', createUserMessage('2'));
			repo.saveSDKMessage('session-1', createUserMessage('3'));

			const count = repo.getSDKMessageCount('session-1');
			expect(count).toBe(3);
		});

		it('should return 0 for non-existent session', () => {
			const count = repo.getSDKMessageCount('nonexistent');
			expect(count).toBe(0);
		});

		it('should exclude subagent messages with parent_tool_use_id', () => {
			// Create top-level messages
			repo.saveSDKMessage('session-1', createUserMessage('top-level-1'));
			repo.saveSDKMessage('session-1', createUserMessage('top-level-2'));

			// Create subagent messages (nested)
			const subagentMessage1 = createUserMessage('subagent-1');
			(subagentMessage1 as SDKMessage & { parent_tool_use_id: string }).parent_tool_use_id =
				'tool-123';
			repo.saveSDKMessage('session-1', subagentMessage1);

			const subagentMessage2 = createUserMessage('subagent-2');
			(subagentMessage2 as SDKMessage & { parent_tool_use_id: string }).parent_tool_use_id =
				'tool-456';
			repo.saveSDKMessage('session-1', subagentMessage2);

			// Count should only include top-level messages
			const count = repo.getSDKMessageCount('session-1');
			expect(count).toBe(2);
		});
	});

	describe('saveUserMessage', () => {
		it('should save with default sent status', () => {
			const message = createUserMessage('Hello');
			const id = repo.saveUserMessage('session-1', message);

			expect(id).toBeDefined();

			const messages = repo.getMessagesByStatus('session-1', 'sent');
			expect(messages).toHaveLength(1);
		});

		it('should save with custom status', () => {
			const message = createUserMessage('Hello');
			repo.saveUserMessage('session-1', message, 'saved');

			const savedMessages = repo.getMessagesByStatus('session-1', 'saved');
			expect(savedMessages).toHaveLength(1);

			const sentMessages = repo.getMessagesByStatus('session-1', 'sent');
			expect(sentMessages).toHaveLength(0);
		});

		it('should save with queued status', () => {
			const message = createUserMessage('Hello');
			repo.saveUserMessage('session-1', message, 'queued');

			const queuedMessages = repo.getMessagesByStatus('session-1', 'queued');
			expect(queuedMessages).toHaveLength(1);
		});
	});

	describe('getMessagesByStatus', () => {
		it('should return messages with dbId and timestamp', () => {
			const message = createUserMessage('Hello');
			repo.saveUserMessage('session-1', message, 'saved');

			const messages = repo.getMessagesByStatus('session-1', 'saved');

			expect(messages).toHaveLength(1);
			expect(messages[0]).toHaveProperty('dbId');
			expect(messages[0]).toHaveProperty('timestamp');
			expect(typeof messages[0].timestamp).toBe('number');
		});

		it('should return messages in chronological order', () => {
			// Use direct SQL insert to control timestamps
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			);
			stmt.run(
				'id-1',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"First"}',
				'2024-01-01T00:00:00.000Z',
				'queued'
			);
			stmt.run(
				'id-2',
				'session-1',
				'user',
				null,
				'{"type":"user","content":"Second"}',
				'2024-01-01T00:01:00.000Z',
				'queued'
			);

			const messages = repo.getMessagesByStatus('session-1', 'queued');

			expect(messages).toHaveLength(2);
			expect(messages[0].timestamp).toBeLessThan(messages[1].timestamp);
		});
	});

	describe('updateMessageStatus', () => {
		it('should update status for multiple messages', () => {
			const id1 = repo.saveUserMessage('session-1', createUserMessage('1'), 'saved');
			const id2 = repo.saveUserMessage('session-1', createUserMessage('2'), 'saved');

			repo.updateMessageStatus([id1, id2], 'queued');

			const savedMessages = repo.getMessagesByStatus('session-1', 'saved');
			const queuedMessages = repo.getMessagesByStatus('session-1', 'queued');

			expect(savedMessages).toHaveLength(0);
			expect(queuedMessages).toHaveLength(2);
		});

		it('should do nothing for empty array', () => {
			repo.saveUserMessage('session-1', createUserMessage('1'), 'saved');

			// Should not throw
			repo.updateMessageStatus([], 'queued');

			const savedMessages = repo.getMessagesByStatus('session-1', 'saved');
			expect(savedMessages).toHaveLength(1);
		});
	});

	describe('getMessageCountByStatus', () => {
		it('should return correct count per status', () => {
			repo.saveUserMessage('session-1', createUserMessage('1'), 'saved');
			repo.saveUserMessage('session-1', createUserMessage('2'), 'saved');
			repo.saveUserMessage('session-1', createUserMessage('3'), 'queued');

			expect(repo.getMessageCountByStatus('session-1', 'saved')).toBe(2);
			expect(repo.getMessageCountByStatus('session-1', 'queued')).toBe(1);
			expect(repo.getMessageCountByStatus('session-1', 'sent')).toBe(0);
		});
	});

	describe('deleteMessagesAfter', () => {
		it('should delete messages after timestamp', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, '{}', '2024-01-02T00:00:00.000Z');
			stmt.run('3', 'session-1', 'user', null, '{}', '2024-01-03T00:00:00.000Z');

			const cutoff = new Date('2024-01-01T12:00:00.000Z').getTime();
			const deleted = repo.deleteMessagesAfter('session-1', cutoff);

			expect(deleted).toBe(2);

			const remaining = repo.getSDKMessages('session-1');
			expect(remaining).toHaveLength(1);
		});

		it('should return 0 when no messages to delete', () => {
			const deleted = repo.deleteMessagesAfter('session-1', Date.now());
			expect(deleted).toBe(0);
		});
	});

	describe('deleteMessagesAtAndAfter', () => {
		it('should delete messages at and after the given timestamp (inclusive)', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, '{}', '2024-01-02T00:00:00.000Z');
			stmt.run('3', 'session-1', 'user', null, '{}', '2024-01-03T00:00:00.000Z');

			const cutoff = new Date('2024-01-02T00:00:00.000Z').getTime();
			const deleted = repo.deleteMessagesAtAndAfter('session-1', cutoff);

			expect(deleted).toBe(2);

			const remaining = repo.getSDKMessages('session-1');
			expect(remaining).toHaveLength(1);
		});

		it('should include the message at the exact timestamp (boundary test)', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			const exactTimestamp = '2024-01-02T00:00:00.000Z';
			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, '{}', exactTimestamp);
			stmt.run('3', 'session-1', 'user', null, '{}', '2024-01-03T00:00:00.000Z');

			// Delete at exact timestamp - should delete message 2 and 3
			const cutoff = new Date(exactTimestamp).getTime();
			const deleted = repo.deleteMessagesAtAndAfter('session-1', cutoff);

			expect(deleted).toBe(2);

			const remaining = repo.getSDKMessages('session-1');
			expect(remaining).toHaveLength(1);
		});

		it('should return 0 when no messages match', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');

			// Timestamp in the future
			const futureTimestamp = new Date('2024-12-31T00:00:00.000Z').getTime();
			const deleted = repo.deleteMessagesAtAndAfter('session-1', futureTimestamp);

			expect(deleted).toBe(0);
		});

		it('should return the correct count of deleted messages', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, '{}', '2024-01-02T00:00:00.000Z');
			stmt.run('3', 'session-1', 'user', null, '{}', '2024-01-03T00:00:00.000Z');
			stmt.run('4', 'session-1', 'user', null, '{}', '2024-01-04T00:00:00.000Z');
			stmt.run('5', 'session-1', 'user', null, '{}', '2024-01-05T00:00:00.000Z');

			const cutoff = new Date('2024-01-03T00:00:00.000Z').getTime();
			const deleted = repo.deleteMessagesAtAndAfter('session-1', cutoff);

			expect(deleted).toBe(3);
		});

		it('should only affect the specified session', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			// Insert messages in session-1
			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, '{}', '2024-01-02T00:00:00.000Z');
			stmt.run('3', 'session-1', 'user', null, '{}', '2024-01-03T00:00:00.000Z');

			// Insert messages in session-2 with same timestamps
			stmt.run('4', 'session-2', 'user', null, '{}', '2024-01-01T00:00:00.000Z');
			stmt.run('5', 'session-2', 'user', null, '{}', '2024-01-02T00:00:00.000Z');
			stmt.run('6', 'session-2', 'user', null, '{}', '2024-01-03T00:00:00.000Z');

			const cutoff = new Date('2024-01-02T00:00:00.000Z').getTime();
			const deleted = repo.deleteMessagesAtAndAfter('session-1', cutoff);

			expect(deleted).toBe(2);

			const remainingSession1 = repo.getSDKMessages('session-1');
			expect(remainingSession1).toHaveLength(1);

			const remainingSession2 = repo.getSDKMessages('session-2');
			expect(remainingSession2).toHaveLength(3);
		});

		it('should delete all messages when timestamp is before all messages', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-02T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, '{}', '2024-01-03T00:00:00.000Z');
			stmt.run('3', 'session-1', 'user', null, '{}', '2024-01-04T00:00:00.000Z');

			const cutoff = new Date('2024-01-01T00:00:00.000Z').getTime();
			const deleted = repo.deleteMessagesAtAndAfter('session-1', cutoff);

			expect(deleted).toBe(3);

			const remaining = repo.getSDKMessages('session-1');
			expect(remaining).toHaveLength(0);
		});
	});

	describe('getUserMessages', () => {
		it('should return user messages for rewind points', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			// Insert user messages with proper structure
			const userMsg1 =
				'{"type":"user","uuid":"uuid-1","message":{"role":"user","content":"First message"}}';
			const userMsg2 =
				'{"type":"user","uuid":"uuid-2","message":{"role":"user","content":"Second message"}}';
			const assistantMsg =
				'{"type":"assistant","uuid":"uuid-3","message":{"role":"assistant","content":"Response"}}';

			stmt.run('1', 'session-1', 'user', null, userMsg1, '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'assistant', null, assistantMsg, '2024-01-01T00:01:00.000Z');
			stmt.run('3', 'session-1', 'user', null, userMsg2, '2024-01-01T00:02:00.000Z');

			const userMessages = repo.getUserMessages('session-1');

			expect(userMessages).toHaveLength(2);
			expect(userMessages[0].uuid).toBe('uuid-1');
			expect(userMessages[0].content).toBe('First message');
			expect(userMessages[1].uuid).toBe('uuid-2');
			expect(userMessages[1].content).toBe('Second message');
		});

		it('should return empty array when no user messages exist', () => {
			const userMessages = repo.getUserMessages('nonexistent');
			expect(userMessages).toEqual([]);
		});

		it('should extract content from array content blocks', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			const userMsgWithArray =
				'{"type":"user","uuid":"uuid-array","message":{"role":"user","content":[{"type":"text","text":"Array content"}]}}';

			stmt.run('1', 'session-1', 'user', null, userMsgWithArray, '2024-01-01T00:00:00.000Z');

			const userMessages = repo.getUserMessages('session-1');

			expect(userMessages).toHaveLength(1);
			expect(userMessages[0].content).toBe('Array content');
		});
	});

	describe('getUserMessageByUuid', () => {
		it('should return user message by UUID', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			const userMsg1 =
				'{"type":"user","uuid":"target-uuid","message":{"role":"user","content":"Target message"}}';
			const userMsg2 =
				'{"type":"user","uuid":"other-uuid","message":{"role":"user","content":"Other message"}}';

			stmt.run('1', 'session-1', 'user', null, userMsg1, '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, userMsg2, '2024-01-01T00:01:00.000Z');

			const message = repo.getUserMessageByUuid('session-1', 'target-uuid');

			expect(message).toBeDefined();
			expect(message?.uuid).toBe('target-uuid');
			expect(message?.content).toBe('Target message');
		});

		it('should return undefined when UUID not found', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			const userMsg =
				'{"type":"user","uuid":"some-uuid","message":{"role":"user","content":"Some message"}}';

			stmt.run('1', 'session-1', 'user', null, userMsg, '2024-01-01T00:00:00.000Z');

			const message = repo.getUserMessageByUuid('session-1', 'non-existent-uuid');

			expect(message).toBeUndefined();
		});

		it('should return undefined for non-existent session', () => {
			const message = repo.getUserMessageByUuid('nonexistent', 'any-uuid');
			expect(message).toBeUndefined();
		});
	});

	describe('countMessagesAfter', () => {
		it('should count messages after timestamp', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');
			stmt.run('2', 'session-1', 'user', null, '{}', '2024-01-02T00:00:00.000Z');
			stmt.run('3', 'session-1', 'user', null, '{}', '2024-01-03T00:00:00.000Z');

			const cutoff = new Date('2024-01-01T12:00:00.000Z').getTime();
			const count = repo.countMessagesAfter('session-1', cutoff);

			expect(count).toBe(2);
		});

		it('should return 0 when no messages after timestamp', () => {
			const stmt = db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run('1', 'session-1', 'user', null, '{}', '2024-01-01T00:00:00.000Z');

			const cutoff = new Date('2024-01-02T00:00:00.000Z').getTime();
			const count = repo.countMessagesAfter('session-1', cutoff);

			expect(count).toBe(0);
		});

		it('should return 0 for non-existent session', () => {
			const count = repo.countMessagesAfter('nonexistent', Date.now());
			expect(count).toBe(0);
		});
	});
});
