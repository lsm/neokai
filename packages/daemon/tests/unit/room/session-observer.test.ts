import { describe, expect, it, beforeEach } from 'bun:test';
import { SessionObserver, type TerminalState } from '../../../src/lib/room/state/session-observer';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { AgentProcessingState } from '@neokai/shared';

/**
 * Minimal mock DaemonHub that captures event subscriptions.
 * Allows tests to fire events and verify observer behavior.
 */
function createMockDaemonHub() {
	const handlers = new Map<string, Map<string | undefined, Array<(data: unknown) => void>>>();

	return {
		on(
			event: string,
			handler: (data: unknown) => void,
			options?: { sessionId?: string }
		): () => void {
			if (!handlers.has(event)) {
				handlers.set(event, new Map());
			}
			const eventHandlers = handlers.get(event)!;
			const key = options?.sessionId;
			if (!eventHandlers.has(key)) {
				eventHandlers.set(key, []);
			}
			eventHandlers.get(key)!.push(handler);

			return () => {
				const list = eventHandlers.get(key);
				if (list) {
					const idx = list.indexOf(handler);
					if (idx !== -1) list.splice(idx, 1);
				}
			};
		},

		/** Fire an event for testing */
		fire(event: string, data: { sessionId: string; processingState?: AgentProcessingState }): void {
			const eventHandlers = handlers.get(event);
			if (!eventHandlers) return;

			// Fire session-scoped handlers
			const scoped = eventHandlers.get(data.sessionId);
			if (scoped) {
				for (const h of scoped) h(data);
			}

			// Fire global handlers
			const global = eventHandlers.get(undefined);
			if (global) {
				for (const h of global) h(data);
			}
		},

		getHandlerCount(event: string, sessionId?: string): number {
			const eventHandlers = handlers.get(event);
			if (!eventHandlers) return 0;
			const list = eventHandlers.get(sessionId);
			return list?.length ?? 0;
		},
	};
}

describe('SessionObserver', () => {
	let mockHub: ReturnType<typeof createMockDaemonHub>;
	let observer: SessionObserver;
	let terminalStates: TerminalState[];

	function onTerminal(state: TerminalState) {
		terminalStates.push(state);
	}

	beforeEach(() => {
		mockHub = createMockDaemonHub();
		observer = new SessionObserver(mockHub as unknown as DaemonHub);
		terminalStates = [];
	});

	describe('observe', () => {
		it('should subscribe to session.updated events', () => {
			observer.observe('session-1', onTerminal);
			expect(mockHub.getHandlerCount('session.updated', 'session-1')).toBe(1);
			expect(observer.isObserving('session-1')).toBe(true);
		});

		it('should replace existing subscription on re-observe', () => {
			observer.observe('session-1', onTerminal);
			observer.observe('session-1', onTerminal);
			expect(mockHub.getHandlerCount('session.updated', 'session-1')).toBe(1);
		});
	});

	describe('unobserve', () => {
		it('should unsubscribe from events', () => {
			observer.observe('session-1', onTerminal);
			observer.unobserve('session-1');
			expect(observer.isObserving('session-1')).toBe(false);
			expect(mockHub.getHandlerCount('session.updated', 'session-1')).toBe(0);
		});

		it('should be safe to call on non-observed session', () => {
			observer.unobserve('nonexistent');
			// No error thrown
		});
	});

	describe('dispose', () => {
		it('should unsubscribe all sessions', () => {
			observer.observe('s1', onTerminal);
			observer.observe('s2', onTerminal);
			expect(observer.observedCount).toBe(2);
			observer.dispose();
			expect(observer.observedCount).toBe(0);
		});
	});

	describe('terminal state detection (stateless relay)', () => {
		it('should fire for idle status', () => {
			observer.observe('s1', onTerminal);

			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'idle' },
			});

			expect(terminalStates).toHaveLength(1);
			expect(terminalStates[0]).toEqual({ sessionId: 's1', kind: 'idle' });
		});

		it('should fire for every idle event (no dedup)', () => {
			observer.observe('s1', onTerminal);

			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'idle' },
			});
			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'idle' },
			});

			// Stateless: both fire, consumer handles idempotency
			expect(terminalStates).toHaveLength(2);
		});

		it('should fire for waiting_for_input status', () => {
			observer.observe('s1', onTerminal);

			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: {
					status: 'waiting_for_input',
					pendingQuestion: { id: 'q1', question: 'Continue?' } as never,
				},
			});

			expect(terminalStates).toHaveLength(1);
			expect(terminalStates[0]).toEqual({ sessionId: 's1', kind: 'waiting_for_input' });
		});

		it('should fire for interrupted status', () => {
			observer.observe('s1', onTerminal);

			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'interrupted' },
			});

			expect(terminalStates).toHaveLength(1);
			expect(terminalStates[0]).toEqual({ sessionId: 's1', kind: 'interrupted' });
		});

		it('should not fire for processing status', () => {
			observer.observe('s1', onTerminal);

			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'processing', messageId: 'm1', phase: 'thinking' },
			});
			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'processing', messageId: 'm1', phase: 'streaming' },
			});

			expect(terminalStates).toHaveLength(0);
		});

		it('should ignore events without processingState', () => {
			observer.observe('s1', onTerminal);

			mockHub.fire('session.updated', {
				sessionId: 's1',
			});

			expect(terminalStates).toHaveLength(0);
		});

		it('should not fire after unobserve', () => {
			observer.observe('s1', onTerminal);
			observer.unobserve('s1');

			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'idle' },
			});

			expect(terminalStates).toHaveLength(0);
		});

		it('should track multiple sessions independently', () => {
			observer.observe('s1', onTerminal);
			observer.observe('s2', onTerminal);

			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'idle' },
			});
			mockHub.fire('session.updated', {
				sessionId: 's2',
				processingState: {
					status: 'waiting_for_input',
					pendingQuestion: { id: 'q1', question: 'Q?' } as never,
				},
			});

			expect(terminalStates).toHaveLength(2);
			expect(terminalStates[0]).toEqual({ sessionId: 's1', kind: 'idle' });
			expect(terminalStates[1]).toEqual({ sessionId: 's2', kind: 'waiting_for_input' });
		});

		it('should fire for each terminal event in a processing cycle', () => {
			observer.observe('s1', onTerminal);

			// First cycle
			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'processing', messageId: 'm1', phase: 'streaming' },
			});
			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'idle' },
			});

			// Second cycle
			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'processing', messageId: 'm2', phase: 'streaming' },
			});
			mockHub.fire('session.updated', {
				sessionId: 's1',
				processingState: { status: 'idle' },
			});

			expect(terminalStates).toHaveLength(2);
			expect(terminalStates[0].kind).toBe('idle');
			expect(terminalStates[1].kind).toBe('idle');
		});
	});
});
