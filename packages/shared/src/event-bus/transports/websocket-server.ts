/**
 * WebSocket Server Transport for Daemon
 *
 * Manages WebSocket connections on the server side and broadcasts events
 * to connected clients.
 */

import type { Event } from "../../types";
import type {
  ITransport,
  TransportEventHandler,
  ConnectionChangeHandler,
  ConnectionState,
  TransportOptions,
} from "../transport";

/**
 * Options for WebSocket server transport
 */
export interface WebSocketServerTransportOptions extends TransportOptions {
  /**
   * Session ID for session-scoped connections
   */
  sessionId: string;
}

/**
 * WebSocket Server Transport
 *
 * Manages multiple WebSocket client connections for a session and
 * broadcasts events to all connected clients.
 */
export class WebSocketServerTransport implements ITransport {
  readonly name = "websocket-server";

  private websockets: Set<WebSocket> = new Set();
  private eventHandlers: Set<TransportEventHandler> = new Set();
  private connectionHandlers: Set<ConnectionChangeHandler> = new Set();
  private sessionId: string;
  private state: ConnectionState = "disconnected";

  constructor(options: WebSocketServerTransportOptions) {
    this.sessionId = options.sessionId;
  }

  async initialize(): Promise<void> {
    this.state = "connected";
    this.notifyConnectionChange("connected");
  }

  async send(event: Event): Promise<void> {
    if (this.websockets.size === 0) {
      return;
    }

    const message = JSON.stringify(event);
    const deadSockets: WebSocket[] = [];

    for (const ws of this.websockets) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        } else {
          deadSockets.push(ws);
        }
      } catch (error) {
        console.error("Error sending WebSocket message:", error);
        deadSockets.push(ws);
      }
    }

    // Clean up dead sockets
    deadSockets.forEach((ws) => this.websockets.delete(ws));
  }

  async close(): Promise<void> {
    // Close all websocket connections
    for (const ws of this.websockets) {
      try {
        ws.close();
      } catch (error) {
        console.error("Error closing WebSocket:", error);
      }
    }

    this.websockets.clear();
    this.state = "disconnected";
    this.notifyConnectionChange("disconnected");
  }

  isReady(): boolean {
    return this.websockets.size > 0;
  }

  onEvent(handler: TransportEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: ConnectionChangeHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * Subscribe a WebSocket to this transport
   */
  subscribeWebSocket(ws: WebSocket): void {
    this.websockets.add(ws);
    console.log(
      `WebSocket subscribed to session ${this.sessionId}. Total: ${this.websockets.size}`,
    );

    if (this.websockets.size === 1) {
      this.notifyConnectionChange("connected");
    }
  }

  /**
   * Unsubscribe a WebSocket from this transport
   */
  unsubscribeWebSocket(ws: WebSocket): void {
    this.websockets.delete(ws);
    console.log(
      `WebSocket unsubscribed from session ${this.sessionId}. Remaining: ${this.websockets.size}`,
    );

    if (this.websockets.size === 0) {
      this.notifyConnectionChange("disconnected");
    }
  }

  /**
   * Handle incoming message from a WebSocket client
   */
  handleMessage(message: string | Event): void {
    try {
      const event: Event = typeof message === "string" ? JSON.parse(message) : message;

      // Validate event
      if (!event.type || !event.sessionId) {
        console.error("Invalid event format:", event);
        return;
      }

      // Emit to event handlers
      for (const handler of this.eventHandlers) {
        handler(event).catch((error) => {
          console.error("Error in event handler:", error);
        });
      }
    } catch (error) {
      console.error("Error handling WebSocket message:", error);
    }
  }

  /**
   * Get count of connected WebSockets
   */
  getConnectionCount(): number {
    return this.websockets.size;
  }

  /**
   * Notify connection state change
   */
  private notifyConnectionChange(state: ConnectionState, error?: Error): void {
    this.state = state;
    for (const handler of this.connectionHandlers) {
      handler(state, error);
    }
  }
}
