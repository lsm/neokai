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

		test('should update session config with autoScroll', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Verify autoScroll is undefined by default
			const initial = db.getSession('session-1');
			assertExists(initial);
			assertEquals(initial.config.autoScroll, undefined);

			// Update config with autoScroll enabled
			db.updateSession('session-1', {
				config: { autoScroll: true },
			});

			const updated = db.getSession('session-1');
			assertExists(updated);
			assertEquals(updated.config.autoScroll, true);
			// Original config values should be preserved
			assertEquals(updated.config.model, 'claude-sonnet-4-5-20250929');
			assertEquals(updated.config.maxTokens, 8192);
			assertEquals(updated.config.temperature, 1.0);

			db.close();
		});

		test('should merge partial config updates without overwriting other fields', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.config.autoScroll = false;
			db.createSession(session);

			// Update only autoScroll
			db.updateSession('session-1', {
				config: { autoScroll: true },
			});

			let updated = db.getSession('session-1');
			assertExists(updated);
			assertEquals(updated.config.autoScroll, true);
			assertEquals(updated.config.model, 'claude-sonnet-4-5-20250929');

			// Update only model, autoScroll should remain
			db.updateSession('session-1', {
				config: { model: 'claude-opus-4-20250514' },
			});

			updated = db.getSession('session-1');
			assertExists(updated);
			assertEquals(updated.config.autoScroll, true);
			assertEquals(updated.config.model, 'claude-opus-4-20250514');

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

			// Get SDK messages directly
			const messages = db.getSDKMessages('session-1');

			assertEquals(messages.length, 1);
			assertEquals(messages[0].uuid, '00000000-0000-0000-0000-000000000001');
			assertEquals(messages[0].message.content, 'Hello, world!');
			assertEquals(messages[0].type, 'user');

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

			const messages = db.getSDKMessages('session-1');

			assertEquals(messages.length, 1);
			assertEquals(messages[0].message.content[0].text, 'The answer is 42');
			assertEquals(messages[0].type, 'assistant');

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

			const messages = db.getSDKMessages('session-1');

			assertEquals(messages.length, 2);
			// SDK messages are stored chronologically
			assertEquals(messages[0].uuid, '00000000-0000-0000-0000-000000000002');
			assertEquals(messages[1].uuid, '00000000-0000-0000-0000-000000000001');

			db.close();
		});

		test('should support cursor-based pagination for SDK messages', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Create 10 SDK messages with small delays to ensure distinct timestamps
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
				// Small delay to ensure different timestamps
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			// Initial load: get newest 5 messages (no cursor)
			const page1 = db.getSDKMessages('session-1', 5);
			assertEquals(page1.length, 5);
			assertEquals(page1[0].uuid, 'msg-5'); // Oldest of the newest 5
			assertEquals(page1[4].uuid, 'msg-9'); // Newest message

			// Get the timestamp of the oldest message in page1 for cursor
			const oldestInPage1 = page1[0] as { timestamp: number };
			const cursor = oldestInPage1.timestamp;

			// Load older: get messages before the cursor
			const page2 = db.getSDKMessages('session-1', 5, cursor);
			assertEquals(page2.length, 5);
			assertEquals(page2[0].uuid, 'msg-0'); // Oldest message
			assertEquals(page2[4].uuid, 'msg-4'); // Just before cursor

			// Verify count
			assertEquals(db.getSDKMessageCount('session-1'), 10);

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

			const messages = db.getSDKMessages('session-1');

			assertEquals(messages.length, 1);
			// Tool uses are in the SDK message content
			assertEquals(messages[0].message.content.length, 2);
			assertEquals(messages[0].message.content[1].name, 'read_file');

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

			const messages = db.getSDKMessages('session-1');

			assertEquals(messages[0].message.content.length, 2);
			assertEquals(messages[0].message.content[0].name, 'read_file');
			assertEquals(messages[0].message.content[1].name, 'write_file');

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

			const messages1 = db.getSDKMessages('session-1');
			const messages2 = db.getSDKMessages('session-2');

			assertEquals(messages1.length, 1);
			assertEquals(messages1[0].message.content, 'Session 1 message');

			assertEquals(messages2.length, 1);
			assertEquals(messages2[0].message.content, 'Session 2 message');

			db.close();
		});
	});
});
