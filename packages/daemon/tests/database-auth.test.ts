/**
 * Database Authentication and SDK Message Tests
 *
 * Tests for deprecated auth methods (for backward compatibility)
 * and additional SDK message operations
 */

import { describe, test, expect } from 'bun:test';
import type { Session } from '@liuboer/shared';
import { Database } from '../src/storage/database';

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

describe('Database Authentication (deprecated methods)', () => {
	describe('getAuthMethod', () => {
		test('should return none by default', async () => {
			const db = await createTestDb();

			const method = db.getAuthMethod();
			expect(method).toBe('none');

			db.close();
		});
	});

	describe('API Key storage', () => {
		test('should save and retrieve API key', async () => {
			const db = await createTestDb();

			const testKey = 'sk-ant-test-key-123456';
			await db.saveApiKey(testKey);

			// Auth method should be updated
			expect(db.getAuthMethod()).toBe('api_key');

			// Should retrieve the key
			const retrieved = await db.getApiKey();
			expect(retrieved).toBe(testKey);

			db.close();
		});

		test('should return null when no API key is saved', async () => {
			const db = await createTestDb();

			const key = await db.getApiKey();
			expect(key).toBeNull();

			db.close();
		});
	});

	describe('OAuth Tokens storage', () => {
		test('should save and retrieve OAuth tokens', async () => {
			const db = await createTestDb();

			const tokens = {
				access_token: 'access-token-123',
				refresh_token: 'refresh-token-456',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'read write',
			};

			await db.saveOAuthTokens(tokens);

			// Auth method should be updated
			expect(db.getAuthMethod()).toBe('oauth');

			// Should retrieve the tokens
			const retrieved = await db.getOAuthTokens();
			expect(retrieved).toEqual(tokens);

			db.close();
		});

		test('should return null when no OAuth tokens are saved', async () => {
			const db = await createTestDb();

			const tokens = await db.getOAuthTokens();
			expect(tokens).toBeNull();

			db.close();
		});
	});

	describe('OAuth Long-Lived Token storage', () => {
		test('should save and retrieve long-lived OAuth token', async () => {
			const db = await createTestDb();

			const token = 'long-lived-oauth-token-789';
			await db.saveOAuthLongLivedToken(token);

			// Auth method should be updated
			expect(db.getAuthMethod()).toBe('oauth_token');

			// Should retrieve the token
			const retrieved = await db.getOAuthLongLivedToken();
			expect(retrieved).toBe(token);

			db.close();
		});

		test('should return null when no long-lived token is saved', async () => {
			const db = await createTestDb();

			const token = await db.getOAuthLongLivedToken();
			expect(token).toBeNull();

			db.close();
		});
	});

	describe('clearAuth', () => {
		test('should clear all authentication data', async () => {
			const db = await createTestDb();

			// Set up some auth
			await db.saveApiKey('test-key');
			expect(db.getAuthMethod()).toBe('api_key');

			// Clear auth
			db.clearAuth();

			// Auth method should be none
			expect(db.getAuthMethod()).toBe('none');

			// All credentials should be null
			expect(await db.getApiKey()).toBeNull();
			expect(await db.getOAuthTokens()).toBeNull();
			expect(await db.getOAuthLongLivedToken()).toBeNull();

			db.close();
		});

		test('should clear OAuth tokens when setting API key', async () => {
			const db = await createTestDb();

			// First set OAuth
			await db.saveOAuthTokens({
				access_token: 'test',
				refresh_token: 'test',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'read',
			});

			// Then set API key (should clear OAuth)
			await db.saveApiKey('test-key');

			expect(await db.getOAuthTokens()).toBeNull();
			expect(db.getAuthMethod()).toBe('api_key');

			db.close();
		});
	});
});

