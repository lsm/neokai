/**
 * Session Observer - Detects terminal states from AgentSessions
 *
 * Subscribes to DaemonHub session.updated events and detects when
 * sessions reach terminal states (idle, waiting_for_input, interrupted).
 * Calls registered callbacks so the RoomRuntime can react.
 *
 * Terminal state mapping:
 * - idle (after processing) → Agent finished turn (success or error)
 * - waiting_for_input → Agent called AskUserQuestion
 * - interrupted → Agent was interrupted
 */

import type { DaemonHub } from '../../daemon-hub';

export type TerminalStateKind = 'idle' | 'waiting_for_input' | 'interrupted';

export interface TerminalState {
	sessionId: string;
	kind: TerminalStateKind;
}

export type TerminalStateCallback = (state: TerminalState) => void;

export class SessionObserver {
	/** Map of sessionId → unsubscribe function */
	private subscriptions = new Map<string, () => void>();

	constructor(private daemonHub: DaemonHub) {}

	/**
	 * Start observing a session for terminal states.
	 * Calls onTerminal when the session reaches idle, waiting_for_input, or interrupted.
	 *
	 * This is a stateless relay — no transition tracking. Every terminal-status
	 * event fires the callback. Consumers must be idempotent (guard via group
	 * state + optimistic locking).
	 */
	observe(sessionId: string, onTerminal: TerminalStateCallback): void {
		// Don't double-subscribe
		if (this.subscriptions.has(sessionId)) {
			this.unobserve(sessionId);
		}

		const unsubscribe = this.daemonHub.on(
			'session.updated',
			(event) => {
				if (!event.processingState) return;
				const status = event.processingState.status;
				if (status === 'idle' || status === 'waiting_for_input' || status === 'interrupted') {
					onTerminal({ sessionId, kind: status });
				}
			},
			{ sessionId }
		);

		this.subscriptions.set(sessionId, unsubscribe);
	}

	/**
	 * Stop observing a session.
	 */
	unobserve(sessionId: string): void {
		const unsub = this.subscriptions.get(sessionId);
		if (unsub) {
			unsub();
			this.subscriptions.delete(sessionId);
		}
	}

	/**
	 * Stop observing all sessions and clean up.
	 */
	dispose(): void {
		for (const [sessionId] of this.subscriptions) {
			this.unobserve(sessionId);
		}
	}

	/**
	 * Check if a session is being observed.
	 */
	isObserving(sessionId: string): boolean {
		return this.subscriptions.has(sessionId);
	}

	/**
	 * Get count of observed sessions.
	 */
	get observedCount(): number {
		return this.subscriptions.size;
	}
}
