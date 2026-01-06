/**
 * InProcessHub - Typed async pub/sub for in-process communication
 *
 * Provides EventBus-like API with async-everywhere design for:
 * 1. Type safety (typed events)
 * 2. Session-scoped subscriptions (O(1) lookup)
 * 3. Async delivery (enables future cluster distribution)
 *
 * DIFFERENCE FROM EVENTBUS:
 * - All emit() calls are async (EventBus.emit() awaits handlers)
 * - Delivery is via queueMicrotask (consistent async semantics)
 * - Can be extended with MessageHub transport for cross-process communication
 *
 * USAGE:
 * ```typescript
 * // Define event map
 * interface MyEventMap extends Record<string, BaseEventData> {
 *   'session:created': { sessionId: string; title: string };
 *   'message:sent': { sessionId: string; content: string };
 * }
 *
 * // Create hub
 * const hub = new InProcessHub<MyEventMap>();
 * await hub.initialize();
 *
 * // Subscribe (EventBus-like API)
 * hub.on('session:created', (data) => {
 *   console.log(data.sessionId);
 * });
 *
 * // Session-scoped subscription
 * hub.on('message:sent', handler, { sessionId: 'abc123' });
 *
 * // Emit (async)
 * await hub.emit('session:created', { sessionId: '123', title: 'New Session' });
 * ```
 */

import type { UnsubscribeFn } from './types.ts';

/**
 * Base constraint for event maps
 * All events must include sessionId for routing
 */
export interface BaseEventData {
	sessionId: string;
}

/**
 * Options for InProcessHub
 */
export interface InProcessHubOptions {
	/**
	 * Hub name for debugging
	 * @default 'in-process-hub'
	 */
	name?: string;

	/**
	 * Enable debug logging
	 * @default false
	 */
	debug?: boolean;

	/**
	 * Simulated latency in ms (for testing)
	 * @default 0
	 */
	simulatedLatency?: number;
}

/**
 * Subscription options for InProcessHub
 */
export interface HubSubscribeOptions {
	/**
	 * Filter events to only this session
	 * If not specified, receives all events
	 */
	sessionId?: string;
}

/**
 * Special sessionId for global (non-session-specific) handlers
 */
const GLOBAL_SESSION_ID = '__global__';

/**
 * InProcessHub - Typed async pub/sub
 *
 * @template TEventMap - Map of event names to their data types
 *
 * All event data must include `sessionId` field for routing.
 */
export class InProcessHub<TEventMap extends Record<string, BaseEventData>> {
	private readonly name: string;
	private readonly debug: boolean;
	private readonly simulatedLatency: number;
	private initialized = false;

	// Track handlers for session-filtered subscriptions
	// event → sessionId → handlers
	private sessionHandlers: Map<string, Map<string, Set<(data: unknown) => void | Promise<void>>>> = new Map();

	constructor(options: InProcessHubOptions = {}) {
		this.name = options.name || 'in-process-hub';
		this.debug = options.debug || false;
		this.simulatedLatency = options.simulatedLatency || 0;
	}