describe('Database SDK Message Operations', () => {
	describe('getSDKMessagesByType', () => {
		test('should filter messages by type', async () => {
			const db = await createTestDb();
			const session = createTestSession('session-1');
			db.createSession(session);

			// Save different message types
			const userMsg = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Hello' },
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: 'session-1',
			};

			const assistantMsg = {
				type: 'assistant' as const,
				message: {
					role: 'assistant' as const,
					content: [{ type: 'text' as const, text: 'Hi there' }],
				},
				parent_tool_use_id: null,
				uuid: 'msg-2',
				session_id: 'session-1',
			};

			const resultMsg = {
				type: 'result' as const,
				subtype: 'success' as const,
				usage: { input_tokens: 10, output_tokens: 20 },
				total_cost_usd: 0.01,
				is_error: false,
				session_id: 'session-1',
			};

			db.saveSDKMessage('session-1', userMsg);
			db.saveSDKMessage('session-1', assistantMsg);
			db.saveSDKMessage('session-1', resultMsg);

			// Get only user messages
			const userMessages = db.getSDKMessagesByType('session-1', 'user');
			expect(userMessages.length).toBe(1);
			expect(userMessages[0].type).toBe('user');

			// Get only assistant messages
			const assistantMessages = db.getSDKMessagesByType('session-1', 'assistant');
			expect(assistantMessages.length).toBe(1);
			expect(assistantMessages[0].type).toBe('assistant');

			// Get only result messages
			const resultMessages = db.getSDKMessagesByType('session-1', 'result');
			expect(resultMessages.length).toBe(1);
			expect(resultMessages[0].type).toBe('result');

			db.close();
		});

		test('should filter messages by type and subtype', async () => {
			const db = await createTestDb();
			const session = createTestSession('session-1');
			db.createSession(session);

			// Save result messages with different subtypes
			const successResult = {
				type: 'result' as const,
				subtype: 'success' as const,
				usage: { input_tokens: 10, output_tokens: 20 },
				total_cost_usd: 0.01,
				is_error: false,
				session_id: 'session-1',
			};

			const errorResult = {
				type: 'result' as const,
				subtype: 'error' as const,
				usage: { input_tokens: 5, output_tokens: 0 },
				total_cost_usd: 0.005,
				is_error: true,
				session_id: 'session-1',
			};

			db.saveSDKMessage('session-1', successResult);
			db.saveSDKMessage('session-1', errorResult);

			// Filter by subtype
			const successMessages = db.getSDKMessagesByType('session-1', 'result', 'success');
			expect(successMessages.length).toBe(1);
			expect((successMessages[0] as typeof successResult).subtype).toBe('success');

			const errorMessages = db.getSDKMessagesByType('session-1', 'result', 'error');
			expect(errorMessages.length).toBe(1);
			expect((errorMessages[0] as typeof errorResult).subtype).toBe('error');

			db.close();
		});

		test('should respect limit parameter', async () => {
			const db = await createTestDb();
			const session = createTestSession('session-1');
			db.createSession(session);

			// Save multiple user messages
			for (let i = 0; i < 10; i++) {
				const msg = {
					type: 'user' as const,
					message: { role: 'user' as const, content: `Message ${i}` },
					parent_tool_use_id: null,
					uuid: `msg-${i}`,
					session_id: 'session-1',
				};
				db.saveSDKMessage('session-1', msg);
			}

			// Get with limit
			const messages = db.getSDKMessagesByType('session-1', 'user', undefined, 5);
			expect(messages.length).toBe(5);

			db.close();
		});
	});

	describe('getSDKMessageCount', () => {
		test('should return correct message count', async () => {
			const db = await createTestDb();
			const session = createTestSession('session-1');
			db.createSession(session);

			expect(db.getSDKMessageCount('session-1')).toBe(0);

			// Add some messages
			for (let i = 0; i < 5; i++) {
				const msg = {
					type: 'user' as const,
					message: { role: 'user' as const, content: `Message ${i}` },
					parent_tool_use_id: null,
					uuid: `msg-${i}`,
					session_id: 'session-1',
				};
				db.saveSDKMessage('session-1', msg);
			}

			expect(db.getSDKMessageCount('session-1')).toBe(5);

			db.close();
		});

		test('should return zero for non-existent session', async () => {
			const db = await createTestDb();

			expect(db.getSDKMessageCount('non-existent')).toBe(0);

			db.close();
		});
	});

	describe('getSDKMessages with since parameter', () => {
		test('should filter messages by timestamp', async () => {
			const db = await createTestDb();
			const session = createTestSession('session-1');
			db.createSession(session);

			// Save a message
			const msg1 = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'First' },
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: 'session-1',
			};
			db.saveSDKMessage('session-1', msg1);

			// Record timestamp after first message
			const afterFirstMsg = Date.now();

			// Small delay to ensure different timestamps
			await Bun.sleep(10);

			// Save another message
			const msg2 = {
				type: 'user' as const,
				message: { role: 'user' as const, content: 'Second' },
				parent_tool_use_id: null,
				uuid: 'msg-2',
				session_id: 'session-1',
			};
			db.saveSDKMessage('session-1', msg2);

			// Get all messages
			const allMessages = db.getSDKMessages('session-1');
			expect(allMessages.length).toBe(2);

			// Get messages since the first one (should only get second)
			const newMessages = db.getSDKMessages('session-1', 100, 0, afterFirstMsg);
			expect(newMessages.length).toBe(1);
			expect(newMessages[0].message.content).toBe('Second');

			db.close();
		});

		test('should return all messages when since is 0', async () => {
			const db = await createTestDb();
			const session = createTestSession('session-1');
			db.createSession(session);

			for (let i = 0; i < 3; i++) {
				const msg = {
					type: 'user' as const,
					message: { role: 'user' as const, content: `Message ${i}` },
					parent_tool_use_id: null,
					uuid: `msg-${i}`,
					session_id: 'session-1',
				};
				db.saveSDKMessage('session-1', msg);
			}

			// since=0 should return all messages
			const messages = db.getSDKMessages('session-1', 100, 0, 0);
			expect(messages.length).toBe(3);

			db.close();
		});
	});

	describe('updateSession with config', () => {
		test('should update session config', async () => {
			const db = await createTestDb();
			const session = createTestSession('session-1');
			db.createSession(session);

			// Update config
			db.updateSession('session-1', {
				config: {
					model: 'claude-opus-4-20250514',
					maxTokens: 16384,
					temperature: 0.5,
				},
			});

			const updated = db.getSession('session-1');
			expect(updated?.config.model).toBe('claude-opus-4-20250514');
			expect(updated?.config.maxTokens).toBe(16384);
			expect(updated?.config.temperature).toBe(0.5);

			db.close();
		});
	});
});
