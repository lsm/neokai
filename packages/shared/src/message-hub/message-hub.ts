/**
 * MessageHub - Unified messaging hub for bidirectional RPC and Pub/Sub
 *
 * Provides:
 * - Bidirectional RPC (client↔server)
 * - Pub/Sub messaging
 * - Session-based routing
 * - Type-safe method registry
 */

import { generateUUID } from "../utils.ts";
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
  isCallMessage,
  isResponseMessage,
  isEventMessage,
  isSubscribeMessage,
  isUnsubscribeMessage,
  validateMethod,
  isValidMessage,
} from "./protocol.ts";
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
  IMessageTransport,
  CallContext,
  EventContext,
  ConnectionState,
  BroadcastResult,
} from "./types.ts";
import type { MessageHubRouter } from "./router.ts";
import { LRUCache, createCacheKey } from "./cache.ts";

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
  private router: MessageHubRouter | null = null;  // Server-side only
  private readonly defaultSessionId: string;
  private readonly defaultTimeout: number;
  private readonly debug: boolean;

  // Backpressure limits
  private readonly maxPendingCalls: number;
  private readonly maxCacheSize: number;
  private readonly cacheTTL: number;
  private readonly maxEventDepth: number;

  // RPC state
  private pendingCalls: Map<string, PendingCall> = new Map();
  private rpcHandlers: Map<string, RPCHandler> = new Map();

  // Request deduplication cache with LRU eviction and TTL
  private requestCache: LRUCache<string, Promise<any>>;

  // Subscription ACK tracking (for reliable subscribe/unsubscribe)
  private pendingSubscribes: Map<string, {
    resolve: (value: void) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    type: 'subscribe' | 'unsubscribe';
  }> = new Map();

  // Pub/Sub state
  private subscriptions: Map<string, Map<string, Set<EventHandler>>> = new Map();
  //                          ^sessionId  ^method   ^handlers

  // Subscription persistence for auto-resubscription
  private persistedSubscriptions: Map<
    string,
    { method: string; handler: EventHandler; options: SubscribeOptions; createdAt: number }
  > = new Map();

  // Event handler recursion tracking (prevents infinite loops)
  private eventDepthMap = new Map<string, number>(); // messageId -> depth

  // Message sequencing for ordering guarantees
  private messageSequence = 0;

  // FIX P0.7: Queue events during resubscription to prevent event loss
  private resubscribing: boolean = false;
  private pendingEvents: HubMessage[] = [];

  // FIX P1.3: Message sequence tracking (per-session)
  private expectedSequence: Map<string, number> = new Map(); // sessionId -> next expected sequence
  private readonly warnOnSequenceGap: boolean;

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
      throw new Error("Transport already registered. Call unregisterTransport() first.");
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
      this.notifyConnectionStateHandlers(state, error);

      // Auto-resubscribe on reconnection
      if (state === "connected") {
        this.resubscribeAll();
      }
    });

    // Return unregister function
    return () => {
      this.transport = null;
      unsubMessage();
      unsubConnection();
      this.log(`Transport unregistered: ${transport.name}`);
    };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.transport?.getState() || "disconnected";
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
      console.warn("[MessageHub] Router already registered, replacing...");
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
    options: CallOptions = {},
  ): Promise<TResult> {
    if (!this.isConnected()) {
      throw new Error("Not connected to transport");
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
          resolve(result);
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
    handler: RPCHandler<TData, TResult>,
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
  async publish(
    method: string,
    data?: unknown,
    options: PublishOptions = {},
  ): Promise<void> {
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
    options: SubscribeOptions = {},
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
    options: CallOptions = {},
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
    if (typeof message.sequence === 'number' && this.warnOnSequenceGap) {
      const sessionId = message.sessionId;
      const expected = this.expectedSequence.get(sessionId);

      if (expected !== undefined) {
        // We've seen messages from this session before
        if (message.sequence < expected) {
          console.warn(
            `[MessageHub] Out-of-order message detected for session ${sessionId}: ` +
            `received sequence ${message.sequence}, expected >= ${expected}`
          );
        } else if (message.sequence > expected) {
          const gap = message.sequence - expected;
          console.warn(
            `[MessageHub] Message sequence gap detected for session ${sessionId}: ` +
            `received sequence ${message.sequence}, expected ${expected} (gap: ${gap} messages)`
          );
        }
      }

      // Update expected sequence for next message
      this.expectedSequence.set(sessionId, message.sequence + 1);
    }

    // Notify message handlers
    this.notifyMessageHandlers(message, "in");

    try {
      if (message.type === MessageType.PING) {
        await this.handlePing(message);
      } else if (message.type === MessageType.PONG) {
        this.handlePong(message);
      } else if (isSubscribeMessage(message)) {
        await this.handleSubscribe(message);
      } else if (isUnsubscribeMessage(message)) {
        await this.handleUnsubscribe(message);
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
      await this.sendMessage(errorMsg);
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
      await this.sendMessage(resultMsg);
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
      await this.sendMessage(errorMsg);
    }
  }

  /**
   * Handle response message (RESULT or ERROR)
   *
   * Handles responses for both RPC calls and subscription operations (SUBSCRIBE/UNSUBSCRIBE)
   */
  private handleResponse(message: HubMessage): void {
    const requestId = message.requestId;
    if (!requestId) {
      console.warn(`[MessageHub] Response without requestId:`, message);
      return;
    }

    // Check if it's a subscription ACK (SUBSCRIBE/UNSUBSCRIBE)
    const pendingSub = this.pendingSubscribes.get(requestId);
    if (pendingSub) {
      clearTimeout(pendingSub.timer);
      this.pendingSubscribes.delete(requestId);

      if (message.type === MessageType.RESULT) {
        this.log(`${pendingSub.type === 'subscribe' ? 'SUBSCRIBE' : 'UNSUBSCRIBE'} ACK received: ${pendingSub.method}`);
        pendingSub.resolve();
      } else {
        const error = new Error(
          message.error || `${pendingSub.type === 'subscribe' ? 'Subscription' : 'Unsubscription'} failed: ${pendingSub.method}`
        );
        pendingSub.reject(error);
      }
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
      pending.reject(new Error(message.error || "Unknown error"));
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
    const clientId = (message as any).clientId;

    if (!clientId) {
      console.error('[MessageHub] SUBSCRIBE without clientId - transport must add clientId to messages');
      return;
    }

    try {
      // Register subscription in router
      this.router.subscribe(message.sessionId, message.method, clientId);

      this.log(`Client ${clientId} subscribed to ${message.sessionId}:${message.method}`);

      // Send ACK (optional - confirms subscription)
      const ackMsg = createResultMessage({
        method: message.method,
        data: { subscribed: true, method: message.method, sessionId: message.sessionId },
        sessionId: message.sessionId,
        requestId: message.id,
      });

      await this.sendMessage(ackMsg);
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

    const clientId = (message as any).clientId;

    if (!clientId) {
      console.error('[MessageHub] UNSUBSCRIBE without clientId');
      return;
    }

    try {
      // Remove subscription from router
      this.router.unsubscribeClient(message.sessionId, message.method, clientId);

      this.log(`Client ${clientId} unsubscribed from ${message.sessionId}:${message.method}`);

      // Send ACK (optional)
      const ackMsg = createResultMessage({
        method: message.method,
        data: { unsubscribed: true, method: message.method, sessionId: message.sessionId },
        sessionId: message.sessionId,
        requestId: message.id,
      });

      await this.sendMessage(ackMsg);
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
      method: "heartbeat",
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
      throw new Error("Transport not ready");
    }

    // Add sequence number for ordering guarantees
    message.sequence = this.messageSequence++;

    this.log(`→ Outgoing: ${message.type} ${message.method} [seq=${message.sequence}]`, message);

    // Notify message handlers
    this.notifyMessageHandlers(message, "out");

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
   * Notify message handlers
   */
  private notifyMessageHandlers(message: HubMessage, direction: "in" | "out"): void {
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
   * Re-subscribe all persisted subscriptions after reconnection
   *
   * FIX P0.3: Atomic swap to prevent race condition where events are dropped
   * FIX P0.7: Queue events during resubscription, then replay after swap
   */
  private resubscribeAll(): void {
    if (this.persistedSubscriptions.size === 0) {
      return;
    }

    this.log(`Re-subscribing ${this.persistedSubscriptions.size} subscriptions after reconnection`);

    // FIX P0.7: Set flag to queue incoming events during rebuild
    this.resubscribing = true;

    try {
      // FIX P0.3: Build new subscription map first, then atomically swap
      // This prevents the window where subscriptions.clear() makes us miss events
      const newSubscriptions = new Map<string, Map<string, Set<EventHandler>>>();

      // Re-establish all persisted subscriptions in new map
      for (const [subId, { method, handler, options }] of this.persistedSubscriptions) {
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
        this.log(`Re-subscribed to: ${method} (session: ${sessionId})`);
      }

      // Atomic swap - no window where events are missed
      this.subscriptions = newSubscriptions;
    } finally {
      // FIX P0.7: Clear flag to allow event processing
      this.resubscribing = false;
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
   */
  cleanup(): void {
    // Reject all pending calls
    for (const [requestId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MessageHub cleanup"));
    }
    this.pendingCalls.clear();

    // Reject all pending subscription operations
    for (const [requestId, pending] of this.pendingSubscribes) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MessageHub cleanup"));
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
    this.expectedSequence.clear();

    this.log("MessageHub cleaned up");
  }

  // ========================================
  // Utilities
  // ========================================

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
