/**
 * Transport Interface - Abstraction for different realtime messaging transports
 *
 * This interface allows EventBus to work with any transport mechanism:
 * WebSocket, SSE, Socket.IO, WebTransport, gRPC, etc.
 */

import type { Event } from "../types";

/**
 * Transport interface that all transport implementations must follow
 */
export interface ITransport {
  /**
   * Unique name for this transport (e.g., "websocket", "sse", "socket.io")
   */
  readonly name: string;

  /**
   * Initialize the transport (connect, setup listeners, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Send an event through this transport
   * @param event The event to send
   * @returns Promise that resolves when the event is sent
   */
  send(event: Event): Promise<void>;

  /**
   * Close/cleanup the transport
   */
  close(): Promise<void>;

  /**
   * Check if transport is ready to send
   */
  isReady(): boolean;

  /**
   * Register a handler for incoming events from this transport
   * @param handler Function to call when an event is received
   * @returns Unsubscribe function
   */
  onEvent(handler: TransportEventHandler): () => void;

  /**
   * Register a handler for connection state changes
   * @param handler Function to call when connection state changes
   * @returns Unsubscribe function
   */
  onConnectionChange(handler: ConnectionChangeHandler): () => void;
}

/**
 * Handler function for incoming transport events
 */
export type TransportEventHandler = (event: Event) => void | Promise<void>;

/**
 * Connection state
 */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

/**
 * Handler function for connection state changes
 */
export type ConnectionChangeHandler = (state: ConnectionState, error?: Error) => void;

/**
 * Base transport options
 */
export interface TransportOptions {
  /**
   * Session ID for session-scoped transports (REQUIRED)
   */
  sessionId: string;

  /**
   * Automatic reconnection
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
}
