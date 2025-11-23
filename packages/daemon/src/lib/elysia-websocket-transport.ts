/**
 * Elysia WebSocket Transport for MessageHub
 *
 * Bridges Elysia's WebSocket API with MessageHub's IMessageTransport interface.
 * Manages multiple WebSocket clients and routes messages to/from MessageHub.
 */

import type { HubMessage, IMessageTransport, ConnectionState } from "@liuboer/shared";
import { generateUUID } from "@liuboer/shared";

interface WebSocketClient {
  id: string;
  ws: any; // Elysia WebSocket
  sessionId: string;
}

export interface ElysiaWebSocketTransportOptions {
  name?: string;
  debug?: boolean;
}

export class ElysiaWebSocketTransport implements IMessageTransport {
  readonly name: string;
  private clients: Map<string, WebSocketClient> = new Map();
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<(state: ConnectionState, error?: Error) => void> = new Set();
  private debug: boolean;

  constructor(options: ElysiaWebSocketTransportOptions = {}) {
    this.name = options.name || "elysia-websocket";
    this.debug = options.debug || false;
  }

  /**
   * Register a WebSocket client
   */
  registerClient(ws: any, sessionId: string): string {
    const clientId = generateUUID();
    this.clients.set(clientId, { id: clientId, ws, sessionId });

    this.log(`Client registered: ${clientId} (session: ${sessionId})`);

    // Notify connection handlers
    this.notifyConnectionHandlers("connected");

    return clientId;
  }

  /**
   * Unregister a WebSocket client
   */
  unregisterClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.clients.delete(clientId);
      this.log(`Client unregistered: ${clientId}`);

      if (this.clients.size === 0) {
        this.notifyConnectionHandlers("disconnected");
      }
    }
  }

  /**
   * Handle incoming message from a WebSocket client
   */
  handleClientMessage(message: HubMessage): void {
    this.log(`Received message: ${message.type} ${message.method}`, message);

    // Notify all message handlers
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error(`Error in message handler:`, error);
      }
    }
  }

  /**
   * Send message to specific client(s) or broadcast
   */
  async send(message: HubMessage): Promise<void> {
    const targetSessionId = message.sessionId;
    let sentCount = 0;

    // Find all clients for this session and send
    for (const client of this.clients.values()) {
      if (client.sessionId === targetSessionId || targetSessionId === "global") {
        try {
          const data = JSON.stringify(message);
          client.ws.send(data);
          sentCount++;
          this.log(`Sent to client ${client.id}:`, message.type, message.method);
        } catch (error) {
          console.error(`Error sending to client ${client.id}:`, error);
        }
      }
    }

    if (sentCount === 0) {
      this.log(`No clients found for session: ${targetSessionId}`);
    }
  }

  /**
   * Subscribe to incoming messages
   */
  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to connection state changes
   */
  onConnectionChange(handler: (state: ConnectionState, error?: Error) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.clients.size > 0 ? "connected" : "disconnected";
  }

  /**
   * Check if ready to send messages
   */
  isReady(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get client by ID
   */
  getClient(clientId: string): WebSocketClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Broadcast to all clients in a session
   */
  async broadcastToSession(sessionId: string, message: HubMessage): Promise<void> {
    const sessionMessage = { ...message, sessionId };
    await this.send(sessionMessage);
  }

  private notifyConnectionHandlers(state: ConnectionState, error?: Error): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch (err) {
        console.error(`Error in connection handler:`, err);
      }
    }
  }

  private log(message: string, ...args: any[]): void {
    if (this.debug) {
      console.log(`[${this.name}] ${message}`, ...args);
    }
  }
}
