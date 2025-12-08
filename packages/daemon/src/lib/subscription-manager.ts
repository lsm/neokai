/**
 * Subscription Manager - Application Layer
 *
 * Manages subscription patterns for different client/session types.
 * This is APPLICATION LOGIC - not infrastructure!
 *
 * ARCHITECTURE:
 * - Infrastructure (Router/MessageHub): Routes messages, tracks subscriptions
 * - Application (SubscriptionManager): Defines WHAT to subscribe to and WHEN
 *
 * The Router/MessageHub layers have NO knowledge of "session.created", "sdk.message", etc.
 * SubscriptionManager defines those patterns based on application requirements.
 */

import type { MessageHub } from '@liuboer/shared';

/**
 * Subscription Manager
 *
 * Centralizes all application-level subscription logic.
 * When clients connect, this manager subscribes them to relevant events.
 */
export class SubscriptionManager {
	private debug: boolean;

	constructor(private messageHub: MessageHub) {
		// Only enable debug logs in development mode, not in test mode
		this.debug = process.env.NODE_ENV === 'development';
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log(...args);
		}
	}

	/**
	 * Subscribe client to global events
	 *
	 * Called when client connects to the global session.
	 * These are application-wide events that all clients should receive.
	 */
	async subscribeToGlobalEvents(clientId: string): Promise<void> {
		this.log(`[SubscriptionManager] Subscribing client ${clientId} to global events`);

		// Define global subscription patterns
		// These are APPLICATION-SPECIFIC events defined by our business logic
		const globalEvents = [
			// Session lifecycle events
			'session.created',
			'session.updated',
			'session.deleted',

			// State channel snapshot events (for state synchronization)
			'state.sessions',
			'state.sessions.delta',
			'state.auth',
			'state.config',
			'state.health',
		];

		// Subscribe to each event
		// The MessageHub will send SUBSCRIBE messages to the server
		// which will register them in the Router
		// RELIABLE: Wait for each subscription to be acknowledged
		for (const method of globalEvents) {
			await this.messageHub.subscribe(
				method,
				() => {}, // Empty handler - actual handling done in client-side state channels
				{ sessionId: 'global' }
			);
		}

		this.log(
			`[SubscriptionManager] Client ${clientId} subscribed to ${globalEvents.length} global events`
		);
	}

	/**
	 * Subscribe client to session-specific events
	 *
	 * Called when client opens/joins a specific session.
	 * These events are scoped to a particular agent session.
	 */
	async subscribeToSessionEvents(clientId: string, sessionId: string): Promise<void> {
		this.log(`[SubscriptionManager] Subscribing client ${clientId} to session ${sessionId} events`);

		// Define session subscription patterns
		// These are APPLICATION-SPECIFIC events for agent sessions
		const sessionEvents = [
			// Agent communication events
			'sdk.message', // Messages from Claude SDK
			'context.updated', // Token usage / context info

			// Session status events
			'session.error', // Session errors
			'session.interrupted', // Agent interrupted

			// State channel events for this session
			'state.session', // Unified session state (metadata + agent + commands + context)
			'state.sdkMessages', // SDK-level messages
			'state.sdkMessages.delta', // SDK message deltas
		];

		// Subscribe to each event for this specific session
		// RELIABLE: Wait for each subscription to be acknowledged
		for (const method of sessionEvents) {
			await this.messageHub.subscribe(
				method,
				() => {}, // Empty handler - actual handling in client
				{ sessionId }
			);
		}

		this.log(
			`[SubscriptionManager] Client ${clientId} subscribed to ${sessionEvents.length} events for session ${sessionId}`
		);
	}

	/**
	 * Unsubscribe client from session events
	 *
	 * Called when client leaves/closes a session.
	 * Clean up subscriptions to prevent memory leaks.
	 */
	async unsubscribeFromSession(clientId: string, sessionId: string): Promise<void> {
		this.log(`[SubscriptionManager] Client ${clientId} leaving session ${sessionId}`);

		// Note: Actual unsubscribe is handled by MessageHub.unsubscribe()
		// which sends UNSUBSCRIBE messages and removes from Router.
		// This method is a placeholder for future session cleanup logic.

		// In the future, could track active subscriptions and explicitly unsubscribe:
		// for (const unsubscribe of this.activeSubscriptions.get(sessionId) || []) {
		//   unsubscribe();
		// }
	}

	/**
	 * Get subscription patterns for debugging
	 */
	getGlobalEventPatterns(): string[] {
		return [
			'session.created',
			'session.updated',
			'session.deleted',
			'state.sessions',
			'state.sessions.delta',
			'state.auth',
			'state.config',
			'state.health',
		];
	}

	getSessionEventPatterns(): string[] {
		return [
			'sdk.message',
			'context.updated',
			'session.error',
			'session.interrupted',
			'state.session',
			'state.sdkMessages',
			'state.sdkMessages.delta',
		];
	}
}
