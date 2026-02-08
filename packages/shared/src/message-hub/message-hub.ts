/**
 * MessageHub - Unified messaging hub for bidirectional RPC and Pub/Sub
 *
 * Provides:
 * - Bidirectional RPC (client↔server)
 * - Pub/Sub messaging
 * - Session-based routing
 * - Type-safe method registry
 */

import { generateUUID } from '../utils.ts';
import { createLogger } from '../logger.ts';

// Create logger for MessageHub (uses unified log levels)
const log = createLogger('kai:messagehub');
import {
	type HubMessage,
	MessageType,
	GLOBAL_SESSION_ID,
	ErrorCode,
	createEventMessage,
	isResponseMessage,
	isEventMessage,
	validateMethod,
	isValidMessage,
	createCommandMessage,
	createQueryMessage,
	createResponseMessage,
	createErrorResponseMessage,
	isCommandMessage,
	isQueryMessage,
} from './protocol.ts';
import type {
	MessageHubOptions,
	MessageHandler,
	ConnectionStateHandler,
	PendingCall,
	IMessageTransport,
	CallContext,
	ConnectionState,
	CommandHandler,
	QueryHandler,
	RoomEventHandler,
	QueryOptions,
	EventOptions,
} from './types.ts';
import type { MessageHubRouter } from './router.ts';

// Define UnsubscribeFn locally (removed from types.ts)
type UnsubscribeFn = () => void;

/**
 * MessageHub class
 * Core implementation of unified messaging system
 *
 * ARCHITECTURE:
 * - MessageHub: Protocol layer (RPC + Pub/Sub logic)
 * - MessageHubRouter: Server-side routing layer (determines recipients)
 * - IMessageTransport: I/O layer (sends/receives over wire)
 *
 * Flow: MessageHub → Router (if server-side) → Transport → Wire
 */
export class MessageHub {
	private transport: IMessageTransport | null = null;
	private router: MessageHubRouter | null = null; // Server-side only
	private readonly defaultSessionId: string;
	private readonly defaultTimeout: number;

	// Backpressure limits
	private readonly maxPendingCalls: number;
	private readonly maxEventDepth: number;

	// RPC state
	private pendingCalls: Map<string, PendingCall<unknown>> = new Map();

	// Room-based command/query handlers (new API)
	private commandHandlers: Map<string, CommandHandler> = new Map();
	private queryHandlers: Map<string, QueryHandler> = new Map();
	// Room event handlers (client-side - keyed by method)
	private roomEventHandlers: Map<string, Set<RoomEventHandler>> = new Map();

	// Event handler recursion tracking (prevents infinite loops)
	private eventDepthMap = new Map<string, number>(); // messageId -> depth

	// Message sequencing for ordering guarantees
	private messageSequence = 0;

	// FIX P1.3: Message sequence tracking
	// Client-side: tracks server's global sequence (all messages from server use one counter)
	// Server-side: tracks per-client sequences (each client has its own counter)
	private expectedSequence: number | null = null; // For client-side global tracking
	private expectedSequencePerClient = new Map<string, number>(); // For server-side per-client tracking
	private readonly warnOnSequenceGap: boolean;

	// FIX P1.4: Event handler error handling mode
	private readonly stopOnEventHandlerError: boolean;

	// Message inspection
	private messageHandlers: Set<MessageHandler> = new Set();

	// Connection state
	private connectionStateHandlers: Set<ConnectionStateHandler> = new Set();

	constructor(options: MessageHubOptions = {}) {
		this.defaultSessionId = options.defaultSessionId || GLOBAL_SESSION_ID;
		this.defaultTimeout = options.timeout || 10000;
		this.maxPendingCalls = options.maxPendingCalls || 1000;
		this.maxEventDepth = options.maxEventDepth || 10;
		this.warnOnSequenceGap = options.warnOnSequenceGap ?? true; // FIX P1.3: Enable sequence gap warnings by default
		this.stopOnEventHandlerError = options.stopOnEventHandlerError ?? false; // FIX P1.4: Continue on handler errors by default
	}

	// ========================================
	// Transport Management
	// ========================================

