/**
 * Message Processing Behavior Tests
 *
 * Tests message handling through RPC (behavior-driven).
 *
 * Pattern:
 * - Send messages via message.send RPC (or simulate SDK messages)
 * - Retrieve via message.sdkMessages RPC
 * - Verify via processing state queries
 * - NO direct SDKMessageHandler access
 * - NO mocks (real message persistence)
 *
 * Note: Full SDK message processing is tested in online tests.
 * These tests focus on message persistence and retrieval behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';
import { createSession, getSDKMessages } from '../helpers/rpc-behavior-helpers';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Message Processing (Behavior)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Message Persistence', () => {
		test('should persist and retrieve SDK messages', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/message-persist`,
			});

			// Simulate SDK message save (in integration tests, SDK is mocked)
			// This simulates what would happen when SDK sends a message
			ctx.db.saveSDKMessage(sessionId, {
				type: 'user',
				message: { role: 'user', content: 'Test message 1' },
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: sessionId,
			});

			ctx.db.saveSDKMessage(sessionId, {
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }] },
				parent_tool_use_id: null,
				uuid: 'msg-2',
				session_id: sessionId,
			});

			// ✅ Retrieve via RPC (behavior)
			const messages = await getSDKMessages(ctx.messageHub, sessionId);

			expect(messages.length).toBe(2);
			expect((messages[0] as { message: { content: string } }).message.content).toBe(
				'Test message 1'
			);
			expect(
				(
					messages[1] as {
						message: { content: Array<{ type: string; text: string }> };
					}
				).message.content[0].text
			).toBe('Response 1');
		});

		test('should maintain message order', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/message-order`,
			});

			// Add messages in sequence
			const messageIds = [];
			for (let i = 1; i <= 5; i++) {
				ctx.db.saveSDKMessage(sessionId, {
					type: 'user',
					message: { role: 'user', content: `Message ${i}` },
					parent_tool_use_id: null,
					uuid: `msg-${i}`,
					session_id: sessionId,
				});
				messageIds.push(`msg-${i}`);
			}

			// ✅ Retrieve via RPC
			const messages = await getSDKMessages(ctx.messageHub, sessionId);

			expect(messages.length).toBe(5);

			// Verify order preserved
			for (let i = 0; i < 5; i++) {
				expect((messages[i] as { uuid: string }).uuid).toBe(messageIds[i]);
				expect((messages[i] as { message: { content: string } }).message.content).toBe(
					`Message ${i + 1}`
				);
			}
		});

		test('should retrieve all SDK messages', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/message-all`,
			});

			// Add 10 messages
			for (let i = 1; i <= 10; i++) {
				ctx.db.saveSDKMessage(sessionId, {
					type: 'user',
					message: { role: 'user', content: `Message ${i}` },
					parent_tool_use_id: null,
					uuid: `msg-${i}`,
					session_id: sessionId,
				});
			}

			// ✅ Get all messages
			const messages = await getSDKMessages(ctx.messageHub, sessionId);
			expect(messages.length).toBe(10);

			// Verify all messages retrieved
			for (let i = 0; i < 10; i++) {
				expect((messages[i] as { uuid: string }).uuid).toBe(`msg-${i + 1}`);
			}
		});
	});

	describe('Message Isolation', () => {
		test('should isolate messages by session', async () => {
			// ✅ Create two sessions
			const sessionId1 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/msg-isolation-1`,
			});

			const sessionId2 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/msg-isolation-2`,
			});

			// Add messages to session 1
			ctx.db.saveSDKMessage(sessionId1, {
				type: 'user',
				message: { role: 'user', content: 'Session 1 message' },
				parent_tool_use_id: null,
				uuid: 'msg-1-1',
				session_id: sessionId1,
			});

			// Add messages to session 2
			ctx.db.saveSDKMessage(sessionId2, {
				type: 'user',
				message: { role: 'user', content: 'Session 2 message' },
				parent_tool_use_id: null,
				uuid: 'msg-2-1',
				session_id: sessionId2,
			});

			// ✅ Retrieve via RPC
			const messages1 = await getSDKMessages(ctx.messageHub, sessionId1);
			const messages2 = await getSDKMessages(ctx.messageHub, sessionId2);

			// Verify isolation
			expect(messages1.length).toBe(1);
			expect(messages2.length).toBe(1);
			expect((messages1[0] as { message: { content: string } }).message.content).toBe(
				'Session 1 message'
			);
			expect((messages2[0] as { message: { content: string } }).message.content).toBe(
				'Session 2 message'
			);
		});
	});

	describe('Message Cascade Delete', () => {
		test('should delete messages when session is deleted', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/cascade-delete`,
			});

			// Add messages
			ctx.db.saveSDKMessage(sessionId, {
				type: 'user',
				message: { role: 'user', content: 'Test message' },
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: sessionId,
			});

			// Verify messages exist
			const messagesBefore = await getSDKMessages(ctx.messageHub, sessionId);
			expect(messagesBefore.length).toBe(1);

			// ✅ Delete session via RPC
			await callRPCHandler(ctx.messageHub, 'session.delete', { sessionId });

			// ✅ Verify messages were cascade deleted (RPC should error for deleted session)
			await expect(getSDKMessages(ctx.messageHub, sessionId)).rejects.toThrow();
		});
	});

	describe('Message Querying', () => {
		test('should handle empty message list', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/message-empty`,
			});

			// ✅ Query messages (should be empty)
			const messages = await getSDKMessages(ctx.messageHub, sessionId);
			expect(messages.length).toBe(0);
		});
	});

	describe('Session Context', () => {
		test('should include context in session.get response', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/session-context`,
			});

			// ✅ Get session via RPC
			const sessionData = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId,
			});

			// Verify context exists (what UI receives)
			expect(sessionData.context).toBeDefined();
		});
	});
});
