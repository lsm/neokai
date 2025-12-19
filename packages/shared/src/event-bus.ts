/**
 * EventBus - Mediator pattern for breaking circular dependencies
 *
 * Provides a central event coordination point between components
 * without requiring direct dependencies.
 *
 * ARCHITECTURE:
 * - SessionManager emits events (no dependency on StateManager)
 * - StateManager listens to events (read-only dependency on SessionManager)
 * - AuthManager emits events (no dependency on StateManager)
 * - No circular dependencies!
 *
 * Events are typed for safety and IDE autocomplete.
 */

import type { Session, AuthMethod, ContextInfo, MessageContent } from './types.ts';
import type { SDKMessage } from './sdk/sdk.d.ts';
import type { AgentProcessingState, ApiConnectionState } from './state-types.ts';

export type UnsubscribeFn = () => void;

/**
 * Event handler function
 */
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

/**
 * Compaction trigger type
 */
export type CompactionTrigger = 'manual' | 'auto';

/**
 * Event types for type safety
 */
export interface EventMap {
	// Session lifecycle events
	'session:created': { session: Session };
	'session:updated': { sessionId: string; updates: Partial<Session> };
	'session:deleted': { sessionId: string };

	// SDK events
	'sdk:message': { sessionId: string; message: SDKMessage };

	// Auth events
	'auth:changed': { method: AuthMethod; isAuthenticated: boolean };

	// API connection events - internal server-side only
	'api:connection': ApiConnectionState;

	// Settings events
	'settings:updated': { settings: import('./types/settings.ts').GlobalSettings };

	// Agent state events
	'agent-state:changed': { sessionId: string; state: AgentProcessingState };

	// Commands events
	'commands:updated': { sessionId: string; commands: string[] };

	// Context events - real-time context window usage tracking
	'context:updated': { sessionId: string; contextInfo: ContextInfo };

	// Compaction events - emitted when SDK auto-compacts or user triggers /compact
	'context:compacting': { sessionId: string; trigger: CompactionTrigger };
	'context:compacted': {
		sessionId: string;
		trigger: CompactionTrigger;
		preTokens: number;
	};

	// Message events - emitted when user sends a message
	'message:sent': { sessionId: string };

	// Title generation events
	'title:generated': { sessionId: string; title: string };
	'title:generation:failed': { sessionId: string; error: Error; attempts: number };

	// User message processing events (3-layer communication pattern)
	// Emitted by RPC handler after persisting message, processed async by SessionManager
	'user-message:persisted': {
		sessionId: string;
		messageId: string;
		messageContent: string | MessageContent[];
		userMessageText: string;
		needsWorkspaceInit: boolean;
		hasDraftToClear: boolean;
	};
}

/**
 * EventBus class
 *
 * Simple pub/sub for internal application events.
 * NOT to be confused with MessageHub (which is for client-server communication).
 * This is purely server-side component coordination.
 */
export class EventBus {
	private handlers: Map<string, Set<EventHandler>> = new Map();
	private debug: boolean;

	constructor(options: { debug?: boolean } = {}) {
		this.debug = options.debug || false;
	}

	/**
	 * Emit an event to all registered handlers
	 */
	async emit<K extends keyof EventMap>(event: K, data: EventMap[K]): Promise<void> {
		this.log(`Emitting event: ${String(event)}`, data);

		const eventHandlers = this.handlers.get(String(event));
		if (!eventHandlers || eventHandlers.size === 0) {
			this.log(`No handlers for event: ${String(event)}`);
			return;
		}

		// Execute all handlers (parallel execution)
		const promises: Promise<void>[] = [];
		for (const handler of eventHandlers) {
			try {
				const result = handler(data);
				if (result instanceof Promise) {
					promises.push(result);
				}
			} catch (error) {
				console.error(`[EventBus] Error in handler for ${String(event)}:`, error);
			}
		}

		// Wait for all async handlers to complete
		if (promises.length > 0) {
			await Promise.all(
				promises.map((p) =>
					p.catch((error) => {
						console.error(`[EventBus] Async handler error for ${String(event)}:`, error);
					})
				)
			);
		}
	}

	/**
	 * Register an event handler
	 */
	on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): UnsubscribeFn {
		const eventKey = String(event);

		if (!this.handlers.has(eventKey)) {
			this.handlers.set(eventKey, new Set());
		}

		this.handlers.get(eventKey)!.add(handler as EventHandler);
		this.log(`Registered handler for: ${eventKey}`);

		// Return unsubscribe function
		return () => {
			const handlers = this.handlers.get(eventKey);
			if (handlers) {
				handlers.delete(handler as EventHandler);

				// Cleanup empty sets to prevent memory leaks
				if (handlers.size === 0) {
					this.handlers.delete(eventKey);
				}
			}
			this.log(`Unregistered handler for: ${eventKey}`);
		};
	}

	/**
	 * Register a one-time event handler (auto-unsubscribes after first call)
	 */
	once<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): UnsubscribeFn {
		let unsubscribe: UnsubscribeFn | null = null;

		const wrappedHandler = async (data: EventMap[K]) => {
			if (unsubscribe) {
				unsubscribe();
			}
			await handler(data);
		};

		unsubscribe = this.on(event, wrappedHandler);
		return unsubscribe;
	}

	/**
	 * Remove all handlers for an event
	 */
	off(event: keyof EventMap): void {
		this.handlers.delete(String(event));
		this.log(`Removed all handlers for: ${String(event)}`);
	}

	/**
	 * Get handler count for an event (for debugging)
	 */
	getHandlerCount(event: keyof EventMap): number {
		return this.handlers.get(String(event))?.size || 0;
	}

	/**
	 * Clear all handlers (for cleanup)
	 */
	clear(): void {
		this.handlers.clear();
		this.log('Cleared all handlers');
	}

	/**
	 * Debug logging
	 */
	private log(message: string, ...args: unknown[]): void {
		if (this.debug) {
			console.log(`[EventBus] ${message}`, ...args);
		}
	}
}
