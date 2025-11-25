/**
 * MessageHub Router
 *
 * Server-side router for handling session-based message routing
 * Routes messages by sessionId to appropriate handlers
 *
 * ARCHITECTURE:
 * - Pure routing layer - NO application logic
 * - O(1) client lookups with reverse index
 * - Memory leak prevention with empty Map cleanup
 * - Subscription key validation
 * - Duplicate registration prevention
 * - Observability with delivery stats
 * - Pluggable logger interface
 * - Transport-agnostic design (works with any connection type)
 * - Abstract ClientConnection interface
 * - Decoupled from WebSocket specifics
 */

import { generateUUID } from "../utils.ts";
import type { HubMessage } from "./protocol.ts";
import {
  MessageType,
  isEventMessage,
} from "./protocol.ts";
import type { UnsubscribeFn } from "./types.ts";

/**
 * Abstract connection interface
 * Allows router to work with any transport (WebSocket, HTTP/2, etc.)
 */
export interface ClientConnection {
  /** Unique connection identifier */
  id: string;
  /** Send data to the client */
  send(data: string): void;
  /** Check if connection is open and ready */
  isOpen(): boolean;
  /** FIX P0.6: Check if connection can accept messages (backpressure) */
  canAccept?(): boolean;
  /** Optional: Get connection metadata */
  metadata?: Record<string, any>;
}

/**
 * Logger interface for dependency injection
 */
