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

// import { generateUUID } from '../utils.ts';
import type { HubMessage } from './protocol.ts';
import { isEventMessage } from './protocol.ts';
import type { RouterSubscriptions } from './types.ts';

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
	/**
	 * Maximum subscriptions per client (prevents subscription bombing)
	 * @default 1000
	 */
	maxSubscriptionsPerClient?: number;
	/**
	 * FIX P2.4: Rate limit for subscribe/unsubscribe operations (per client)
	 * Using token bucket: max operations per second
	 * @default 50 operations/sec
	 */
	subscriptionRateLimit?: number;
}

/**
 * FIX P2.4: Token bucket for rate limiting
 */
interface TokenBucket {
	tokens: number;
	lastRefill: number;
	capacity: number;
	refillRate: number; // tokens per second
}

/**
 * Client information
 */
interface ClientInfo {
	clientId: string;
	connection: ClientConnection;
	connectedAt: number;
	subscriptions: Map<string, Set<string>>; // Map<sessionId, Set<method>>
	rateLimitBucket?: TokenBucket; // FIX P2.4: Rate limiting
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
 * - Manage client subscriptions
 * - Broadcast events to subscribed clients
 */
export class MessageHubRouter {
	private clients: Map<string, ClientInfo> = new Map(); // Now keyed by clientId
	private subscriptions: RouterSubscriptions = new Map();

	private logger: RouterLogger;
	private debug: boolean;
	private readonly maxSubscriptionsPerClient: number;
	private readonly subscriptionRateLimit: number; // FIX P2.4

	constructor(options: MessageHubRouterOptions = {}) {
		this.logger = options.logger || console;
		this.debug = options.debug || false;
		this.maxSubscriptionsPerClient = options.maxSubscriptionsPerClient || 1000;
		this.subscriptionRateLimit = options.subscriptionRateLimit || 50; // FIX P2.4: 50 ops/sec default
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
			subscriptions: new Map(),
			// FIX P2.4: Initialize rate limit bucket
			rateLimitBucket:
				this.subscriptionRateLimit > 0
					? {
							tokens: this.subscriptionRateLimit,
							lastRefill: Date.now(),
							capacity: this.subscriptionRateLimit,
							refillRate: this.subscriptionRateLimit,
						}
					: undefined,
		};

		this.clients.set(connection.id, info);
		this.log(`Client registered: ${connection.id}`);

		return connection.id;
	}

	/**
	 * Unregister a client by clientId
	 * Cleans up all subscriptions
	 */
	unregisterConnection(clientId: string): void {
		const info = this.clients.get(clientId);
		if (!info) {
			return;
		}

		// Remove all subscriptions for this client
		for (const [sessionId, methods] of info.subscriptions.entries()) {
			for (const method of methods) {
				this.unsubscribeClient(sessionId, method, info.clientId);
			}
		}

		this.clients.delete(clientId);
		this.log(`Client unregistered: ${info.clientId}`);
	}

	/**
	 * FIX P2.4: Check and consume rate limit token
	 * Returns true if operation allowed, false if rate limit exceeded
	 */
	private checkRateLimit(clientId: string): boolean {
		const client = this.getClientById(clientId);
		if (!client || !client.rateLimitBucket) {
			return true; // No rate limiting enabled
		}

		const bucket = client.rateLimitBucket;
		const now = Date.now();
		const elapsed = (now - bucket.lastRefill) / 1000; // seconds

		// Refill tokens based on elapsed time
		const newTokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRate);

		bucket.tokens = newTokens;
		bucket.lastRefill = now;