	/**
	 * Register a transport
	 */
	registerTransport(transport: IMessageTransport): UnsubscribeFn {
		if (this.transport) {
			throw new Error('Transport already registered. Call unregisterTransport() first.');
		}

		this.transport = transport;
		this.logDebug(`Transport registered: ${transport.name}`);

		// Subscribe to incoming messages
		const unsubMessage = transport.onMessage((message) => {
			this.handleIncomingMessage(message);
		});

		// Subscribe to connection state changes
		const unsubConnection = transport.onConnectionChange((state, error) => {
			this.logDebug(`Connection state: ${state}`, error);

			// Notify handlers (e.g., StateChannel.hybridRefresh)
			this.notifyConnectionStateHandlers(state, error);
		});

		// Subscribe to client disconnect events (server-side only, for per-client cleanup)
		let unsubClientDisconnect: (() => void) | undefined;
		if (transport.onClientDisconnect) {
			unsubClientDisconnect = transport.onClientDisconnect((clientId) => {
				this.cleanupClientSequence(clientId);
			});
		}

		// Return unregister function
		return () => {
			this.transport = null;
			unsubMessage();
			unsubConnection();
			unsubClientDisconnect?.();
			this.logDebug(`Transport unregistered: ${transport.name}`);
		};
	}

	/**
	 * Get current connection state
	 */
	getState(): ConnectionState {
		return this.transport?.getState() || 'disconnected';
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.transport?.isReady() || false;
	}

	/**
	 * Subscribe to connection state changes
	 */
	onConnection(handler: ConnectionStateHandler): UnsubscribeFn {
		this.connectionStateHandlers.add(handler);
		return () => {
			this.connectionStateHandlers.delete(handler);
		};
	}

	// ========================================
	// Router Management (Server-side)
	// ========================================

	/**
	 * Register a router for server-side message routing
	 * Optional - only needed for server-side deployments
	 *
	 * When registered, MessageHub uses the router to determine which clients
	 * should receive EVENT messages based on their subscriptions.
	 */
	registerRouter(router: MessageHubRouter): void {
		if (this.router) {
			log.warn('Router already registered, replacing...');
		}
		this.router = router;
		this.logDebug(`Router registered`);
	}

	/**
	 * Get the registered router (if any)
	 */
	getRouter(): MessageHubRouter | null {
		return this.router;
	}

	// ========================================
	// RPC Pattern (Bidirectional) - REMOVED
	// Old call() and handle() methods removed - use query() and onQuery() instead
	// ========================================

	// ========================================
	// Pub/Sub Pattern - REMOVED
	// Old publish(), subscribe(), subscribeOptimistic() methods removed
	// Use event() and onEvent() instead
	// ========================================

	// ========================================
	// Room-based API (New simplified protocol)
	// ========================================

