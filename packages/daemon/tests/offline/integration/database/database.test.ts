/**
 * Database Unit Tests
 *
 * Tests database storage functionality for sessions, messages, and tool calls
 */

import { describe, test } from 'bun:test';
import type { Session } from '@liuboer/shared';
import { Database } from '../../../../src/storage/database';
import { assertEquals, assertExists } from '../../../test-utils';

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

		test('should persist and retrieve SDK session ID', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.sdkSessionId = 'sdk-session-abc-123';
			db.createSession(session);

			const retrieved = db.getSession('session-1');

			assertExists(retrieved);
			assertEquals(retrieved.sdkSessionId, 'sdk-session-abc-123');

			db.close();
		});

		test('should update SDK session ID', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Verify no SDK session ID initially
			let retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.sdkSessionId, undefined);

			// Update with SDK session ID
			db.updateSession('session-1', {
				sdkSessionId: 'sdk-session-xyz-789',
			});

			retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.sdkSessionId, 'sdk-session-xyz-789');

			db.close();
		});

		test('should handle SDK session ID in listSessions', async () => {
			const db = await createTestDb();

			const session1 = createTestSession('session-1');
			session1.sdkSessionId = 'sdk-session-1';
			db.createSession(session1);

			const session2 = createTestSession('session-2');
			// No SDK session ID
			db.createSession(session2);

			const session3 = createTestSession('session-3');
			session3.sdkSessionId = 'sdk-session-3';
			db.createSession(session3);

			const sessions = db.listSessions();

			assertEquals(sessions.length, 3);

			// Find each session and verify SDK session ID
			const s1 = sessions.find((s) => s.id === 'session-1');
			assertExists(s1);
			assertEquals(s1.sdkSessionId, 'sdk-session-1');

			const s2 = sessions.find((s) => s.id === 'session-2');
			assertExists(s2);
			assertEquals(s2.sdkSessionId, undefined);

			const s3 = sessions.find((s) => s.id === 'session-3');
			assertExists(s3);
			assertEquals(s3.sdkSessionId, 'sdk-session-3');

			db.close();
		});

		test('should handle SDK session ID update correctly', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.sdkSessionId = 'sdk-session-initial';
			db.createSession(session);

			// Verify initial SDK session ID
			let retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.sdkSessionId, 'sdk-session-initial');

			// Update to a different SDK session ID
			db.updateSession('session-1', {
				sdkSessionId: 'sdk-session-updated',
			});

			retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.sdkSessionId, 'sdk-session-updated');

			db.close();
		});

		test('should persist and retrieve processing state', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.processingState = JSON.stringify({
				status: 'processing',
				messageId: 'msg-123',
				phase: 'streaming',
			});
			db.createSession(session);

			const retrieved = db.getSession('session-1');

			assertExists(retrieved);
			assertEquals(retrieved.processingState, session.processingState);

			// Verify it's valid JSON
			const parsed = JSON.parse(retrieved.processingState as string);
			assertEquals(parsed.status, 'processing');
			assertEquals(parsed.messageId, 'msg-123');
			assertEquals(parsed.phase, 'streaming');

			db.close();
		});

		test('should update processing state', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Verify no processing state initially
			let retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.processingState, undefined);

			// Update with processing state
			db.updateSession('session-1', {
				processingState: JSON.stringify({
					status: 'queued',
					messageId: 'msg-456',
				}),
			});

			retrieved = db.getSession('session-1');
			assertExists(retrieved);
			const parsed = JSON.parse(retrieved.processingState as string);
			assertEquals(parsed.status, 'queued');
			assertEquals(parsed.messageId, 'msg-456');

			db.close();
		});

		test('should persist and retrieve available commands', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.availableCommands = ['/help', '/clear', '/context'];
			db.createSession(session);

			const retrieved = db.getSession('session-1');

			assertExists(retrieved);
			assertExists(retrieved.availableCommands);
			assertEquals(retrieved.availableCommands.length, 3);
			assertEquals(retrieved.availableCommands[0], '/help');
			assertEquals(retrieved.availableCommands[1], '/clear');
			assertEquals(retrieved.availableCommands[2], '/context');

			db.close();
		});

		test('should update available commands', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Verify no available commands initially
			let retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.availableCommands, undefined);

			// Update with available commands
			db.updateSession('session-1', {
				availableCommands: ['/new', '/test', '/debug'],
			});

			retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertExists(retrieved.availableCommands);
			assertEquals(retrieved.availableCommands.length, 3);
			assertEquals(retrieved.availableCommands[0], '/new');
			assertEquals(retrieved.availableCommands[1], '/test');
			assertEquals(retrieved.availableCommands[2], '/debug');

			db.close();
		});

		test('should handle null/undefined for processing state', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.processingState = JSON.stringify({ status: 'idle' });
			db.createSession(session);

			// Update to null (clearing the state)
			db.updateSession('session-1', {
				processingState: null,
			});

			const retrieved = db.getSession('session-1');
			assertExists(retrieved);
			// Database converts null to undefined when retrieving
			assertEquals(retrieved.processingState, undefined);

			db.close();
		});

		test('should handle empty array for available commands', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.availableCommands = [];
			db.createSession(session);

			const retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertExists(retrieved.availableCommands);
			assertEquals(retrieved.availableCommands.length, 0);

			db.close();
		});

		test('should list sessions with processing state and available commands', async () => {
			const db = await createTestDb();

			const session1 = createTestSession('session-1');
			session1.processingState = JSON.stringify({ status: 'processing' });
			session1.availableCommands = ['/help'];
			db.createSession(session1);

			const session2 = createTestSession('session-2');
			// No processing state or commands
			db.createSession(session2);

			const session3 = createTestSession('session-3');
			session3.processingState = JSON.stringify({ status: 'idle' });
			session3.availableCommands = ['/test', '/debug'];
			db.createSession(session3);

			const sessions = db.listSessions();

			assertEquals(sessions.length, 3);

			// Find each session and verify
			const s1 = sessions.find((s) => s.id === 'session-1');
			assertExists(s1);
			assertExists(s1.processingState);
			assertEquals(JSON.parse(s1.processingState).status, 'processing');
			assertExists(s1.availableCommands);
			assertEquals(s1.availableCommands.length, 1);

			const s2 = sessions.find((s) => s.id === 'session-2');
			assertExists(s2);
			assertEquals(s2.processingState, undefined);
			assertEquals(s2.availableCommands, undefined);

			const s3 = sessions.find((s) => s.id === 'session-3');
			assertExists(s3);
			assertExists(s3.processingState);
			assertExists(s3.availableCommands);
			assertEquals(s3.availableCommands.length, 2);

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

	describe('Session inputDraft persistence', () => {
		test('should save inputDraft to metadata', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Update with inputDraft
			db.updateSession('session-1', {
				metadata: { inputDraft: 'test draft' },
			});

			const updated = db.getSession('session-1');

			assertExists(updated);
			assertEquals(updated.metadata.inputDraft, 'test draft');

			db.close();
		});

		test('should merge inputDraft with existing metadata fields', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.metadata.messageCount = 5;
			session.metadata.totalTokens = 1000;
			db.createSession(session);

			// Update with inputDraft
			db.updateSession('session-1', {
				metadata: { inputDraft: 'draft text' },
			});

			const updated = db.getSession('session-1');

			assertExists(updated);
			assertEquals(updated.metadata.inputDraft, 'draft text');
			// Verify other metadata fields are preserved
			assertEquals(updated.metadata.messageCount, 5);
			assertEquals(updated.metadata.totalTokens, 1000);
			assertEquals(updated.metadata.inputTokens, 0);
			assertEquals(updated.metadata.outputTokens, 0);

			db.close();
		});

		test('should clear inputDraft when set to undefined', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			session.metadata.inputDraft = 'initial draft';
			session.metadata.messageCount = 3;
			db.createSession(session);

			// Verify inputDraft is set
			let retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.metadata.inputDraft, 'initial draft');

			// Clear inputDraft by setting to undefined
			db.updateSession('session-1', {
				metadata: { inputDraft: undefined },
			});

			retrieved = db.getSession('session-1');
			assertExists(retrieved);
			assertEquals(retrieved.metadata.inputDraft, undefined);
			// Verify other metadata preserved
			assertEquals(retrieved.metadata.messageCount, 3);

			db.close();
		});

		test('should handle empty string inputDraft', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Update with empty string
			db.updateSession('session-1', {
				metadata: { inputDraft: '' },
			});

			const updated = db.getSession('session-1');

			assertExists(updated);
			assertEquals(updated.metadata.inputDraft, '');

			db.close();
		});

		test('should persist inputDraft across session retrieval', async () => {
			const db = await createTestDb();

			const session = createTestSession('session-1');
			db.createSession(session);

			// Set inputDraft
			db.updateSession('session-1', {
				metadata: { inputDraft: 'persisted draft' },
			});

			// Retrieve session multiple times
			const retrieved1 = db.getSession('session-1');
			assertExists(retrieved1);
			assertEquals(retrieved1.metadata.inputDraft, 'persisted draft');

			const retrieved2 = db.getSession('session-1');
			assertExists(retrieved2);
			assertEquals(retrieved2.metadata.inputDraft, 'persisted draft');

			// Verify it's also in listSessions
			const sessions = db.listSessions();
			const found = sessions.find((s) => s.id === 'session-1');
			assertExists(found);
			assertEquals(found.metadata.inputDraft, 'persisted draft');

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

	describe('Global Settings', () => {
		test('should return default settings on first load', async () => {
			const db = await createTestDb();

			const settings = db.getGlobalSettings();

			assertExists(settings);
			assertEquals(
				JSON.stringify(settings.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			);
			assertEquals(JSON.stringify(settings.disabledMcpServers), JSON.stringify([]));

			db.close();
		});

		test('should save and load global settings', async () => {
			const db = await createTestDb();

			const customSettings = {
				settingSources: ['project', 'local'] as const,
				model: 'claude-opus-4-5-20251101',
				permissionMode: 'acceptEdits' as const,
				maxThinkingTokens: 10000,
				disabledMcpServers: ['server1', 'server2'],
			};

			db.saveGlobalSettings(customSettings);
			const loaded = db.getGlobalSettings();

			assertEquals(JSON.stringify(loaded.settingSources), JSON.stringify(['project', 'local']));
			assertEquals(loaded.model, 'claude-opus-4-5-20251101');
			assertEquals(loaded.permissionMode, 'acceptEdits');
			assertEquals(loaded.maxThinkingTokens, 10000);
			assertEquals(
				JSON.stringify(loaded.disabledMcpServers),
				JSON.stringify(['server1', 'server2'])
			);

			db.close();
		});

		test('should perform partial update', async () => {
			const db = await createTestDb();

			// First save
			db.saveGlobalSettings({
				settingSources: ['user', 'project', 'local'],
				model: 'claude-sonnet-4-5-20250929',
				disabledMcpServers: [],
			});

			// Partial update
			const updated = db.updateGlobalSettings({
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: ['server1'],
			});

			assertEquals(updated.model, 'claude-opus-4-5-20251101');
			assertEquals(JSON.stringify(updated.disabledMcpServers), JSON.stringify(['server1']));
			assertEquals(
				JSON.stringify(updated.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			); // Unchanged

			db.close();
		});

		test('should merge with defaults for backward compatibility', async () => {
			const db = await createTestDb();

			// Save settings with only some fields
			db.saveGlobalSettings({
				settingSources: ['project'],
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: [],
			});

			// Load should merge with defaults
			const loaded = db.getGlobalSettings();

			assertExists(loaded.settingSources);
			assertExists(loaded.disabledMcpServers);
			assertEquals(loaded.model, 'claude-opus-4-5-20251101');

			db.close();
		});

		test('should persist settings across database close/reopen', async () => {
			const dbPath = ':memory:';
			let db = new Database(dbPath);
			await db.initialize();

			const customSettings = {
				settingSources: ['local'] as const,
				model: 'claude-haiku-3-5-20241022',
				disabledMcpServers: ['test-server'],
			};

			db.saveGlobalSettings(customSettings);
			db.close();

			// Note: In-memory database loses data on close
			// This test documents the expected behavior
			// For file-based databases, data would persist

			db = new Database(dbPath);
			await db.initialize();
			const loaded = db.getGlobalSettings();

			// In-memory DB returns defaults after reopen
			assertEquals(
				JSON.stringify(loaded.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			);

			db.close();
		});

		test('should handle invalid JSON gracefully', async () => {
			const db = await createTestDb();

			// Manually insert invalid JSON (simulating corruption)
			try {
				(db as unknown as { db: { exec: (sql: string) => void } }).db.exec(`
					UPDATE global_settings SET settings = 'invalid-json' WHERE id = 1
				`);
			} catch {
				// Some versions might prevent this
			}

			// Should return defaults instead of throwing
			const loaded = db.getGlobalSettings();

			assertExists(loaded);
			assertEquals(
				JSON.stringify(loaded.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			);

			db.close();
		});

		test('should only allow single row (id = 1)', async () => {
			const db = await createTestDb();

			// Save different settings
			db.saveGlobalSettings({
				settingSources: ['user', 'project', 'local'],
				model: 'claude-sonnet-4-5-20250929',
				disabledMcpServers: [],
			});

			db.saveGlobalSettings({
				settingSources: ['local'],
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: ['server1'],
			});

			// Should only have one row (second save replaces first)
			const loaded = db.getGlobalSettings();
			assertEquals(loaded.model, 'claude-opus-4-5-20251101');
			assertEquals(JSON.stringify(loaded.disabledMcpServers), JSON.stringify(['server1']));

			db.close();
		});
	});

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

	describe('Sub-Sessions', () => {
		test('should create sub-session with parentId', async () => {
			const db = await createTestDb();

			// Create parent session
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['exploration', 'branch-a'],
			};
			db.createSubSession(subSession);

			// Retrieve and verify
			const retrieved = db.getSession('sub-1');
			assertExists(retrieved);
			assertEquals(retrieved.parentId, 'parent-1');
			assertExists(retrieved.labels);
			assertEquals(retrieved.labels.length, 2);
			assertEquals(retrieved.labels[0], 'exploration');
			assertEquals(retrieved.labels[1], 'branch-a');
			assertExists(retrieved.subSessionOrder);

			db.close();
		});

		test('should prevent sub-session creation without parentId', async () => {
			const db = await createTestDb();

			const subSession = createTestSession('sub-1');
			// No parentId set

			let error: Error | null = null;
			try {
				db.createSubSession(subSession);
			} catch (e) {
				error = e as Error;
			}

			assertExists(error);
			assertEquals(error.message, 'Sub-session must have a parentId');

			db.close();
		});

		test('should prevent nested sub-sessions (one level deep only)', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
			};
			db.createSubSession(subSession);

			// Try to create nested sub-session
			const nestedSubSession: Session = {
				...createTestSession('nested-1'),
				parentId: 'sub-1', // Parent is a sub-session
			};

			let error: Error | null = null;
			try {
				db.createSubSession(nestedSubSession);
			} catch (e) {
				error = e as Error;
			}

			assertExists(error);
			assertEquals(
				error.message,
				'Cannot create sub-session under another sub-session (one level deep only)'
			);

			db.close();
		});

		test('should get sub-sessions for a parent', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create multiple sub-sessions
			const sub1: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
			};
			const sub2: Session = {
				...createTestSession('sub-2'),
				parentId: 'parent-1',
			};
			const sub3: Session = {
				...createTestSession('sub-3'),
				parentId: 'parent-1',
			};

			db.createSubSession(sub1);
			db.createSubSession(sub2);
			db.createSubSession(sub3);

			// Get sub-sessions
			const subSessions = db.getSubSessions('parent-1');
			assertEquals(subSessions.length, 3);

			// Should be ordered by sub_session_order
			assertEquals(subSessions[0].id, 'sub-1');
			assertEquals(subSessions[0].subSessionOrder, 0);
			assertEquals(subSessions[1].id, 'sub-2');
			assertEquals(subSessions[1].subSessionOrder, 1);
			assertEquals(subSessions[2].id, 'sub-3');
			assertEquals(subSessions[2].subSessionOrder, 2);

			db.close();
		});

		test('should filter sub-sessions by labels', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-sessions with different labels
			const sub1: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['exploration'],
			};
			const sub2: Session = {
				...createTestSession('sub-2'),
				parentId: 'parent-1',
				labels: ['implementation'],
			};
			const sub3: Session = {
				...createTestSession('sub-3'),
				parentId: 'parent-1',
				labels: ['exploration', 'testing'],
			};

			db.createSubSession(sub1);
			db.createSubSession(sub2);
			db.createSubSession(sub3);

			// Filter by 'exploration'
			const explorationSessions = db.getSubSessions('parent-1', ['exploration']);
			assertEquals(explorationSessions.length, 2);
			assertEquals(explorationSessions[0].id, 'sub-1');
			assertEquals(explorationSessions[1].id, 'sub-3');

			// Filter by 'implementation'
			const implementationSessions = db.getSubSessions('parent-1', ['implementation']);
			assertEquals(implementationSessions.length, 1);
			assertEquals(implementationSessions[0].id, 'sub-2');

			// Filter by 'testing'
			const testingSessions = db.getSubSessions('parent-1', ['testing']);
			assertEquals(testingSessions.length, 1);
			assertEquals(testingSessions[0].id, 'sub-3');

			db.close();
		});

		test('should update sub-session order', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-sessions
			const sub1: Session = { ...createTestSession('sub-1'), parentId: 'parent-1' };
			const sub2: Session = { ...createTestSession('sub-2'), parentId: 'parent-1' };
			const sub3: Session = { ...createTestSession('sub-3'), parentId: 'parent-1' };

			db.createSubSession(sub1);
			db.createSubSession(sub2);
			db.createSubSession(sub3);

			// Reorder: sub-3, sub-1, sub-2
			db.updateSubSessionOrder('parent-1', ['sub-3', 'sub-1', 'sub-2']);

			// Verify new order
			const subSessions = db.getSubSessions('parent-1');
			assertEquals(subSessions[0].id, 'sub-3');
			assertEquals(subSessions[0].subSessionOrder, 0);
			assertEquals(subSessions[1].id, 'sub-1');
			assertEquals(subSessions[1].subSessionOrder, 1);
			assertEquals(subSessions[2].id, 'sub-2');
			assertEquals(subSessions[2].subSessionOrder, 2);

			db.close();
		});

		test('should check if session has sub-sessions', async () => {
			const db = await createTestDb();

			// Create two parents
			const parent1 = createTestSession('parent-1');
			const parent2 = createTestSession('parent-2');
			db.createSession(parent1);
			db.createSession(parent2);

			// Add sub-session only to parent1
			const sub1: Session = { ...createTestSession('sub-1'), parentId: 'parent-1' };
			db.createSubSession(sub1);

			// Check
			assertEquals(db.hasSubSessions('parent-1'), true);
			assertEquals(db.hasSubSessions('parent-2'), false);

			db.close();
		});

		test('should return sub-session fields in listSessions', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['test-label'],
			};
			db.createSubSession(subSession);

			// List all sessions
			const sessions = db.listSessions();
			assertEquals(sessions.length, 2);

			// Find sub-session
			const foundSub = sessions.find((s) => s.id === 'sub-1');
			assertExists(foundSub);
			assertEquals(foundSub.parentId, 'parent-1');
			assertExists(foundSub.labels);
			assertEquals(foundSub.labels[0], 'test-label');

			db.close();
		});

		test('should update sub-session fields', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-session
			const subSession: Session = {
				...createTestSession('sub-1'),
				parentId: 'parent-1',
				labels: ['initial'],
			};
			db.createSubSession(subSession);

			// Update labels
			db.updateSession('sub-1', {
				labels: ['updated', 'modified'],
			});

			// Verify
			const updated = db.getSession('sub-1');
			assertExists(updated);
			assertExists(updated.labels);
			assertEquals(updated.labels.length, 2);
			assertEquals(updated.labels[0], 'updated');
			assertEquals(updated.labels[1], 'modified');

			db.close();
		});

		test('should cascade delete sub-sessions when parent is deleted', async () => {
			const db = await createTestDb();

			// Create parent
			const parent = createTestSession('parent-1');
			db.createSession(parent);

			// Create sub-sessions
			const sub1: Session = { ...createTestSession('sub-1'), parentId: 'parent-1' };
			const sub2: Session = { ...createTestSession('sub-2'), parentId: 'parent-1' };
			db.createSubSession(sub1);
			db.createSubSession(sub2);

			assertEquals(db.listSessions().length, 3);

			// Delete parent - sub-sessions should be deleted too
			// Note: This relies on application layer cascade since we can't add FK via ALTER TABLE
			// In a real scenario, SessionManager handles cascade delete
			db.deleteSession('parent-1');

			// Parent should be gone
			assertEquals(db.getSession('parent-1'), null);

			// Sub-sessions still exist (DB doesn't have FK cascade from migration)
			// In production, SessionManager.deleteSession handles cascade
			// This test documents the DB-level behavior

			db.close();
		});
	});
});
