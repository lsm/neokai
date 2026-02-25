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

import type { DaemonHub } from '../daemon-hub';
import type { AgentProcessingState } from '@neokai/shared';

export type TerminalStateKind = 'completed' | 'waiting_for_input' | 'interrupted';

export interface TerminalState {
	sessionId: string;
	kind: TerminalStateKind;
}

export type TerminalStateCallback = (state: TerminalState) => void;

export class SessionObserver {
	/** Map of sessionId → unsubscribe function */
	private subscriptions = new Map<string, () => void>();
	/** Track last known processing status per session to detect transitions */
	private lastStatus = new Map<string, string>();

	constructor(private daemonHub: DaemonHub) {}

	/**
	 * Start observing a session for terminal states.
	 * Calls onTerminal when the session reaches idle, waiting_for_input, or interrupted.
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
				this.handleStateChange(sessionId, event.processingState, onTerminal);
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
			this.lastStatus.delete(sessionId);
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

	private handleStateChange(
		sessionId: string,
		state: AgentProcessingState,
		onTerminal: TerminalStateCallback
	): void {
		const prevStatus = this.lastStatus.get(sessionId);
		const newStatus = state.status;

		// Update tracked status
		this.lastStatus.set(sessionId, newStatus);

		// Only fire on transitions TO terminal states
		// (idle after processing, waiting_for_input, interrupted)
		if (prevStatus === newStatus) return;

		if (newStatus === 'idle' && prevStatus && prevStatus !== 'idle') {
			onTerminal({ sessionId, kind: 'completed' });
		} else if (newStatus === 'waiting_for_input') {
			onTerminal({ sessionId, kind: 'waiting_for_input' });
		} else if (newStatus === 'interrupted') {
			onTerminal({ sessionId, kind: 'interrupted' });
		}
	}
}
