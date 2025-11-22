/**
 * Event Bus Client for Web UI
 *
 * Provides a singleton EventBus with WebSocket transport for the client side.
 */

import { EventBus, WebSocketClientTransport } from "@liuboer/shared";
import type { Event, EventType, EventListener, ConnectionState } from "@liuboer/shared";

type ConnectionEventType = "connect" | "disconnect";
type ConnectionEventHandler = () => void;

/**
 * Get the daemon WebSocket base URL based on the current hostname
 */
function getDaemonWsUrl(): string {
  if (typeof window === "undefined") {
    return "ws://localhost:8283";
  }

  const hostname = window.location.hostname;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  return `${protocol}//${hostname}:8283`;
}

/**
 * Client-side EventBus Manager
 *
 * Manages EventBus instance with WebSocket transport for a session.
 */
class EventBusClient {
  private eventBus: EventBus | null = null;
  private transport: WebSocketClientTransport | null = null;
  private currentSessionId: string | null = null;
  private connectionHandlers: Map<ConnectionEventType, Set<ConnectionEventHandler>> = new Map();

  /**
   * Connect to a session's event stream (sessionId is REQUIRED)
   */
  connect(sessionId: string, debug = false): EventBus {
    if (!sessionId) {
      throw new Error("EventBusClient.connect() requires a valid sessionId");
    }

    // If already connected to this session, return existing instance
    if (this.eventBus && this.currentSessionId === sessionId) {
      return this.eventBus;
    }

    // Disconnect from any existing session
    this.disconnect();

    // Create new EventBus
    this.eventBus = new EventBus({ sessionId, debug });
    this.currentSessionId = sessionId;

    // Create WebSocket transport
    const baseUrl = getDaemonWsUrl();
    this.transport = new WebSocketClientTransport({
      url: `${baseUrl}/ws/${sessionId}`,
      sessionId,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
      pingInterval: 30000,
    });

    // Register transport with EventBus
    this.eventBus.registerTransport(this.transport);

    // Listen to connection state changes
    this.transport.onConnectionChange((state: ConnectionState) => {
      if (state === "connected") {
        this.emitConnectionEvent("connect");
      } else if (state === "disconnected") {
        this.emitConnectionEvent("disconnect");
      }
    });

    // Initialize transport (connect)
    this.transport.initialize().catch((error) => {
      console.error("Failed to initialize WebSocket transport:", error);
    });

    console.log(`[EventBusClient] Connected to session: ${sessionId}`);

    return this.eventBus;
  }

  /**
   * Disconnect from current session
   */
  async disconnect(force = false): Promise<void> {
    // Don't disconnect if we're just switching sessions and connect() will handle it
    if (!force && this.currentSessionId) {
      console.log(`[EventBusClient] Skipping disconnect - session switch will be handled by connect()`);
      return;
    }

    if (this.eventBus) {
      await this.eventBus.close();
      this.eventBus = null;
    }

    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }

    this.currentSessionId = null;
    console.log("[EventBusClient] Disconnected");
  }

  /**
   * Get current EventBus instance
   */
  getEventBus(): EventBus | null {
    return this.eventBus;
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.transport?.isReady() ?? false;
  }

  /**
   * Get connection state
   */
  getConnectionState() {
    return this.transport?.getState() ?? "disconnected";
  }

  /**
   * Listen to events (supports EventType, "all", "connect", "disconnect")
   */
  on(
    eventType: EventType | "all" | "connect" | "disconnect",
    listener: EventListener | ConnectionEventHandler,
  ): (() => void) | null {
    // Handle connection events
    if (eventType === "connect" || eventType === "disconnect") {
      if (!this.connectionHandlers.has(eventType)) {
        this.connectionHandlers.set(eventType, new Set());
      }
      this.connectionHandlers.get(eventType)!.add(listener as ConnectionEventHandler);

      // Return unsubscribe function
      return () => {
        this.connectionHandlers.get(eventType)?.delete(listener as ConnectionEventHandler);
      };
    }

    // Handle regular events
    if (!this.eventBus) {
      console.warn("[EventBusClient] Not connected. Call connect() first.");
      return null;
    }
    return this.eventBus.on(eventType as EventType | "all", listener as EventListener);
  }

  /**
   * Emit connection state event
   */
  private emitConnectionEvent(eventType: ConnectionEventType): void {
    const handlers = this.connectionHandlers.get(eventType);
    if (handlers) {
      handlers.forEach((handler) => handler());
    }
  }

  /**
   * Convenience method: Emit an event
   */
  async emit(event: Event): Promise<void> {
    if (!this.eventBus) {
      console.warn("[EventBusClient] Not connected. Call connect() first.");
      return;
    }
    await this.eventBus.emit(event);
  }
}

// Singleton instance
export const eventBusClient = new EventBusClient();

// Export for direct access to EventBus if needed
export { EventBus } from "@liuboer/shared";
export type { Event, EventType, EventListener } from "@liuboer/shared";