	/**
	 * Initialize the hub
	 * Must be called before emit/on
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		this.initialized = true;
		this.log('Initialized');
	}

	/**
	 * Emit an event to all subscribers
	 *
	 * @param event - Event name
	 * @param data - Event data (must include sessionId)
	 */
	async emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): Promise<void> {
		if (!this.initialized) {
			throw new Error('InProcessHub not initialized. Call initialize() first.');
		}

		this.log(`Emitting: ${event}`, data);

		// Deliver asynchronously to maintain consistent async behavior
		await this.deliverAsync(() => {
			this.dispatchToHandlers(event, data);
		});
	}

	/**
	 * Subscribe to an event
	 *
	 * @param event - Event name to subscribe to
	 * @param handler - Handler function
	 * @param options - Subscription options (sessionId for filtering)
	 * @returns Unsubscribe function
	 */
	on<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
		options?: HubSubscribeOptions
	): UnsubscribeFn {
		const sessionId = options?.sessionId || GLOBAL_SESSION_ID;

		// Initialize nested maps if needed
		if (!this.sessionHandlers.has(event)) {
			this.sessionHandlers.set(event, new Map());
		}

		const sessionMap = this.sessionHandlers.get(event)!;
		if (!sessionMap.has(sessionId)) {
			sessionMap.set(sessionId, new Set());
		}

		// Add handler
		const wrappedHandler = handler as (data: unknown) => void | Promise<void>;
		sessionMap.get(sessionId)!.add(wrappedHandler);

		this.log(`Subscribed to ${event}${sessionId !== GLOBAL_SESSION_ID ? ` (session: ${sessionId})` : ''}`);

		// Return unsubscribe function
		return () => {
			const sessionMap = this.sessionHandlers.get(event);
			if (sessionMap) {
				const handlers = sessionMap.get(sessionId);
				if (handlers) {
					handlers.delete(wrappedHandler);

					// Cleanup empty sets
					if (handlers.size === 0) {
						sessionMap.delete(sessionId);
					}
				}

				// Cleanup empty maps
				if (sessionMap.size === 0) {
					this.sessionHandlers.delete(event);
				}
			}

			this.log(`Unsubscribed from ${event}${sessionId !== GLOBAL_SESSION_ID ? ` (session: ${sessionId})` : ''}`);
		};
	}

	/**
	 * Subscribe to an event once (auto-unsubscribes after first call)
	 */
	once<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
		options?: HubSubscribeOptions
	): UnsubscribeFn {
		let unsubscribe: UnsubscribeFn | null = null;

		const wrappedHandler = async (data: TEventMap[K]) => {
			if (unsubscribe) {
				unsubscribe();
			}
			await handler(data);
		};

		unsubscribe = this.on(event, wrappedHandler, options);
		return unsubscribe;
	}

	/**
	 * Remove all handlers for an event
	 */
	off<K extends keyof TEventMap & string>(event: K): void {
		this.sessionHandlers.delete(event);
		this.log(`Removed all handlers for: ${event}`);
	}

	/**
	 * Get handler count for an event
	 */
	getHandlerCount<K extends keyof TEventMap & string>(event: K): number {
		const sessionMap = this.sessionHandlers.get(event);
		if (!sessionMap) return 0;

		let total = 0;
		for (const handlers of sessionMap.values()) {
			total += handlers.size;
		}
		return total;
	}

	/**
	 * Close the hub and cleanup resources
	 */
	async close(): Promise<void> {
		this.sessionHandlers.clear();
		this.initialized = false;
		this.log('Closed');
	}

	/**
	 * Create a connected participant hub
	 * Returns a new view into the same hub with its own name
	 *
	 * Use this when you need separate components that share
	 * the same event space but want named logging.
	 */
	createParticipant(name: string): ParticipantHub<TEventMap> {
		return new ParticipantHub(this, name, this.debug);
	}

	/**
	 * Dispatch event to local handlers
	 */
	private dispatchToHandlers<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): void {
		const sessionMap = this.sessionHandlers.get(event);
		if (!sessionMap || sessionMap.size === 0) {
			return;
		}

		const eventSessionId = data.sessionId;

		// 1. Session-specific handlers (O(1) lookup)
		const sessionHandlers = sessionMap.get(eventSessionId);
		if (sessionHandlers) {
			for (const handler of sessionHandlers) {
				this.invokeHandler(handler, data, event);
			}
		}

		// 2. Global handlers (O(1) lookup)
		const globalHandlers = sessionMap.get(GLOBAL_SESSION_ID);
		if (globalHandlers) {
			for (const handler of globalHandlers) {
				this.invokeHandler(handler, data, event);
			}
		}
	}

	/**
	 * Invoke a handler with error handling
	 */
	private invokeHandler(
		handler: (data: unknown) => void | Promise<void>,
		data: unknown,
		event: string
	): void {
		try {
			const result = handler(data);
			if (result instanceof Promise) {
				result.catch((error) => {
					console.error(`[${this.name}] Async handler error for ${event}:`, error);
				});
			}
		} catch (error) {
			console.error(`[${this.name}] Handler error for ${event}:`, error);
		}
	}

	/**
	 * Deliver asynchronously
	 * Uses queueMicrotask for minimal latency while maintaining async semantics
	 */
	private async deliverAsync(fn: () => void): Promise<void> {
		if (this.simulatedLatency > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.simulatedLatency));
			fn();
		} else {
			// Use microtask for minimal latency but still async
			await new Promise<void>((resolve) => {
				queueMicrotask(() => {
					fn();
					resolve();
				});
			});
		}
	}

	/**
	 * Debug logging
	 */
	private log(message: string, ...args: unknown[]): void {
		if (this.debug) {
			console.log(`[${this.name}] ${message}`, ...args);
		}
	}
}

/**
 * ParticipantHub - A named view into an InProcessHub
 *
 * Shares the same event space but has its own name for logging.
 * Useful for component identification in logs.
 */
export class ParticipantHub<TEventMap extends Record<string, BaseEventData>> {
	private parent: InProcessHub<TEventMap>;
	private readonly name: string;
	private readonly debug: boolean;

	constructor(parent: InProcessHub<TEventMap>, name: string, debug: boolean = false) {
		this.parent = parent;
		this.name = name;
		this.debug = debug;
	}

	/**
	 * Emit an event (delegates to parent)
	 */
	async emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): Promise<void> {
		this.log(`Emitting: ${event}`);
		return this.parent.emit(event, data);
	}

	/**
	 * Subscribe to an event (delegates to parent)
	 */
	on<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
		options?: HubSubscribeOptions
	): UnsubscribeFn {
		this.log(`Subscribing to: ${event}`);
		return this.parent.on(event, handler, options);
	}

	/**
	 * Subscribe once (delegates to parent)
	 */
	once<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
		options?: HubSubscribeOptions
	): UnsubscribeFn {
		return this.parent.once(event, handler, options);
	}

	/**
	 * Debug logging
	 */
	private log(message: string, ...args: unknown[]): void {
		if (this.debug) {
			console.log(`[${this.name}] ${message}`, ...args);
		}
	}
}
