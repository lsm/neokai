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
  maxQueueSize?: number; // Backpressure: max queued messages per client
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
  private readonly maxQueueSize: number;

  // Track WebSocket -> ClientId mapping for cleanup
  private wsToClientId: Map<ServerWebSocket<unknown>, string> = new Map();

  // Backpressure: track pending messages per client
  private clientQueues: Map<string, number> = new Map();

  constructor(options: BunWebSocketTransportOptions) {
    this.name = options.name || "bun-websocket";
    this.debug = options.debug || false;
    this.router = options.router;
    this.maxQueueSize = options.maxQueueSize || 1000;
  }

  /**
   * Initialize transport (no-op for Bun WebSocket - managed by Elysia)
   */
  async initialize(): Promise<void> {
    this.log("Transport initialized (Bun WebSocket managed by Elysia)");
  }

  /**
   * Close transport and cleanup all connections
   */
  async close(): Promise<void> {
    this.log("Closing transport and cleaning up connections");

    // Unregister all clients
    const clientIds = Array.from(this.wsToClientId.values());
    for (const clientId of clientIds) {
      this.unregisterClient(clientId);
    }

    // Clear mappings
    this.wsToClientId.clear();

    // Notify connection handlers
    this.notifyConnectionHandlers("disconnected");
  }

  /**
   * Register a WebSocket client
   * Creates a ClientConnection and registers with router
   */
  registerClient(ws: ServerWebSocket<unknown>, connectionSessionId: string): string {
    // Generate client ID first (no mutation needed)
    const clientId = crypto.randomUUID();

    // Create connection wrapper with ID already set
    const connection: ClientConnection = {
      id: clientId,
      send: (data: string) => {
        // Backpressure check
        const queueSize = this.clientQueues.get(clientId) || 0;
        if (queueSize >= this.maxQueueSize) {
          throw new Error(`Message queue full for client ${clientId} (max: ${this.maxQueueSize})`);
        }

        try {
          this.clientQueues.set(clientId, queueSize + 1);
          ws.send(data);
          // Decrement after successful send
          this.clientQueues.set(clientId, queueSize);
        } catch (error) {
          this.clientQueues.set(clientId, queueSize); // Revert on error
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

    // Register with router
    this.router.registerConnection(connection);

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

    // Clean up queue tracking
    this.clientQueues.delete(clientId);

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
