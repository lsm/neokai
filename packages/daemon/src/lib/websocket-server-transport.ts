/**
 * Server-Side WebSocket Transport for MessageHub
 *
 * PHASE 3 ARCHITECTURE (FIXED):
 * - Pure I/O layer - handles WebSocket send/receive only
 * - Uses Router for CLIENT MANAGEMENT (register connections, subscriptions)
 * - NO ROUTING LOGIC - MessageHub handles routing, Transport handles I/O
 * - Provides sendToClient() for targeted sends (called by MessageHub via Router)
 */

import type { ServerWebSocket } from 'bun';
import type { HubMessage, IMessageTransport, ConnectionState } from '@liuboer/shared';
import type { HubMessageWithMetadata } from '@liuboer/shared/message-hub/protocol';
import type { MessageHubRouter, ClientConnection } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';

export interface WebSocketServerTransportOptions {
	name?: string;
	debug?: boolean;
	router: MessageHubRouter; // For client management only, not routing
	maxQueueSize?: number; // Backpressure: max queued messages per client
}

/**
 * Server-Side WebSocket Transport - Pure I/O Layer
 *
 * Responsibilities:
 * - Create ClientConnection wrappers for Bun WebSockets
 * - Forward incoming messages to MessageHub handlers
 * - Delegate all routing to MessageHubRouter
 */
export class WebSocketServerTransport implements IMessageTransport {
	readonly name: string;
	private router: MessageHubRouter;
	private messageHandlers: Set<(message: HubMessage) => void> = new Set();
	private connectionHandlers: Set<(state: ConnectionState, error?: Error) => void> = new Set();
	private debug: boolean;
	private readonly maxQueueSize: number;

	// FIX P2.2: Bidirectional mapping for O(1) lookups
	private wsToClientId: Map<ServerWebSocket<unknown>, string> = new Map();
	private clientIdToWs: Map<string, ServerWebSocket<unknown>> = new Map();

	// Backpressure: track pending messages per client
	private clientQueues: Map<string, number> = new Map();

	constructor(options: WebSocketServerTransportOptions) {
		this.name = options.name || 'websocket-server';
		this.debug = options.debug || false;
		this.router = options.router;
		this.maxQueueSize = options.maxQueueSize || 1000;
	}

	/**
	 * Initialize transport (no-op for Bun WebSocket - managed by Elysia)
	 */
	async initialize(): Promise<void> {
		this.log('Transport initialized (Bun WebSocket managed by Elysia)');
	}

	/**
	 * Close transport and cleanup all connections
	 * FIX P2.2: Clear both bidirectional maps
	 */
	async close(): Promise<void> {
		this.log('Closing transport and cleaning up connections');

		// Unregister all clients
		const clientIds = Array.from(this.clientIdToWs.keys());
		for (const clientId of clientIds) {
			this.unregisterClient(clientId);
		}

		// FIX P2.2: Clear both mappings
		this.wsToClientId.clear();
		this.clientIdToWs.clear();

		// Notify connection handlers
		this.notifyConnectionHandlers('disconnected');
	}

	/**
	 * Register a WebSocket client
	 * Creates a ClientConnection and registers with router
	 */
	registerClient(ws: ServerWebSocket<unknown>, connectionSessionId: string): string {
		// Generate client ID first (no mutation needed)
		const clientId = generateUUID();

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
			// FIX P0.6: Add canAccept() for backpressure checking
			canAccept: () => {
				const queueSize = this.clientQueues.get(clientId) || 0;
				return queueSize < this.maxQueueSize;
			},
			metadata: {
				ws,
				connectionSessionId,
			},
		};

		// Register with router
		this.router.registerConnection(connection);

		// FIX P2.2: Track bidirectional mapping for O(1) cleanup
		this.wsToClientId.set(ws, clientId);
		this.clientIdToWs.set(clientId, ws);

		this.log(`Client registered: ${clientId} (session: ${connectionSessionId})`);

		// Notify connection handlers
		if (this.router.getClientCount() === 1) {
			this.notifyConnectionHandlers('connected');
		}

		return clientId;
	}

	/**
	 * Unregister a WebSocket client
	 * FIX P2.2: O(1) lookup using bidirectional mapping
	 */
	unregisterClient(clientId: string): void {
		// FIX P2.2: O(1) reverse lookup instead of O(n) iteration
		const ws = this.clientIdToWs.get(clientId);
		if (ws) {
			this.wsToClientId.delete(ws);
			this.clientIdToWs.delete(clientId);
		}

		// Clean up queue tracking
		this.clientQueues.delete(clientId);

		// Unregister from router
		this.router.unregisterConnection(clientId);

		this.log(`Client unregistered: ${clientId}`);

		// Notify connection handlers if no clients left
		if (this.router.getClientCount() === 0) {
			this.notifyConnectionHandlers('disconnected');
		}
	}

	/**
	 * Handle incoming message from a WebSocket client
	 * Adds clientId to message for subscription tracking
	 */
	handleClientMessage(message: HubMessage, clientId?: string): void {
		this.log(`Received message: ${message.type} ${message.method}`, message);

		// Add clientId to message metadata for SUBSCRIBE/UNSUBSCRIBE handling
		// MessageHub needs this to track which client subscribed
		if (clientId) {
			(message as HubMessageWithMetadata).clientId = clientId;
		}

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
	 * Send message (deprecated - MessageHub now handles routing)
	 *
	 * @deprecated MessageHub now routes EVENT messages via Router directly.
	 * This method is kept for backwards compatibility and non-EVENT messages.
	 *
	 * New architecture flow:
	 * - MessageHub.sendMessage() checks if Router is registered
	 * - If yes: MessageHub → Router.routeEvent() → ClientConnection.send()
	 * - If no: MessageHub → Transport.send() (this method)
	 */
	async send(message: HubMessage): Promise<void> {
		// For EVENT messages: MessageHub should have routed via Router already
		// If we get here, it means no router registered (shouldn't happen server-side)
		if (message.type === 'EVENT') {
			console.warn(
				`[${this.name}] EVENT message sent via deprecated path. ` +
					`MessageHub should route via Router.`
			);
			// Fallback: broadcast to all clients
			this.router.broadcast(message);
			return;
		}

		// For non-EVENT messages (CALL, RESULT, ERROR): broadcast
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
		return this.router.getClientCount() > 0 ? 'connected' : 'disconnected';
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
	getClient(clientId: string): unknown {
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

	/**
	 * FIX P0.6: Check if client can accept messages (backpressure check)
	 * Returns true if client queue is not full
	 */
	canClientAccept(clientId: string): boolean {
		const queueSize = this.clientQueues.get(clientId) || 0;
		return queueSize < this.maxQueueSize;
	}

	/**
	 * Get current queue size for a client
	 */
	getClientQueueSize(clientId: string): number {
		return this.clientQueues.get(clientId) || 0;
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

	private log(message: string, ...args: unknown[]): void {
		if (this.debug) {
			console.log(`[${this.name}] ${message}`, ...args);
		}
	}
}
