/**
 * InProcessHub Unit Tests
 *
 * Tests for typed EventBus-like wrapper over MessageHub + InProcessTransport.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { InProcessHub } from '../src/message-hub/in-process-hub.ts';
import type { BaseEventData } from '../src/message-hub/in-process-hub.ts';

// Define test event map (similar to EventBus's EventMap)
interface TestEventMap extends Record<string, BaseEventData> {
	'session:created': { sessionId: string; title: string };
	'session:updated': { sessionId: string; title?: string; status?: string };
	'session:deleted': { sessionId: string };
	'message:sent': { sessionId: string; content: string };
	'context:updated': { sessionId: string; tokens: number };
	'global:settings': { sessionId: string; theme: string }; // Use 'global' sessionId
}

describe('InProcessHub', () => {
	let hub: InProcessHub<TestEventMap>;

	beforeEach(async () => {
		hub = new InProcessHub<TestEventMap>({ name: 'test-hub' });
		await hub.initialize();
	});

	afterEach(async () => {
		await hub.close();
	});

	describe('basic pub/sub', () => {
		it('should emit and receive events', async () => {
			const received: TestEventMap['session:created'][] = [];

			hub.on('session:created', (data) => {
				received.push(data);
			});

			await hub.emit('session:created', { sessionId: 'test-1', title: 'Test Session' });

			// Wait for async delivery
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received.length).toBe(1);
			expect(received[0].sessionId).toBe('test-1');
			expect(received[0].title).toBe('Test Session');
		});

		it('should support multiple subscribers', async () => {
			const received1: string[] = [];
			const received2: string[] = [];

			hub.on('session:created', (data) => {
				received1.push(data.sessionId);
			});

			hub.on('session:created', (data) => {
				received2.push(data.sessionId);
			});

			await hub.emit('session:created', { sessionId: 'multi-test', title: 'Multi' });
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received1).toEqual(['multi-test']);
			expect(received2).toEqual(['multi-test']);
		});

		it('should support unsubscribe', async () => {
			const received: string[] = [];

			const unsubscribe = hub.on('session:created', (data) => {
				received.push(data.sessionId);
			});

			await hub.emit('session:created', { sessionId: 'before', title: 'Before' });
			await new Promise((resolve) => setTimeout(resolve, 10));

			unsubscribe();

			await hub.emit('session:created', { sessionId: 'after', title: 'After' });
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received).toEqual(['before']);
		});

		it('should support once() for one-time subscriptions', async () => {
			const received: string[] = [];

			hub.once('session:created', (data) => {
				received.push(data.sessionId);
			});

			await hub.emit('session:created', { sessionId: 'first', title: 'First' });
			await hub.emit('session:created', { sessionId: 'second', title: 'Second' });
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Should only receive first event
			expect(received).toEqual(['first']);
		});
	});

	describe('session-scoped subscriptions', () => {
		it('should filter events by sessionId', async () => {
			const session1Events: string[] = [];
			const session2Events: string[] = [];
			const allEvents: string[] = [];

			// Session-specific subscriptions
			hub.on(
				'message:sent',
				(data) => {
					session1Events.push(data.content);
				},
				{ sessionId: 'session-1' }
			);

			hub.on(
				'message:sent',
				(data) => {
					session2Events.push(data.content);
				},
				{ sessionId: 'session-2' }
			);

			// Global subscription (no sessionId filter)
			hub.on('message:sent', (data) => {
				allEvents.push(data.content);
			});

			// Emit events for different sessions
			await hub.emit('message:sent', { sessionId: 'session-1', content: 'msg1' });
			await hub.emit('message:sent', { sessionId: 'session-2', content: 'msg2' });
			await hub.emit('message:sent', { sessionId: 'session-3', content: 'msg3' });
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Session-specific handlers only get their session's events
			expect(session1Events).toEqual(['msg1']);
			expect(session2Events).toEqual(['msg2']);

			// Global handler gets all events
			expect(allEvents).toEqual(['msg1', 'msg2', 'msg3']);
		});

		it('should support session-scoped once()', async () => {
			const received: string[] = [];

			hub.once(
				'message:sent',
				(data) => {
					received.push(data.content);
				},
				{ sessionId: 'target-session' }
			);

			// These should be filtered out
			await hub.emit('message:sent', { sessionId: 'other-session', content: 'other1' });
			await hub.emit('message:sent', { sessionId: 'other-session', content: 'other2' });

			// This should be received (and unsubscribe)
			await hub.emit('message:sent', { sessionId: 'target-session', content: 'target1' });

			// This should be missed (already unsubscribed)
			await hub.emit('message:sent', { sessionId: 'target-session', content: 'target2' });

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(received).toEqual(['target1']);
		});
	});

	describe('handler count', () => {
		it('should track handler count correctly', () => {
			expect(hub.getHandlerCount('session:created')).toBe(0);

			const unsub1 = hub.on('session:created', () => {});
			expect(hub.getHandlerCount('session:created')).toBe(1);

			const unsub2 = hub.on('session:created', () => {});
			expect(hub.getHandlerCount('session:created')).toBe(2);

			unsub1();
			expect(hub.getHandlerCount('session:created')).toBe(1);

			unsub2();
			expect(hub.getHandlerCount('session:created')).toBe(0);
		});

		it('should count session-scoped handlers separately', () => {
			hub.on('message:sent', () => {}); // global
			hub.on('message:sent', () => {}, { sessionId: 'session-1' });
			hub.on('message:sent', () => {}, { sessionId: 'session-2' });

			// Total should be 3
			expect(hub.getHandlerCount('message:sent')).toBe(3);
		});
	});

	describe('off()', () => {
		it('should remove all handlers for an event', async () => {
			const received: string[] = [];

			hub.on('session:created', (data) => {
				received.push('handler1:' + data.sessionId);
			});

			hub.on('session:created', (data) => {
				received.push('handler2:' + data.sessionId);
			});

			hub.on(
				'session:created',
				(data) => {
					received.push('scoped:' + data.sessionId);
				},
				{ sessionId: 'specific' }
			);

			hub.off('session:created');

			await hub.emit('session:created', { sessionId: 'specific', title: 'Test' });
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received).toEqual([]);
			expect(hub.getHandlerCount('session:created')).toBe(0);
		});
	});

	describe('error handling', () => {
		it('should throw when emitting before initialization', async () => {
			const uninitializedHub = new InProcessHub<TestEventMap>({ name: 'uninitialized' });

			await expect(
				uninitializedHub.emit('session:created', { sessionId: 'test', title: 'Test' })
			).rejects.toThrow('not initialized');

			// Cleanup
			await uninitializedHub.close();
		});

		it('should handle errors in handlers gracefully', async () => {
			const received: string[] = [];

			// This handler will throw
			hub.on('session:created', () => {
				throw new Error('Handler error');
			});

			// This handler should still execute
			hub.on('session:created', (data) => {
				received.push(data.sessionId);
			});

			// Should not throw, error handled internally
			await hub.emit('session:created', { sessionId: 'error-test', title: 'Test' });
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Second handler should still have received the event
			expect(received).toEqual(['error-test']);
		});

		it('should handle async errors in handlers gracefully', async () => {
			const received: string[] = [];

			// This async handler will reject
			hub.on('session:created', async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				throw new Error('Async handler error');
			});

			// This handler should still execute
			hub.on('session:created', (data) => {
				received.push(data.sessionId);
			});

			// Should not throw
			await hub.emit('session:created', { sessionId: 'async-error-test', title: 'Test' });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(received).toEqual(['async-error-test']);
		});
	});

	describe('async handlers', () => {
		it('should support async handlers', async () => {
			const order: string[] = [];

			hub.on('session:created', async (data) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push('async:' + data.sessionId);
			});

			hub.on('session:created', (data) => {
				order.push('sync:' + data.sessionId);
			});

			await hub.emit('session:created', { sessionId: 'test', title: 'Test' });

			// Sync handler should execute first
			expect(order).toContain('sync:test');

			// Wait for async handler
			await new Promise((resolve) => setTimeout(resolve, 30));

			expect(order).toContain('async:test');
		});
	});

	describe('multiple event types', () => {
		it('should handle multiple event types independently', async () => {
			const created: string[] = [];
			const deleted: string[] = [];

			hub.on('session:created', (data) => {
				created.push(data.sessionId);
			});

			hub.on('session:deleted', (data) => {
				deleted.push(data.sessionId);
			});

			await hub.emit('session:created', { sessionId: 'new', title: 'New' });
			await hub.emit('session:deleted', { sessionId: 'old' });
			await hub.emit('session:created', { sessionId: 'another', title: 'Another' });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(created).toEqual(['new', 'another']);
			expect(deleted).toEqual(['old']);
		});
	});

	describe('participant hub', () => {
		it('should create participant that can emit and subscribe', async () => {
			const participant = hub.createParticipant('component-1');
			const received: string[] = [];

			// Subscribe via participant
			participant.on('session:created', (data) => {
				received.push('participant:' + data.sessionId);
			});

			// Emit via main hub
			await hub.emit('session:created', { sessionId: 'from-main', title: 'Main' });

			// Emit via participant
			await participant.emit('session:created', { sessionId: 'from-participant', title: 'Participant' });

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(received).toContain('participant:from-main');
			expect(received).toContain('participant:from-participant');
		});
	});

	describe('reinitialization', () => {
		it('should allow reinitialization after close', async () => {
			const hub2 = new InProcessHub<TestEventMap>({ name: 'reinit-test' });
			await hub2.initialize();

			const received: string[] = [];
			hub2.on('session:created', (data) => received.push(data.sessionId));

			await hub2.emit('session:created', { sessionId: 'before-close', title: 'Before' });
			await new Promise((resolve) => setTimeout(resolve, 10));

			await hub2.close();

			// Reinitialize
			await hub2.initialize();

			// Need to re-subscribe after close (handlers cleared)
			hub2.on('session:created', (data) => received.push('after:' + data.sessionId));

			await hub2.emit('session:created', { sessionId: 'after-reinit', title: 'After' });
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received).toContain('before-close');
			expect(received).toContain('after:after-reinit');

			await hub2.close();
		});
	});
});
