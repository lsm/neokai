/**
 * Helper utilities for online daemon tests
 *
 * These helpers provide convenient patterns for:
 * - Sending messages via RPC
 * - Waiting for state changes via subscriptions
 * - Observing agent behavior through events
 */

import type { DaemonServerContext } from './daemon-server';

/**
 * Send a message via RPC and return the messageId
 */
export async function sendMessage(
	daemon: DaemonServerContext,
	sessionId: string,
	content: string,
	options: {
		images?: Array<{ type: string; source: { type: string; data: string } }>;
	} = {}
): Promise<{ messageId: string }> {
	const result = (await daemon.messageHub.request('message.send', {
		sessionId,
		content,
		...options,
	})) as { messageId: string };
	return result;
}

/**
 * Wait for the agent to reach a specific processing state
 *
 * Uses state.session subscription to monitor agent state changes.
 * Also checks the current state first to handle the case where
 * processing completes before the subscription is set up.
 *
 * NOTE: The state structure uses 'agentState' (not 'processingState').
 * See SessionState interface in @neokai/shared/src/state-types.ts
 */

async function waitForProcessingState(
	daemon: DaemonServerContext,
	sessionId: string,
	targetStatus: string,
	timeout = 30000
): Promise<void> {
	// First check if we're already in the target state
	// This handles the race condition where processing completes before subscription
	const currentState = await getProcessingState(daemon, sessionId);
	if (currentState.status === targetStatus) {
		return;
	}

	return new Promise((resolve, reject) => {
		let unsubscribe: (() => void) | undefined;
		let resolved = false;
		let poller: ReturnType<typeof setInterval> | undefined;

		const cleanup = () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				if (poller) clearInterval(poller);
				unsubscribe?.();
			}
		};

		// Set up timeout
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(`Timeout waiting for processing state "${targetStatus}" after ${timeout}ms`)
			);
		}, timeout);

		// Subscribe to events FIRST to ensure no events are missed once room is joined
		unsubscribe = daemon.messageHub.onEvent('state.session', (data: unknown) => {
			if (resolved) return;
			const state = data as { agentState?: { status: string } };
			const currentStatus = state.agentState?.status;

			if (currentStatus === targetStatus) {
				cleanup();
				resolve();
			}
		});

		// Polling fallback: re-check state periodically in case events are missed.
		// This closes any remaining race windows regardless of event delivery.
		poller = setInterval(async () => {
			if (resolved) return;
			try {
				const state = await getProcessingState(daemon, sessionId);
				if (state.status === targetStatus) {
					cleanup();
					resolve();
				}
			} catch {
				// Ignore polling errors
			}
		}, 2000);

		// Join room, then re-check state to close the primary race window.
		// The re-check AFTER joinRoom ensures: if state changed before join completed,
		// we catch it. If it changes after, the event handler catches it.
		(async () => {
			try {
				await daemon.messageHub.joinRoom('session:' + sessionId);
			} catch {
				// Join failed, polling fallback will still work
			}
			// Re-check after room join completes
			if (!resolved) {
				try {
					const state = await getProcessingState(daemon, sessionId);
					if (state.status === targetStatus) {
						cleanup();
						resolve();
					}
				} catch {
					// Ignore errors, polling will retry
				}
			}
		})();
	});
}

/**
 * Wait for the agent to reach idle state
 */
export async function waitForIdle(
	daemon: DaemonServerContext,
	sessionId: string,
	timeout = 60000
): Promise<void> {
	return waitForProcessingState(daemon, sessionId, 'idle', timeout);
}

/**
 * Collect SDK messages from the session via subscription
 *
 * Returns an async generator that yields SDK messages as they arrive.
 */

/**
 * Get current processing state via RPC
 */
export async function getProcessingState(
	daemon: DaemonServerContext,
	sessionId: string
): Promise<{ status: string; phase?: string }> {
	const result = (await daemon.messageHub.request('agent.getState', {
		sessionId,
	})) as { state: { status: string; phase?: string } } | undefined;

	if (!result?.state) {
		// Return a default state if RPC fails or returns unexpected data
		return { status: 'unknown' };
	}

	return result.state;
}

/**
 * Get session data via RPC
 */
export async function getSession(
	daemon: DaemonServerContext,
	sessionId: string
): Promise<Record<string, unknown>> {
	const result = (await daemon.messageHub.request('session.get', {
		sessionId,
	})) as { session: Record<string, unknown> } | undefined;

	if (!result?.session) {
		throw new Error(`Session not found: ${sessionId}`);
	}

	return result.session;
}

/**
 * List all sessions via RPC
 */

/**
 * Delete a session via RPC
 */

/**
 * Interrupt the current processing via RPC
 */
export async function interrupt(daemon: DaemonServerContext, sessionId: string): Promise<void> {
	await daemon.messageHub.request('client.interrupt', { sessionId });
}
