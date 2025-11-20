import type { Event, EventType } from "@liuboer/shared";

export type EventHandler = (event: Event) => void;
export type ConnectionHandler = () => void;

/**
 * Get the daemon WebSocket base URL based on the current hostname
 * Uses the same hostname as the web UI but with port 8283 and WebSocket protocol
 */
function getDaemonWsUrl(): string {
  if (typeof window === 'undefined') {
    return "ws://localhost:8283";
  }

  const hostname = window.location.hostname;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  // Use the current hostname with port 8283 and appropriate WebSocket protocol
  return `${protocol}//${hostname}:8283`;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private handlers: Map<EventType | "all", Set<EventHandler>> = new Map();
  private connectionHandlers: Map<"connect" | "disconnect", Set<ConnectionHandler>> = new Map();
  private baseUrl: string;
  private shouldReconnect = true;
  private pingInterval: number | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getDaemonWsUrl();
    console.log(`WebSocket Client initialized with baseUrl: ${this.baseUrl}`);
  }

  connect(sessionId: string): void {
    this.sessionId = sessionId;
    this.shouldReconnect = true;
    this.disconnect();

    try {
      this.ws = new WebSocket(`${this.baseUrl}/ws/${sessionId}`);

      this.ws.onopen = () => {
        console.log(`WebSocket connected to session ${sessionId}`);
        this.reconnectAttempts = 0;

        // Emit connect event
        this.emitConnectionEvent("connect");

        // Clear any existing ping interval
        if (this.pingInterval !== null) {
          clearInterval(this.pingInterval);
        }

        // Send ping every 30 seconds
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
          }
        }, 30000) as unknown as number;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Event;
          this.handleEvent(data);
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
      };

      this.ws.onclose = () => {
        console.log("WebSocket closed");

        // Emit disconnect event
        this.emitConnectionEvent("disconnect");

        if (this.shouldReconnect) {
          this.attemptReconnect();
        }
      };
    } catch (error) {
      console.error("Error creating WebSocket:", error);
      if (this.shouldReconnect) {
        this.attemptReconnect();
      }
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.sessionId) {
        this.connect(this.sessionId);
      }
    }, delay);
  }

  on(eventType: EventType | "all" | "connect" | "disconnect", handler: EventHandler | ConnectionHandler): () => void {
    // Handle connection events separately
    if (eventType === "connect" || eventType === "disconnect") {
      if (!this.connectionHandlers.has(eventType)) {
        this.connectionHandlers.set(eventType, new Set());
      }
      this.connectionHandlers.get(eventType)!.add(handler as ConnectionHandler);

      // Return unsubscribe function
      return () => {
        this.connectionHandlers.get(eventType)?.delete(handler as ConnectionHandler);
      };
    }

    // Handle regular events
    if (!this.handlers.has(eventType as EventType | "all")) {
      this.handlers.set(eventType as EventType | "all", new Set());
    }
    this.handlers.get(eventType as EventType | "all")!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType as EventType | "all")?.delete(handler as EventHandler);
    };
  }

  off(eventType: EventType | "all" | "connect" | "disconnect", handler: EventHandler | ConnectionHandler): void {
    if (eventType === "connect" || eventType === "disconnect") {
      this.connectionHandlers.get(eventType)?.delete(handler as ConnectionHandler);
    } else {
      this.handlers.get(eventType as EventType | "all")?.delete(handler as EventHandler);
    }
  }

  private emitConnectionEvent(eventType: "connect" | "disconnect"): void {
    const handlers = this.connectionHandlers.get(eventType);
    if (handlers) {
      handlers.forEach((handler) => handler());
    }
  }

  private handleEvent(event: Event): void {
    // Call type-specific handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      typeHandlers.forEach((handler) => handler(event));
    }

    // Call "all" handlers
    const allHandlers = this.handlers.get("all");
    if (allHandlers) {
      allHandlers.forEach((handler) => handler(event));
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const wsClient = new WebSocketClient();
