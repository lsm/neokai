/**
 * WebSocket Server Transport for MessageHub
 *
 * Server-side WebSocket transport without sessionId in URL
 * Handles multiple client connections
 */

import type {
  IMessageTransport,
  ConnectionState,
  ConnectionStateHandler,
  UnsubscribeFn,
} from "./types.ts";
import type { HubMessage } from "./protocol.ts";

/**
 * WebSocket server transport for MessageHub
 * Manages broadcast to multiple connected clients
 */
export class WebSocketServerTransport implements IMessageTransport {
  readonly name = "websocket-server";

  private clients: Set<WebSocket> = new Set();
  private state: ConnectionState = "disconnected";

  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<ConnectionStateHandler> = new Set();

  constructor() {
    // Server transport is initialized when first client connects
  }

  /**
   * Initialize transport
   */
  async initialize(): Promise<void> {
    this.setState("connected");
  }

  /**
   * Subscribe a WebSocket client
   */
  subscribeWebSocket(ws: WebSocket): void {
    this.clients.add(ws);
    console.log(`[${this.name}] Client connected (total: ${this.clients.size})`);

    // Setup client handlers
    ws.addEventListener("message", (event) => {
      this.handleClientMessage(event.data as string);
    });

    ws.addEventListener("close", () => {
      this.unsubscribeWebSocket(ws);
    });

    ws.addEventListener("error", (error) => {
      console.error(`[${this.name}] Client error:`, error);
    });

    // Update state
    if (this.state === "disconnected") {
      this.setState("connected");
    }
  }

  /**
   * Unsubscribe a WebSocket client
   */
  unsubscribeWebSocket(ws: WebSocket): void {
    this.clients.delete(ws);
    console.log(`[${this.name}] Client disconnected (total: ${this.clients.size})`);

    // Update state
    if (this.clients.size === 0) {
      this.setState("disconnected");
    }
  }

  /**
   * Send a message to all connected clients
   */
  async send(message: HubMessage): Promise<void> {
    const json = JSON.stringify(message);
    let sentCount = 0;

    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN = 1
        try {
          client.send(json);
          sentCount++;
        } catch (error) {
          console.error(`[${this.name}] Failed to send to client:`, error);
        }
      }
    }

    if (sentCount === 0 && this.clients.size > 0) {
      console.warn(`[${this.name}] No clients ready to receive message`);
    }
  }

  /**
   * Send a message to a specific client
   */
  async sendToClient(ws: WebSocket, message: HubMessage): Promise<void> {
    if (ws.readyState === 1) { // WebSocket.OPEN = 1
      const json = JSON.stringify(message);
      ws.send(json);
    }
  }

  /**
   * Close transport
   */
  async close(): Promise<void> {
    // Close all client connections
    for (const client of this.clients) {
      try {
        client.close();
      } catch (error) {
        console.error(`[${this.name}] Error closing client:`, error);
      }
    }

    this.clients.clear();
    this.setState("disconnected");
  }

  /**
   * Check if transport is ready
   */
  isReady(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Get connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Register handler for incoming messages
   */
  onMessage(handler: (message: HubMessage) => void): UnsubscribeFn {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Register handler for connection state changes
   */
  onConnectionChange(handler: ConnectionStateHandler): UnsubscribeFn {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * Handle incoming message from a client
   */
  private handleClientMessage(data: string): void {
    try {
      const message = JSON.parse(data) as HubMessage;

      // Notify all handlers
      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch (error) {
          console.error(`[${this.name}] Error in message handler:`, error);
        }
      }
    } catch (error) {
      console.error(`[${this.name}] Failed to parse message:`, error);
    }
  }

  /**
   * Set connection state
   */
  private setState(state: ConnectionState, error?: Error): void {
    if (this.state === state) {
      return;
    }

    this.state = state;

    // Notify all handlers
    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch (err) {
        console.error(`[${this.name}] Error in connection handler:`, err);
      }
    }
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.clients.size;
  }

  /**
   * Handle incoming message directly (for manual routing)
   */
  handleMessage(data: string): void {
    this.handleClientMessage(data);
  }
}
