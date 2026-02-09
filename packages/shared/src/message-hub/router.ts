/**
 * MessageHub Router
 *
 * Server-side router for handling session-based message routing
 * Routes messages by sessionId to appropriate handlers
 *
 * ARCHITECTURE:
 * - Pure routing layer - NO application logic
 * - O(1) client lookups with reverse index
 * - Memory leak prevention with empty Map cleanup
 * - Subscription key validation
 * - Duplicate registration prevention
 * - Observability with delivery stats
 * - Pluggable logger interface
 * - Transport-agnostic design (works with any connection type)
 * - Abstract ClientConnection interface
 * - Decoupled from WebSocket specifics
 */

import type { HubMessage } from './protocol.ts';
import { isEventMessage } from './protocol.ts';
import { RoomManager } from './room-manager.ts';

/**
 * Abstract connection interface
 * Allows router to work with any transport (WebSocket, HTTP/2, etc.)
 */
export interface ClientConnection {
	/** Unique connection identifier */
	id: string;
	/** Send data to the client */
	send(data: string): void;
	/** Check if connection is open and ready */
	isOpen(): boolean;
	/** FIX P0.6: Check if connection can accept messages (backpressure) */
	canAccept?(): boolean;
	/** Optional: Get connection metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Logger interface for dependency injection
 */
export interface RouterLogger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/**
 * Router configuration options
 */
export interface MessageHubRouterOptions {
	logger?: RouterLogger;
	debug?: boolean;
}

/**
 * Client information
 */
interface ClientInfo {
	clientId: string;
	connection: ClientConnection;
	connectedAt: number;
}

/**
 * Route result with delivery statistics
 */
export interface RouteResult {
	sent: number;
	failed: number;
	totalSubscribers: number;
	sessionId: string;
	method: string;
}

/**
 * MessageHub Router for server-side
 *
 * Responsibilities:
 * - Route messages by sessionId
 * - Manage room-based event routing
 * - Broadcast events to clients in rooms
 */
export class MessageHubRouter {
	private clients: Map<string, ClientInfo> = new Map(); // Now keyed by clientId
	private roomManager: RoomManager = new RoomManager();

	private logger: RouterLogger;
	private debug: boolean;

	constructor(options: MessageHubRouterOptions = {}) {
		this.logger = options.logger || console;
		this.debug = options.debug || false;
	}

	/**
	 * Register a client connection
	 * Prevents duplicate registration
	 */
	registerConnection(connection: ClientConnection): string {
		// Check for duplicate registration
		const existing = this.clients.get(connection.id);
		if (existing) {
			this.log(`Client already registered: ${existing.clientId}, returning existing ID`);
			return existing.clientId;
		}

		const info: ClientInfo = {
			clientId: connection.id,
			connection,
			connectedAt: Date.now(),
		};

		this.clients.set(connection.id, info);
		// Auto-join global room
		this.roomManager.joinRoom(connection.id, 'global');
		this.log(`Client registered: ${connection.id}`);

		return connection.id;
	}

	/**
	 * Unregister a client by clientId
	 * Cleans up room memberships
	 */
	unregisterConnection(clientId: string): void {
		const info = this.clients.get(clientId);
		if (!info) {
			return;
		}

		// Clean up room membership
		this.roomManager.removeClient(clientId);

		this.clients.delete(clientId);
		this.log(`Client unregistered: ${info.clientId}`);
	}

	/**
	 * Route an EVENT message to room members (legacy method, delegates to routeEventToRoom)
	 * Returns delivery statistics for observability
	 */
	routeEvent(message: HubMessage): RouteResult {
		if (!isEventMessage(message)) {
			this.logger.warn(`[MessageHubRouter] Not an EVENT message:`, message);
			return {
				sent: 0,
				failed: 0,
				totalSubscribers: 0,
				sessionId: message.sessionId,
				method: message.method,
			};
		}

		// Delegate to room-based routing
		return this.routeEventToRoom(message);
	}

	/**
	 * Send a message to a specific client
	 * FIX P2.1: Handle serialization errors
	 */
	sendToClient(clientId: string, message: HubMessage): boolean {
		const client = this.getClientById(clientId);
		if (!client) {
			this.logger.warn(`[MessageHubRouter] Client not found: ${clientId}`);
			return false;
		}

		if (!client.connection.isOpen()) {
			this.logger.warn(`[MessageHubRouter] Client not ready: ${clientId}`);
			return false;
		}

		// FIX P2.1: Handle serialization errors
		let json: string;
		try {
			json = JSON.stringify(message);
		} catch (error) {
			this.logger.error(
				`[MessageHubRouter] Failed to serialize message for client ${clientId}:`,
				error
			);
			return false;
		}

		try {
			client.connection.send(json);
			return true;
		} catch (error) {
			this.logger.error(`[MessageHubRouter] Failed to send to client ${clientId}:`, error);
			return false;
		}
	}

