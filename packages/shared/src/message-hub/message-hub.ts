/**
 * MessageHub - Unified messaging hub for bidirectional RPC and Pub/Sub
 *
 * Provides:
 * - Bidirectional RPC (client↔server)
 * - Pub/Sub messaging
 * - Session-based routing
 * - Type-safe method registry
 */

import { generateUUID } from '../utils.ts';
import {
	type HubMessage,
	MessageType,
	GLOBAL_SESSION_ID,
	ErrorCode,
	createCallMessage,
	createResultMessage,
	createErrorMessage,
	createEventMessage,
	createSubscribeMessage,
	createUnsubscribeMessage,
	createSubscribedMessage,
	createUnsubscribedMessage,
	isCallMessage,
	isResponseMessage,
	isEventMessage,
	isSubscribeMessage,
	isUnsubscribeMessage,
	isSubscribedMessage,
	isUnsubscribedMessage,
	validateMethod,
	isValidMessage,
} from './protocol.ts';
import type {
	MessageHubOptions,
	CallOptions,
	PublishOptions,
	SubscribeOptions,
	RPCHandler,
	EventHandler,
	MessageHandler,
	ConnectionStateHandler,
	UnsubscribeFn,
	PendingCall,
	PendingSubscription,
	PersistedSubscription,
	// MethodHandlers,
	SessionSubscriptions,
	IMessageTransport,
	CallContext,
	EventContext,
	ConnectionState,
	// BroadcastResult,
	// TimeoutId,
} from './types.ts';
import type { MessageHubRouter } from './router.ts';
import { LRUCache, createCacheKey } from './cache.ts';

/**
 * MessageHub class
 * Core implementation of unified messaging system
 *
 * ARCHITECTURE:
 * - MessageHub: Protocol layer (RPC + Pub/Sub logic)
 * - MessageHubRouter: Server-side routing layer (determines recipients)
 * - IMessageTransport: I/O layer (sends/receives over wire)
 *
 * Flow: MessageHub → Router (if server-side) → Transport → Wire
 */
export class MessageHub {
	private transport: IMessageTransport | null = null;
	private router: MessageHubRouter | null = null; // Server-side only
	private readonly defaultSessionId: string;
	private readonly defaultTimeout: number;
	private readonly debug: boolean;

	// Backpressure limits
	private readonly maxPendingCalls: number;
	private readonly maxCacheSize: number;
	private readonly cacheTTL: number;
	private readonly maxEventDepth: number;

	// RPC state
	private pendingCalls: Map<string, PendingCall<unknown>> = new Map();
	private rpcHandlers: Map<string, RPCHandler> = new Map();

	// Request deduplication cache with LRU eviction and TTL
	private requestCache: LRUCache<string, Promise<unknown>>;

	// Subscription ACK tracking (for reliable subscribe/unsubscribe)
	private pendingSubscribes: Map<string, PendingSubscription> = new Map();

	// Pub/Sub state
	private subscriptions: SessionSubscriptions = new Map();

	// Subscription persistence for auto-resubscription
	private persistedSubscriptions: Map<string, PersistedSubscription> = new Map();

	// Event handler recursion tracking (prevents infinite loops)
	private eventDepthMap = new Map<string, number>(); // messageId -> depth

	// Message sequencing for ordering guarantees
	private messageSequence = 0;

	// FIX P0.7: Queue events during resubscription to prevent event loss
	private resubscribing: boolean = false;
	private pendingEvents: HubMessage[] = [];

	// FIX P1.3: Message sequence tracking
	// Client-side: tracks server's global sequence (all messages from server use one counter)
	// Server-side: tracks per-client sequences (each client has its own counter)
	private expectedSequence: number | null = null; // For client-side global tracking
	private expectedSequencePerClient = new Map<string, number>(); // For server-side per-client tracking
	private readonly warnOnSequenceGap: boolean;

	// FIX: Track in-flight subscription requests to prevent duplicates
	// Key format: "{sessionId}:{method}"
	private inFlightSubscriptions = new Set<string>();

	// FIX: Debounce resubscription to prevent duplicate calls within short window
	// This prevents the subscription storm caused by multiple sources triggering resubscription
	private lastResubscribeTime = 0;
	private readonly resubscribeDebounceMs = 1000; // 1 second debounce window

	// FIX P1.4: Event handler error handling mode
	private readonly stopOnEventHandlerError: boolean;

	// Message inspection
	private messageHandlers: Set<MessageHandler> = new Set();

	// Connection state
	private connectionStateHandlers: Set<ConnectionStateHandler> = new Set();

	constructor(options: MessageHubOptions = {}) {
		this.defaultSessionId = options.defaultSessionId || GLOBAL_SESSION_ID;
		this.defaultTimeout = options.timeout || 10000;
		this.debug = options.debug || false;
		this.maxPendingCalls = options.maxPendingCalls || 1000;
		this.maxCacheSize = options.maxCacheSize || 500;
		this.cacheTTL = options.cacheTTL || 60000;
		this.maxEventDepth = options.maxEventDepth || 10;
		this.warnOnSequenceGap = options.warnOnSequenceGap ?? true; // FIX P1.3: Enable sequence gap warnings by default
		this.stopOnEventHandlerError = options.stopOnEventHandlerError ?? false; // FIX P1.4: Continue on handler errors by default

		// Initialize LRU cache
		this.requestCache = new LRUCache(this.maxCacheSize, this.cacheTTL);
	}

	// ========================================
	// Transport Management
	// ========================================

