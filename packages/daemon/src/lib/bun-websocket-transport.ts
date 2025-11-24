/**
 * Bun Native WebSocket Transport for MessageHub
 *
 * PHASE 2 REFACTOR:
 * - Pure I/O layer (no routing logic)
 * - Delegates client management to MessageHubRouter
 * - Focuses only on WebSocket send/receive operations
 */

import type { ServerWebSocket } from "bun";
import type { HubMessage, IMessageTransport, ConnectionState } from "@liuboer/shared";
import type { MessageHubRouter, ClientConnection } from "@liuboer/shared";

export interface BunWebSocketTransportOptions {
  name?: string;
  debug?: boolean;
  router: MessageHubRouter;
}

/**
 * Bun WebSocket Transport - Pure I/O Layer
 *
 * Responsibilities:
 * - Create ClientConnection wrappers for Bun WebSockets
 * - Forward incoming messages to MessageHub handlers
 * - Delegate all routing to MessageHubRouter
 */
export class BunWebSocketTransport implements IMessageTransport {
  readonly name: string;
  private router: MessageHubRouter;
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<(state: ConnectionState, error?: Error) => void> = new Set();
  private debug: boolean;

  // Track WebSocket -> ClientId mapping for cleanup
  private wsToClientId: Map<ServerWebSocket<unknown>, string> = new Map();

  constructor(options: BunWebSocketTransportOptions) {
    this.name = options.name || "bun-websocket";
    this.debug = options.debug || false;
    this.router = options.router;
  }

  /**
   * Register a WebSocket client
   * Creates a ClientConnection and registers with router
   */
  registerClient(ws: ServerWebSocket<unknown>, connectionSessionId: string): string {
    // Create connection wrapper
    const connection: ClientConnection = {
      id: '', // Will be set by router
      send: (data: string) => {
        try {
          ws.send(data);
        } catch (error) {
          console.error(`[${this.name}] Failed to send:`, error);
          throw error;
        }
      },
      isOpen: () => ws.readyState === 1, // Bun WebSocket OPEN state
      metadata: {
        ws,
        connectionSessionId,
      },
    };

    // Register with router (router assigns the clientId)
    const clientId = this.router.registerConnection(connection);

    // Update connection id
    connection.id = clientId;

    // Track mapping for cleanup
    this.wsToClientId.set(ws, clientId);

    this.log(`Client registered: ${clientId} (session: ${connectionSessionId})`);

    // Auto-subscribe to connection session
    this.router.autoSubscribeConnection(clientId, connectionSessionId);

    // Notify connection handlers
    if (this.router.getClientCount() === 1) {
      this.notifyConnectionHandlers("connected");
    }

    return clientId;
  }

  /**
   * Unregister a WebSocket client
   */
  unregisterClient(clientId: string): void {
    // Find and remove WebSocket mapping
    for (const [ws, id] of this.wsToClientId.entries()) {
      if (id === clientId) {
        this.wsToClientId.delete(ws);
        break;
      }
    }

    // Unregister from router
    this.router.unregisterConnection(clientId);

    this.log(`Client unregistered: ${clientId}`);

    // Notify connection handlers if no clients left
    if (this.router.getClientCount() === 0) {
      this.notifyConnectionHandlers("disconnected");
    }
  }

  /**
   * Handle incoming message from a WebSocket client
   * Simplified: just forward to handlers (no routing logic)
   */
  handleClientMessage(message: HubMessage, clientId?: string): void {
    this.log(`Received message: ${message.type} ${message.method}`, message);

    // Notify all message handlers (MessageHub will process)
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error(`[${this.name}] Error in message handler:`, error);
      }
    }
  }

  /**
   * Send message via router
   * Router determines which clients should receive it
   */
  async send(message: HubMessage): Promise<void> {
    // For EVENT messages, use router's routing logic
    if (message.type === "EVENT") {
      const result = this.router.routeEvent(message);
      this.log(`Routed event: ${result.sent} sent, ${result.failed} failed`);
      return;
    }

    // For non-EVENT messages (CALL, RESULT, ERROR), broadcast to relevant clients
    // The router will handle filtering based on subscriptions
    this.router.broadcast(message);
  }

  /**
   * Subscribe to incoming messages
   */
  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to connection state changes
   */
  onConnectionChange(handler: (state: ConnectionState, error?: Error) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.router.getClientCount() > 0 ? "connected" : "disconnected";
  }

  /**
   * Check if ready to send messages
   */
  isReady(): boolean {
    return this.router.getClientCount() > 0;
  }

  /**
   * Get number of connected clients (delegates to router)
   */
  getClientCount(): number {
    return this.router.getClientCount();
  }

  /**
   * Get client by ID (delegates to router)
   */
  getClient(clientId: string): any {
    return this.router.getClientById(clientId);
  }

  /**
   * Broadcast to all clients in a session
   * Uses router's routing logic
   */
  async broadcastToSession(sessionId: string, message: HubMessage): Promise<void> {
    const sessionMessage = { ...message, sessionId };
    await this.send(sessionMessage);
  }

  /**
   * Get the router instance
   */
  getRouter(): MessageHubRouter {
    return this.router;
  }

  private notifyConnectionHandlers(state: ConnectionState, error?: Error): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch (err) {
        console.error(`[${this.name}] Error in connection handler:`, err);
      }
    }
  }

  private log(message: string, ...args: any[]): void {
    if (this.debug) {
      console.log(`[${this.name}] ${message}`, ...args);
    }
  }
}
