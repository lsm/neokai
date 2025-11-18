/**
 * Event Bus - Central event system for real-time WebSocket updates
 *
 * Manages event subscriptions and broadcasting to WebSocket clients.
 */

export type EventType =
  | "message.start"
  | "message.content"
  | "message.complete"
  | "tool.call"
  | "tool.result"
  | "agent.thinking"
  | "context.updated"
  | "tools.loaded"
  | "tools.unloaded"
  | "session.created"
  | "session.ended"
  | "error";

export interface Event {
  type: EventType;
  sessionId: string;
  timestamp: string;
  data: unknown;
}

export type EventListener = (event: Event) => void | Promise<void>;

export class EventBus {
  private listeners: Map<string, Set<EventListener>> = new Map();
  private websockets: Map<string, Set<WebSocket>> = new Map();

  /**
   * Register an event listener for a specific event type
   */
  on(eventType: EventType | "all", listener: EventListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
  }

  /**
   * Remove an event listener
   */
  off(eventType: EventType | "all", listener: EventListener): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Emit an event to all registered listeners and WebSocket clients
   */
  async emit(event: Event): Promise<void> {
    // Emit to local listeners for specific event type
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

    // Emit to WebSocket clients subscribed to this session
    const sessionWs = this.websockets.get(event.sessionId);
    if (sessionWs) {
      const message = JSON.stringify(event);
      for (const ws of sessionWs) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
          }
        } catch (error) {
          console.error(
            `Error sending WebSocket message for session ${event.sessionId}:`,
            error,
          );
        }
      }
    }
  }

  /**
   * Subscribe a WebSocket to events for a specific session
   */
  subscribeWebSocket(sessionId: string, ws: WebSocket): void {
    if (!this.websockets.has(sessionId)) {
      this.websockets.set(sessionId, new Set());
    }
    this.websockets.get(sessionId)!.add(ws);

    console.log(
      `WebSocket subscribed to session ${sessionId}. Total: ${
        this.websockets.get(sessionId)!.size
      }`,
    );
  }

  /**
   * Unsubscribe a WebSocket from a session
   */
  unsubscribeWebSocket(sessionId: string, ws: WebSocket): void {
    const sessionWs = this.websockets.get(sessionId);
    if (sessionWs) {
      sessionWs.delete(ws);
      console.log(
        `WebSocket unsubscribed from session ${sessionId}. Remaining: ${sessionWs.size}`,
      );

      // Clean up empty sets
      if (sessionWs.size === 0) {
        this.websockets.delete(sessionId);
      }
    }
  }

  /**
   * Get count of WebSocket clients for a session
   */
  getWebSocketCount(sessionId: string): number {
    return this.websockets.get(sessionId)?.size || 0;
  }

  /**
   * Clear all listeners and WebSocket subscriptions
   */
  clear(): void {
    this.listeners.clear();
    this.websockets.clear();
  }
}