	/**
	 * Register a transport
	 */
	registerTransport(transport: IMessageTransport): UnsubscribeFn {
		if (this.transport) {
			throw new Error('Transport already registered. Call unregisterTransport() first.');
		}

		this.transport = transport;
		this.log(`Transport registered: ${transport.name}`);

		// Subscribe to incoming messages
		const unsubMessage = transport.onMessage((message) => {
			this.handleIncomingMessage(message);
		});

		// Subscribe to connection state changes
		const unsubConnection = transport.onConnectionChange((state, error) => {
			this.log(`Connection state: ${state}`, error);

			// CRITICAL FIX: Resubscribe BEFORE notifying handlers
			// This ensures subscriptions are re-established on the server BEFORE
			// StateChannel handlers run and fetch snapshots. Otherwise, there's
			// a race window where events published between snapshot fetch and
			// subscription re-establishment are lost.
			if (state === 'connected') {
				this.resubscribeAll();
			}

			// Now notify handlers (e.g., StateChannel.hybridRefresh)
			this.notifyConnectionStateHandlers(state, error);
		});

		// Subscribe to client disconnect events (server-side only, for per-client cleanup)
		let unsubClientDisconnect: (() => void) | undefined;
		if (transport.onClientDisconnect) {
			unsubClientDisconnect = transport.onClientDisconnect((clientId) => {
				this.cleanupClientSequence(clientId);
			});
		}

		// Return unregister function
		return () => {
			this.transport = null;
			unsubMessage();
			unsubConnection();
			unsubClientDisconnect?.();
			this.log(`Transport unregistered: ${transport.name}`);
		};
	}

	/**
	 * Get current connection state
	 */
	getState(): ConnectionState {
		return this.transport?.getState() || 'disconnected';
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.transport?.isReady() || false;
	}

	/**
	 * Subscribe to connection state changes
	 */
	onConnection(handler: ConnectionStateHandler): UnsubscribeFn {
		this.connectionStateHandlers.add(handler);
		return () => {
			this.connectionStateHandlers.delete(handler);
		};
	}

	// ========================================
	// Router Management (Server-side)
	// ========================================

	/**
	 * Register a router for server-side message routing
	 * Optional - only needed for server-side deployments
	 *
	 * When registered, MessageHub uses the router to determine which clients
	 * should receive EVENT messages based on their subscriptions.
	 */
	registerRouter(router: MessageHubRouter): void {
		if (this.router) {
			console.warn('[MessageHub] Router already registered, replacing...');
		}
		this.router = router;
		this.log(`Router registered`);
	}

	/**
	 * Get the registered router (if any)
	 */
	getRouter(): MessageHubRouter | null {
		return this.router;
	}

	// ========================================
	// RPC Pattern (Bidirectional)
	// ========================================

	/**
	 * Make an RPC call and wait for response
	 *
	 * FIXES:
	 * - ✅ P0.1: LRU cache with TTL prevents unbounded memory growth
	 * - ✅ P0.5: Backpressure - rejects when too many pending calls
	 * - ✅ P1.3: Optimized cache key generation with hashing
	 *
	 * @example
	 * // Client calls server
	 * const { sessionId } = await hub.call('session.create', { workspacePath: '/path' });
	 *
	 * // Server calls client  (session-scoped)
	 * const viewport = await hub.call('client.getViewportInfo', {}, { sessionId: 'abc-123' });
	 */
	async call<TResult = unknown>(
		method: string,
		data?: unknown,
		options: CallOptions = {}
	): Promise<TResult> {
		if (!this.isConnected()) {
			throw new Error('Not connected to transport');
		}

		const sessionId = options.sessionId || this.defaultSessionId;

		// FIX P2: Remove unnecessary buildFullMethod() call - just use method directly
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}

		// FIX P0.5: Backpressure - reject if too many pending calls
		if (this.pendingCalls.size >= this.maxPendingCalls) {
			throw new Error(
				`Too many pending calls (${this.pendingCalls.size}/${this.maxPendingCalls}). ` +
					`Server may be overloaded or unresponsive.`
			);
		}

		// FIX P1.3: Optimized cache key using hashing for large objects
		const cacheKey = createCacheKey(method, sessionId, data);
		const cached = this.requestCache.get(cacheKey);
		if (cached) {
			this.log(`Returning cached request for: ${method}`);
			return cached as Promise<TResult>;
		}

		const messageId = generateUUID();
		const timeout = options.timeout || this.defaultTimeout;

		const requestPromise = new Promise<TResult>((resolve, reject) => {
			// Setup timeout
			const timer = setTimeout(() => {
				this.pendingCalls.delete(messageId);
				this.requestCache.delete(cacheKey);
				reject(new Error(`RPC timeout: ${method} (${timeout}ms)`));
			}, timeout);

			// Store pending call
			this.pendingCalls.set(messageId, {
				resolve: (result) => {
					this.requestCache.delete(cacheKey);
					resolve(result as TResult);
				},
				reject: (error) => {
					this.requestCache.delete(cacheKey);
					reject(error);
				},
				timer,
				method,
				sessionId,
			});

			// Create and send CALL message
			const message = createCallMessage({
				method,
				data,
				sessionId,
				id: messageId,
			});

			this.sendMessage(message).catch((error) => {
				clearTimeout(timer);
				this.pendingCalls.delete(messageId);
				this.requestCache.delete(cacheKey);
				reject(error);
			});
		});

		// FIX P0.1: Cache with LRU eviction and TTL
		this.requestCache.set(cacheKey, requestPromise);

