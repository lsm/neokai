/**
 * WebSocket Client Transport for MessageHub
 *
 * Client-side WebSocket transport without sessionId in URL
 */

import type {
  IMessageTransport,
  ConnectionState,
  ConnectionStateHandler,
  UnsubscribeFn,
} from "./types.ts";
import type { HubMessage } from "./protocol.ts";

export interface WebSocketClientTransportOptions {
  /**
   * WebSocket URL (no sessionId in path!)
   */
  url: string;

  /**
   * Auto-reconnect on disconnect
   */
  autoReconnect?: boolean;

  /**
   * Maximum reconnection attempts
   */
  maxReconnectAttempts?: number;

  /**
   * Base reconnection delay in milliseconds
   */
  reconnectDelay?: number;

  /**
   * Heartbeat/ping interval in milliseconds
   */
  pingInterval?: number;
}

/**
 * WebSocket client transport for MessageHub
 */
export class WebSocketClientTransport implements IMessageTransport {
  readonly name = "websocket-client";

  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly pingInterval: number;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<ConnectionStateHandler> = new Set();

  constructor(options: WebSocketClientTransportOptions) {
    this.url = options.url;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.pingInterval = options.pingInterval ?? 30000;
  }

  /**
   * Initialize transport (connect)
   */
  async initialize(): Promise<void> {
    return this.connect();
  }

  /**
   * Connect to WebSocket
   */
  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.setState("connecting");

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log(`[${this.name}] Connected to ${this.url}`);
          this.setState("connected");
          this.reconnectAttempts = 0;
          this.startPing();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error(`[${this.name}] WebSocket error:`, error);
          this.setState("error", new Error("WebSocket error"));
        };

        this.ws.onclose = () => {
          console.log(`[${this.name}] Disconnected`);
          this.setState("disconnected");
          this.stopPing();
          this.handleDisconnect();
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.setState("error", err);
        reject(err);
      }
    });
  }

  /**
   * Handle disconnect
   *
   * FIX P1.2: Add jitter to prevent thundering herd on reconnect
   */
  private handleDisconnect(): void {
    if (!this.autoReconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[${this.name}] Max reconnection attempts (${this.maxReconnectAttempts}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;

    // FIX P1.2: Add exponential backoff + jitter (±30%) to prevent thundering herd
    const baseDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const jitter = Math.random() * baseDelay * 0.6 - baseDelay * 0.3; // ±30%
    const delay = Math.max(100, baseDelay + jitter); // Minimum 100ms

    console.log(
      `[${this.name}] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error(`[${this.name}] Reconnection failed:`, error);
      });
    }, delay);
  }

  /**
   * Send a message
   */
  async send(message: HubMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error("WebSocket not connected");
    }

    const json = JSON.stringify(message);
    this.ws!.send(json);
  }

  /**
   * Close transport
   */
  async close(): Promise<void> {
    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer );
      this.reconnectTimer = null;
    }
    this.stopPing();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState("disconnected");
  }

  /**
   * Check if transport is ready
   */
  isReady(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
   * Handle incoming message
   */
  private handleMessage(data: string): void {
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
   * Start ping/heartbeat
   *
   * FIX P1.1: Send real PING messages to detect half-open connections
   */
  private startPing(): void {
    if (this.pingInterval <= 0) {
      return;
    }

    this.stopPing();

    this.pingTimer = setInterval(() => {
      if (this.isReady()) {
        // FIX P1.1: Send actual PING message (not just check readyState)
        const pingMessage = {
          id: crypto.randomUUID(),
          type: "PING" as const,
          method: "heartbeat",
          sessionId: "global",
          timestamp: new Date().toISOString(),
        };

        try {
          this.ws!.send(JSON.stringify(pingMessage));
        } catch (error) {
          console.error(`[${this.name}] Failed to send PING:`, error);
          this.handleDisconnect();
        }
      }
    }, this.pingInterval);
  }

  /**
   * Stop ping/heartbeat
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer );
      this.pingTimer = null;
    }
  }
}
