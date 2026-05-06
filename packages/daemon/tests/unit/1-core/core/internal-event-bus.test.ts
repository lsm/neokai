/**
 * InternalEventBus Unit Tests
 *
 * Covers:
 *   – awaited handler behaviour (publish)
 *   – structured handler failure behaviour
 *   – fire-and-forget behaviour (publishAsync)
 *   – subscriber-name diagnostics
 *   – session-scoped routing
 *
 * See docs/plans/internal-event-command-query-architecture.md
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
	InternalEventBus,
	InternalEventBusPublishError,
} from '../../../../src/lib/internal-event-bus';

interface TestEventMap {
	'session.created': { sessionId: string; title: string };
	'session.updated': { sessionId: string; title?: string };
	'session.deleted': { sessionId: string };
	'app.ping': { sessionId: string; ts: number };
}

describe('InternalEventBus', () => {
	let bus: InternalEventBus<TestEventMap>;

	beforeEach(() => {
		bus = new InternalEventBus<TestEventMap>();
	});

	describe('subscribe', () => {
		it('should require a non-empty subscriberName', () => {
			expect(() => bus.subscribe('session.created', () => {}, { subscriberName: '' })).toThrow(
				'subscriberName'
			);

			expect(() => bus.subscribe('session.created', () => {}, { subscriberName: '   ' })).toThrow(
				'subscriberName'
			);
		});

		it('should return an unsubscribe function', () => {
			const unsub = bus.subscribe('session.created', () => {}, {
				subscriberName: 'test-sub',
			});
			expect(typeof unsub).toBe('function');
		});

		it('should remove handler when unsubscribe is called', async () => {
			const received: string[] = [];
			const unsub = bus.subscribe(
				'session.created',
				(data) => {
					received.push(data.sessionId);
				},
				{ subscriberName: 'a' }
			);

			await bus.publish('session.created', { sessionId: 's1', title: 'T1' });
			expect(received).toEqual(['s1']);

			unsub();
			await bus.publish('session.created', { sessionId: 's2', title: 'T2' });
			expect(received).toEqual(['s1']);
		});
	});

	describe('publish – awaited handler behaviour', () => {
		it('should await a single handler', async () => {
			let received = false;
			bus.subscribe(
				'session.created',
				async () => {
					await new Promise((r) => setTimeout(r, 5));
					received = true;
				},
				{ subscriberName: 'single' }
			);

			const result = await bus.publish('session.created', {
				sessionId: 's1',
				title: 'T1',
			});
			expect(received).toBe(true);
			expect(result.delivered).toBe(1);
			expect(result.failures).toHaveLength(0);
		});

		it('should await multiple handlers concurrently', async () => {
			const order: number[] = [];

			bus.subscribe(
				'session.created',
				async () => {
					await new Promise((r) => setTimeout(r, 20));
					order.push(1);
				},
				{ subscriberName: 'slow' }
			);

			bus.subscribe(
				'session.created',
				async () => {
					await new Promise((r) => setTimeout(r, 5));
					order.push(2);
				},
				{ subscriberName: 'fast' }
			);

			const result = await bus.publish('session.created', {
				sessionId: 's1',
				title: 'T1',
			});

			expect(result.delivered).toBe(2);
			expect(order).toEqual([2, 1]); // fast finishes first
		});

		it('should return empty result when no handlers are registered', async () => {
			const result = await bus.publish('session.deleted', { sessionId: 'orphan' });
			expect(result.delivered).toBe(0);
			expect(result.failures).toHaveLength(0);
		});

		it('should deliver to both session-scoped and global handlers', async () => {
			const hits: string[] = [];

			bus.subscribe('session.created', () => hits.push('global'), { subscriberName: 'global' });
			bus.subscribe('session.created', () => hits.push('scoped'), {
				subscriberName: 'scoped',
				sessionId: 's1',
			});
			bus.subscribe('session.created', () => hits.push('other-scope'), {
				subscriberName: 'other',
				sessionId: 's2',
			});

			const result = await bus.publish('session.created', {
				sessionId: 's1',
				title: 'T1',
			});

			expect(hits.sort()).toEqual(['global', 'scoped']);
			expect(result.delivered).toBe(2);
		});
	});

	describe('publish – handler failure behaviour', () => {
		it('should throw InternalEventBusPublishError when a handler throws', async () => {
			const err = new Error('boom');
			bus.subscribe(
				'session.created',
				() => {
					throw err;
				},
				{ subscriberName: 'flaky' }
			);

			try {
				await bus.publish('session.created', { sessionId: 's1', title: 'T1' });
				expect.unreachable('should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(InternalEventBusPublishError);
				const pe = e as InternalEventBusPublishError;
				expect(pe.event).toBe('session.created');
				expect(pe.result.delivered).toBe(0);
				expect(pe.result.failures).toHaveLength(1);
				expect(pe.result.failures[0].subscriberName).toBe('flaky');
				expect(pe.result.failures[0].event).toBe('session.created');
				expect(pe.result.failures[0].error).toBe(err);
			}
		});

		it('should throw when a handler rejects', async () => {
			const err = new Error('async boom');
			bus.subscribe(
				'session.created',
				async () => {
					throw err;
				},
				{ subscriberName: 'async-flaky' }
			);

			await expect(
				bus.publish('session.created', { sessionId: 's1', title: 'T1' })
			).rejects.toBeInstanceOf(InternalEventBusPublishError);
		});

		it('should still run remaining handlers when one throws', async () => {
			const hits: string[] = [];

			bus.subscribe(
				'session.created',
				() => {
					throw new Error('first');
				},
				{ subscriberName: 'bad' }
			);

			bus.subscribe(
				'session.created',
				() => {
					hits.push('good');
				},
				{ subscriberName: 'good' }
			);

			bus.subscribe(
				'session.created',
				async () => {
					await new Promise((r) => setTimeout(r, 5));
					hits.push('async-good');
				},
				{ subscriberName: 'async-good' }
			);

			try {
				await bus.publish('session.created', { sessionId: 's1', title: 'T1' });
				expect.unreachable('should have thrown');
			} catch (e) {
				const pe = e as InternalEventBusPublishError;
				expect(pe.result.delivered).toBe(2);
				expect(pe.result.failures).toHaveLength(1);
				expect(hits.sort()).toEqual(['async-good', 'good']);
			}
		});

		it('should collect multiple failures in a single publish', async () => {
			bus.subscribe(
				'session.created',
				() => {
					throw new Error('a');
				},
				{ subscriberName: 'a' }
			);
			bus.subscribe(
				'session.created',
				() => {
					throw new Error('b');
				},
				{ subscriberName: 'b' }
			);

			try {
				await bus.publish('session.created', { sessionId: 's1', title: 'T1' });
				expect.unreachable('should have thrown');
			} catch (e) {
				const pe = e as InternalEventBusPublishError;
				expect(pe.result.failures).toHaveLength(2);
				const names = pe.result.failures.map((f) => f.subscriberName).sort();
				expect(names).toEqual(['a', 'b']);
			}
		});

		it('should wrap non-Error throws in Error objects', async () => {
			bus.subscribe(
				'session.created',
				() => {
					throw 'string-throw';
				},
				{ subscriberName: 'weird' }
			);

			try {
				await bus.publish('session.created', { sessionId: 's1', title: 'T1' });
				expect.unreachable('should have thrown');
			} catch (e) {
				const pe = e as InternalEventBusPublishError;
				expect(pe.result.failures[0].error).toBeInstanceOf(Error);
				expect(pe.result.failures[0].error.message).toBe('string-throw');
			}
		});
	});

	describe('publishAsync – fire-and-forget', () => {
		it('should return immediately without awaiting handlers', async () => {
			let resolved = false;
			bus.subscribe(
				'session.created',
				async () => {
					await new Promise((r) => setTimeout(r, 50));
					resolved = true;
				},
				{ subscriberName: 'slow' }
			);

			const start = performance.now();
			bus.publishAsync('session.created', { sessionId: 's1', title: 'T1' });
			const elapsed = performance.now() - start;

			expect(elapsed).toBeLessThan(10);
			expect(resolved).toBe(false);

			// Wait for handler to finish
			await new Promise((r) => setTimeout(r, 80));
			expect(resolved).toBe(true);
		});

		it('should not throw when a handler fails', async () => {
			bus.subscribe(
				'session.created',
				() => {
					throw new Error('async-boom');
				},
				{ subscriberName: 'flaky' }
			);

			// Must not throw synchronously or as an unhandled rejection
			expect(() =>
				bus.publishAsync('session.created', { sessionId: 's1', title: 'T1' })
			).not.toThrow();

			// Give microtasks a chance to run
			await new Promise((r) => setTimeout(r, 10));
		});
	});

	describe('diagnostics', () => {
		it('should report correct handler counts', () => {
			expect(bus.getHandlerCount('session.created')).toBe(0);

			bus.subscribe('session.created', () => {}, { subscriberName: 'a' });
			bus.subscribe('session.created', () => {}, { subscriberName: 'b' });
			bus.subscribe('session.created', () => {}, { subscriberName: 'c', sessionId: 's1' });

			expect(bus.getHandlerCount('session.created')).toBe(3);
			expect(bus.getHandlerCountForSession('session.created', 's1')).toBe(1);
			expect(bus.getHandlerCountForSession('session.created', 's2')).toBe(0);
		});

		it('should clear all handlers', async () => {
			const hits: string[] = [];
			bus.subscribe('session.created', () => hits.push('a'), { subscriberName: 'a' });
			bus.subscribe('session.updated', () => hits.push('b'), { subscriberName: 'b' });

			bus.clear();

			await bus.publish('session.created', { sessionId: 's1', title: 'T1' });
			await bus.publish('session.updated', { sessionId: 's1' });

			expect(hits).toHaveLength(0);
		});

		it('should clear handlers for a specific event via off()', async () => {
			const hits: string[] = [];
			bus.subscribe('session.created', () => hits.push('created'), { subscriberName: 'c' });
			bus.subscribe('session.deleted', () => hits.push('deleted'), { subscriberName: 'd' });

			bus.off('session.created');

			await bus.publish('session.created', { sessionId: 's1', title: 'T1' });
			await bus.publish('session.deleted', { sessionId: 's1' });

			expect(hits).toEqual(['deleted']);
		});
	});
});
