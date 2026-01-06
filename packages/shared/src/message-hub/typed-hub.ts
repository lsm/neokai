/**
 * TypedHub - Type-safe wrapper over MessageHub + InProcessTransportBus
 *
 * Provides EventBus-like typed API while using MessageHub for actual messaging.
 * This enables:
 * 1. Type safety (typed events with TypeScript inference)
 * 2. Session-scoped subscriptions
 * 3. Async-everywhere design
 * 4. Cluster distribution readiness (same MessageHub protocol)
 *
 * ARCHITECTURE:
 * - Uses InProcessTransportBus for in-process multi-party communication
 * - Each participant gets a MessageHub connected to shared bus
 * - Messages routed via MessageHub protocol (method names like 'session.created')
 * - Type safety via generics (like EventBus's EventMap)
 *
 * USAGE:
 * ```typescript
 * // Define event types (like EventMap)
 * interface ServerEvents extends Record<string, BaseEventData> {
 *   'session.created': { sessionId: string; session: Session };
 *   'session.updated': { sessionId: string; data: Partial<Session> };
 * }
 *
 * // Create typed hub (server-side singleton)
 * const serverHub = new TypedHub<ServerEvents>({ name: 'server' });
 * await serverHub.initialize();
 *
 * // Publish events (type-safe)
 * await serverHub.publish('session.created', { sessionId: '123', session: {...} });
 *
 * // Subscribe to events (type-safe)
 * serverHub.subscribe('session.created', (data) => {
 *   console.log(data.session); // TypeScript knows the shape
 * });
 *
 * // Session-scoped subscription
 * serverHub.subscribe('session.updated', handler, { sessionId: 'abc123' });
 * ```
 */

import { MessageHub } from './message-hub.ts';
import { InProcessTransportBus, InProcessTransport } from './in-process-transport.ts';
import type { UnsubscribeFn, EventHandler } from './types.ts';

/**
 * Base constraint for event data
 * All events must include sessionId for routing
 */
export interface BaseEventData {
	sessionId: string;
}

/**
 * Options for TypedHub
 */
export interface TypedHubOptions {
	/**
	 * Hub name for debugging
	 * @default 'typed-hub'
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

	/**
	 * Existing bus to join (for multi-hub scenarios)
	 * If not provided, creates a new bus
	 */
	bus?: InProcessTransportBus;
}

/**
 * Subscribe options
 */
export interface TypedSubscribeOptions {
	/**
	 * Filter events to only this session
	 * If not specified, receives all events (global subscription)
	 */
	sessionId?: string;
}

/**
 * TypedHub - Type-safe MessageHub wrapper
 *
 * @template TEventMap - Map of event names to their data types
 */
export class TypedHub<TEventMap extends Record<string, BaseEventData>> {
	private readonly name: string;
	private readonly debug: boolean;

	private bus: InProcessTransportBus;
	private transport: InProcessTransport;
	private hub: MessageHub;
	private ownsBus: boolean;
	private initialized = false;

	// Track local handlers for direct dispatch (like EventBus)
	// event → sessionId → handlers
	// This enables EventBus-like behavior where publisher receives own events
	private localHandlers: Map<string, Map<string, Set<(data: unknown) => void | Promise<void>>>> =
		new Map();

	// Track MessageHub subscriptions for cleanup
	private hubSubscriptions: Map<string, UnsubscribeFn[]> = new Map();

	constructor(options: TypedHubOptions = {}) {
		this.name = options.name || 'typed-hub';
		this.debug = options.debug || false;

		// Use provided bus or create new one
		if (options.bus) {
			this.bus = options.bus;
			this.ownsBus = false;
		} else {
			this.bus = new InProcessTransportBus({
				name: `${this.name}-bus`,
				simulatedLatency: options.simulatedLatency,
			});
			this.ownsBus = true;
		}

		// Create transport for this hub
		this.transport = this.bus.createTransport(this.name);

		// Create MessageHub with transport
		this.hub = new MessageHub({
			defaultSessionId: 'global',
		});
		this.hub.registerTransport(this.transport);
	}

