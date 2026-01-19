/**
 * Session CRUD Database Tests
 *
 * Tests for core session create/read/update/delete operations
 */

import { describe, test } from 'bun:test';
import {
	createTestDb,
	createTestSession,
	assertEquals,
	assertExists,
} from './fixtures/database-test-utils';

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
});
