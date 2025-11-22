/**
 * WebSocket Client Transport for Web UI
 *
 * Handles WebSocket connection to the daemon server with automatic
 * reconnection and heartbeat support.
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
 * Options for WebSocket client transport
 */
export interface WebSocketClientTransportOptions extends TransportOptions {
  /**
   * WebSocket URL to connect to
   */
  url: string;

  /**
   * Ping interval in milliseconds (default: 30000)
   */
  pingInterval?: number;
}

/**
 * WebSocket Client Transport
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Heartbeat (ping/pong)
 * - Connection state management
 * - Message queuing while disconnected
 */
export class WebSocketClientTransport implements ITransport {
  readonly name = "websocket-client";

  private ws: WebSocket | null = null;
  private url: string;
  private state: ConnectionState = "disconnected";
  private eventHandlers: Set<TransportEventHandler> = new Set();
  private connectionHandlers: Set<ConnectionChangeHandler> = new Set();
  private messageQueue: Event[] = [];
  private reconnectAttempts = 0;
  private pingInterval: number | null = null;
  private options: Required<WebSocketClientTransportOptions>;

  constructor(options: WebSocketClientTransportOptions) {
    if (!options.sessionId) {
      throw new Error("WebSocketClientTransport requires sessionId");
    }

    this.url = options.url;
    this.options = {
      url: options.url,
      sessionId: options.sessionId,
      autoReconnect: options.autoReconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
      reconnectDelay: options.reconnectDelay ?? 1000,
      pingInterval: options.pingInterval ?? 30000,
    };
  }

  async initialize(): Promise<void> {
    return this.connect();
  }

  async send(event: Event): Promise<void> {
    if (!this.isReady()) {
      // Queue message if auto-reconnect is enabled
      if (this.options.autoReconnect) {
        this.messageQueue.push(event);
        console.log(`Message queued (${this.messageQueue.length} in queue)`);
      } else {
        throw new Error("WebSocket not connected");
      }
      return;
    }

    const message = JSON.stringify(event);
    this.ws!.send(message);
  }

  async close(): Promise<void> {
    this.options.autoReconnect = false;

    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState("disconnected");
    this.messageQueue = [];
  }

  isReady(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Connect to WebSocket server
   */
  private async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.CONNECTING || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.setState("connecting");

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log(`WebSocket connected to ${this.url}`);
        this.reconnectAttempts = 0;
        this.setState("connected");
        this.startPingInterval();
        this.flushMessageQueue();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Event;

          // Handle pong responses
          if (data.type === "pong") {
            return;
          }

          // Emit to event handlers
          for (const handler of this.eventHandlers) {
            handler(data).catch((error) => {
              console.error("Error in event handler:", error);
            });
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        this.setState("error", new Error("WebSocket error"));
      };

      this.ws.onclose = () => {
        console.log("WebSocket closed");
        this.stopPingInterval();
        this.setState("disconnected");

        if (this.options.autoReconnect) {
          this.attemptReconnect();
        }
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error creating WebSocket:", err);
      this.setState("error", err);

      if (this.options.autoReconnect) {
        this.attemptReconnect();
      }
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      this.setState("error", new Error("Max reconnection attempts reached"));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(
      `Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts})`,
    );

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Start sending periodic pings
   */
  private startPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      if (this.isReady()) {
        this.ws!.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, this.options.pingInterval) as unknown as number;
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Flush queued messages
   */
  private async flushMessageQueue(): Promise<void> {
    if (this.messageQueue.length === 0) {
      return;
    }

    console.log(`Flushing ${this.messageQueue.length} queued message(s)`);

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const event of queue) {
      try {
        await this.send(event);
      } catch (error) {
        console.error("Error sending queued message:", error);
        // Re-queue on failure
        this.messageQueue.push(event);
      }
    }
  }

  /**
   * Set connection state and notify handlers
   */
  private setState(state: ConnectionState, error?: Error): void {
    this.state = state;
    for (const handler of this.connectionHandlers) {
      handler(state, error);
    }
  }
}
