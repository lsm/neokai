import type { Event, EventType } from "@liuboer/shared";

export type EventHandler = (event: Event) => void;

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

  on(eventType: EventType | "all", handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  off(eventType: EventType | "all", handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
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