	/**
	 * Initialize the hub
	 * Must be called before publish/subscribe
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.transport.initialize();
		this.initialized = true;
		this.log('Initialized');
	}

	/**
	 * Publish an event to all subscribers
	 *
	 * @param event - Event name (e.g., 'session.created')
	 * @param data - Event data (must include sessionId)
	 */
	async publish<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): Promise<void> {
		if (!this.initialized) {
			throw new Error('TypedHub not initialized. Call initialize() first.');
		}

		this.log(`Publishing: ${event}`, data);

		// Dispatch to local handlers (EventBus-like behavior)
		// This ensures publisher receives own events, even with single hub
		await this.dispatchLocally(event, data);

		// Also publish via MessageHub for cross-transport delivery
		// Note: Bus excludes sender, so this only reaches other participants
		await this.hub.publish(event, data, { sessionId: data.sessionId });
	}

	/**
	 * Dispatch event to local handlers
	 * Delivers asynchronously via queueMicrotask for consistent async behavior
	 */
	private async dispatchLocally<K extends keyof TEventMap & string>(
		event: K,
		data: TEventMap[K]
	): Promise<void> {
		const eventHandlers = this.localHandlers.get(event);
		if (!eventHandlers || eventHandlers.size === 0) {
			return;
		}

		const eventSessionId = data.sessionId;
		const GLOBAL_KEY = '__global__';

		// Deliver asynchronously
		await new Promise<void>((resolve) => {
			queueMicrotask(() => {
				// 1. Session-specific handlers (O(1) lookup)
				const sessionHandlers = eventHandlers.get(eventSessionId);
				if (sessionHandlers) {
					for (const handler of sessionHandlers) {
						this.invokeHandler(handler, data, event);
					}
				}

				// 2. Global handlers (O(1) lookup)
				const globalHandlers = eventHandlers.get(GLOBAL_KEY);
				if (globalHandlers) {
					for (const handler of globalHandlers) {
						this.invokeHandler(handler, data, event);
					}
				}

				resolve();
			});
		});
	}

	/**
	 * Invoke handler with error handling
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
	 * Subscribe to an event
	 *
	 * @param event - Event name to subscribe to
	 * @param handler - Handler function
	 * @param options - Subscribe options (sessionId for filtering)
	 * @returns Unsubscribe function
	 */
	subscribe<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
		options?: TypedSubscribeOptions
	): UnsubscribeFn {
		const sessionId = options?.sessionId;
		const subscriptionKey = sessionId || '__global__';

		// Cast handler to unknown type for storage
		const typedHandler = handler as (data: unknown) => void | Promise<void>;

		// Add to local handlers for direct dispatch
		if (!this.localHandlers.has(event)) {
			this.localHandlers.set(event, new Map());
		}
		const eventHandlers = this.localHandlers.get(event)!;
		if (!eventHandlers.has(subscriptionKey)) {
			eventHandlers.set(subscriptionKey, new Set());
		}
		eventHandlers.get(subscriptionKey)!.add(typedHandler);

		// Also subscribe via MessageHub for cross-transport events (from other participants)
		// Create wrapper that applies session filtering
		const hubHandler: EventHandler = (data) => {
			const eventData = data as TEventMap[K];
			if (sessionId && eventData.sessionId !== sessionId) {
				return;
			}
			handler(eventData);
		};
		const hubUnsub = this.hub.subscribeOptimistic(event, hubHandler, {
			sessionId: sessionId || 'global',
		});

		// Track MessageHub subscription for cleanup
		if (!this.hubSubscriptions.has(event)) {
			this.hubSubscriptions.set(event, []);
		}
		this.hubSubscriptions.get(event)!.push(hubUnsub);

		this.log(`Subscribed to ${event}${sessionId ? ` (session: ${sessionId})` : ''}`);

		// Return unsubscribe function
		return () => {
			// Remove from local handlers
			const eventHandlers = this.localHandlers.get(event);
			if (eventHandlers) {
				const handlers = eventHandlers.get(subscriptionKey);
				if (handlers) {
					handlers.delete(typedHandler);
					if (handlers.size === 0) {
						eventHandlers.delete(subscriptionKey);
					}
				}
				if (eventHandlers.size === 0) {
					this.localHandlers.delete(event);
				}
			}

			// Unsubscribe from MessageHub
			hubUnsub();

			this.log(`Unsubscribed from ${event}${sessionId ? ` (session: ${sessionId})` : ''}`);
		};
	}

	/**
	 * Subscribe once (auto-unsubscribes after first matching event)
	 */
	once<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
		options?: TypedSubscribeOptions
	): UnsubscribeFn {
		let unsub: UnsubscribeFn | null = null;

		const wrappedHandler = async (data: TEventMap[K]) => {
			if (unsub) {
				unsub();
			}
			await handler(data);
		};

		unsub = this.subscribe(event, wrappedHandler, options);
		return unsub;
	}

	/**
	 * Alias for publish() - EventBus compatibility
	 */
	emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): Promise<void> {
		return this.publish(event, data);
	}

	/**
	 * Alias for subscribe() - EventBus compatibility
	 */
	on<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
		options?: TypedSubscribeOptions
	): UnsubscribeFn {
		return this.subscribe(event, handler, options);
	}

	/**
	 * Get underlying MessageHub (for advanced usage like RPC)
	 */
	getMessageHub(): MessageHub {
		return this.hub;
	}

	/**
	 * Get underlying bus (for creating additional participants)
	 */
	getBus(): InProcessTransportBus {
		return this.bus;
	}

	/**
	 * Create another participant connected to the same bus
	 * Useful for component isolation with shared event space
	 */
	createParticipant(name: string): TypedHub<TEventMap> {
		return new TypedHub<TEventMap>({
			name,
			debug: this.debug,
			bus: this.bus, // Share the same bus
		});
	}

	/**
	 * Close the hub and cleanup resources
	 */
	async close(): Promise<void> {
		// Unsubscribe all MessageHub subscriptions
		for (const unsubs of this.hubSubscriptions.values()) {
			for (const unsub of unsubs) {
				unsub();
			}
		}
		this.hubSubscriptions.clear();

		// Clear local handlers
		this.localHandlers.clear();

		// Close transport
		await this.transport.close();

		// Close bus if we own it
		if (this.ownsBus) {
			await this.bus.close();
		}

		this.initialized = false;
		this.log('Closed');
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
