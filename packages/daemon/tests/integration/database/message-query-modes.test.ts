/**
 * Message Query Modes Database Tests
 *
 * Tests for message status management (sent/saved/queued modes)
 */

import { describe, test } from 'bun:test';
import {
	createTestDb,
	createTestSession,
	assertEquals,
	assertExists,
} from '../../helpers/database';

describe('Database', () => {
	describe('Message Query Modes', () => {
		test('should save user message with default send_status (sent)', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Save as SDK user message (default status)
			const sdkMessage = {
				type: 'user' as const,
				message: {
					role: 'user' as const,
					content: 'Hello, world!',
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000001' as const,
				session_id: 'session-1',
			};

			const messageId = db.saveUserMessage('session-1', sdkMessage);
			assertExists(messageId);

			// Messages should appear in getSDKMessages (which gets all messages)
			const messages = db.getSDKMessages('session-1');
			assertEquals(messages.length, 1);

			// Check count by status - should be 1 'sent'
			assertEquals(db.getMessageCountByStatus('session-1', 'sent'), 1);
			assertEquals(db.getMessageCountByStatus('session-1', 'saved'), 0);
			assertEquals(db.getMessageCountByStatus('session-1', 'queued'), 0);

			db.close();
		});

		test('should save user message with saved status (Manual mode)', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			const sdkMessage = {
				type: 'user' as const,
				message: {
					role: 'user' as const,
					content: 'Message to save but not send',
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000002' as const,
				session_id: 'session-1',
			};

			db.saveUserMessage('session-1', sdkMessage, 'saved');

			// Check counts
			assertEquals(db.getMessageCountByStatus('session-1', 'saved'), 1);
			assertEquals(db.getMessageCountByStatus('session-1', 'sent'), 0);

			db.close();
		});

		test('should save user message with queued status (Auto-queue mode)', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			const sdkMessage = {
				type: 'user' as const,
				message: {
					role: 'user' as const,
					content: 'Queued message',
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000003' as const,
				session_id: 'session-1',
			};

			db.saveUserMessage('session-1', sdkMessage, 'queued');

			// Check counts
			assertEquals(db.getMessageCountByStatus('session-1', 'queued'), 1);
			assertEquals(db.getMessageCountByStatus('session-1', 'sent'), 0);

			db.close();
		});

		test('should get messages by status', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Create messages with different statuses
			const savedMsg = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Saved message' },
				parent_tool_use_id: null,
				uuid: 'msg-saved' as const,
				session_id: 'session-1',
			};
			const queuedMsg = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Queued message' },
				parent_tool_use_id: null,
				uuid: 'msg-queued' as const,
				session_id: 'session-1',
			};
			const sentMsg = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Sent message' },
				parent_tool_use_id: null,
				uuid: 'msg-sent' as const,
				session_id: 'session-1',
			};

			db.saveUserMessage('session-1', savedMsg, 'saved');
			db.saveUserMessage('session-1', queuedMsg, 'queued');
			db.saveUserMessage('session-1', sentMsg, 'sent');

			// Get by status
			const savedMessages = db.getMessagesByStatus('session-1', 'saved');
			const queuedMessages = db.getMessagesByStatus('session-1', 'queued');
			const sentMessages = db.getMessagesByStatus('session-1', 'sent');

			assertEquals(savedMessages.length, 1);
			assertEquals(savedMessages[0].uuid, 'msg-saved');
			assertExists(savedMessages[0].dbId); // Should have dbId for update operations

			assertEquals(queuedMessages.length, 1);
			assertEquals(queuedMessages[0].uuid, 'msg-queued');

			assertEquals(sentMessages.length, 1);
			assertEquals(sentMessages[0].uuid, 'msg-sent');

			db.close();
		});

		test('should update message status', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Create saved messages
			const msg1 = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Message 1' },
				parent_tool_use_id: null,
				uuid: 'msg-1' as const,
				session_id: 'session-1',
			};
			const msg2 = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Message 2' },
				parent_tool_use_id: null,
				uuid: 'msg-2' as const,
				session_id: 'session-1',
			};

			db.saveUserMessage('session-1', msg1, 'saved');
			db.saveUserMessage('session-1', msg2, 'saved');

			// Verify initial status
			assertEquals(db.getMessageCountByStatus('session-1', 'saved'), 2);

			// Get saved messages to get their dbIds
			const savedMessages = db.getMessagesByStatus('session-1', 'saved');
			const dbIds = savedMessages.map((m) => m.dbId);

			// Update to queued
			db.updateMessageStatus(dbIds, 'queued');

			assertEquals(db.getMessageCountByStatus('session-1', 'saved'), 0);
			assertEquals(db.getMessageCountByStatus('session-1', 'queued'), 2);

			// Update to sent
			db.updateMessageStatus(dbIds, 'sent');

			assertEquals(db.getMessageCountByStatus('session-1', 'queued'), 0);
			assertEquals(db.getMessageCountByStatus('session-1', 'sent'), 2);

			db.close();
		});

		test('should handle empty array for updateMessageStatus', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Should not throw
			db.updateMessageStatus([], 'sent');

			db.close();
		});

		test('should maintain message order by timestamp in getMessagesByStatus', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Save messages with small delays to ensure different timestamps
			for (let i = 0; i < 5; i++) {
				const msg = {
					type: 'user' as const,
					message: { role: 'user' as const, content: `Message ${i}` },
					parent_tool_use_id: null,
					uuid: `msg-${i}` as const,
					session_id: 'session-1',
				};
				db.saveUserMessage('session-1', msg, 'saved');
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			// Get saved messages - should be in chronological order (oldest first)
			const savedMessages = db.getMessagesByStatus('session-1', 'saved');
			assertEquals(savedMessages.length, 5);
			assertEquals(savedMessages[0].uuid, 'msg-0'); // Oldest first
			assertEquals(savedMessages[4].uuid, 'msg-4'); // Newest last

			db.close();
		});

		test('should isolate messages by session', async () => {
			const db = await createTestDb();

			const session1 = createTestSession('session-1');
			const session2 = createTestSession('session-2');
			db.createSession(session1);
			db.createSession(session2);

			// Create messages in different sessions with different statuses
			const msg1 = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Session 1 saved' },
				parent_tool_use_id: null,
				uuid: 's1-msg' as const,
				session_id: 'session-1',
			};
			const msg2 = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Session 2 saved' },
				parent_tool_use_id: null,
				uuid: 's2-msg' as const,
				session_id: 'session-2',
			};

			db.saveUserMessage('session-1', msg1, 'saved');
			db.saveUserMessage('session-2', msg2, 'saved');

			// Each session should only see its own messages
			assertEquals(db.getMessageCountByStatus('session-1', 'saved'), 1);
			assertEquals(db.getMessageCountByStatus('session-2', 'saved'), 1);

			const s1Messages = db.getMessagesByStatus('session-1', 'saved');
			const s2Messages = db.getMessagesByStatus('session-2', 'saved');

			assertEquals(s1Messages.length, 1);
			assertEquals(s1Messages[0].uuid, 's1-msg');
			assertEquals(s2Messages.length, 1);
			assertEquals(s2Messages[0].uuid, 's2-msg');

			db.close();
		});
	});
});
