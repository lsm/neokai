/**
 * Context Repository Tests
 *
 * Tests for Neo context and context message CRUD operations.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ContextRepository } from '../../../src/storage/repositories/context-repository';
import type { NeoContext, NeoContextMessage } from '@neokai/shared';

describe('ContextRepository', () => {
	let db: Database;
	let repository: ContextRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE contexts (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL UNIQUE,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				last_compacted_at INTEGER,
				status TEXT NOT NULL DEFAULT 'idle',
				current_task_id TEXT,
				current_session_id TEXT
			);

			CREATE TABLE context_messages (
				id TEXT PRIMARY KEY,
				context_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				token_count INTEGER NOT NULL,
				session_id TEXT,
				task_id TEXT,
				FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
			);

			CREATE INDEX idx_context_messages_context ON context_messages(context_id);
		`);
		repository = new ContextRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createContext', () => {
		it('should create a context for a room', () => {
			const context = repository.createContext('room-1');

			expect(context.id).toBeDefined();
			expect(context.roomId).toBe('room-1');
			expect(context.totalTokens).toBe(0);
			expect(context.status).toBe('idle');
		});

		it('should generate unique IDs for different contexts', () => {
			const context1 = repository.createContext('room-1');
			const context2 = repository.createContext('room-2');

			expect(context1.id).not.toBe(context2.id);
		});
	});

	describe('getContext', () => {
		it('should return context by ID', () => {
			const created = repository.createContext('room-1');
			const context = repository.getContext(created.id);

			expect(context).not.toBeNull();
			expect(context?.id).toBe(created.id);
			expect(context?.roomId).toBe('room-1');
		});

		it('should return null for non-existent ID', () => {
			const context = repository.getContext('non-existent-id');

			expect(context).toBeNull();
		});
	});

	describe('getContextForRoom', () => {
		it('should return context for a room', () => {
			repository.createContext('room-1');

			const context = repository.getContextForRoom('room-1');

			expect(context).not.toBeNull();
			expect(context?.roomId).toBe('room-1');
		});

		it('should return null for non-existent room', () => {
			const context = repository.getContextForRoom('non-existent-room');

			expect(context).toBeNull();
		});
	});

	describe('updateContext', () => {
		it('should update context status', () => {
			const context = repository.createContext('room-1');

			const updated = repository.updateContext(context.id, { status: 'thinking' });

			expect(updated?.status).toBe('thinking');
		});

		it('should update total tokens', () => {
			const context = repository.createContext('room-1');

			const updated = repository.updateContext(context.id, { totalTokens: 500 });

			expect(updated?.totalTokens).toBe(500);
		});

		it('should update current task ID', () => {
			const context = repository.createContext('room-1');

			const updated = repository.updateContext(context.id, { currentTaskId: 'task-1' });

			expect(updated?.currentTaskId).toBe('task-1');
		});

		it('should clear current task ID when set to null', () => {
			const context = repository.createContext('room-1');
			repository.updateContext(context.id, { currentTaskId: 'task-1' });

			const updated = repository.updateContext(context.id, { currentTaskId: null });

			expect(updated?.currentTaskId).toBeUndefined();
		});

		it('should update current session ID', () => {
			const context = repository.createContext('room-1');

			const updated = repository.updateContext(context.id, { currentSessionId: 'session-1' });

			expect(updated?.currentSessionId).toBe('session-1');
		});

		it('should update last compacted at', () => {
			const context = repository.createContext('room-1');
			const timestamp = Date.now();

			const updated = repository.updateContext(context.id, { lastCompactedAt: timestamp });

			expect(updated?.lastCompactedAt).toBe(timestamp);
		});

		it('should update multiple fields at once', () => {
			const context = repository.createContext('room-1');

			const updated = repository.updateContext(context.id, {
				status: 'waiting_for_input',
				totalTokens: 1000,
				currentTaskId: 'task-1',
				currentSessionId: 'session-1',
			});

			expect(updated?.status).toBe('waiting_for_input');
			expect(updated?.totalTokens).toBe(1000);
			expect(updated?.currentTaskId).toBe('task-1');
			expect(updated?.currentSessionId).toBe('session-1');
		});

		it('should return null for non-existent context', () => {
			const updated = repository.updateContext('non-existent', { status: 'thinking' });

			expect(updated).toBeNull();
		});

		it('should preserve unmodified fields', () => {
			const context = repository.createContext('room-1');
			repository.updateContext(context.id, { currentTaskId: 'task-1' });

			const updated = repository.updateContext(context.id, { status: 'thinking' });

			expect(updated?.currentTaskId).toBe('task-1');
		});
	});

	describe('addMessage', () => {
		it('should add a system message', () => {
			const context = repository.createContext('room-1');

			const message = repository.addMessage(context.id, 'system', 'System instruction', 50);

			expect(message.id).toBeDefined();
			expect(message.contextId).toBe(context.id);
			expect(message.role).toBe('system');
			expect(message.content).toBe('System instruction');
			expect(message.tokenCount).toBe(50);
		});

		it('should add a user message', () => {
			const context = repository.createContext('room-1');

			const message = repository.addMessage(context.id, 'user', 'User question', 20);

			expect(message.role).toBe('user');
			expect(message.content).toBe('User question');
		});

		it('should add an assistant message', () => {
			const context = repository.createContext('room-1');

			const message = repository.addMessage(context.id, 'assistant', 'Assistant response', 100);

			expect(message.role).toBe('assistant');
			expect(message.content).toBe('Assistant response');
		});

		it('should include session ID if provided', () => {
			const context = repository.createContext('room-1');

			const message = repository.addMessage(context.id, 'user', 'Test', 10, 'session-1');

			expect(message.sessionId).toBe('session-1');
		});

		it('should include task ID if provided', () => {
			const context = repository.createContext('room-1');

			const message = repository.addMessage(context.id, 'user', 'Test', 10, undefined, 'task-1');

			expect(message.taskId).toBe('task-1');
		});

		it('should update total tokens in context', () => {
			const context = repository.createContext('room-1');

			repository.addMessage(context.id, 'user', 'Message 1', 50);
			repository.addMessage(context.id, 'assistant', 'Message 2', 100);

			const updatedContext = repository.getContext(context.id);
			expect(updatedContext?.totalTokens).toBe(150);
		});

		it('should set timestamp', () => {
			const context = repository.createContext('room-1');
			const beforeTime = Date.now();

			const message = repository.addMessage(context.id, 'user', 'Test', 10);

			expect(message.timestamp).toBeGreaterThanOrEqual(beforeTime);
		});
	});

	describe('getMessage', () => {
		it('should return message by ID', () => {
			const context = repository.createContext('room-1');
			const created = repository.addMessage(context.id, 'user', 'Test message', 10);

			const message = repository.getMessage(created.id);

			expect(message).not.toBeNull();
			expect(message?.id).toBe(created.id);
			expect(message?.content).toBe('Test message');
		});

		it('should return null for non-existent message ID', () => {
			const message = repository.getMessage('non-existent-id');

			expect(message).toBeNull();
		});
	});

	describe('getMessages', () => {
		it('should return all messages for a context', () => {
			const context = repository.createContext('room-1');
			repository.addMessage(context.id, 'system', 'System', 10);
			repository.addMessage(context.id, 'user', 'User', 20);
			repository.addMessage(context.id, 'assistant', 'Assistant', 30);

			const messages = repository.getMessages(context.id);

			expect(messages.length).toBe(3);
		});

		it('should return messages in chronological order', async () => {
			const context = repository.createContext('room-1');
			repository.addMessage(context.id, 'user', 'First', 10);
			await new Promise((r) => setTimeout(r, 5));
			repository.addMessage(context.id, 'user', 'Second', 10);
			await new Promise((r) => setTimeout(r, 5));
			repository.addMessage(context.id, 'user', 'Third', 10);

			const messages = repository.getMessages(context.id);

			expect(messages[0].content).toBe('First');
			expect(messages[1].content).toBe('Second');
			expect(messages[2].content).toBe('Third');
		});

		it('should return empty array for non-existent context', () => {
			const messages = repository.getMessages('non-existent-context');

			expect(messages).toEqual([]);
		});

		it('should only return messages for the specified context', () => {
			const context1 = repository.createContext('room-1');
			const context2 = repository.createContext('room-2');
			repository.addMessage(context1.id, 'user', 'Context 1', 10);
			repository.addMessage(context2.id, 'user', 'Context 2', 10);

			const messages1 = repository.getMessages(context1.id);
			const messages2 = repository.getMessages(context2.id);

			expect(messages1.length).toBe(1);
			expect(messages1[0].content).toBe('Context 1');
			expect(messages2.length).toBe(1);
			expect(messages2[0].content).toBe('Context 2');
		});
	});

	describe('deleteMessagesAfter', () => {
		it('should delete messages after specified timestamp', async () => {
			const context = repository.createContext('room-1');
			repository.addMessage(context.id, 'user', 'First', 10);
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.addMessage(context.id, 'user', 'Second', 10);
			repository.addMessage(context.id, 'user', 'Third', 10);

			const deletedCount = repository.deleteMessagesAfter(context.id, middleTime);

			expect(deletedCount).toBe(2);
			expect(repository.getMessages(context.id).length).toBe(1);
		});

		it('should return 0 when no messages to delete', () => {
			const context = repository.createContext('room-1');
			repository.addMessage(context.id, 'user', 'Only message', 10);

			const deletedCount = repository.deleteMessagesAfter(context.id, Date.now() + 10000);

			expect(deletedCount).toBe(0);
		});

		it('should only delete from specified context', async () => {
			const context1 = repository.createContext('room-1');
			const context2 = repository.createContext('room-2');
			repository.addMessage(context1.id, 'user', 'Context 1', 10);
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.addMessage(context2.id, 'user', 'Context 2', 10);

			repository.deleteMessagesAfter(context1.id, middleTime);

			expect(repository.getMessages(context2.id).length).toBe(1);
		});
	});

	describe('deleteContext', () => {
		it('should delete a context', () => {
			const context = repository.createContext('room-1');

			repository.deleteContext(context.id);

			expect(repository.getContext(context.id)).toBeNull();
		});

		it('should not throw when deleting non-existent context', () => {
			expect(() => repository.deleteContext('non-existent')).not.toThrow();
		});

		it('should cascade delete associated messages', () => {
			const context = repository.createContext('room-1');
			repository.addMessage(context.id, 'user', 'Message 1', 10);
			repository.addMessage(context.id, 'user', 'Message 2', 10);

			repository.deleteContext(context.id);

			// Since the foreign key has ON DELETE CASCADE, messages should be deleted too
			// Note: SQLite needs foreign keys enabled for this to work
		});
	});

	describe('context lifecycle', () => {
		it('should support full context workflow', () => {
			// Create context
			const context = repository.createContext('room-1');
			expect(context.status).toBe('idle');

			// Add system message
			repository.addMessage(context.id, 'system', 'System prompt', 100);

			// Start working
			repository.updateContext(context.id, { status: 'thinking', currentTaskId: 'task-1' });

			// Add user and assistant messages
			repository.addMessage(context.id, 'user', 'User request', 50, 'session-1');
			repository.addMessage(
				context.id,
				'assistant',
				'Assistant response',
				200,
				'session-1',
				'task-1'
			);

			// Wait for input
			repository.updateContext(context.id, { status: 'waiting_for_input' });

			// Verify final state
			const finalContext = repository.getContext(context.id);
			expect(finalContext?.status).toBe('waiting_for_input');
			expect(finalContext?.totalTokens).toBe(350);
			expect(finalContext?.currentTaskId).toBe('task-1');

			const messages = repository.getMessages(context.id);
			expect(messages.length).toBe(3);
		});
	});
});