		return requestPromise;
	}

	/**
	 * Register a handler for incoming RPC calls
	 *
	 * @example
	 * // Server handles client calls
	 * hub.handle('session.create', async (data) => {
	 *   const sessionId = await sessionManager.create(data);
	 *   return { sessionId };
	 * });
	 *
	 * // Client handles server calls
	 * hub.handle('client.getViewportInfo', async () => {
	 *   return { width: window.innerWidth, height: window.innerHeight };
	 * });
	 */
	handle<TData = unknown, TResult = unknown>(
		method: string,
		handler: RPCHandler<TData, TResult>
	): UnsubscribeFn {
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}

		if (this.rpcHandlers.has(method)) {
			console.warn(`[MessageHub] Overwriting existing handler for: ${method}`);
		}

		this.rpcHandlers.set(method, handler as RPCHandler);
		this.log(`RPC handler registered: ${method}`);

		// Return unregister function
		return () => {
			this.rpcHandlers.delete(method);
			this.log(`RPC handler unregistered: ${method}`);
		};
	}

	// ========================================
	// Pub/Sub Pattern
	// ========================================

	/**
	 * Publish an event to all subscribers
	 *
	 * @example
	 * // Global event
	 * hub.publish('session.created', { sessionId: 'abc-123' }, { sessionId: 'global' });
	 *
	 * // Session-scoped event
	 * hub.publish('sdk.message', sdkMessage, { sessionId: 'abc-123' });
	 */
	async publish(method: string, data?: unknown, options: PublishOptions = {}): Promise<void> {
		// Allow publishing without transport (for server-side testing)
		// In this case, we just skip sending - the event won't propagate
		if (!this.isConnected()) {
			this.log(`Publish skipped (no transport): ${method}`);
			return;
		}

		const messageId = generateUUID();
		const sessionId = options.sessionId || this.defaultSessionId;

		// FIX P2: Remove unnecessary buildFullMethod() call
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}

		// Create EVENT message directly - no need for PUBLISH message type
		const message = createEventMessage({
			method,
			data,
			sessionId,
			id: messageId,
		});

		// Send to transport for broadcasting
		await this.sendMessage(message);
	}

	/**
	 * Subscribe to events (RELIABLE - waits for server ACK)
	 *
	 * EXPLICIT SUBSCRIPTION PROTOCOL:
	 * - Stores subscription locally (for event routing)
	 * - Sends SUBSCRIBE message to server
	 * - Waits for ACK to confirm subscription
	 * - Server tracks subscription in Router
	 * - Auto-resubscribes on reconnection
	 *
	 * @example
	 * // Global event
	 * const unsubscribe = await hub.subscribe('session.deleted', (data) => {
	 *   console.log('Session deleted:', data.sessionId);
	 * }, { sessionId: 'global' });
	 *
	 * // Session-scoped event
	 * const unsubscribe = await hub.subscribe('sdk.message', (data) => {
	 *   console.log('SDK message:', data);
	 * }, { sessionId: 'abc-123' });
	 */
	async subscribe<TData = unknown>(
		method: string,
		handler: EventHandler<TData>,
		options: SubscribeOptions = {}
	): Promise<UnsubscribeFn> {
		const sessionId = options.sessionId || this.defaultSessionId;

		// FIX P2: Remove unnecessary buildFullMethod() call
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}

		// Generate unique subscription ID
		const subId = generateUUID();

		// Initialize subscription maps if needed (do this early for local events)
		if (!this.subscriptions.has(sessionId)) {
			this.subscriptions.set(sessionId, new Map());
		}

		const sessionSubs = this.subscriptions.get(sessionId)!;

		if (!sessionSubs.has(method)) {
			sessionSubs.set(method, new Set());
		}

		sessionSubs.get(method)!.add(handler as EventHandler);

		// Send SUBSCRIBE message to server and wait for ACK
		if (this.isConnected()) {
			const timeout = options.timeout || this.defaultTimeout;

			// Create promise that waits for ACK
			const ackPromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pendingSubscribes.delete(subId);
					reject(new Error(`Subscription timeout: ${method} (${timeout}ms)`));
				}, timeout);

				// Track pending subscription
				this.pendingSubscribes.set(subId, {
					resolve,
					reject,
					timer,
					method,
					type: 'subscribe',
				});
			});

			// Send SUBSCRIBE message
			const subscribeMsg = createSubscribeMessage({
				method,
				sessionId,
				id: subId,
			});

			try {
				await this.sendMessage(subscribeMsg);
				// Wait for ACK from server
				await ackPromise;
				this.log(`Subscribed to: ${method} (session: ${sessionId}) - ACK received`);
			} catch (error) {
				// Cleanup on failure
				sessionSubs.get(method)?.delete(handler as EventHandler);
				throw error;
			}
		} else {
			// Not connected - local-only subscription
			this.log(`Subscribed to: ${method} (session: ${sessionId}) - local only (not connected)`);
		}

		// FIX P0.2: Track creation time for subscription lifecycle management
		this.persistedSubscriptions.set(subId, {
			method,
			handler: handler as EventHandler,
			options: { sessionId },
			createdAt: Date.now(),
		});

		// Return async unsubscribe function
		return async () => {
			// Send UNSUBSCRIBE message to server and wait for ACK
			if (this.isConnected()) {
				const unsubId = generateUUID();
				const timeout = options.timeout || this.defaultTimeout;

				// Create promise that waits for ACK
				const ackPromise = new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						this.pendingSubscribes.delete(unsubId);
						reject(new Error(`Unsubscribe timeout: ${method} (${timeout}ms)`));
					}, timeout);

					this.pendingSubscribes.set(unsubId, {
						resolve,
						reject,
						timer,
						method,
						type: 'unsubscribe',
					});
				});

				const unsubscribeMsg = createUnsubscribeMessage({
					method,
					sessionId,
					id: unsubId,
				});

				try {
					await this.sendMessage(unsubscribeMsg);
					await ackPromise;
					this.log(`Unsubscribed from: ${method} (session: ${sessionId}) - ACK received`);
				} catch (error) {
					console.warn(`[MessageHub] Unsubscribe failed:`, error);
					// Continue with local cleanup even if server unsubscribe fails
				}
			}

			// Remove from persisted subscriptions
			this.persistedSubscriptions.delete(subId);

			// Remove from active subscriptions
			sessionSubs.get(method)?.delete(handler as EventHandler);
			this.log(`Unsubscribed from: ${method} (session: ${sessionId})`);
		};
	}

	/**
	 * Subscribe to events (OPTIMISTIC - non-blocking, returns immediately)
	 *
	 * NON-BLOCKING SUBSCRIPTION PROTOCOL:
	 * - Registers handler locally immediately (synchronous)
	 * - Sends SUBSCRIBE message to server in background (fire-and-forget)
	 * - Returns unsubscribe function immediately (no waiting for ACK)
	 * - Auto-resubscribes on reconnection
	 *
	 * USE CASE:
	 * Use this when UI responsiveness is more important than subscription
	 * confirmation. The slight delay before server-side events start flowing
	 * is acceptable because local state will be used as fallback.
	 *
	 * @example
	 * // Non-blocking subscription - returns immediately
	 * const unsubscribe = hub.subscribeOptimistic('sdk.message', (data) => {
	 *   console.log('SDK message:', data);
	 * }, { sessionId: 'abc-123' });
	 *
	 * // Can unsubscribe synchronously
	 * unsubscribe();
	 */
	subscribeOptimistic<TData = unknown>(
		method: string,
		handler: EventHandler<TData>,
		options: SubscribeOptions = {}
	): UnsubscribeFn {
		const sessionId = options.sessionId || this.defaultSessionId;

		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}

		// Generate unique subscription ID
		const subId = generateUUID();

		// 1. Register handler locally IMMEDIATELY (synchronous - no blocking)
		if (!this.subscriptions.has(sessionId)) {
			this.subscriptions.set(sessionId, new Map());
		}

		const sessionSubs = this.subscriptions.get(sessionId)!;

		if (!sessionSubs.has(method)) {
			sessionSubs.set(method, new Set());
		}

		sessionSubs.get(method)!.add(handler as EventHandler);

		this.log(
			`Subscribed (optimistic) to: ${method} (session: ${sessionId}) - local handler registered`
		);

		// 2. Send SUBSCRIBE to server in BACKGROUND (fire-and-forget, non-blocking)
		if (this.isConnected()) {
			const subscribeMsg = createSubscribeMessage({
				method,
				sessionId,
				id: subId,
			});

			// Fire and forget - don't wait for ACK
			this.sendMessage(subscribeMsg).catch((error) => {
				console.warn(`[MessageHub] Background SUBSCRIBE failed for ${method}:`, error);
				// Handler is still registered locally - events will flow once server-side catches up
			});
		}

		// 3. Persist subscription for auto-resubscription on reconnect
		this.persistedSubscriptions.set(subId, {
			method,
			handler: handler as EventHandler,
			options: { sessionId },
			createdAt: Date.now(),
		});

		// 4. Return SYNCHRONOUS unsubscribe function (non-blocking)
		return () => {
			// Remove from active subscriptions immediately
			sessionSubs.get(method)?.delete(handler as EventHandler);

			// Remove from persisted subscriptions
			this.persistedSubscriptions.delete(subId);

			this.log(`Unsubscribed (optimistic) from: ${method} (session: ${sessionId})`);

			// Send UNSUBSCRIBE to server in background (fire-and-forget)
			if (this.isConnected()) {
				const unsubscribeMsg = createUnsubscribeMessage({
					method,
					sessionId,
					id: generateUUID(),
				});

				this.sendMessage(unsubscribeMsg).catch((error) => {
					console.warn(`[MessageHub] Background UNSUBSCRIBE failed for ${method}:`, error);
					// Local cleanup already done - server will eventually clean up stale subscriptions
				});
			}
		};
	}

	// ========================================
	// Hybrid Pattern (callAndPublish)
	// ========================================

	/**
	 * Make an RPC call AND publish an event
	 * Perfect for mutations that should notify all clients
	 *
	 * @example
	 * // Delete session: get confirmation + notify all UIs
	 * await hub.callAndPublish(
	 *   'session.delete',        // RPC method
	 *   'session.deleted',       // Event to publish
	 *   { sessionId: 'abc-123' },
	 *   { sessionId: 'global' }
	 * );
	 */
	async callAndPublish<TResult = unknown>(
		callMethod: string,
		publishMethod: string,
		data?: unknown,
		options: CallOptions = {}
	): Promise<TResult> {
		// Make the RPC call first
		const result = await this.call<TResult>(callMethod, data, options);

		// Publish the event (use same sessionId)
		await this.publish(publishMethod, result, {
			sessionId: options.sessionId || this.defaultSessionId,
		});

		return result;
	}

	// ========================================
	// Message Inspection
	// ========================================

	/**
	 * Register a handler for all messages (for debugging/logging)
	 *
	 * @example
	 * hub.onMessage((message, direction) => {
	 *   console.log(`[${direction}] ${message.type} ${message.method}`, message);
	 * });
	 */
	onMessage(handler: MessageHandler): UnsubscribeFn {
		this.messageHandlers.add(handler);
		return () => {
			this.messageHandlers.delete(handler);
		};
	}

	// ========================================
	// Internal Message Handling
	// ========================================

	/**
	 * Handle incoming message from transport
	 * FIX P1.3: Validate message sequence to detect out-of-order or missing messages
	 */
	private async handleIncomingMessage(message: HubMessage): Promise<void> {
		// Validate message structure
		if (!isValidMessage(message)) {
			console.error(`[MessageHub] Invalid message format:`, message);
			throw new Error(`Invalid message format: ${JSON.stringify(message)}`);
		}

		this.log(`← Incoming: ${message.type} ${message.method}`, message);

		// FIX P1.3: Validate message sequence (if present)
		// Server-side: track per-client (each client has its own sequence counter)
		// Client-side: track globally (server uses one global counter for all outgoing messages)
		if (typeof message.sequence === 'number' && this.warnOnSequenceGap) {
			const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId;

			if (this.router && clientId) {
				// Server-side: use per-client tracking
				const expectedSeq = this.expectedSequencePerClient.get(clientId);
				if (expectedSeq !== undefined) {
					if (message.sequence < expectedSeq) {
						console.warn(
							`[MessageHub] Out-of-order message from client ${clientId}: ` +
								`received sequence ${message.sequence}, expected >= ${expectedSeq}`
						);
					} else if (message.sequence > expectedSeq) {
						const gap = message.sequence - expectedSeq;
						console.warn(
							`[MessageHub] Message sequence gap from client ${clientId}: ` +
								`received sequence ${message.sequence}, expected ${expectedSeq} (gap: ${gap} messages)`
						);
					}
				}
				// Update expected sequence for this client
				this.expectedSequencePerClient.set(clientId, message.sequence + 1);
			} else {
				// Client-side: use global tracking (server uses single counter)
				if (this.expectedSequence !== null) {
					if (message.sequence < this.expectedSequence) {
						console.warn(
							`[MessageHub] Out-of-order message detected: ` +
								`received sequence ${message.sequence}, expected >= ${this.expectedSequence}`
						);
					} else if (message.sequence > this.expectedSequence) {
						const gap = message.sequence - this.expectedSequence;
						console.warn(
							`[MessageHub] Message sequence gap detected: ` +
								`received sequence ${message.sequence}, expected ${this.expectedSequence} (gap: ${gap} messages)`
						);
					}
				}
				// Update expected sequence for next message (global)
				this.expectedSequence = message.sequence + 1;
			}
		}

		// Notify message handlers
		this.notifyMessageHandlers(message, 'in');

		try {
			if (message.type === MessageType.PING) {
				await this.handlePing(message);
			} else if (message.type === MessageType.PONG) {
				this.handlePong(message);
			} else if (isSubscribeMessage(message)) {
				await this.handleSubscribe(message);
			} else if (isUnsubscribeMessage(message)) {
				await this.handleUnsubscribe(message);
			} else if (isSubscribedMessage(message) || isUnsubscribedMessage(message)) {
				this.handleSubscriptionResponse(message);
			} else if (isCallMessage(message)) {
				await this.handleIncomingCall(message);
			} else if (isResponseMessage(message)) {
				this.handleResponse(message);
			} else if (isEventMessage(message)) {
				await this.handleEvent(message);
			}
		} catch (error) {
			console.error(`[MessageHub] Error handling message:`, error);
		}
	}

	/**
	 * Handle incoming CALL message
	 */
	private async handleIncomingCall(message: HubMessage): Promise<void> {
		const handler = this.rpcHandlers.get(message.method);
		const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId; // Added by transport

		if (!handler) {
			// No handler - send error response
			const errorMsg = createErrorMessage({
				method: message.method,
				error: {
					code: ErrorCode.METHOD_NOT_FOUND,
					message: `No handler for method: ${message.method}`,
				},
				sessionId: message.sessionId,
				requestId: message.id,
			});
			await this.sendResponseToClient(errorMsg, clientId);
			return;
		}

		// Execute handler
		try {
			const context: CallContext = {
				messageId: message.id,
				sessionId: message.sessionId,
				method: message.method,
				timestamp: message.timestamp,
			};

			const result = await Promise.resolve(handler(message.data, context));

			// Send success response
			const resultMsg = createResultMessage({
				method: message.method,
				data: result,
				sessionId: message.sessionId,
				requestId: message.id,
			});
			await this.sendResponseToClient(resultMsg, clientId);
		} catch (error) {
			// Send error response
			const errorMsg = createErrorMessage({
				method: message.method,
				error: {
					code: ErrorCode.HANDLER_ERROR,
					message: error instanceof Error ? error.message : String(error),
				},
				sessionId: message.sessionId,
				requestId: message.id,
			});
			await this.sendResponseToClient(errorMsg, clientId);
		}
	}

	/**
	 * Handle SUBSCRIBED/UNSUBSCRIBED response messages
	 */
	private handleSubscriptionResponse(message: HubMessage): void {
		const requestId = message.requestId;
		if (!requestId) {
			console.warn(`[MessageHub] Subscription response without requestId:`, message);
			return;
		}

		const pendingSub = this.pendingSubscribes.get(requestId);
		if (!pendingSub) {
			this.log(
				`Subscription response for unknown request: ${requestId} (method: ${message.method})`
			);
			return;
		}

		clearTimeout(pendingSub.timer);
		this.pendingSubscribes.delete(requestId);

		if (message.type === MessageType.SUBSCRIBED || message.type === MessageType.UNSUBSCRIBED) {
			const action = message.type === MessageType.SUBSCRIBED ? 'SUBSCRIBE' : 'UNSUBSCRIBE';
			this.log(`${action} ACK received: ${pendingSub.method}`);
			pendingSub.resolve();
		} else {
			// Shouldn't reach here, but handle just in case
			const error = new Error(
				`Unexpected subscription response type: ${message.type} for ${pendingSub.method}`
			);
			pendingSub.reject(error);
		}
	}

	/**
	 * Handle response message (RESULT or ERROR)
	 *
	 * Handles responses for RPC calls only (subscription responses handled separately)
	 */
	private handleResponse(message: HubMessage): void {
		const requestId = message.requestId;
		if (!requestId) {
			console.warn(`[MessageHub] Response without requestId:`, message);
			return;
		}

		// Check if it's an RPC call response
		const pending = this.pendingCalls.get(requestId);
		if (!pending) {
			this.log(`Response for unknown request: ${requestId} (method: ${message.method})`);
			return;
		}

		// Clear timeout
		clearTimeout(pending.timer);
		this.pendingCalls.delete(requestId);

		// Resolve or reject
		if (message.type === MessageType.RESULT) {
			pending.resolve(message.data);
		} else {
			pending.reject(new Error(message.error || 'Unknown error'));
		}
	}

	/**
	 * Handle event message
	 *
	 * FIX P0.4: Prevent infinite recursion in event handlers
	 * FIX P0.7: Queue events during resubscription to prevent event loss
	 */
	private async handleEvent(message: HubMessage): Promise<void> {
		// FIX P0.7: Queue events during resubscription
		if (this.resubscribing) {
			this.pendingEvents.push(message);
			this.log(`Event queued during resubscription: ${message.method}`);
			return;
		}

		// FIX P0.4: Check recursion depth
		const currentDepth = this.eventDepthMap.get(message.id) || 0;
		if (currentDepth >= this.maxEventDepth) {
			console.error(
				`[MessageHub] Max event depth (${this.maxEventDepth}) exceeded for ${message.method}. ` +
					`Possible circular dependency or infinite loop.`
			);
			return;
		}

		const sessionSubs = this.subscriptions.get(message.sessionId);
		if (!sessionSubs) {
			return;
		}

		const handlers = sessionSubs.get(message.method);
		if (!handlers || handlers.size === 0) {
			return;
		}

		const context: EventContext = {
			messageId: message.id,
			sessionId: message.sessionId,
			method: message.method,
			timestamp: message.timestamp,
		};

		// Track depth
		this.eventDepthMap.set(message.id, currentDepth + 1);

		try {
			// FIX P1.4: Collect all handler errors for better visibility
			const handlerErrors: Array<{ handler: EventHandler; error: Error }> = [];

			// Execute all handlers synchronously but with depth tracking
			// This maintains backward compat while preventing infinite recursion
			for (const handler of handlers) {
				try {
					await Promise.resolve(handler(message.data, context));
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					handlerErrors.push({ handler, error: err });

					// FIX P1.4: Configurable error handling behavior
					if (this.stopOnEventHandlerError) {
						// Stop on first error (strict mode)
						console.error(
							`[MessageHub] Event handler failed for ${message.method} (stopping):`,
							err
						);
						break;
					}
					// Default: Continue executing other handlers (resilient mode)
				}
			}

			// FIX P1.4: Log all collected errors together
			if (handlerErrors.length > 0 && !this.stopOnEventHandlerError) {
				console.error(
					`[MessageHub] ${handlerErrors.length} event handler(s) failed for ${message.method}:`,
					handlerErrors.map((e) => e.error.message)
				);
			}
		} finally {
			// Clean up depth tracking immediately after handlers complete
			this.eventDepthMap.delete(message.id);
		}
	}

	/**
	 * Handle SUBSCRIBE message (server-side)
	 *
	 * Client sends SUBSCRIBE to register interest in specific events.
	 * Server tracks subscription in Router for targeted event routing.
	 */
	private async handleSubscribe(message: HubMessage): Promise<void> {
		if (!this.router) {
			this.log('No router registered, ignoring SUBSCRIBE');
			return;
		}

		// Get clientId from message metadata (added by transport)
		const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId;

		if (!clientId) {
			console.error(
				'[MessageHub] SUBSCRIBE without clientId - transport must add clientId to messages'
			);
			return;
		}

		try {
			// Register subscription in router
			this.router.subscribe(message.sessionId, message.method, clientId);

			this.log(`Client ${clientId} subscribed to ${message.sessionId}:${message.method}`);

			// Send SUBSCRIBED confirmation
			const ackMsg = createSubscribedMessage({
				method: message.method,
				sessionId: message.sessionId,
				requestId: message.id,
			});

			await this.sendResponseToClient(ackMsg, clientId);
		} catch (error) {
			console.error(`[MessageHub] Error handling SUBSCRIBE:`, error);

			// Send error response
			const errorMsg = createErrorMessage({
				method: message.method,
				error: {
					code: ErrorCode.HANDLER_ERROR,
					message: error instanceof Error ? error.message : String(error),
				},
				sessionId: message.sessionId,
				requestId: message.id,
			});

			await this.sendMessage(errorMsg);
		}
	}

	/**
	 * Handle UNSUBSCRIBE message (server-side)
	 *
	 * Client sends UNSUBSCRIBE to stop receiving specific events.
	 * Server removes subscription from Router.
	 */
	private async handleUnsubscribe(message: HubMessage): Promise<void> {
		if (!this.router) {
			this.log('No router registered, ignoring UNSUBSCRIBE');
			return;
		}

		const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId;

		if (!clientId) {
			console.error('[MessageHub] UNSUBSCRIBE without clientId');
			return;
		}

		try {
			// Remove subscription from router
			this.router.unsubscribeClient(message.sessionId, message.method, clientId);

			this.log(`Client ${clientId} unsubscribed from ${message.sessionId}:${message.method}`);

			// Send UNSUBSCRIBED confirmation
			const ackMsg = createUnsubscribedMessage({
				method: message.method,
				sessionId: message.sessionId,
				requestId: message.id,
			});

			await this.sendResponseToClient(ackMsg, clientId);
		} catch (error) {
			console.error(`[MessageHub] Error handling UNSUBSCRIBE:`, error);
		}
	}

	/**
	 * Handle PING message - respond with PONG
	 */
	private async handlePing(message: HubMessage): Promise<void> {
		this.log(`Received PING from session: ${message.sessionId}`);

		// Create PONG response
		const pongMessage: HubMessage = {
			id: generateUUID(),
			type: MessageType.PONG,
			sessionId: message.sessionId,
			method: 'heartbeat',
			timestamp: new Date().toISOString(),
			requestId: message.id,
		};

		// Send PONG response
		await this.sendMessage(pongMessage);
	}

	/**
	 * Handle PONG message - track connection health
	 */
	private handlePong(message: HubMessage): void {
		this.log(`Received PONG from session: ${message.sessionId}`);
		// Optional: Could track latency metrics here
		// const latency = Date.now() - new Date(message.timestamp).getTime();
		// this.connectionHealth.set(message.sessionId, { latency, lastPong: Date.now() });
	}

	/**
	 * Send a message via transport
	 *
	 * Routing logic:
	 * - If router is registered (server-side) AND message is EVENT:
	 *   Router determines subscribers → Transport sends to those clients
	 * - Otherwise (client-side or non-EVENT):
	 *   Transport broadcasts directly
	 */
	private async sendMessage(message: HubMessage): Promise<void> {
		if (!this.transport || !this.transport.isReady()) {
			throw new Error('Transport not ready');
		}

		// Add sequence number for ordering guarantees
		message.sequence = this.messageSequence++;

		this.log(`→ Outgoing: ${message.type} ${message.method} [seq=${message.sequence}]`, message);

		// Notify message handlers
		this.notifyMessageHandlers(message, 'out');

		// Server-side routing for EVENT messages
		if (this.router && message.type === MessageType.EVENT) {
			// Use router to route EVENT to subscribed clients
			const result = this.router.routeEvent(message);
			this.log(`Routed event: ${result.sent}/${result.totalSubscribers} delivered`);
			return;
		}

		// Client-side or non-EVENT messages: send via transport
		await this.transport.send(message);
	}

	/**
	 * Send RPC response (RESULT/ERROR/SUBSCRIBED/UNSUBSCRIBED) to a specific client
	 * Server-side only - routes the response to the client that made the request
	 */
	private async sendResponseToClient(message: HubMessage, clientId?: string): Promise<void> {
		// Add sequence number for ordering guarantees
		message.sequence = this.messageSequence++;

		// Notify message handlers
		this.notifyMessageHandlers(message, 'out');

		// If we have a router and clientId, send to specific client
		if (this.router && clientId) {
			const success = this.router.sendToClient(clientId, message);
			if (!success) {
				console.warn(
					`[MessageHub] Failed to send response to client ${clientId}, falling back to broadcast`
				);
				// Fallback to broadcast if client not found
				this.router.broadcast(message);
			}
			return;
		}

		// Fallback: send via transport (will broadcast on server-side)
		if (!this.transport || !this.transport.isReady()) {
			throw new Error('Transport not ready');
		}
		await this.transport.send(message);
	}

	/**
	 * Notify message handlers
	 */
	private notifyMessageHandlers(message: HubMessage, direction: 'in' | 'out'): void {
		for (const handler of this.messageHandlers) {
			try {
				handler(message, direction);
			} catch (error) {
				console.error(`[MessageHub] Error in message handler:`, error);
			}
		}
	}

	/**
	 * Notify connection state handlers
	 */
	private notifyConnectionStateHandlers(state: ConnectionState, error?: Error): void {
		for (const handler of this.connectionStateHandlers) {
			try {
				handler(state, error);
			} catch (err) {
				console.error(`[MessageHub] Error in connection state handler:`, err);
			}
		}
	}

	// ========================================
	// Cleanup
	// ========================================

	/**
	 * Force re-establish all subscriptions with the server.
	 *
	 * Use this after connection validation (e.g., returning from background tab)
	 * to ensure server-side subscriptions are in sync. This is critical for
	 * Safari background tab handling where the connection may appear healthy
	 * but subscriptions are stale.
	 *
	 * This is a public wrapper around the internal resubscribeAll() method.
	 */
	forceResubscribe(): void {
		this.log('Force resubscribing all subscriptions (connection validation)');
		this.resubscribeAll();
	}

	/**
	 * Re-subscribe all persisted subscriptions after reconnection
	 *
	 * FIX P0.3: Atomic swap to prevent race condition where events are dropped
	 * FIX P0.7: Queue events during resubscription, then replay after swap
	 * FIX: Send SUBSCRIBE messages to server to re-establish server-side subscriptions
	 * FIX: Wait for SUBSCRIBE ACKs with timeout for better reliability
	 */
	private resubscribeAll(): void {
		if (this.persistedSubscriptions.size === 0) {
			return;
		}

		// FIX: Debounce to prevent subscription storm from multiple sources
		// (MessageHub on connect, StateChannel.hybridRefresh, ConnectionManager.validateConnectionOnResume)
		const now = Date.now();
		if (now - this.lastResubscribeTime < this.resubscribeDebounceMs) {
			this.log(
				`Skipping resubscribeAll - debounced (last call ${now - this.lastResubscribeTime}ms ago)`
			);
			return;
		}
		this.lastResubscribeTime = now;

		this.log(`Re-subscribing ${this.persistedSubscriptions.size} subscriptions after reconnection`);

		// FIX: Clear sequence tracking on reconnection
		// Server may have restarted and reset its sequence counter, so client must reset expectations
		this.expectedSequence = null;
		this.log(`Cleared sequence tracking for fresh reconnection`);

		// FIX P0.7: Set flag to queue incoming events during rebuild
		this.resubscribing = true;

		// FIX: Clear in-flight subscription tracking on reconnection
		this.inFlightSubscriptions.clear();

		// Track subscription promises for ACK verification
		const subscriptionPromises: Promise<{ method: string; success: boolean }>[] = [];
		const RESUBSCRIBE_TIMEOUT = 2000; // 2 second timeout for ACKs

		try {
			// FIX P0.3: Build new subscription map first, then atomically swap
			// This prevents the window where subscriptions.clear() makes us miss events
			const newSubscriptions = new Map<string, Map<string, Set<EventHandler>>>();

			// Re-establish all persisted subscriptions in new map AND send SUBSCRIBE to server
			for (const [_subId, { method, handler, options }] of this.persistedSubscriptions) {
				const sessionId = options.sessionId || this.defaultSessionId;

				// Initialize subscription maps if needed
				if (!newSubscriptions.has(sessionId)) {
					newSubscriptions.set(sessionId, new Map());
				}

				const sessionSubs = newSubscriptions.get(sessionId)!;

				if (!sessionSubs.has(method)) {
					sessionSubs.set(method, new Set());
				}

				sessionSubs.get(method)!.add(handler);

				// FIX: Send SUBSCRIBE message to server with ACK tracking
				// Deduplicate: only send if not already in-flight
				const subKey = `${sessionId}:${method}`;
				if (this.isConnected() && !this.inFlightSubscriptions.has(subKey)) {
					this.inFlightSubscriptions.add(subKey);

					const subId = generateUUID();
					const subscribeMsg = createSubscribeMessage({
						method,
						sessionId,
						id: subId,
					});

					// Create promise that waits for ACK with timeout
					const ackPromise = new Promise<{ method: string; success: boolean }>((resolve) => {
						const timer = setTimeout(() => {
							this.pendingSubscribes.delete(subId);
							this.inFlightSubscriptions.delete(subKey); // Clean up on timeout
							this.log(`Subscription ACK timeout for ${method} (session: ${sessionId})`);
							resolve({ method, success: false });
						}, RESUBSCRIBE_TIMEOUT);

						// Track pending subscription
						this.pendingSubscribes.set(subId, {
							resolve: () => {
								clearTimeout(timer);
								this.inFlightSubscriptions.delete(subKey); // Clean up on success
								resolve({ method, success: true });
							},
							reject: () => {
								clearTimeout(timer);
								this.inFlightSubscriptions.delete(subKey); // Clean up on error
								resolve({ method, success: false });
							},
							timer,
							method,
							type: 'subscribe',
						});
					});

					// Send message (don't await here to avoid blocking)
					this.sendMessage(subscribeMsg).catch((error) => {
						console.error(
							`[MessageHub] Failed to send SUBSCRIBE for ${method} (session: ${sessionId}):`,
							error
						);
						this.inFlightSubscriptions.delete(subKey); // Clean up on send error
					});

					subscriptionPromises.push(ackPromise);
				} else if (this.inFlightSubscriptions.has(subKey)) {
					this.log(`Skipping duplicate SUBSCRIBE for ${method} (session: ${sessionId})`);
				}

				this.log(`Re-subscribed to: ${method} (session: ${sessionId})`);
			}

			// Atomic swap - no window where events are missed
			this.subscriptions = newSubscriptions;
		} finally {
			// FIX P0.7: Clear flag to allow event processing
			this.resubscribing = false;
		}

		// Wait for ACKs in background (non-blocking) and log results
		if (subscriptionPromises.length > 0) {
			Promise.allSettled(subscriptionPromises).then((results) => {
				const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
				const failed = results.length - succeeded;

				if (failed > 0) {
					console.warn(
						`[MessageHub] Resubscription completed: ${succeeded}/${results.length} ACKs received, ${failed} timed out`
					);
				} else {
					this.log(`Resubscription completed: all ${succeeded} ACKs received`);
				}
			});
		}

		// FIX P0.7: Replay queued events after subscription rebuild
		if (this.pendingEvents.length > 0) {
			this.log(`Replaying ${this.pendingEvents.length} queued events`);
			const events = [...this.pendingEvents];
			this.pendingEvents = [];

			for (const event of events) {
				// Replay event asynchronously (don't block reconnection)
				this.handleEvent(event).catch((error) => {
					console.error(`[MessageHub] Error replaying queued event:`, error);
				});
			}
		}
	}

	/**
	 * Cleanup all state
	 * FIX P1.3: Clear sequence tracking map
	 * FIX: Clear pending subscription operations
	 * FIX: Clear in-flight subscription tracking
	 */
	cleanup(): void {
		// Reject all pending calls
		for (const [_requestId, pending] of this.pendingCalls) {
			clearTimeout(pending.timer);
			pending.reject(new Error('MessageHub cleanup'));
		}
		this.pendingCalls.clear();

		// Reject all pending subscription operations
		for (const [_requestId, pending] of this.pendingSubscribes) {
			clearTimeout(pending.timer);
			pending.reject(new Error('MessageHub cleanup'));
		}
		this.pendingSubscribes.clear();

		// FIX P0.1: Properly destroy cache (stops cleanup timer)
		this.requestCache.destroy();

		// Clear handlers
		this.rpcHandlers.clear();
		this.subscriptions.clear();
		this.persistedSubscriptions.clear();
		this.messageHandlers.clear();
		this.connectionStateHandlers.clear();
		this.eventDepthMap.clear();

		// FIX P1.3: Clear sequence tracking
		this.expectedSequence = null;
		this.expectedSequencePerClient.clear();

		// FIX: Clear in-flight subscription tracking
		this.inFlightSubscriptions.clear();

		this.log('MessageHub cleaned up');
	}

	// ========================================
	// Utilities
	// ========================================

	/**
	 * Clean up sequence tracking for a disconnected client (server-side only)
	 * Call this when a client disconnects to free up memory
	 */
	cleanupClientSequence(clientId: string): void {
		this.expectedSequencePerClient.delete(clientId);
	}

	/**
	 * Debug logging
	 */
	private log(message: string, ...args: unknown[]): void {
		if (this.debug) {
			console.log(`[MessageHub] ${message}`, ...args);
		}
	}

	/**
	 * Get pending call count
	 */
	getPendingCallCount(): number {
		return this.pendingCalls.size;
	}

	/**
	 * Get subscription count for a method
	 */
	getSubscriptionCount(method: string, sessionId?: string): number {
		const sid = sessionId || this.defaultSessionId;
		const sessionSubs = this.subscriptions.get(sid);
		if (!sessionSubs) {
			return 0;
		}
		return sessionSubs.get(method)?.size || 0;
	}
}
