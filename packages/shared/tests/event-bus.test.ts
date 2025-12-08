/**
 * EventBus Tests
 *
 * Tests for the EventBus pub/sub coordination system
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { EventBus } from '../src/event-bus';

describe('EventBus', () => {
	let eventBus: EventBus;

	beforeEach(() => {
		eventBus = new EventBus();
	});

	describe('emit', () => {
		test('should emit event to registered handler', async () => {
			let receivedData: unknown = null;

			eventBus.on('session:created', (data) => {
				receivedData = data;
			});

			await eventBus.emit('session:created', {
				session: {
					id: 'test-session',
					workspacePath: '/test',
					status: 'active',
					config: { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 1 },
					metadata: {},
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			});

			expect(receivedData).toBeDefined();
			expect((receivedData as { session: { id: string } }).session.id).toBe('test-session');
		});

		test('should emit to multiple handlers', async () => {
			let count = 0;

			eventBus.on('session:deleted', () => {
				count++;
			});
			eventBus.on('session:deleted', () => {
				count++;
			});

			await eventBus.emit('session:deleted', { sessionId: 'test' });

			expect(count).toBe(2);
		});

		test('should handle events with no handlers', async () => {
			// Should not throw
			await eventBus.emit('session:deleted', { sessionId: 'test' });
		});

		test('should handle async handlers', async () => {
			let completed = false;

			eventBus.on('session:created', async () => {
				await new Promise((r) => setTimeout(r, 10));
				completed = true;
			});

			await eventBus.emit('session:created', {
				session: {
					id: 'test',
					workspacePath: '/test',
					status: 'active',
					config: { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 1 },
					metadata: {},
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			});

			expect(completed).toBe(true);
		});

		test('should catch handler errors without stopping other handlers', async () => {
			let secondHandlerCalled = false;

			eventBus.on('session:deleted', () => {
				throw new Error('First handler error');
			});
			eventBus.on('session:deleted', () => {
				secondHandlerCalled = true;
			});

			// Should not throw
			await eventBus.emit('session:deleted', { sessionId: 'test' });

			expect(secondHandlerCalled).toBe(true);
		});

		test('should catch async handler errors', async () => {
			eventBus.on('session:deleted', async () => {
				throw new Error('Async error');
			});

			// Should not throw
			await eventBus.emit('session:deleted', { sessionId: 'test' });
		});
	});

	describe('on', () => {
		test('should register handler and return unsubscribe function', () => {
			const unsubscribe = eventBus.on('session:deleted', () => {});

			expect(typeof unsubscribe).toBe('function');
		});

		test('unsubscribe should remove handler', async () => {
			let callCount = 0;

			const unsubscribe = eventBus.on('session:deleted', () => {
				callCount++;
			});

			await eventBus.emit('session:deleted', { sessionId: 'test' });
			expect(callCount).toBe(1);

			unsubscribe();

			await eventBus.emit('session:deleted', { sessionId: 'test' });
			expect(callCount).toBe(1); // Should not increase
		});
	});

	describe('once', () => {
		test('should only call handler once', async () => {
			let callCount = 0;

			eventBus.once('session:deleted', () => {
				callCount++;
			});

			await eventBus.emit('session:deleted', { sessionId: 'test' });
			await eventBus.emit('session:deleted', { sessionId: 'test' });

			expect(callCount).toBe(1);
		});

		test('should return unsubscribe function', () => {
			const unsubscribe = eventBus.once('session:deleted', () => {});
			expect(typeof unsubscribe).toBe('function');
		});

		test('unsubscribe should prevent handler from being called', async () => {
			let callCount = 0;

			const unsubscribe = eventBus.once('session:deleted', () => {
				callCount++;
			});

			unsubscribe();

			await eventBus.emit('session:deleted', { sessionId: 'test' });
			expect(callCount).toBe(0);
		});
	});

	describe('off', () => {
		test('should remove all handlers for an event', async () => {
			let callCount = 0;

			eventBus.on('session:deleted', () => callCount++);
			eventBus.on('session:deleted', () => callCount++);

			eventBus.off('session:deleted');

			await eventBus.emit('session:deleted', { sessionId: 'test' });
			expect(callCount).toBe(0);
		});
	});

	describe('getHandlerCount', () => {
		test('should return correct handler count', () => {
			expect(eventBus.getHandlerCount('session:deleted')).toBe(0);

			eventBus.on('session:deleted', () => {});
			expect(eventBus.getHandlerCount('session:deleted')).toBe(1);

			eventBus.on('session:deleted', () => {});
			expect(eventBus.getHandlerCount('session:deleted')).toBe(2);
		});
	});

	describe('clear', () => {
		test('should remove all handlers', async () => {
			let callCount = 0;

			eventBus.on('session:deleted', () => callCount++);
			eventBus.on('session:created', () => callCount++);

			eventBus.clear();

			await eventBus.emit('session:deleted', { sessionId: 'test' });
			await eventBus.emit('session:created', {
				session: {
					id: 'test',
					workspacePath: '/test',
					status: 'active',
					config: { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 1 },
					metadata: {},
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			});

			expect(callCount).toBe(0);
		});
	});

	describe('debug mode', () => {
		test('should log events when debug is enabled', async () => {
			const debugBus = new EventBus({ debug: true });

			// This should not throw and should log
			debugBus.on('session:deleted', () => {});
			await debugBus.emit('session:deleted', { sessionId: 'test' });
		});
	});
});
