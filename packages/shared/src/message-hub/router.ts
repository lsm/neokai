/**
 * MessageHub Router
 *
 * Server-side router for handling session-based message routing
 * Routes messages by sessionId to appropriate handlers
 */

import { generateUUID } from "../utils.ts";
import type { HubMessage } from "./protocol.ts";
import {
  MessageType,
  createEventMessage,
  isPublishMessage,
} from "./protocol.ts";
import type { UnsubscribeFn } from "./types.ts";

/**
 * Subscription tracker for routing events to specific clients
 */
interface Subscription {
  sessionId: string;
  method: string;
  clientId: string;
}

/**
 * Client information
 */
interface ClientInfo {
  clientId: string;
  ws: WebSocket;
  connectedAt: number;
  subscriptions: Set<string>; // Set of "sessionId:method"
}

/**
 * MessageHub Router for server-side
 *
 * Responsibilities:
 * - Route messages by sessionId
 * - Manage client subscriptions
 * - Broadcast events to subscribed clients
 * - Handle PUBLISH → EVENT conversion
 */
export class MessageHubRouter {
  private clients: Map<WebSocket, ClientInfo> = new Map();
  private subscriptions: Map<string, Map<string, Set<string>>> = new Map();
  //                          ^sessionId  ^method   ^clientIds

  /**
   * Register a WebSocket client
   */
  registerClient(ws: WebSocket): string {
    const clientId = generateUUID();
    const info: ClientInfo = {
      clientId,
      ws,
      connectedAt: Date.now(),
      subscriptions: new Set(),
    };

    this.clients.set(ws, info);
    console.log(`[MessageHubRouter] Client registered: ${clientId}`);

    return clientId;
  }

  /**
   * Unregister a WebSocket client
   */
  unregisterClient(ws: WebSocket): void {
    const info = this.clients.get(ws);
    if (!info) {
      return;
    }

    // Remove all subscriptions for this client
    for (const sub of info.subscriptions) {
      const [sessionId, method] = sub.split(":");
      this.unsubscribeClient(sessionId, method, info.clientId);
    }

    this.clients.delete(ws);
    console.log(`[MessageHubRouter] Client unregistered: ${info.clientId}`);
  }

  /**
   * Subscribe a client to a method in a session
   */
  subscribe(sessionId: string, method: string, clientId: string): void {
    // Initialize maps if needed
    if (!this.subscriptions.has(sessionId)) {
      this.subscriptions.set(sessionId, new Map());
    }

    const sessionSubs = this.subscriptions.get(sessionId)!;

    if (!sessionSubs.has(method)) {
      sessionSubs.set(method, new Set());
    }

    sessionSubs.get(method)!.add(clientId);

    // Track subscription in client info
    const client = Array.from(this.clients.values()).find(c => c.clientId === clientId);
    if (client) {
      client.subscriptions.add(`${sessionId}:${method}`);
    }

    console.log(`[MessageHubRouter] Client ${clientId} subscribed to ${sessionId}:${method}`);
  }

  /**
   * Unsubscribe a client from a method in a session
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

    // Remove from client info
    const client = Array.from(this.clients.values()).find(c => c.clientId === clientId);
    if (client) {
      client.subscriptions.delete(`${sessionId}:${method}`);
    }

    console.log(`[MessageHubRouter] Client ${clientId} unsubscribed from ${sessionId}:${method}`);
  }

  /**
   * Route a PUBLISH message to subscribed clients
   * Converts PUBLISH to EVENT messages for each subscriber
   */
  routePublish(message: HubMessage): void {
    if (!isPublishMessage(message)) {
      console.warn(`[MessageHubRouter] Not a PUBLISH message:`, message);
      return;
    }

    const sessionSubs = this.subscriptions.get(message.sessionId);
    if (!sessionSubs) {
      console.log(`[MessageHubRouter] No subscriptions for session: ${message.sessionId}`);
      return;
    }

    const methodSubs = sessionSubs.get(message.method);
    if (!methodSubs || methodSubs.size === 0) {
      console.log(`[MessageHubRouter] No subscribers for ${message.sessionId}:${message.method}`);
      return;
    }

    // Create EVENT message
    const eventMessage = createEventMessage({
      method: message.method,
      data: message.data,
      sessionId: message.sessionId,
    });

    // Send to all subscribed clients
    let sentCount = 0;
    for (const clientId of methodSubs) {
      const client = Array.from(this.clients.values()).find(c => c.clientId === clientId);
      if (client && client.ws.readyState === 1) { // WebSocket.OPEN
        try {
          client.ws.send(JSON.stringify(eventMessage));
          sentCount++;
        } catch (error) {
          console.error(`[MessageHubRouter] Failed to send to client ${clientId}:`, error);
        }
      }
    }

    console.log(
      `[MessageHubRouter] Routed ${message.sessionId}:${message.method} to ${sentCount} clients`,
    );
  }

  /**
   * Send a message to a specific client
   */
  sendToClient(clientId: string, message: HubMessage): void {
    const client = Array.from(this.clients.values()).find(c => c.clientId === clientId);
    if (!client) {
      console.warn(`[MessageHubRouter] Client not found: ${clientId}`);
      return;
    }

    if (client.ws.readyState !== 1) { // WebSocket.OPEN
      console.warn(`[MessageHubRouter] Client not ready: ${clientId}`);
      return;
    }

    try {
      client.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`[MessageHubRouter] Failed to send to client ${clientId}:`, error);
    }
  }

  /**
   * Broadcast a message to all clients
   */
  broadcast(message: HubMessage): void {
    const json = JSON.stringify(message);
    let sentCount = 0;

    for (const client of this.clients.values()) {
      if (client.ws.readyState === 1) { // WebSocket.OPEN
        try {
          client.ws.send(json);
          sentCount++;
        } catch (error) {
          console.error(`[MessageHubRouter] Failed to broadcast to client ${client.clientId}:`, error);
        }
      }
    }

    console.log(`[MessageHubRouter] Broadcast message to ${sentCount} clients`);
  }

  /**
   * Get client info by WebSocket
   */
  getClientInfo(ws: WebSocket): ClientInfo | undefined {
    return this.clients.get(ws);
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
   * Auto-subscribe client to common patterns
   * This is a convenience method for implicit subscriptions
   */
  autoSubscribe(ws: WebSocket, sessionId: string): void {
    const info = this.clients.get(ws);
    if (!info) {
      return;
    }

    // Auto-subscribe to common events based on sessionId
    if (sessionId === "global") {
      // Global session: subscribe to session management events
      this.subscribe("global", "session.created", info.clientId);
      this.subscribe("global", "session.updated", info.clientId);
      this.subscribe("global", "session.deleted", info.clientId);
    } else {
      // Specific session: subscribe to session-specific events
      this.subscribe(sessionId, "sdk.message", info.clientId);
      this.subscribe(sessionId, "context.updated", info.clientId);
      this.subscribe(sessionId, "message.queued", info.clientId);
    }

    console.log(`[MessageHubRouter] Auto-subscribed client ${info.clientId} to ${sessionId} events`);
  }
}
