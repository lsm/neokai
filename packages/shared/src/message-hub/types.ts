/**
 * MessageHub Types
 *
 * Type definitions for MessageHub API
 */

import type { HubMessage } from "./protocol.ts";

// Re-export HubMessage for convenience
export type { HubMessage };

/**
 * Unsubscribe function returned by subscribe operations
 */
export type UnsubscribeFn = () => void;

/**
 * RPC handler function
 * Handles incoming CALL messages and returns result
 */
export type RPCHandler<TData = unknown, TResult = unknown> = (
  data: TData,
  context: CallContext,
) => Promise<TResult> | TResult;

/**
 * Event handler function
 * Handles incoming EVENT messages
 */
export type EventHandler<TData = unknown> = (
  data: TData,
  context: EventContext,
) => void | Promise<void>;

/**
 * Message handler for raw message inspection
 */
export type MessageHandler = (
  message: HubMessage,
  direction: "in" | "out",
) => void | Promise<void>;

/**
 * Connection state change handler
 */
export type ConnectionStateHandler = (
  state: ConnectionState,
  error?: Error,
) => void;

/**
 * Context provided to RPC handlers
 */
export interface CallContext {
  /**
   * Message ID
   */
  messageId: string;

  /**
   * Session ID
   */
  sessionId: string;

  /**
   * Method name
   */
  method: string;

  /**
   * Timestamp
   */
  timestamp: string;
}

/**
 * Context provided to event handlers
 */
export interface EventContext {
  /**
   * Message ID
   */
  messageId: string;

  /**
   * Session ID
   */
  sessionId: string;

  /**
   * Method/Event name
   */
  method: string;

  /**
   * Timestamp
   */
  timestamp: string;
}

/**
 * Connection state
 */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

/**
 * Options for call()
 */
export interface CallOptions {
  /**
   * Override session ID
   */
  sessionId?: string;

  /**
   * RPC timeout in milliseconds
   * @default 10000
   */
  timeout?: number;
}

/**
 * Options for publish()
 */
export interface PublishOptions {
  /**
   * Target session ID
   * If not specified, uses default session ID
   */
  sessionId?: string;

  /**
   * Whether to broadcast to all connected clients
   * @default true
   */
  broadcast?: boolean;
}

/**
 * Options for subscribe()
 */
export interface SubscribeOptions {
  /**
   * Filter by session ID
   * If not specified, subscribes to all sessions
   */
  sessionId?: string;
}

/**
 * MessageHub configuration options
 */
export interface MessageHubOptions {
  /**
   * Default session ID for operations
   * @default "global"
   */
  defaultSessionId?: string;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Default RPC timeout in milliseconds
   * @default 10000
   */
  timeout?: number;

  /**
   * Auto-reconnect on disconnect
   * @default true
   */
  autoReconnect?: boolean;

  /**
   * Maximum reconnection attempts
   * @default 5
   */
  maxReconnectAttempts?: number;

  /**
   * Reconnection delay in milliseconds
   * @default 1000
   */
  reconnectDelay?: number;

  /**
   * Heartbeat/ping interval in milliseconds
   * Set to 0 to disable
   * @default 30000
   */
  pingInterval?: number;

  /**
   * Maximum number of pending RPC calls (backpressure)
   * @default 1000
   */
  maxPendingCalls?: number;

  /**
   * Maximum cache size for request deduplication
   * @default 500
   */
  maxCacheSize?: number;

  /**
   * Cache entry TTL in milliseconds
   * @default 60000 (1 minute)
   */
  cacheTTL?: number;

  /**
   * Maximum subscriptions per client (router-side)
   * @default 1000
   */
  maxSubscriptionsPerClient?: number;

  /**
   * Maximum event handler nesting depth (prevents infinite recursion)
   * @default 10
   */
  maxEventDepth?: number;

  /**
   * FIX P1.3: Warn on message sequence gaps (out-of-order or missing messages)
   * @default true
   */
  warnOnSequenceGap?: boolean;

  /**
   * FIX P1.4: Stop on first event handler error (strict mode)
   * If false (default), all handlers execute and errors are collected
   * If true, stops on first handler error
   * @default false
   */
  stopOnEventHandlerError?: boolean;
}

/**
 * Result of broadcast operation
 */
export interface BroadcastResult {
  sent: number;
  failed: number;
  totalTargets: number;
}

/**
 * Transport interface for MessageHub
 *
 * Transports are pure I/O layers - they send/receive messages but don't route.
 * MessageHub is responsible for determining message recipients.
 */
export interface IMessageTransport {
  /**
   * Transport name
   */
  readonly name: string;

  /**
   * Initialize transport (connect)
   */
  initialize(): Promise<void>;

  /**
   * Send a message to a specific client (server-side transports only)
   * @returns true if sent successfully, false otherwise
   */
  sendToClient?(clientId: string, message: HubMessage): Promise<boolean>;

  /**
   * Broadcast a message to multiple clients (server-side transports only)
   * @returns statistics about delivery success/failure
   */
  broadcastToClients?(clientIds: string[], message: HubMessage): Promise<BroadcastResult>;

  /**
   * Send a message (client-side: to server, server-side: broadcast to all)
   * @deprecated Use sendToClient or broadcastToClients for server-side transports
   */
  send(message: HubMessage): Promise<void>;

  /**
   * Close transport
   */
  close(): Promise<void>;

  /**
   * Check if transport is ready
   */
  isReady(): boolean;

  /**
   * Get connection state
   */
  getState(): ConnectionState;

  /**
   * Register handler for incoming messages
   */
  onMessage(handler: (message: HubMessage) => void): UnsubscribeFn;

  /**
   * Register handler for connection state changes
   */
  onConnectionChange(handler: ConnectionStateHandler): UnsubscribeFn;
}

/**
 * Pending RPC call tracker
 */
export interface PendingCall {
  /**
   * Promise resolve function
   */
  resolve: (data: any) => void;

  /**
   * Promise reject function
   */
  reject: (error: Error) => void;

  /**
   * Timeout timer (cross-platform compatible type)
   */
  timer: ReturnType<typeof setTimeout>;

  /**
   * Method name
   */
  method: string;

  /**
   * Session ID
   */
  sessionId: string;
}