	/**
	 * Send a fire-and-forget command (no response expected)
	 */
	command(method: string, data?: unknown, options: EventOptions = {}): void {
		if (!this.isConnected()) {
			throw new Error('Not connected to transport');
		}
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}
		const sessionId = options.room || this.defaultSessionId;
		const message = createCommandMessage({ method, data, sessionId });
		this.sendMessage(message).catch((error) => {
			log.error(`Failed to send command ${method}:`, error);
		});
	}

	/**
	 * Send a query and wait for response
	 * Reuses the pendingCalls infrastructure from call()
	 */
	async query<TResult = unknown>(
		method: string,
		data?: unknown,
		options: QueryOptions = {}
	): Promise<TResult> {
		if (!this.isConnected()) {
			throw new Error('Not connected to transport');
		}
		const sessionId = options.room || this.defaultSessionId;
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}
		if (this.pendingCalls.size >= this.maxPendingCalls) {
			throw new Error(
				`Too many pending calls (${this.pendingCalls.size}/${this.maxPendingCalls}).`
			);
		}

		const messageId = generateUUID();
		const timeout = options.timeout || this.defaultTimeout;

		return new Promise<TResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCalls.delete(messageId);
				reject(new Error(`Query timeout: ${method} (${timeout}ms)`));
			}, timeout);

			this.pendingCalls.set(messageId, {
				resolve: resolve as (result: unknown) => void,
				reject,
				timer,
				method,
				sessionId,
			});

			const message = createQueryMessage({ method, data, sessionId, id: messageId });
			this.sendMessage(message).catch((error) => {
				clearTimeout(timer);
				this.pendingCalls.delete(messageId);
				reject(error);
			});
		});
	}

	/**
	 * Broadcast an event to a room (server-side)
	 * If no room specified, broadcasts globally
	 */
	event(method: string, data?: unknown, options: EventOptions = {}): void {
		if (!this.isConnected()) {
			this.logDebug(`Event skipped (no transport): ${method}`);
			return;
		}
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}
		const sessionId = options.room || this.defaultSessionId;
		const message = createEventMessage({ method, data, sessionId });
		// Set room field for room-based routing
		message.room = options.room;
		this.sendMessage(message).catch((error) => {
			log.error(`Failed to send event ${method}:`, error);
		});
	}

	/**
	 * Register a command handler (server-side, no response sent)
	 */
	onCommand<TData = unknown>(method: string, handler: CommandHandler<TData>): UnsubscribeFn {
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}
		if (this.commandHandlers.has(method)) {
			log.warn(`Overwriting existing command handler for: ${method}`);
		}
		this.commandHandlers.set(method, handler as CommandHandler);
		this.logDebug(`Command handler registered: ${method}`);
		return () => {
			this.commandHandlers.delete(method);
			this.logDebug(`Command handler unregistered: ${method}`);
		};
	}

	/**
	 * Register a query handler (server-side, return value becomes response)
	 */
	onQuery<TData = unknown, TResult = unknown>(
		method: string,
		handler: QueryHandler<TData, TResult>
	): UnsubscribeFn {
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}
		if (this.queryHandlers.has(method)) {
			log.warn(`Overwriting existing query handler for: ${method}`);
		}
		this.queryHandlers.set(method, handler as QueryHandler);
		this.logDebug(`Query handler registered: ${method}`);
		return () => {
			this.queryHandlers.delete(method);
			this.logDebug(`Query handler unregistered: ${method}`);
		};
	}

	/**
	 * Listen for events (client-side)
	 * No subscription ceremony - just register handler locally
	 */
	onEvent<TData = unknown>(method: string, handler: RoomEventHandler<TData>): UnsubscribeFn {
		if (!validateMethod(method)) {
			throw new Error(`Invalid method name: ${method}`);
		}
		if (!this.roomEventHandlers.has(method)) {
			this.roomEventHandlers.set(method, new Set());
		}
		this.roomEventHandlers.get(method)!.add(handler as RoomEventHandler);
		this.logDebug(`Event handler registered: ${method}`);
		return () => {
			this.roomEventHandlers.get(method)?.delete(handler as RoomEventHandler);
			this.logDebug(`Event handler unregistered: ${method}`);
		};
	}

	/**
	 * Join a room (client → server)
	 * Sends a reserved command that the router handles
	 */
	joinRoom(room: string): void {
		if (!this.isConnected()) {
			this.logDebug(`joinRoom skipped (not connected): ${room}`);
			return;
		}
		const message = createCommandMessage({
			method: 'room.join',
			data: { room },
			sessionId: this.defaultSessionId,
		});
		this.sendMessage(message).catch((error) => {
			log.error(`Failed to join room ${room}:`, error);
		});
	}

	/**
	 * Leave a room (client → server)
	 */
	leaveRoom(room: string): void {
		if (!this.isConnected()) {
			this.logDebug(`leaveRoom skipped (not connected): ${room}`);
			return;
		}
		const message = createCommandMessage({
			method: 'room.leave',
			data: { room },
			sessionId: this.defaultSessionId,
		});
		this.sendMessage(message).catch((error) => {
			log.error(`Failed to leave room ${room}:`, error);
		});
	}

	// ========================================
	// Message Inspection
	// ========================================

	/**
	 * Register a handler for all messages (for debugging/logging)
	 *
	 * @example
	 * hub.onMessage((message, direction) => {
	 *   console.log(`[${direction}] ${message.type} ${message.method}`, message);
	 * });
	 */
	onMessage(handler: MessageHandler): UnsubscribeFn {
		this.messageHandlers.add(handler);
		return () => {
			this.messageHandlers.delete(handler);
		};
	}

	// ========================================
	// Internal Message Handling
	// ========================================

	/**
	 * Handle incoming message from transport
	 * FIX P1.3: Validate message sequence to detect out-of-order or missing messages
	 */
	private async handleIncomingMessage(message: HubMessage): Promise<void> {
		// Validate message structure
		if (!isValidMessage(message)) {
			log.error(`Invalid message format:`, message);
			throw new Error(`Invalid message format: ${JSON.stringify(message)}`);
		}

		this.logDebug(`← Incoming: ${message.type} ${message.method}`, message);

		// FIX P1.3: Validate message sequence (if present)
		// Server-side: track per-client (each client has its own sequence counter)
		// Client-side: track globally (server uses one global counter for all outgoing messages)
		if (typeof message.sequence === 'number' && this.warnOnSequenceGap) {
			const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId;

			if (this.router && clientId) {
				// Server-side: use per-client tracking
				const expectedSeq = this.expectedSequencePerClient.get(clientId);
				if (expectedSeq !== undefined) {
					if (message.sequence < expectedSeq) {
						log.warn(
							`Out-of-order message from client ${clientId}: ` +
								`received sequence ${message.sequence}, expected >= ${expectedSeq}`
						);
					} else if (message.sequence > expectedSeq) {
						const gap = message.sequence - expectedSeq;
						log.warn(
							`Message sequence gap from client ${clientId}: ` +
								`received sequence ${message.sequence}, expected ${expectedSeq} (gap: ${gap} messages)`
						);
					}
				}
				// Update expected sequence for this client
				this.expectedSequencePerClient.set(clientId, message.sequence + 1);
			} else {
				// Client-side: use global tracking (server uses single counter)
				if (this.expectedSequence !== null) {
					if (message.sequence < this.expectedSequence) {
						log.warn(
							`Out-of-order message detected: ` +
								`received sequence ${message.sequence}, expected >= ${this.expectedSequence}`
						);
					} else if (message.sequence > this.expectedSequence) {
						const gap = message.sequence - this.expectedSequence;
						log.warn(
							`Message sequence gap detected: ` +
								`received sequence ${message.sequence}, expected ${this.expectedSequence} (gap: ${gap} messages)`
						);
					}
				}
				// Update expected sequence for next message (global)
				this.expectedSequence = message.sequence + 1;
			}
		}

		// Notify message handlers
		this.notifyMessageHandlers(message, 'in');

		try {
			if (message.type === MessageType.PING) {
				await this.handlePing(message);
			} else if (message.type === MessageType.PONG) {
				this.handlePong(message);
			} else if (isCommandMessage(message)) {
				await this.handleIncomingCommand(message);
			} else if (isQueryMessage(message)) {
				await this.handleIncomingQuery(message);
			} else if (isResponseMessage(message)) {
				this.handleResponse(message);
			} else if (isEventMessage(message)) {
				await this.handleEvent(message);
			}
		} catch (error) {
			log.error(`Error handling message:`, error);
		}
	}

	/**
	 * Handle incoming COMMAND message (fire-and-forget, no response)
	 */
	private async handleIncomingCommand(message: HubMessage): Promise<void> {
		// Handle reserved room commands
		if (message.method === 'room.join' || message.method === 'room.leave') {
			if (this.router) {
				const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId;
				if (
					clientId &&
					message.data &&
					typeof (message.data as Record<string, unknown>).room === 'string'
				) {
					const room = (message.data as Record<string, unknown>).room as string;
					if (message.method === 'room.join') {
						this.router.joinRoom(clientId, room);
					} else {
						this.router.leaveRoom(clientId, room);
					}
				}
			}
			return;
		}

		const handler = this.commandHandlers.get(message.method);
		if (!handler) {
			this.logDebug(`No command handler for: ${message.method}`);
			return; // Commands are fire-and-forget, no error response
		}

		try {
			const context: CallContext = {
				messageId: message.id,
				sessionId: message.sessionId,
				method: message.method,
				timestamp: message.timestamp,
			};
			await Promise.resolve(handler(message.data, context));
		} catch (error) {
			log.error(`Command handler error for ${message.method}:`, error);
			// No response sent - commands are fire-and-forget
		}
	}

	/**
	 * Handle incoming QUERY message (returns response)
	 */
	private async handleIncomingQuery(message: HubMessage): Promise<void> {
		const handler = this.queryHandlers.get(message.method);
		const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId;

		if (!handler) {
			const errorMsg = createErrorResponseMessage({
				method: message.method,
				error: {
					message: `No handler for method: ${message.method}`,
					code: ErrorCode.METHOD_NOT_FOUND,
				},
				sessionId: message.sessionId,
				requestId: message.id,
			});
			await this.sendResponseToClient(errorMsg, clientId);
			return;
		}

		try {
			const context: CallContext = {
				messageId: message.id,
				sessionId: message.sessionId,
				method: message.method,
				timestamp: message.timestamp,
			};
			const result = await Promise.resolve(handler(message.data, context));

			const resultMsg = createResponseMessage({
				method: message.method,
				data: result,
				sessionId: message.sessionId,
				requestId: message.id,
			});
			await this.sendResponseToClient(resultMsg, clientId);
		} catch (error) {
			const errorMsg = createErrorResponseMessage({
				method: message.method,
				error: {
					message: error instanceof Error ? error.message : String(error),
					code: ErrorCode.HANDLER_ERROR,
				},
				sessionId: message.sessionId,
				requestId: message.id,
			});
			await this.sendResponseToClient(errorMsg, clientId);
		}
	}

	/**
	 * Handle response message (RESPONSE only for queries)
	 */
	private handleResponse(message: HubMessage): void {
		const requestId = message.requestId;
		if (!requestId) {
			log.warn(`Response without requestId:`, message);
			return;
		}

		// Check if it's a query response
		const pending = this.pendingCalls.get(requestId);
		if (!pending) {
			this.logDebug(`Response for unknown request: ${requestId} (method: ${message.method})`);
			return;
		}

		// Clear timeout
		clearTimeout(pending.timer);
		this.pendingCalls.delete(requestId);

		// Resolve or reject
		if (message.error) {
			pending.reject(new Error(message.error));
		} else {
			pending.resolve(message.data);
		}
	}

	/**
	 * Handle event message
	 *
	 * FIX P0.4: Prevent infinite recursion in event handlers
	 */
	private async handleEvent(message: HubMessage): Promise<void> {
		// FIX P0.4: Check recursion depth
		const currentDepth = this.eventDepthMap.get(message.id) || 0;
		if (currentDepth >= this.maxEventDepth) {
			log.error(
				`Max event depth (${this.maxEventDepth}) exceeded for ${message.method}. ` +
					`Possible circular dependency or infinite loop.`
			);
			return;
		}

		// Track depth
		this.eventDepthMap.set(message.id, currentDepth + 1);

		try {
			// Dispatch to room event handlers (new API)
			this.dispatchToRoomEventHandlers(message);
		} finally {
			// Clean up depth tracking immediately after handlers complete
			this.eventDepthMap.delete(message.id);
		}
	}

	/**
	 * Dispatch event to room event handlers (new API)
	 * Called from handleEvent alongside existing subscription dispatch
	 */
	private dispatchToRoomEventHandlers(message: HubMessage): void {
		const handlers = this.roomEventHandlers.get(message.method);
		if (!handlers || handlers.size === 0) return;

		const context = {
			messageId: message.id,
			sessionId: message.sessionId,
			method: message.method,
			timestamp: message.timestamp,
			room: message.room,
		};

		for (const handler of handlers) {
			try {
				Promise.resolve(handler(message.data, context)).catch((error) => {
					log.error(`Room event handler error for ${message.method}:`, error);
				});
			} catch (error) {
				log.error(`Room event handler sync error for ${message.method}:`, error);
			}
		}
	}

	/**
	 * Handle PING message - respond with PONG
	 */
	private async handlePing(message: HubMessage): Promise<void> {
		this.logDebug(`Received PING from session: ${message.sessionId}`);

		// Create PONG response
		const pongMessage: HubMessage = {
			id: generateUUID(),
			type: MessageType.PONG,
			sessionId: message.sessionId,
			method: 'heartbeat',
			timestamp: new Date().toISOString(),
			requestId: message.id,
		};

		// Send PONG response
		await this.sendMessage(pongMessage);
	}

	/**
	 * Handle PONG message - track connection health
	 */
	private handlePong(message: HubMessage): void {
		this.logDebug(`Received PONG from session: ${message.sessionId}`);
		// Optional: Could track latency metrics here
		// const latency = Date.now() - new Date(message.timestamp).getTime();
		// this.connectionHealth.set(message.sessionId, { latency, lastPong: Date.now() });
	}

	/**
	 * Send a message via transport
	 *
	 * Routing logic:
	 * - If router is registered (server-side) AND message is EVENT:
	 *   Router determines subscribers → Transport sends to those clients
	 * - Otherwise (client-side or non-EVENT):
	 *   Transport broadcasts directly
	 */
	private async sendMessage(message: HubMessage): Promise<void> {
		if (!this.transport || !this.transport.isReady()) {
			throw new Error('Transport not ready');
		}

		// Add sequence number for ordering guarantees
		message.sequence = this.messageSequence++;

		this.logDebug(
			`→ Outgoing: ${message.type} ${message.method} [seq=${message.sequence}]`,
			message
		);

		// Notify message handlers
		this.notifyMessageHandlers(message, 'out');

		// Server-side routing for EVENT messages
		if (this.router && message.type === MessageType.EVENT) {
			// Room-based routing if room is set
			if (message.room && this.router) {
				this.router.routeEventToRoom(message);
				return;
			}
			// Use router to route EVENT to subscribed clients
			const result = this.router.routeEvent(message);
			this.logDebug(`Routed event: ${result.sent}/${result.totalSubscribers} delivered`);
			return;
		}

		// Client-side or non-EVENT messages: send via transport
		await this.transport.send(message);
	}

	/**
	 * Send RPC response (RESULT/ERROR/SUBSCRIBED/UNSUBSCRIBED) to a specific client
	 * Server-side only - routes the response to the client that made the request
	 */
	private async sendResponseToClient(message: HubMessage, clientId?: string): Promise<void> {
		// Add sequence number for ordering guarantees
		message.sequence = this.messageSequence++;

		// Notify message handlers
		this.notifyMessageHandlers(message, 'out');

		// If we have a router and clientId, send to specific client
		if (this.router && clientId) {
			const success = this.router.sendToClient(clientId, message);
			if (!success) {
				log.warn(`Failed to send response to client ${clientId}, falling back to broadcast`);
				// Fallback to broadcast if client not found
				this.router.broadcast(message);
			}
			return;
		}

		// Fallback: send via transport (will broadcast on server-side)
		if (!this.transport || !this.transport.isReady()) {
			throw new Error('Transport not ready');
		}
		await this.transport.send(message);
	}

	/**
	 * Notify message handlers
	 */
	private notifyMessageHandlers(message: HubMessage, direction: 'in' | 'out'): void {
		for (const handler of this.messageHandlers) {
			try {
				handler(message, direction);
			} catch (error) {
				log.error(`Error in message handler:`, error);
			}
		}
	}

	/**
	 * Notify connection state handlers
	 */
	private notifyConnectionStateHandlers(state: ConnectionState, error?: Error): void {
		for (const handler of this.connectionStateHandlers) {
			try {
				handler(state, error);
			} catch (err) {
				log.error(`Error in connection state handler:`, err);
			}
		}
	}

	// ========================================
	// Cleanup
	// ========================================

	/**
	 * Cleanup all state
	 * FIX P1.3: Clear sequence tracking map
	 */
	cleanup(): void {
		// Reject all pending calls
		for (const [_requestId, pending] of this.pendingCalls) {
			clearTimeout(pending.timer);
			pending.reject(new Error('MessageHub cleanup'));
		}
		this.pendingCalls.clear();

		// Clear handlers
		this.commandHandlers.clear();
		this.queryHandlers.clear();
		this.roomEventHandlers.clear();
		this.messageHandlers.clear();
		this.connectionStateHandlers.clear();
		this.eventDepthMap.clear();

		// FIX P1.3: Clear sequence tracking
		this.expectedSequence = null;
		this.expectedSequencePerClient.clear();

		this.logDebug('MessageHub cleaned up');
	}

	// ========================================
	// Utilities
	// ========================================

	/**
	 * Clean up sequence tracking for a disconnected client (server-side only)
	 * Call this when a client disconnects to free up memory
	 */
	cleanupClientSequence(clientId: string): void {
		this.expectedSequencePerClient.delete(clientId);
	}

	/**
	 * Debug logging - uses unified logger
	 */
	private logDebug(message: string, ...args: unknown[]): void {
		log.debug(message, ...args);
	}

	/**
	 * Get pending call count
	 */
	getPendingCallCount(): number {
		return this.pendingCalls.size;
	}
}
