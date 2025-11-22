/**
 * Event Bus Manager for Daemon
 *
 * Manages EventBus instances for each session with WebSocket transport.
 * Also maintains a special "global" EventBus for system-level operations.
 */

import { EventBus, RPCManager } from "@liuboer/shared";
import { WebSocketServerTransport } from "@liuboer/shared";

const GLOBAL_SESSION_ID = "global";

/**
 * Manager for session-scoped EventBus instances
 */
export class EventBusManager {
  private eventBuses: Map<string, EventBus> = new Map();
  private transports: Map<string, WebSocketServerTransport> = new Map();
  private rpcManagers: Map<string, RPCManager> = new Map();

  constructor() {
    // Initialize global EventBus on construction
    this.getOrCreateEventBus(GLOBAL_SESSION_ID, false);
  }

  /**
   * Get or create an EventBus for a session
   */
  getOrCreateEventBus(sessionId: string, debug = false): EventBus {
    let eventBus = this.eventBuses.get(sessionId);

    if (!eventBus) {
      // Create new EventBus for this session
      eventBus = new EventBus({ sessionId, debug });

      // Create and register WebSocket transport
      const transport = new WebSocketServerTransport({ sessionId });
      transport.initialize();
      eventBus.registerTransport(transport);

      // Create RPC Manager for this session
      const rpcManager = new RPCManager(eventBus, sessionId);

      // Store instances
      this.eventBuses.set(sessionId, eventBus);
      this.transports.set(sessionId, transport);
      this.rpcManagers.set(sessionId, rpcManager);

      console.log(`EventBus created for session: ${sessionId}`);
    }

    return eventBus;
  }

  /**
   * Get RPC Manager for a session
   */
  getRPCManager(sessionId: string): RPCManager | undefined {
    return this.rpcManagers.get(sessionId);
  }

  /**
   * Get global RPC Manager
   */
  getGlobalRPCManager(): RPCManager | undefined {
    return this.rpcManagers.get(GLOBAL_SESSION_ID);
  }

  /**
   * Get EventBus for a session (returns undefined if not exists)
   */
  getEventBus(sessionId: string): EventBus | undefined {
    return this.eventBuses.get(sessionId);
  }

  /**
   * Get WebSocket transport for a session
   */
  getTransport(sessionId: string): WebSocketServerTransport | undefined {
    return this.transports.get(sessionId);
  }

  /**
   * Remove EventBus and cleanup
   */
  async removeEventBus(sessionId: string): Promise<void> {
    // Don't allow removing global event bus
    if (sessionId === GLOBAL_SESSION_ID) {
      console.warn("Cannot remove global EventBus");
      return;
    }

    const eventBus = this.eventBuses.get(sessionId);
    const rpcManager = this.rpcManagers.get(sessionId);

    if (eventBus) {
      // Cleanup RPC Manager
      if (rpcManager) {
        rpcManager.cleanup();
        this.rpcManagers.delete(sessionId);
      }

      await eventBus.close();
      this.eventBuses.delete(sessionId);
      this.transports.delete(sessionId);
      console.log(`EventBus removed for session: ${sessionId}`);
    }
  }

  /**
   * Subscribe a WebSocket to a session's event bus
   */
  subscribeWebSocket(sessionId: string, ws: WebSocket): void {
    const transport = this.getTransport(sessionId);
    if (!transport) {
      throw new Error(`No transport found for session: ${sessionId}`);
    }

    transport.subscribeWebSocket(ws);
  }

  /**
   * Unsubscribe a WebSocket from a session's event bus
   */
  unsubscribeWebSocket(sessionId: string, ws: WebSocket): void {
    const transport = this.getTransport(sessionId);
    if (transport) {
      transport.unsubscribeWebSocket(ws);
    }
  }

  /**
   * Handle incoming message from WebSocket
   */
  handleWebSocketMessage(sessionId: string, message: string): void {
    const transport = this.getTransport(sessionId);
    if (transport) {
      transport.handleMessage(message);
    }
  }

  /**
   * Get count of WebSocket connections for a session
   */
  getWebSocketCount(sessionId: string): number {
    const transport = this.getTransport(sessionId);
    return transport?.getConnectionCount() || 0;
  }

  /**
   * Cleanup all event buses
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.eventBuses.values()).map((eb) => eb.close());
    await Promise.all(closePromises);

    this.eventBuses.clear();
    this.transports.clear();

    console.log("All EventBus instances closed");
  }
}