		// Check if we have a token
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return true;
		}

		return false;
	}

	/**
	 * Subscribe a client to a method in a session
	 *
	 * FIXES:
	 * - ✅ P1.4: Validates clientId (non-empty string)
	 * - ✅ P1.3: Enforces max subscriptions limit per client
	 * - ✅ P2.4: Rate limits subscribe operations (token bucket)
	 * - ✅ P2.5: Warns on duplicate subscriptions (idempotent)
	 */
	subscribe(sessionId: string, method: string, clientId: string): void {
		// FIX P1.4: Validate clientId
		if (!clientId || typeof clientId !== 'string' || clientId.trim().length === 0) {
			throw new Error(`Invalid clientId: ${JSON.stringify(clientId)}`);
		}

		// FIX P2.4: Check rate limit
		if (!this.checkRateLimit(clientId)) {
			throw new Error(
				`Rate limit exceeded for client ${clientId}. Max ${this.subscriptionRateLimit} subscribe operations per second.`
			);
		}

		// Validate sessionId - colons not allowed (reserved for internal routing)
		if (sessionId.includes(':')) {
			throw new Error('SessionId cannot contain colon character (reserved for internal use)');
		}

		// Validate method format (including colon restriction)
		if (method.includes(':')) {
			throw new Error('Method cannot contain colon character (reserved for internal use)');
		}

		// FIX P1.3: Check subscription limit before adding
		const client = this.getClientById(clientId);
		if (client) {
			// Count total subscriptions across all sessions
			let totalSubs = 0;
			for (const methods of client.subscriptions.values()) {
				totalSubs += methods.size;
			}

			// Check if already subscribed (idempotent)
			const existingMethods = client.subscriptions.get(sessionId);
			const alreadySubscribed = existingMethods?.has(method);

			if (!alreadySubscribed && totalSubs >= this.maxSubscriptionsPerClient) {
				throw new Error(
					`Client ${clientId} has reached max subscriptions limit (${this.maxSubscriptionsPerClient})`
				);
			}

			// FIX P2.5: Warn on duplicate subscriptions (but allow - idempotent)
			if (alreadySubscribed) {
				this.logger.warn(
					`[MessageHubRouter] Client ${clientId} already subscribed to ${sessionId}:${method}`
				);
				return; // Idempotent - do nothing
			}
		}

		// Initialize maps if needed
		if (!this.subscriptions.has(sessionId)) {
			this.subscriptions.set(sessionId, new Map());
		}

		const sessionSubs = this.subscriptions.get(sessionId)!;

		if (!sessionSubs.has(method)) {
			sessionSubs.set(method, new Set());
		}

		sessionSubs.get(method)!.add(clientId);

		// FIX P0.1: Re-check client exists AFTER adding subscription (race condition fix)
		// Client could have disconnected between line 180 and here!
		const clientNow = this.getClientById(clientId);
		if (!clientNow) {
			// Client disconnected - cleanup the subscription we just added
			sessionSubs.get(method)!.delete(clientId);

			// Cleanup empty maps
			if (sessionSubs.get(method)!.size === 0) {
				sessionSubs.delete(method);
				if (sessionSubs.size === 0) {
					this.subscriptions.delete(sessionId);
				}
			}

			this.logger.warn(
				`Client ${clientId} disconnected during subscription to ${sessionId}:${method} - cleaned up`
			);
			return;
		}

		// Track subscription in client info using O(1) lookup
		if (!clientNow.subscriptions.has(sessionId)) {
			clientNow.subscriptions.set(sessionId, new Set());
		}
		clientNow.subscriptions.get(sessionId)!.add(method);

		this.log(`Client ${clientId} subscribed to ${sessionId}:${method}`);
	}

	/**
	 * Unsubscribe a client from a method in a session
	 * Cleans up empty Maps to prevent memory leaks
	 * FIX P2.4: Rate limits unsubscribe operations
	 */
	unsubscribeClient(sessionId: string, method: string, clientId: string): void {
		// FIX P2.4: Check rate limit (same limit as subscribe)
		if (!this.checkRateLimit(clientId)) {
			this.logger.warn(
				`Rate limit exceeded for client ${clientId} during unsubscribe. Max ${this.subscriptionRateLimit} operations per second.`
			);
			// Don't throw for unsubscribe - just log warning and proceed
			// Allows cleanup to continue even if rate limited
		}

		const sessionSubs = this.subscriptions.get(sessionId);
		if (!sessionSubs) {
			return;
		}

		const methodSubs = sessionSubs.get(method);
		if (!methodSubs) {
			return;
		}

		methodSubs.delete(clientId);

		// MEMORY LEAK FIX: Cleanup empty structures
		if (methodSubs.size === 0) {
			sessionSubs.delete(method);
			if (sessionSubs.size === 0) {
				this.subscriptions.delete(sessionId);
			}
		}

		// Remove from client info using O(1) lookup
		const client = this.getClientById(clientId);
		if (client) {
			const clientMethods = client.subscriptions.get(sessionId);
			if (clientMethods) {
				clientMethods.delete(method);
				if (clientMethods.size === 0) {
					client.subscriptions.delete(sessionId);
				}
			}
		}

		this.log(`Client ${clientId} unsubscribed from ${sessionId}:${method}`);
	}

	/**
	 * Route an EVENT message to subscribed clients
	 * Returns delivery statistics for observability
	 * FIX P2.1: Handle serialization errors (circular refs, etc.)
	 * Also sends to "global" subscribers for cross-session orchestration
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

		// Collect all subscriber clientIds (session-specific + global)
		const allSubscribers = new Set<string>();

		// Add session-specific subscribers
		const sessionSubs = this.subscriptions.get(message.sessionId);
		if (sessionSubs) {
			const methodSubs = sessionSubs.get(message.method);
			if (methodSubs) {
				for (const clientId of methodSubs) {
					allSubscribers.add(clientId);
				}
			}
		}

		// Also add "global" subscribers (for orchestrators that want all events)
		if (message.sessionId !== 'global') {
			const globalSubs = this.subscriptions.get('global');
			if (globalSubs) {
				const globalMethodSubs = globalSubs.get(message.method);
				if (globalMethodSubs) {
					for (const clientId of globalMethodSubs) {
						allSubscribers.add(clientId);
					}
				}
			}
		}

		// Debug logging for event routing
		this.log(
			`[routeEvent] ${message.sessionId}:${message.method} - session subs: ${sessionSubs?.get(message.method)?.size ?? 0}, global subs: ${this.subscriptions.get('global')?.get(message.method)?.size ?? 0}, total: ${allSubscribers.size}`
		);

		if (allSubscribers.size === 0) {
			this.log(`No subscribers for ${message.sessionId}:${message.method}`);
			return {
				sent: 0,
				failed: 0,
				totalSubscribers: 0,
				sessionId: message.sessionId,
				method: message.method,
			};
		}

		// Use allSubscribers instead of methodSubs
		const methodSubs = allSubscribers;

		// FIX P2.1: Handle serialization errors (circular refs, BigInt, etc.)
		let json: string;
		try {
			json = JSON.stringify(message);
		} catch (error) {
			this.logger.error(
				`[MessageHubRouter] Failed to serialize message for ${message.sessionId}:${message.method}:`,
				error
			);
			return {
				sent: 0,
				failed: methodSubs.size,
				totalSubscribers: methodSubs.size,
				sessionId: message.sessionId,
				method: message.method,
			};
		}

		// Send to all subscribed clients
		let sentCount = 0;
		let failedCount = 0;

		for (const clientId of methodSubs) {
			const client = this.getClientById(clientId);
			if (client && client.connection.isOpen()) {
				try {
					client.connection.send(json);
					sentCount++;
				} catch (error) {
					this.logger.error(`Failed to send to client ${clientId}:`, error);
					failedCount++;
				}
			} else {
				failedCount++;
			}
		}

		this.log(
			`Routed ${message.sessionId}:${message.method} to ${sentCount}/${methodSubs.size} clients`
		);

		return {
			sent: sentCount,
			failed: failedCount,
			totalSubscribers: methodSubs.size,
			sessionId: message.sessionId,
			method: message.method,
		};
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
	 * Get subscription count for a method
	 */
	getSubscriptionCount(sessionId: string, method: string): number {
		const sessionSubs = this.subscriptions.get(sessionId);
		if (!sessionSubs) {
			return 0;
		}
		return sessionSubs.get(method)?.size || 0;
	}

	/**
	 * Get all subscriptions for debugging
	 */
	getSubscriptions(): RouterSubscriptions {
		return new Map(this.subscriptions);
	}

	/**
	 * Get all connected client IDs
	 */
	getClientIds(): string[] {
		return Array.from(this.clients.keys());
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
