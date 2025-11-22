/**
 * EventBus - Universal event system for real-time updates
 *
 * Supports both local (in-process) and remote (via transports) event distribution.
 * Can be used on both server and client with pluggable transport layers.
 */

import type { Event, EventType } from "../types";
import type { ITransport, TransportEventHandler, ConnectionChangeHandler } from "./transport";

export type EventListener = (event: Event) => void | Promise<void>;

/**
 * EventBus configuration options
 */
export interface EventBusOptions {
  /**
   * Session ID for session-scoped event filtering (REQUIRED)
   */
  sessionId: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

/**
 * Universal EventBus with transport abstraction
 *
 * Features:
 * - Local event listeners (in-process pub/sub)
 * - Multiple transport support (WebSocket, SSE, etc.)
 * - Session-scoped event filtering (REQUIRED)
 * - Type-safe event system
 * - Bidirectional communication
 */
export class EventBus {
  private listeners: Map<EventType | "all", Set<EventListener>> = new Map();
  private transports: Set<ITransport> = new Set();
  private readonly sessionId: string;
  private debug: boolean;

  constructor(options: EventBusOptions) {
    this.sessionId = options.sessionId;
    this.debug = options.debug ?? false;
  }

  /**
   * Register a transport for remote event distribution
   *
   * @param transport Transport implementation
   * @returns Unregister function
   */
  registerTransport(transport: ITransport): () => void {
    this.transports.add(transport);
    this.log(`Transport registered: ${transport.name}`);

    // Subscribe to incoming events from this transport
    const unsubscribeEvent = transport.onEvent((event) => {
      this.handleIncomingEvent(event, transport.name);
    });

    // Subscribe to connection state changes
    const unsubscribeConnection = transport.onConnectionChange((state, error) => {
      this.log(`Transport ${transport.name} state: ${state}`, error);
    });

    // Return unregister function
    return () => {
      this.transports.delete(transport);
      unsubscribeEvent();
      unsubscribeConnection();
      this.log(`Transport unregistered: ${transport.name}`);
    };
  }

  /**
   * Register an event listener for a specific event type
   *
   * @param eventType Event type to listen for, or "all" for all events
   * @param listener Callback function
   * @returns Unsubscribe function
   */
  on(eventType: EventType | "all", listener: EventListener): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
    this.log(`Listener registered for: ${eventType}`);

    // Return unsubscribe function
    return () => {
      this.off(eventType, listener);
    };
  }

  /**
   * Remove an event listener
   *
   * @param eventType Event type
   * @param listener Callback function to remove
   */
  off(eventType: EventType | "all", listener: EventListener): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      listeners.delete(listener);
      this.log(`Listener removed for: ${eventType}`);
    }
  }

  /**
   * Emit an event to all registered listeners and transports
   *
   * @param event Event to emit
   * @param options Emit options
   */
  async emit(
    event: Event,
    options: { localOnly?: boolean; transportOnly?: boolean } = {},
  ): Promise<void> {
    // Enforce session ID matching
    if (event.sessionId !== this.sessionId) {
      this.log(`Event rejected: session mismatch (expected: ${this.sessionId}, got: ${event.sessionId})`);
      throw new Error(
        `Event sessionId mismatch: expected "${this.sessionId}", got "${event.sessionId}"`,
      );
    }

    this.log(`Emitting event: ${event.type} for session ${event.sessionId}`);

    // Emit to local listeners (unless transportOnly)
    if (!options.transportOnly) {
      await this.emitLocal(event);
    }

    // Emit to transports (unless localOnly)
    if (!options.localOnly) {
      await this.emitToTransports(event);
    }
  }

  /**
   * Emit to local listeners only
   */
  private async emitLocal(event: Event): Promise<void> {
    // Emit to type-specific listeners
    const specificListeners = this.listeners.get(event.type);
    if (specificListeners) {
      for (const listener of specificListeners) {
        try {
          await listener(event);
        } catch (error) {
          console.error(`Error in event listener for ${event.type}:`, error);
        }
      }
    }

    // Emit to "all" listeners
    const allListeners = this.listeners.get("all");
    if (allListeners) {
      for (const listener of allListeners) {
        try {
          await listener(event);
        } catch (error) {
          console.error(`Error in "all" event listener:`, error);
        }
      }
    }
  }

  /**
   * Emit to all registered transports
   */
  private async emitToTransports(event: Event): Promise<void> {
    if (this.transports.size === 0) {
      return;
    }

    const sendPromises = Array.from(this.transports)
      .filter((t) => t.isReady())
      .map((transport) =>
        transport.send(event).catch((error) => {
          console.error(
            `Error sending event to transport ${transport.name}:`,
            error,
          );
        }),
      );

    await Promise.all(sendPromises);
    this.log(`Event sent to ${sendPromises.length} transport(s)`);
  }

  /**
   * Handle incoming event from a transport
   */
  private async handleIncomingEvent(event: Event, transportName: string): Promise<void> {
    this.log(`Received event from ${transportName}: ${event.type}`);

    // Validate incoming event session ID
    if (event.sessionId !== this.sessionId) {
      console.warn(
        `[EventBus:${this.sessionId}] Received event for wrong session: ${event.sessionId}`,
      );
      return;
    }

    // Emit to local listeners only (don't echo back to transports)
    await this.emitLocal(event);
  }

  /**
   * Get the session ID for this EventBus
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get count of active transports
   */
  getTransportCount(): number {
    return this.transports.size;
  }

  /**
   * Get count of listeners for a specific event type
   */
  getListenerCount(eventType: EventType | "all"): number {
    return this.listeners.get(eventType)?.size || 0;
  }

  /**
   * Clear all listeners (does not affect transports)
   */
  clearListeners(): void {
    this.listeners.clear();
    this.log("All listeners cleared");
  }

  /**
   * Close all transports and clear listeners
   */
  async close(): Promise<void> {
    this.log("Closing EventBus...");

    // Close all transports
    const closePromises = Array.from(this.transports).map((t) =>
      t.close().catch((error) => {
        console.error(`Error closing transport ${t.name}:`, error);
      }),
    );
    await Promise.all(closePromises);

    // Clear all listeners
    this.clearListeners();
    this.transports.clear();

    this.log("EventBus closed");
  }

  /**
   * Debug logging
   */
  private log(message: string, ...args: unknown[]): void {
    if (this.debug) {
      console.log(`[EventBus:${this.sessionId}] ${message}`, ...args);
    }
  }
}
