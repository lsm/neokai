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

  // RPC state
  private pendingCalls: Map<string, PendingCall> = new Map();
  private rpcHandlers: Map<string, RPCHandler> = new Map();

  // Request deduplication cache (prevents duplicate concurrent calls)
  private requestCache: Map<string, Promise<any>> = new Map();

  // Pub/Sub state
  private subscriptions: Map<string, Map<string, Set<EventHandler>>> = new Map();
  //                          ^sessionId  ^method   ^handlers

  // Subscription persistence for auto-resubscription
  private persistedSubscriptions: Map<
    string,
    { method: string; handler: EventHandler; options: SubscribeOptions }
  > = new Map();

  // Message sequencing for ordering guarantees
  private messageSequence = 0;

  // Message inspection
  private messageHandlers: Set<MessageHandler> = new Set();

  // Connection state
  private connectionStateHandlers: Set<ConnectionStateHandler> = new Set();

  constructor(options: MessageHubOptions = {}) {
    this.defaultSessionId = options.defaultSessionId || GLOBAL_SESSION_ID;
    this.defaultTimeout = options.timeout || 10000;
    this.debug = options.debug || false;
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

    // Build full method name with session scoping
    const fullMethod = this.buildFullMethod(method, sessionId);

    if (!validateMethod(fullMethod)) {
      throw new Error(`Invalid method name: ${fullMethod}`);
    }

    // Request deduplication: check if identical request is already in flight
    const cacheKey = `${fullMethod}:${sessionId}:${JSON.stringify(data)}`;
    const cached = this.requestCache.get(cacheKey);
    if (cached) {
      this.log(`Returning cached request for: ${fullMethod}`);
      return cached as Promise<TResult>;
    }

    const messageId = generateUUID();
    const timeout = options.timeout || this.defaultTimeout;

    const requestPromise = new Promise<TResult>((resolve, reject) => {
      // Setup timeout
      const timer = setTimeout(() => {
        this.pendingCalls.delete(messageId);
        this.requestCache.delete(cacheKey);
        reject(new Error(`RPC timeout: ${fullMethod} (${timeout}ms)`));
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
        method: fullMethod,
        sessionId,
      });

      // Create and send CALL message
      const message = createCallMessage({
        method: fullMethod,
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

    // Cache the promise
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
    if (!this.isConnected()) {
      throw new Error("Not connected to transport");
    }

    const messageId = generateUUID();
    const sessionId = options.sessionId || this.defaultSessionId;

    // Build full method name with session scoping
    const fullMethod = this.buildFullMethod(method, sessionId);

    if (!validateMethod(fullMethod)) {
      throw new Error(`Invalid method name: ${fullMethod}`);
    }

    // Create EVENT message directly - no need for PUBLISH message type
    const message = createEventMessage({
      method: fullMethod,
      data,
      sessionId,
      id: messageId,
    });

    // Send to transport for broadcasting
    await this.sendMessage(message);
  }

  /**
   * Subscribe to events
   *
   * EXPLICIT SUBSCRIPTION PROTOCOL:
   * - Stores subscription locally (for event routing)
   * - Sends SUBSCRIBE message to server (if connected)
   * - Server tracks subscription in Router
   * - Auto-resubscribes on reconnection
   *
   * @example
   * // Global event
   * hub.subscribe('session.deleted', (data) => {
   *   console.log('Session deleted:', data.sessionId);
   * }, { sessionId: 'global' });
   *
   * // Session-scoped event
   * hub.subscribe('sdk.message', (data) => {
   *   console.log('SDK message:', data);
   * }, { sessionId: 'abc-123' });
   */
  subscribe<TData = unknown>(
    method: string,
    handler: EventHandler<TData>,
    options: SubscribeOptions = {},
  ): UnsubscribeFn {
    const sessionId = options.sessionId || this.defaultSessionId;

    // Build full method name with session scoping
    const fullMethod = this.buildFullMethod(method, sessionId);

    if (!validateMethod(fullMethod)) {
      throw new Error(`Invalid method name: ${fullMethod}`);
    }

    // Generate unique subscription ID
    const subId = generateUUID();

    // Persist subscription for auto-resubscription on reconnect
    this.persistedSubscriptions.set(subId, {
      method: fullMethod,
      handler: handler as EventHandler,
      options: { sessionId },
    });

    // Initialize subscription maps if needed
    if (!this.subscriptions.has(sessionId)) {
      this.subscriptions.set(sessionId, new Map());
    }

    const sessionSubs = this.subscriptions.get(sessionId)!;

    if (!sessionSubs.has(fullMethod)) {
      sessionSubs.set(fullMethod, new Set());
    }

    sessionSubs.get(fullMethod)!.add(handler as EventHandler);
    this.log(`Subscribed to: ${fullMethod} (session: ${sessionId})`);

    // Send SUBSCRIBE message to server (explicit subscription protocol)
    if (this.isConnected()) {
      const subscribeMsg = createSubscribeMessage({
        method: fullMethod,
        sessionId,
        id: subId,
      });

      this.sendMessage(subscribeMsg).catch((error) => {
        console.warn(`[MessageHub] Failed to send SUBSCRIBE message:`, error);
        // Continue - local subscription still works
      });
    }

    // Return unsubscribe function
    return () => {
      // Send UNSUBSCRIBE message to server
      if (this.isConnected()) {
        const unsubscribeMsg = createUnsubscribeMessage({
          method: fullMethod,
          sessionId,
          id: generateUUID(),
        });

        this.sendMessage(unsubscribeMsg).catch((error) => {
          console.warn(`[MessageHub] Failed to send UNSUBSCRIBE message:`, error);
        });
      }

      // Remove from persisted subscriptions
      this.persistedSubscriptions.delete(subId);

      // Remove from active subscriptions
      sessionSubs.get(fullMethod)?.delete(handler as EventHandler);
      this.log(`Unsubscribed from: ${fullMethod} (session: ${sessionId})`);
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
   */
  private async handleIncomingMessage(message: HubMessage): Promise<void> {
    // Validate message structure
    if (!isValidMessage(message)) {
      console.error(`[MessageHub] Invalid message format:`, message);
      throw new Error(`Invalid message format: ${JSON.stringify(message)}`);
    }

    this.log(`← Incoming: ${message.type} ${message.method}`, message);

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
   */
  private handleResponse(message: HubMessage): void {
    const requestId = message.requestId;
    if (!requestId) {
      console.warn(`[MessageHub] Response without requestId:`, message);
      return;
    }

    const pending = this.pendingCalls.get(requestId);
    if (!pending) {
      console.warn(`[MessageHub] Response for unknown request: ${requestId}`);
      return;
    }

    // Clear timeout
    clearTimeout(pending.timer );
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
   */
  private async handleEvent(message: HubMessage): Promise<void> {
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

    // Execute all handlers
    for (const handler of handlers) {
      try {
        await Promise.resolve(handler(message.data, context));
      } catch (error) {
        console.error(`[MessageHub] Error in event handler for ${message.method}:`, error);
      }
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
   */
  private resubscribeAll(): void {
    if (this.persistedSubscriptions.size === 0) {
      return;
    }

    this.log(`Re-subscribing ${this.persistedSubscriptions.size} subscriptions after reconnection`);

    // Clear current subscriptions
    this.subscriptions.clear();

    // Re-establish all persisted subscriptions
    for (const [subId, { method, handler, options }] of this.persistedSubscriptions) {
      const sessionId = options.sessionId || this.defaultSessionId;

      // Initialize subscription maps if needed
      if (!this.subscriptions.has(sessionId)) {
        this.subscriptions.set(sessionId, new Map());
      }

      const sessionSubs = this.subscriptions.get(sessionId)!;

      if (!sessionSubs.has(method)) {
        sessionSubs.set(method, new Set());
      }

      sessionSubs.get(method)!.add(handler);
      this.log(`Re-subscribed to: ${method} (session: ${sessionId})`);
    }
  }

  /**
   * Cleanup all state
   */
  cleanup(): void {
    // Reject all pending calls
    for (const [requestId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer );
      pending.reject(new Error("MessageHub cleanup"));
    }
    this.pendingCalls.clear();

    // Clear handlers
    this.rpcHandlers.clear();
    this.subscriptions.clear();
    this.persistedSubscriptions.clear();
    this.messageHandlers.clear();
    this.connectionStateHandlers.clear();

    this.log("MessageHub cleaned up");
  }

  // ========================================
  // Utilities
  // ========================================

  /**
   * Validate and return method name (no transformation needed)
   *
   * This is intentionally a pass-through function for architectural clarity.
   * Session routing is handled via message.sessionId field, NOT method name prefixes.
   *
   * Historical note: Previously prepended sessionId to method names (e.g., "session123:method.name").
   * Now follows principle: "sessionId in message, not URL/method name"
   */
  private buildFullMethod(method: string, _sessionId: string): string {
    return method;
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