export interface RouterLogger {
  log(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/**
 * Router configuration options
 */
export interface MessageHubRouterOptions {
  logger?: RouterLogger;
  debug?: boolean;
  /**
   * Maximum subscriptions per client (prevents subscription bombing)
   * @default 1000
   */
  maxSubscriptionsPerClient?: number;
}

/**
 * Client information
 */
interface ClientInfo {
  clientId: string;
  connection: ClientConnection;
  connectedAt: number;
  subscriptions: Map<string, Set<string>>; // Map<sessionId, Set<method>>
}

/**
 * Route result with delivery statistics
 */
export interface RouteResult {
  sent: number;
  failed: number;
  totalSubscribers: number;
  sessionId: string;
  method: string;
}

/**
 * MessageHub Router for server-side
 *
 * Responsibilities:
 * - Route messages by sessionId
 * - Manage client subscriptions
 * - Broadcast events to subscribed clients
 */
export class MessageHubRouter {
  private clients: Map<string, ClientInfo> = new Map(); // Now keyed by clientId
  private subscriptions: Map<string, Map<string, Set<string>>> = new Map();
  //                          ^sessionId  ^method   ^clientIds

  private logger: RouterLogger;
  private debug: boolean;
  private readonly maxSubscriptionsPerClient: number;

  constructor(options: MessageHubRouterOptions = {}) {
    this.logger = options.logger || console;
    this.debug = options.debug || false;
    this.maxSubscriptionsPerClient = options.maxSubscriptionsPerClient || 1000;
  }

  /**
   * Register a client connection
   * Prevents duplicate registration
   */
  registerConnection(connection: ClientConnection): string {
    // Check for duplicate registration
    const existing = this.clients.get(connection.id);
    if (existing) {
      this.log(`Client already registered: ${existing.clientId}, returning existing ID`);
      return existing.clientId;
    }

    const info: ClientInfo = {
      clientId: connection.id,
      connection,
      connectedAt: Date.now(),
      subscriptions: new Map(),
    };

    this.clients.set(connection.id, info);
    this.log(`Client registered: ${connection.id}`);

    return connection.id;
  }

  /**
   * Unregister a client by clientId
   * Cleans up all subscriptions
   */
  unregisterConnection(clientId: string): void {
    const info = this.clients.get(clientId);
    if (!info) {
      return;
    }

    // Remove all subscriptions for this client
    for (const [sessionId, methods] of info.subscriptions.entries()) {
      for (const method of methods) {
        this.unsubscribeClient(sessionId, method, info.clientId);
      }
    }

    this.clients.delete(clientId);
    this.log(`Client unregistered: ${info.clientId}`);
  }

  /**
   * Subscribe a client to a method in a session
   *
   * FIXES:
   * - ✅ P1.4: Validates clientId (non-empty string)
   * - ✅ P1.3: Enforces max subscriptions limit per client
   * - ✅ P2.5: Warns on duplicate subscriptions (idempotent)
   */
  subscribe(sessionId: string, method: string, clientId: string): void {
    // FIX P1.4: Validate clientId
    if (!clientId || typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw new Error(`Invalid clientId: ${JSON.stringify(clientId)}`);
    }

    // Validate sessionId - colons not allowed (reserved for internal routing)
    if (sessionId.includes(':')) {
      throw new Error('SessionId cannot contain colon character (reserved for internal use)');
    }

    // Validate method format (including colon restriction)
    if (method.includes(':')) {
      throw new Error('Method cannot contain colon character (reserved for internal use)');
    }

    // FIX P1.3: Check subscription limit before adding
    const client = this.getClientById(clientId);
    if (client) {
      // Count total subscriptions across all sessions
      let totalSubs = 0;
      for (const methods of client.subscriptions.values()) {
        totalSubs += methods.size;
      }

      // Check if already subscribed (idempotent)
      const existingMethods = client.subscriptions.get(sessionId);
      const alreadySubscribed = existingMethods?.has(method);

      if (!alreadySubscribed && totalSubs >= this.maxSubscriptionsPerClient) {
        throw new Error(
          `Client ${clientId} has reached max subscriptions limit (${this.maxSubscriptionsPerClient})`
        );
      }

      // FIX P2.5: Warn on duplicate subscriptions (but allow - idempotent)
      if (alreadySubscribed) {
        this.logger.warn(
          `[MessageHubRouter] Client ${clientId} already subscribed to ${sessionId}:${method}`
        );
        return; // Idempotent - do nothing
      }
    }

    // Initialize maps if needed
    if (!this.subscriptions.has(sessionId)) {
      this.subscriptions.set(sessionId, new Map());
    }

    const sessionSubs = this.subscriptions.get(sessionId)!;

    if (!sessionSubs.has(method)) {
      sessionSubs.set(method, new Set());
    }

    sessionSubs.get(method)!.add(clientId);

    // FIX P0.1: Re-check client exists AFTER adding subscription (race condition fix)
    // Client could have disconnected between line 180 and here!
    const clientNow = this.getClientById(clientId);
    if (!clientNow) {
      // Client disconnected - cleanup the subscription we just added
      sessionSubs.get(method)!.delete(clientId);

      // Cleanup empty maps
      if (sessionSubs.get(method)!.size === 0) {
        sessionSubs.delete(method);
        if (sessionSubs.size === 0) {
          this.subscriptions.delete(sessionId);
        }
      }

      this.logger.warn(
        `Client ${clientId} disconnected during subscription to ${sessionId}:${method} - cleaned up`
      );
      return;
    }

    // Track subscription in client info using O(1) lookup
    if (!clientNow.subscriptions.has(sessionId)) {
      clientNow.subscriptions.set(sessionId, new Set());
    }
    clientNow.subscriptions.get(sessionId)!.add(method);

    this.log(`Client ${clientId} subscribed to ${sessionId}:${method}`);
  }

  /**
   * Unsubscribe a client from a method in a session
   * Cleans up empty Maps to prevent memory leaks
   */
  unsubscribeClient(sessionId: string, method: string, clientId: string): void {
    const sessionSubs = this.subscriptions.get(sessionId);
    if (!sessionSubs) {
      return;
    }

    const methodSubs = sessionSubs.get(method);
    if (!methodSubs) {
      return;
    }

    methodSubs.delete(clientId);

    // MEMORY LEAK FIX: Cleanup empty structures
    if (methodSubs.size === 0) {
      sessionSubs.delete(method);
      if (sessionSubs.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    }

    // Remove from client info using O(1) lookup
    const client = this.getClientById(clientId);
    if (client) {
      const clientMethods = client.subscriptions.get(sessionId);
      if (clientMethods) {
        clientMethods.delete(method);
        if (clientMethods.size === 0) {
          client.subscriptions.delete(sessionId);
        }
      }
    }

    this.log(`Client ${clientId} unsubscribed from ${sessionId}:${method}`);
  }

  /**
   * Route an EVENT message to subscribed clients
   * Returns delivery statistics for observability
   */
  routeEvent(message: HubMessage): RouteResult {
    if (!isEventMessage(message)) {
      this.logger.warn(`[MessageHubRouter] Not an EVENT message:`, message);
      return {
        sent: 0,
        failed: 0,
        totalSubscribers: 0,
        sessionId: message.sessionId,
        method: message.method,
      };
    }

    const sessionSubs = this.subscriptions.get(message.sessionId);
    if (!sessionSubs) {
      this.log(`No subscriptions for session: ${message.sessionId}`);
      return {
        sent: 0,
        failed: 0,
        totalSubscribers: 0,
        sessionId: message.sessionId,
        method: message.method,
      };
    }

    const methodSubs = sessionSubs.get(message.method);
    if (!methodSubs || methodSubs.size === 0) {
      this.log(`No subscribers for ${message.sessionId}:${message.method}`);
      return {
        sent: 0,
        failed: 0,
        totalSubscribers: 0,
        sessionId: message.sessionId,
        method: message.method,
      };
    }

    // Send to all subscribed clients
    let sentCount = 0;
    let failedCount = 0;
    const json = JSON.stringify(message);

    for (const clientId of methodSubs) {
      const client = this.getClientById(clientId);
      if (client && client.connection.isOpen()) {
        try {
          client.connection.send(json);
          sentCount++;
        } catch (error) {
          this.logger.error(`Failed to send to client ${clientId}:`, error);
          failedCount++;
        }
      } else {
        failedCount++;
      }
    }

    this.log(
      `Routed ${message.sessionId}:${message.method} to ${sentCount}/${methodSubs.size} clients`,
    );

    return {
      sent: sentCount,
      failed: failedCount,
      totalSubscribers: methodSubs.size,
      sessionId: message.sessionId,
      method: message.method,
    };
  }

  /**
   * Send a message to a specific client
   */
  sendToClient(clientId: string, message: HubMessage): boolean {
    const client = this.getClientById(clientId);
    if (!client) {
      this.logger.warn(`[MessageHubRouter] Client not found: ${clientId}`);
      return false;
    }

    if (!client.connection.isOpen()) {
      this.logger.warn(`[MessageHubRouter] Client not ready: ${clientId}`);
      return false;
    }

    try {
      client.connection.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.error(`[MessageHubRouter] Failed to send to client ${clientId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast a message to all clients
   * FIX P0.6: Check backpressure before sending to prevent server OOM
   */
  broadcast(message: HubMessage): { sent: number; failed: number; skipped?: number } {
    const json = JSON.stringify(message);
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const client of this.clients.values()) {
      if (!client.connection.isOpen()) {
        failedCount++;
        continue;
      }

      // FIX P0.6: Check backpressure before sending
      if (client.connection.canAccept && !client.connection.canAccept()) {
        this.logger.warn(
          `Skipping broadcast to client ${client.clientId} - queue full (backpressure)`
        );
        skippedCount++;
        continue;
      }

      try {
        client.connection.send(json);
        sentCount++;
      } catch (error) {
        this.logger.error(`Failed to broadcast to client ${client.clientId}:`, error);
        failedCount++;
      }
    }

    this.log(
      `Broadcast message to ${sentCount} clients (${failedCount} failed, ${skippedCount} skipped)`
    );

    return { sent: sentCount, failed: failedCount, skipped: skippedCount };
  }

  /**
   * Get client info by clientId (O(1) lookup)
   */
  getClientById(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Get active client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get subscription count for a method
   */
  getSubscriptionCount(sessionId: string, method: string): number {
    const sessionSubs = this.subscriptions.get(sessionId);
    if (!sessionSubs) {
      return 0;
    }
    return sessionSubs.get(method)?.size || 0;
  }

  /**
   * Get all subscriptions for debugging
   */
  getSubscriptions(): Map<string, Map<string, Set<string>>> {
    return new Map(this.subscriptions);
  }

  /**
   * Handle incoming message from a client
   * This allows the router to process messages directly
   */
  handleMessage(message: HubMessage, clientId: string): void {
    // Router can intercept and process certain message types
    // For now, this is a placeholder for future functionality
    this.log(`Received message from client ${clientId}: ${message.type} ${message.method}`);
  }

  /**
   * Get all connected client IDs
   */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Debug logging
   */
  private log(message: string, ...args: any[]): void {
    if (this.debug) {
      this.logger.log(`[MessageHubRouter] ${message}`, ...args);
    }
  }
}
