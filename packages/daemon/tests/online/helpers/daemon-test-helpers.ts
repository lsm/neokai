/**
 * Helper utilities for online daemon tests
 *
 * These helpers provide convenient patterns for:
 * - Sending messages via RPC
 * - Waiting for state changes via subscriptions
 * - Observing agent behavior through events
 */

import type { DaemonServerContext } from './daemon-server-helper';

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
	const result = (await daemon.messageHub.call('message.send', {
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
 * See SessionState interface in @liuboer/shared/src/state-types.ts
 */
export async function waitForProcessingState(
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

		const cleanup = () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
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

		// Subscribe to state changes - returns unsubscribe function
		daemon.messageHub
			.subscribe(
				'state.session',
				(data: unknown) => {
					if (resolved) return;
					const state = data as { agentState?: { status: string } };
					const currentStatus = state.agentState?.status;

					if (currentStatus === targetStatus) {
						cleanup();
						resolve();
					}
				},
				{ sessionId }
			)
			.then(async (fn) => {
				unsubscribe = fn;
				// Double-check state after subscription is set up
				// in case the state changed between our initial check and subscription
				if (!resolved) {
					const state = await getProcessingState(daemon, sessionId);
					if (state.status === targetStatus) {
						cleanup();
						resolve();
					}
				}
			});
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
export async function* collectSDKMessages(
	daemon: DaemonServerContext,
	sessionId: string,
	timeout = 30000
): AsyncGenerator<unknown, void, unknown> {
	const messages: unknown[] = [];
	let resolved = false;
	let unsubscribe: (() => void) | null = null;

	const timer = setTimeout(() => {
		if (!resolved && unsubscribe) {
			resolved = true;
			unsubscribe();
		}
	}, timeout);

	unsubscribe = await daemon.messageHub.subscribe(
		'state.sdkMessages.delta',
		(data: unknown) => {
			if (resolved) return;
			messages.push(data);
		},
		{ sessionId }
	);

	try {
		while (!resolved) {
			// Check if we have messages to yield
			while (messages.length > 0) {
				yield messages.shift();
			}
			// Small delay to prevent busy-waiting
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	} finally {
		clearTimeout(timer);
		if (unsubscribe) {
			unsubscribe();
		}
	}
}

/**
 * Get current processing state via RPC
 */
export async function getProcessingState(
	daemon: DaemonServerContext,
	sessionId: string
): Promise<{ status: string; phase?: string }> {
	const result = (await daemon.messageHub.call('agent.getState', {
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
	const result = (await daemon.messageHub.call('session.get', {
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
export async function listSessions(
	daemon: DaemonServerContext
): Promise<Array<Record<string, unknown>>> {
	const result = (await daemon.messageHub.call('session.list', {})) as
		| {
				sessions: Array<Record<string, unknown>>;
		  }
		| undefined;

	if (!result?.sessions) {
		return [];
	}

	return result.sessions;
}

/**
 * Delete a session via RPC
 */
export async function deleteSession(daemon: DaemonServerContext, sessionId: string): Promise<void> {
	await daemon.messageHub.call('session.delete', { sessionId });
}

/**
 * Interrupt the current processing via RPC
 */
export async function interrupt(daemon: DaemonServerContext, sessionId: string): Promise<void> {
	await daemon.messageHub.call('client.interrupt', { sessionId });
}
