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
  isCallMessage,
  isResponseMessage,
  isEventMessage,
  validateMethod,
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
} from "./types.ts";

/**
 * MessageHub class
 * Core implementation of unified messaging system
 */
export class MessageHub {
  private transport: IMessageTransport | null = null;
  private readonly defaultSessionId: string;
  private readonly defaultTimeout: number;
  private readonly debug: boolean;

  // RPC state
  private pendingCalls: Map<string, PendingCall> = new Map();
  private rpcHandlers: Map<string, RPCHandler> = new Map();

  // Pub/Sub state
  private subscriptions: Map<string, Map<string, Set<EventHandler>>> = new Map();
  //                          ^sessionId  ^method   ^handlers

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

    const messageId = generateUUID();
    const sessionId = options.sessionId || this.defaultSessionId;
    const timeout = options.timeout || this.defaultTimeout;

    // Build full method name with session scoping
    const fullMethod = this.buildFullMethod(method, sessionId);

    if (!validateMethod(fullMethod)) {
      throw new Error(`Invalid method name: ${fullMethod}`);
    }

    return new Promise<TResult>((resolve, reject) => {
      // Setup timeout
      const timer = setTimeout(() => {
        this.pendingCalls.delete(messageId);
        reject(new Error(`RPC timeout: ${fullMethod} (${timeout}ms)`));
      }, timeout);

      // Store pending call
      this.pendingCalls.set(messageId, {
        resolve,
        reject,
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
        reject(error);
      });
    });
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

    // Return unsubscribe function
    return () => {
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
    this.log(`← Incoming: ${message.type} ${message.method}`, message);

    // Notify message handlers
    this.notifyMessageHandlers(message, "in");

    try {
      if (isCallMessage(message)) {
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
   * Send a message via transport
   */
  private async sendMessage(message: HubMessage): Promise<void> {
    if (!this.transport || !this.transport.isReady()) {
      throw new Error("Transport not ready");
    }

    this.log(`→ Outgoing: ${message.type} ${message.method}`, message);

    // Notify message handlers
    this.notifyMessageHandlers(message, "out");

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
    this.messageHandlers.clear();
    this.connectionStateHandlers.clear();

    this.log("MessageHub cleaned up");
  }

  // ========================================
  // Utilities
  // ========================================

  /**
   * Build full method name
   * No longer prepends session ID - routing is handled via message.sessionId field
   */
  private buildFullMethod(method: string, sessionId: string): string {
    // Keep method names clean - session routing is handled via the sessionId field
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