	/**
	 * Broadcast a message to all clients
	 * FIX P0.6: Check backpressure before sending to prevent server OOM
	 * FIX P2.1: Handle serialization errors
	 */
	broadcast(message: HubMessage): {
		sent: number;
		failed: number;
		skipped?: number;
	} {
		// FIX P2.1: Handle serialization errors
		let json: string;
		try {
			json = JSON.stringify(message);
		} catch (error) {
			this.logger.error(`[MessageHubRouter] Failed to serialize broadcast message:`, error);
			return { sent: 0, failed: this.clients.size, skipped: 0 };
		}

		let sentCount = 0;
		let failedCount = 0;
		let skippedCount = 0;

		for (const client of this.clients.values()) {
			if (!client.connection.isOpen()) {
				failedCount++;
				continue;
			}

			// FIX P0.6: Check backpressure before sending
			if (client.connection.canAccept && !client.connection.canAccept()) {
				this.logger.warn(
					`Skipping broadcast to client ${client.clientId} - queue full (backpressure)`
				);
				skippedCount++;
				continue;
			}

			try {
				client.connection.send(json);
				sentCount++;
			} catch (error) {
				this.logger.error(`Failed to broadcast to client ${client.clientId}:`, error);
				failedCount++;
			}
		}

		this.log(
			`Broadcast message to ${sentCount} clients (${failedCount} failed, ${skippedCount} skipped)`
		);

		return { sent: sentCount, failed: failedCount, skipped: skippedCount };
	}

	/**
	 * Get client info by clientId (O(1) lookup)
	 */
	getClientById(clientId: string): ClientInfo | undefined {
		return this.clients.get(clientId);
	}

	/**
	 * Get active client count
	 */
	getClientCount(): number {
		return this.clients.size;
	}

	/**
	 * Get all connected client IDs
	 */
	getClientIds(): string[] {
		return Array.from(this.clients.keys());
	}

	/**
	 * Join a client to a room
	 */
	joinRoom(clientId: string, room: string): void {
		const client = this.getClientById(clientId);
		if (!client) {
			this.logger.warn(`[MessageHubRouter] Cannot join room - client not found: ${clientId}`);
			return;
		}
		this.roomManager.joinRoom(clientId, room);
		this.log(`Client ${clientId} joined room: ${room}`);
	}

	/**
	 * Remove a client from a room
	 */
	leaveRoom(clientId: string, room: string): void {
		this.roomManager.leaveRoom(clientId, room);
		this.log(`Client ${clientId} left room: ${room}`);
	}

	/**
	 * Route an EVENT message to all clients in the message's room
	 */
	routeEventToRoom(message: HubMessage): RouteResult {
		const room = message.room || 'global';
		const members = this.roomManager.getRoomMembers(room);

		// Only include members of the specific room (no global cross-pollution)
		const allRecipients = new Set(members);

		if (allRecipients.size === 0) {
			this.log(`No room members for room ${room}, method ${message.method}`);
			return {
				sent: 0,
				failed: 0,
				totalSubscribers: 0,
				sessionId: message.sessionId,
				method: message.method,
			};
		}

		// Serialize once
		let json: string;
		try {
			json = JSON.stringify(message);
		} catch (error) {
			this.logger.error(`[MessageHubRouter] Failed to serialize room event:`, error);
			return {
				sent: 0,
				failed: allRecipients.size,
				totalSubscribers: allRecipients.size,
				sessionId: message.sessionId,
				method: message.method,
			};
		}

		let sent = 0,
			failed = 0;
		for (const clientId of allRecipients) {
			const client = this.getClientById(clientId);
			if (client && client.connection.isOpen()) {
				try {
					client.connection.send(json);
					sent++;
				} catch (error) {
					this.logger.error(`Failed to send room event to client ${clientId}:`, error);
					failed++;
				}
			} else {
				failed++;
			}
		}

		this.log(
			`Routed room event ${room}:${message.method} to ${sent}/${allRecipients.size} clients`
		);

		return {
			sent,
			failed,
			totalSubscribers: allRecipients.size,
			sessionId: message.sessionId,
			method: message.method,
		};
	}

	/**
	 * Get the room manager for inspection
	 */
	getRoomManager(): RoomManager {
		return this.roomManager;
	}

	/**
	 * Debug logging
	 */
	private log(message: string, ...args: unknown[]): void {
		if (this.debug) {
			this.logger.log(`[MessageHubRouter] ${message}`, ...args);
		}
	}
}
