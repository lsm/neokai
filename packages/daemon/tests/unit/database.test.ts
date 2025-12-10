/**
 * Database Unit Tests
 *
 * Tests database storage functionality for sessions, messages, and tool calls
 */

import { describe, test } from 'bun:test';
import type { Session } from '@liuboer/shared';
import { Database } from '../../src/storage/database';
import { assertEquals, assertExists } from '../test-utils';

async function createTestDb(): Promise<Database> {
	const db = new Database(':memory:');
	await db.initialize();
	return db;
}

function createTestSession(id: string): Session {
	return {
		id,
		title: `Test Session ${id}`,
		workspacePath: '/test/workspace',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model: 'claude-sonnet-4-5-20250929',
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
}

describe('Database', () => {
	describe('Session Management', () => {
		test('should initialize and create tables', async () => {
			const db = await createTestDb();

			// Should not throw
			db.createSession(createTestSession('test-1'));
			const session = db.getSession('test-1');

			assertExists(session);
			assertEquals(session.id, 'test-1');

			db.close();
		});

		test('should create and get session', async () => {
			const db = await createTestDb();

			const testSession = createTestSession('session-1');
			db.createSession(testSession);

			const retrieved = db.getSession('session-1');

			assertExists(retrieved);
			assertEquals(retrieved.id, testSession.id);
			assertEquals(retrieved.title, testSession.title);
			assertEquals(retrieved.workspacePath, testSession.workspacePath);
			assertEquals(retrieved.status, testSession.status);
			assertEquals(retrieved.config.model, testSession.config.model);
			assertEquals(retrieved.metadata.messageCount, 0);

			db.close();
		});

		test('should return null for non-existent session', async () => {
			const db = await createTestDb();

			const result = db.getSession('non-existent');
			assertEquals(result, null);

			db.close();
		});

		test('should list sessions ordered by last active', async () => {
			const db = await createTestDb();

			// Create sessions with explicit timestamps
			const now = Date.now();
			const session1 = createTestSession('session-1');
			session1.lastActiveAt = new Date(now).toISOString();

			const session2 = createTestSession('session-2');
			session2.lastActiveAt = new Date(now + 1000).toISOString();

			const session3 = createTestSession('session-3');
			session3.lastActiveAt = new Date(now + 2000).toISOString();

			db.createSession(session1);
			db.createSession(session2);
			db.createSession(session3);

			const sessions = db.listSessions();

			assertEquals(sessions.length, 3);
			// Should be ordered by last_active_at DESC (most recent first)
			assertEquals(sessions[0].id, 'session-3');
			assertEquals(sessions[1].id, 'session-2');
			assertEquals(sessions[2].id, 'session-1');

			db.close();
		});

		test('should update session', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			db.updateSession('session-1', {
				title: 'Updated Title',
				workspacePath: '/new/path',
				status: 'paused',
			});

			const updated = db.getSession('session-1');

			assertExists(updated);
			assertEquals(updated.title, 'Updated Title');
			assertEquals(updated.workspacePath, '/new/path');
			assertEquals(updated.status, 'paused');

			db.close();
		});

		test('should delete session', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			assertEquals(db.listSessions().length, 1);

			db.deleteSession('session-1');

			assertEquals(db.getSession('session-1'), null);
			assertEquals(db.listSessions().length, 0);

			db.close();
		});
	});

	describe('Message Management', () => {
		test('should save and get messages via SDK messages', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Save as SDK user message (new approach)
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

			db.saveSDKMessage('session-1', sdkMessage);

			// getMessages extracts from SDK messages
			const messages = db.getMessages('session-1');

			assertEquals(messages.length, 1);
			assertEquals(messages[0].id, '00000000-0000-0000-0000-000000000001');
			assertEquals(messages[0].content, 'Hello, world!');
			assertEquals(messages[0].role, 'user');

			db.close();
		});

		test('should save assistant messages via SDK messages', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Save as SDK assistant message
			const sdkMessage = {
				type: 'assistant' as const,
				message: {
					role: 'assistant' as const,
					content: [
						{
							type: 'text' as const,
							text: 'The answer is 42',
						},
					],
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000001' as const,
				session_id: 'session-1',
			};

			db.saveSDKMessage('session-1', sdkMessage);

			const messages = db.getMessages('session-1');

			assertEquals(messages.length, 1);
			assertEquals(messages[0].content, 'The answer is 42');
			assertEquals(messages[0].role, 'assistant');

			db.close();
		});

		test('should order messages chronologically', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			const sdkMsg1 = {
				type: 'user' as const,
				message: {
					role: 'user' as const,
					content: 'First',
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000001' as const,
				session_id: 'session-1',
			};

			const sdkMsg2 = {
				type: 'assistant' as const,
				message: {
					role: 'assistant' as const,
					content: [{ type: 'text' as const, text: 'Second' }],
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000002' as const,
				session_id: 'session-1',
			};

			db.saveSDKMessage('session-1', sdkMsg2); // Save in reverse order
			db.saveSDKMessage('session-1', sdkMsg1);

			const messages = db.getMessages('session-1');

			assertEquals(messages.length, 2);
			// SDK messages are stored chronologically
			assertEquals(messages[0].id, '00000000-0000-0000-0000-000000000002');
			assertEquals(messages[1].id, '00000000-0000-0000-0000-000000000001');

			db.close();
		});

		test('should support message pagination', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Create 10 SDK messages
			for (let i = 0; i < 10; i++) {
				const sdkMsg = {
					type: 'user' as const,
					message: {
						role: 'user' as const,
						content: `Message ${i}`,
					},
					parent_tool_use_id: null,
					uuid: `msg-${i}`,
					session_id: 'session-1',
				};
				db.saveSDKMessage('session-1', sdkMsg);
			}

			// Pagination now returns NEWEST messages first (for "load older" UX)
			// offset=0 returns newest 5 messages in chronological order
			const page1 = db.getMessages('session-1', 5, 0);
			assertEquals(page1.length, 5);
			assertEquals(page1[0].id, 'msg-5'); // Oldest of the newest 5
			assertEquals(page1[4].id, 'msg-9'); // Newest message

			// offset=5 returns older 5 messages in chronological order
			const page2 = db.getMessages('session-1', 5, 5);
			assertEquals(page2.length, 5);
			assertEquals(page2[0].id, 'msg-0'); // Oldest message
			assertEquals(page2[4].id, 'msg-4');

			db.close();
		});
	});

	describe('Tool Call Management', () => {
		test('should extract tool calls from SDK messages', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// SDK assistant message with tool use
			const sdkMessage = {
				type: 'assistant' as const,
				message: {
					role: 'assistant' as const,
					content: [
						{
							type: 'text' as const,
							text: 'Reading file...',
						},
						{
							type: 'tool_use' as const,
							id: 'tool-1',
							name: 'read_file',
							input: { path: '/test/file.txt' },
						},
					],
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000001' as const,
				session_id: 'session-1',
			};

			db.saveSDKMessage('session-1', sdkMessage);

			const messages = db.getMessages('session-1');

			assertEquals(messages.length, 1);
			assertExists(messages[0].toolCalls);
			assertEquals(messages[0].toolCalls!.length, 1);
			assertEquals(messages[0].toolCalls![0].tool, 'read_file');
			assertEquals(messages[0].toolCalls![0].status, 'success');

			db.close();
		});

		test('should handle multiple tool uses in SDK messages', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// SDK assistant message with multiple tool uses
			const sdkMessage = {
				type: 'assistant' as const,
				message: {
					role: 'assistant' as const,
					content: [
						{
							type: 'tool_use' as const,
							id: 'tool-1',
							name: 'read_file',
							input: { path: '/file1.txt' },
						},
						{
							type: 'tool_use' as const,
							id: 'tool-2',
							name: 'write_file',
							input: { path: '/file2.txt', content: 'data' },
						},
					],
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000001' as const,
				session_id: 'session-1',
			};

			db.saveSDKMessage('session-1', sdkMessage);

			const messages = db.getMessages('session-1');

			assertEquals(messages[0].toolCalls!.length, 2);
			assertEquals(messages[0].toolCalls![0].tool, 'read_file');
			assertEquals(messages[0].toolCalls![1].tool, 'write_file');

			db.close();
		});
	});

	describe('Data Integrity', () => {
		test('should cascade delete SDK messages when session is deleted', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			const sdkMsg = {
				type: 'user' as const,
				message: {
					role: 'user' as const,
					content: 'Test',
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000001' as const,
				session_id: 'session-1',
			};
			db.saveSDKMessage('session-1', sdkMsg);

			assertEquals(db.getMessages('session-1').length, 1);
			assertEquals(db.getSDKMessages('session-1').length, 1);

			// Delete session should cascade delete SDK messages
			db.deleteSession('session-1');

			// Session should be gone
			assertEquals(db.getSession('session-1'), null);
			assertEquals(db.getSDKMessages('session-1').length, 0);

			db.close();
		});

		test('should maintain session isolation', async () => {
			const db = await createTestDb();

			const session1 = createTestSession('session-1');
			const session2 = createTestSession('session-2');

			db.createSession(session1);
			db.createSession(session2);

			const sdkMsg1 = {
				type: 'user' as const,
				message: {
					role: 'user' as const,
					content: 'Session 1 message',
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000001' as const,
				session_id: 'session-1',
			};

			const sdkMsg2 = {
				type: 'user' as const,
				message: {
					role: 'user' as const,
					content: 'Session 2 message',
				},
				parent_tool_use_id: null,
				uuid: '00000000-0000-0000-0000-000000000002' as const,
				session_id: 'session-2',
			};

			db.saveSDKMessage('session-1', sdkMsg1);
			db.saveSDKMessage('session-2', sdkMsg2);

			const messages1 = db.getMessages('session-1');
			const messages2 = db.getMessages('session-2');

			assertEquals(messages1.length, 1);
			assertEquals(messages1[0].content, 'Session 1 message');

			assertEquals(messages2.length, 1);
			assertEquals(messages2[0].content, 'Session 2 message');

			db.close();
		});
	});
});
