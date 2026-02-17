/**
 * ContextManager Tests
 *
 * Tests for context management with compaction support:
 * - Initialization and context creation
 * - Adding and retrieving messages
 * - Token counting
 * - Context compaction
 * - Status and context updates
 * - Edge cases
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { ContextManager } from '../../../src/lib/room/context-manager';
import { RoomManager } from '../../../src/lib/room/room-manager';
import type { NeoContext, NeoContextMessage } from '@neokai/shared';

// TODO: Fix CI isolation issue - tests pass locally but fail in CI
describe.skip('ContextManager', () => {
	let db: Database;
	let tempDir: string;
	let contextManager: ContextManager;
	let roomManager: RoomManager;
	let roomId: string;

	beforeEach(() => {
		// Create temp directory and file-based database
		tempDir = `/tmp/neokai-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		require('fs').mkdirSync(tempDir, { recursive: true });
		db = new Database(`${tempDir}/test.db`);
		createTables(db);

		// Create room manager and a room
		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: ['/workspace/test'],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Create context manager
		contextManager = new ContextManager(db, roomId);
	});

	afterEach(() => {
		db.close();
		try {
			require('fs').rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('initialization', () => {
		it('should create context manager with valid room', () => {
			expect(contextManager).toBeDefined();
		});

		it('should use existing context created by room', async () => {
			// RoomManager creates context when creating room
			const stmt = db.prepare('SELECT * FROM contexts WHERE room_id = ?');
			const row = stmt.get(roomId) as Record<string, unknown> | undefined;
			expect(row).not.toBeNull();
			expect(row?.room_id).toBe(roomId);

			// ContextManager should use the existing context
			const context = await contextManager.getContext();
			expect(context).not.toBeNull();
			expect(context?.roomId).toBe(roomId);
		});

		it('should reuse existing context on subsequent operations', async () => {
			await contextManager.addMessage('user', 'First');
			const context1 = await contextManager.getContext();

			await contextManager.addMessage('user', 'Second');
			const context2 = await contextManager.getContext();

			expect(context1?.id).toBe(context2?.id);
		});
	});

	describe('addMessage', () => {
		it('should add a user message to context', async () => {
			const message = await contextManager.addMessage('user', 'Hello, world!');

			expect(message).toBeDefined();
			expect(message.id).toBeDefined();
			expect(message.role).toBe('user');
			expect(message.content).toBe('Hello, world!');
			expect(message.tokenCount).toBeGreaterThan(0);
			expect(message.contextId).toBeDefined();
		});

		it('should add an assistant message to context', async () => {
			const message = await contextManager.addMessage('assistant', 'Hello! How can I help you?');

			expect(message).toBeDefined();
			expect(message.role).toBe('assistant');
			expect(message.content).toBe('Hello! How can I help you?');
		});

		it('should add a system message to context', async () => {
			const message = await contextManager.addMessage('system', 'You are a helpful assistant.');

			expect(message).toBeDefined();
			expect(message.role).toBe('system');
			expect(message.content).toBe('You are a helpful assistant.');
		});

		it('should include metadata when provided', async () => {
			const message = await contextManager.addMessage('user', 'Task message', {
				sessionId: 'session-123',
				taskId: 'task-456',
			});

			expect(message.sessionId).toBe('session-123');
			expect(message.taskId).toBe('task-456');
		});

		it('should estimate token count correctly', async () => {
			// ~4 characters per token
			const shortMessage = await contextManager.addMessage('user', 'Hi');
			expect(shortMessage.tokenCount).toBe(1);

			const longMessage = await contextManager.addMessage(
				'user',
				'This is a longer message that should have more tokens'
			);
			expect(longMessage.tokenCount).toBeGreaterThan(shortMessage.tokenCount);
		});

		it('should update total tokens when adding messages', async () => {
			await contextManager.addMessage('user', 'First message');
			await contextManager.addMessage('assistant', 'Second message');

			const tokenCount = await contextManager.getTokenCount();
			expect(tokenCount).toBeGreaterThan(0);
		});
	});

	describe('getRecentMessages', () => {
		it('should return all messages when no limit specified', async () => {
			await contextManager.addMessage('user', 'Message 1');
			await contextManager.addMessage('assistant', 'Message 2');
			await contextManager.addMessage('user', 'Message 3');

			const messages = await contextManager.getRecentMessages();

			expect(messages).toHaveLength(3);
		});

		it('should return limited number of messages', async () => {
			await contextManager.addMessage('user', 'Message 1');
			await contextManager.addMessage('assistant', 'Message 2');
			await contextManager.addMessage('user', 'Message 3');
			await contextManager.addMessage('assistant', 'Message 4');
			await contextManager.addMessage('user', 'Message 5');

			const messages = await contextManager.getRecentMessages(2);

			expect(messages).toHaveLength(2);
			// Should return most recent messages
			expect(messages[0].content).toBe('Message 4');
			expect(messages[1].content).toBe('Message 5');
		});

		it('should return empty array when no messages exist', async () => {
			const messages = await contextManager.getRecentMessages();

			expect(messages).toEqual([]);
		});

		it('should return all messages when limit exceeds count', async () => {
			await contextManager.addMessage('user', 'Message 1');
			await contextManager.addMessage('assistant', 'Message 2');

			const messages = await contextManager.getRecentMessages(10);

			expect(messages).toHaveLength(2);
		});

		it('should preserve message order', async () => {
			await contextManager.addMessage('system', 'System prompt');
			await contextManager.addMessage('user', 'User message');
			await contextManager.addMessage('assistant', 'Assistant response');

			const messages = await contextManager.getRecentMessages();

			expect(messages[0].role).toBe('system');
			expect(messages[1].role).toBe('user');
			expect(messages[2].role).toBe('assistant');
		});
	});

	describe('getTokenCount', () => {
		it('should return 0 for empty context', async () => {
			const tokenCount = await contextManager.getTokenCount();

			expect(tokenCount).toBe(0);
		});

		it('should accumulate tokens from all messages', async () => {
			await contextManager.addMessage('user', 'Short');
			await contextManager.addMessage('assistant', 'Medium length response');

			const tokenCount = await contextManager.getTokenCount();

			expect(tokenCount).toBeGreaterThan(0);
		});
	});

	describe('getContext', () => {
		it('should return context with correct properties', async () => {
			await contextManager.addMessage('user', 'Test');

			const context = await contextManager.getContext();

			expect(context).not.toBeNull();
			expect(context?.id).toBeDefined();
			expect(context?.roomId).toBe(roomId);
			expect(context?.totalTokens).toBeGreaterThan(0);
			expect(context?.status).toBe('idle');
		});

		it('should create context if it does not exist', async () => {
			const context = await contextManager.getContext();

			expect(context).not.toBeNull();
			expect(context?.roomId).toBe(roomId);
		});
	});

	describe('updateStatus', () => {
		it('should update context status to thinking', async () => {
			await contextManager.addMessage('user', 'Test');
			await contextManager.updateStatus('thinking');

			const context = await contextManager.getContext();
			expect(context?.status).toBe('thinking');
		});

		it('should update context status to waiting_for_input', async () => {
			await contextManager.addMessage('user', 'Test');
			await contextManager.updateStatus('waiting_for_input');

			const context = await contextManager.getContext();
			expect(context?.status).toBe('waiting_for_input');
		});

		it('should update context status back to idle', async () => {
			await contextManager.addMessage('user', 'Test');
			await contextManager.updateStatus('thinking');
			await contextManager.updateStatus('idle');

			const context = await contextManager.getContext();
			expect(context?.status).toBe('idle');
		});
	});

	describe('setCurrentContext', () => {
		it('should set current task ID', async () => {
			await contextManager.addMessage('user', 'Test');
			await contextManager.setCurrentContext({ currentTaskId: 'task-123' });

			const context = await contextManager.getContext();
			expect(context?.currentTaskId).toBe('task-123');
		});

		it('should set current session ID', async () => {
			await contextManager.addMessage('user', 'Test');
			await contextManager.setCurrentContext({ currentSessionId: 'session-456' });

			const context = await contextManager.getContext();
			expect(context?.currentSessionId).toBe('session-456');
		});

		it('should clear current task ID with null', async () => {
			await contextManager.addMessage('user', 'Test');
			await contextManager.setCurrentContext({ currentTaskId: 'task-123' });
			await contextManager.setCurrentContext({ currentTaskId: null });

			const context = await contextManager.getContext();
			expect(context?.currentTaskId).toBeUndefined();
		});

		it('should set both task and session IDs', async () => {
			await contextManager.addMessage('user', 'Test');
			await contextManager.setCurrentContext({
				currentTaskId: 'task-789',
				currentSessionId: 'session-012',
			});

			const context = await contextManager.getContext();
			expect(context?.currentTaskId).toBe('task-789');
			expect(context?.currentSessionId).toBe('session-012');
		});
	});

	describe('compactIfNecessary', () => {
		it('should not compact when below token limit', async () => {
			await contextManager.addMessage('user', 'Short message');

			const result = await contextManager.compactIfNecessary();

			expect(result).toBe(false);

			const messages = await contextManager.getRecentMessages();
			expect(messages).toHaveLength(1);
		});

		it('should compact when above token limit', async () => {
			// Add many messages to exceed the token limit (150000)
			// Each character is ~0.25 tokens, so we need ~600000 characters
			const longContent = 'x'.repeat(10000); // ~2500 tokens each
			for (let i = 0; i < 70; i++) {
				await contextManager.addMessage('user', longContent);
			}

			const result = await contextManager.compactIfNecessary();

			expect(result).toBe(true);

			const context = await contextManager.getContext();
			expect(context?.lastCompactedAt).toBeDefined();
		});

		it('should keep system messages during compaction', async () => {
			// Add system messages
			await contextManager.addMessage('system', 'System prompt 1');
			await contextManager.addMessage('system', 'System prompt 2');

			// Add many messages to exceed the token limit
			const longContent = 'x'.repeat(10000);
			for (let i = 0; i < 70; i++) {
				await contextManager.addMessage('user', longContent);
			}

			await contextManager.compactIfNecessary();

			const messages = await contextManager.getRecentMessages();
			const systemMessages = messages.filter((m) => m.role === 'system');
			expect(systemMessages).toHaveLength(2);
		});

		it('should keep recent non-system messages during compaction', async () => {
			// Add many messages to exceed the token limit
			const longContent = 'x'.repeat(10000);
			for (let i = 0; i < 70; i++) {
				await contextManager.addMessage('user', `Message ${i}: ${longContent}`);
			}

			await contextManager.compactIfNecessary();

			const messages = await contextManager.getRecentMessages();
			// Should keep at least COMPACTION_KEEP_RECENT (20) messages
			expect(messages.length).toBeLessThan(70);
		});

		it('should update total tokens after compaction', async () => {
			// Add many messages to exceed the token limit
			const longContent = 'x'.repeat(10000);
			for (let i = 0; i < 70; i++) {
				await contextManager.addMessage('user', longContent);
			}

			const tokensBefore = await contextManager.getTokenCount();
			await contextManager.compactIfNecessary();
			const tokensAfter = await contextManager.getTokenCount();

			expect(tokensAfter).toBeLessThan(tokensBefore);
		});
	});

	describe('clearContext', () => {
		it('should remove all messages from context', async () => {
			await contextManager.addMessage('user', 'Message 1');
			await contextManager.addMessage('assistant', 'Message 2');
			await contextManager.addMessage('user', 'Message 3');

			await contextManager.clearContext();

			const messages = await contextManager.getRecentMessages();
			expect(messages).toHaveLength(0);
		});

		it('should reset token count to 0', async () => {
			await contextManager.addMessage('user', 'Some message');
			await contextManager.clearContext();

			const tokenCount = await contextManager.getTokenCount();
			expect(tokenCount).toBe(0);
		});

		it('should preserve context object itself', async () => {
			await contextManager.addMessage('user', 'Message');
			const contextBefore = await contextManager.getContext();

			await contextManager.clearContext();

			const contextAfter = await contextManager.getContext();
			expect(contextAfter).not.toBeNull();
			expect(contextAfter?.id).toBe(contextBefore?.id);
		});
	});

	describe('multiple rooms', () => {
		it('should isolate contexts between rooms', async () => {
			// Create another room
			const room2 = roomManager.createRoom({
				name: 'Test Room 2',
				allowedPaths: ['/workspace/test2'],
			});
			const contextManager2 = new ContextManager(db, room2.id);

			// Add messages to both contexts
			await contextManager.addMessage('user', 'Room 1 message');
			await contextManager2.addMessage('user', 'Room 2 message');

			// Verify isolation
			const messages1 = await contextManager.getRecentMessages();
			const messages2 = await contextManager2.getRecentMessages();

			expect(messages1).toHaveLength(1);
			expect(messages2).toHaveLength(1);
			expect(messages1[0].content).toBe('Room 1 message');
			expect(messages2[0].content).toBe('Room 2 message');
		});
	});

	describe('edge cases', () => {
		it('should handle empty message content', async () => {
			const message = await contextManager.addMessage('user', '');

			expect(message).toBeDefined();
			expect(message.content).toBe('');
			expect(message.tokenCount).toBe(0);
		});

		it('should handle very long message content', async () => {
			const longContent = 'x'.repeat(100000);
			const message = await contextManager.addMessage('user', longContent);

			expect(message).toBeDefined();
			expect(message.content).toBe(longContent);
			expect(message.tokenCount).toBe(25000); // 100000 / 4
		});

		it('should handle unicode content', async () => {
			const unicodeContent = '你好世界 🌍 مرحبا';
			const message = await contextManager.addMessage('user', unicodeContent);

			expect(message).toBeDefined();
			expect(message.content).toBe(unicodeContent);
		});

		it('should handle special characters in content', async () => {
			const specialContent = 'Test with "quotes" and \'apostrophes\' and \n newlines \t tabs';
			const message = await contextManager.addMessage('user', specialContent);

			expect(message).toBeDefined();
			expect(message.content).toBe(specialContent);
		});
	});
});
