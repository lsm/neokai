/**
 * WebSocket Client Transport for MessageHub
 *
 * Client-side WebSocket transport without sessionId in URL
 */

import type {
	IMessageTransport,
	ConnectionState,
	ConnectionStateHandler,
	UnsubscribeFn,
} from './types.ts';
import type { HubMessage } from './protocol.ts';
import { generateUUID } from '../utils.ts';
import { createLogger } from '../logger.ts';

// Create logger for WebSocket transport (uses unified log levels)
const log = createLogger('liuboer:transport:client');

export interface WebSocketClientTransportOptions {
	/**
	 * WebSocket URL (no sessionId in path!)
	 */
	url: string;

	/**
	 * Auto-reconnect on disconnect
	 */
	autoReconnect?: boolean;

	/**
	 * Maximum reconnection attempts
	 */
	maxReconnectAttempts?: number;

	/**
	 * Base reconnection delay in milliseconds
	 */
	reconnectDelay?: number;

	/**
	 * Heartbeat/ping interval in milliseconds
	 */
	pingInterval?: number;
}

/**
 * WebSocket client transport for MessageHub
 */
export class WebSocketClientTransport implements IMessageTransport {
	readonly name = 'websocket-client';

	private ws: WebSocket | null = null;
	private state: ConnectionState = 'disconnected';
	private readonly url: string;
	private readonly autoReconnect: boolean;
	private readonly maxReconnectAttempts: number;
	private readonly reconnectDelay: number;
	private readonly pingInterval: number;

	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	private messageHandlers: Set<(message: HubMessage) => void> = new Set();
	private connectionHandlers: Set<ConnectionStateHandler> = new Set();

	// FIX P1.1: Message size validation (DoS prevention)
	private readonly maxMessageSize: number = 10 * 1024 * 1024; // 10MB

	// FIX P1.2: PONG timeout detection (stale connection detection)
	private lastPongTime: number = Date.now();
	private readonly pongTimeout: number = 60000; // 60s timeout for PONG
	private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: WebSocketClientTransportOptions) {
		this.url = options.url;
		this.autoReconnect = options.autoReconnect ?? true;
		this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
		this.reconnectDelay = options.reconnectDelay ?? 1000;
		this.pingInterval = options.pingInterval ?? 30000;
	}

	/**
	 * Initialize transport (connect)
	 */
	async initialize(): Promise<void> {
		return this.connect();
	}

	/**
	 * Connect to WebSocket
	 */
	private async connect(): Promise<void> {
		// Prevent connection after close() has been called
		if (this.closed) {
			return;
		}

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return;
		}

		this.setState('connecting');

		return new Promise((resolve, reject) => {
			try {
				this.ws = new WebSocket(this.url);

				this.ws.onopen = () => {
					log.info(`Connected to ${this.url}`);
					this.setState('connected');
					this.reconnectAttempts = 0;
					this.startPing();
					resolve();
				};

				this.ws.onmessage = (event) => {
					this.handleMessage(event.data);
				};

				this.ws.onerror = (error) => {
					log.error(`WebSocket error:`, error);
					this.setState('error', new Error('WebSocket error'));
				};

				this.ws.onclose = () => {
					log.info(`Disconnected`);
					this.setState('disconnected');
					this.stopPing();
					this.handleDisconnect();
				};
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				this.setState('error', err);
				reject(err);
			}
		});
	}

	/**
	 * Handle disconnect
	 *
	 * FIX P1.2: Add jitter to prevent thundering herd on reconnect
	 */
	private handleDisconnect(): void {
		// Prevent reconnection after close() has been called
		if (this.closed) {
			return;
		}

		if (!this.autoReconnect) {
			return;
		}

		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			log.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
			// Emit 'failed' state to notify UI that reconnection has permanently failed
			this.setState('failed');
			return;
		}

		this.reconnectAttempts++;

		// FIX P1.2: Add exponential backoff + jitter (±30%) to prevent thundering herd
		const baseDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
		const jitter = Math.random() * baseDelay * 0.6 - baseDelay * 0.3; // ±30%
		const delay = Math.max(100, baseDelay + jitter); // Minimum 100ms

		log.debug(
			`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
		);

		this.reconnectTimer = setTimeout(() => {
			this.connect().catch((error) => {
				log.error(`Reconnection failed:`, error);
			});
		}, delay);
	}

	/**
	 * Send a message
	 * FIX P0.5: Wrap send in try-catch to handle race condition where
	 * WebSocket closes between isReady() check and send() call
	 * FIX P1.1: Validate message size before sending (DoS prevention)
	 */
	async send(message: HubMessage): Promise<void> {
		if (!this.isReady()) {
			throw new Error('WebSocket not connected');
		}

		try {
			const json = JSON.stringify(message);

			// FIX P1.1: Validate message size before sending
			const messageSize = new TextEncoder().encode(json).length;
			if (messageSize > this.maxMessageSize) {
				throw new Error(
					`Message size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds maximum ${this.maxMessageSize / (1024 * 1024)}MB`
				);
			}

			this.ws!.send(json);
		} catch (error) {
			log.error(`Send failed:`, error);

			// Update state if WebSocket closed
			if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
				this.setState('disconnected');
			}

			throw new Error(
				`Failed to send message: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Close transport
	 */
	async close(): Promise<void> {
		// Set closed flag to prevent reconnection
		this.closed = true;

		// Clear timers
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.stopPing();

		// Close WebSocket
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.setState('disconnected');
	}

	/**
	 * Check if transport is ready
	 */
	isReady(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Get connection state
	 */
	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Reset reconnection state to allow fresh reconnection attempts
	 * Used when user manually triggers reconnect or returns from background
	 */
	resetReconnectState(): void {
		this.closed = false;
		this.reconnectAttempts = 0;
		log.debug(`Reconnect state reset - ready for fresh connection attempt`);
	}

	/**
	 * Force close and trigger reconnection
	 * Unlike close(), this does NOT set closed=true, allowing auto-reconnect
	 */
	forceReconnect(): void {
		log.debug(`Force reconnect initiated`);

		// Reset state to allow reconnection
		this.resetReconnectState();

		// Stop ping timer
		this.stopPing();

		// Close current WebSocket if exists
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		// Trigger handleDisconnect which will start reconnection
		this.setState('reconnecting');
		this.handleDisconnect();
	}

	/**
	 * Register handler for incoming messages
	 */
	onMessage(handler: (message: HubMessage) => void): UnsubscribeFn {
		this.messageHandlers.add(handler);
		return () => {
			this.messageHandlers.delete(handler);
		};
	}

	/**
	 * Register handler for connection state changes
	 */
	onConnectionChange(handler: ConnectionStateHandler): UnsubscribeFn {
		this.connectionHandlers.add(handler);
		return () => {
			this.connectionHandlers.delete(handler);
		};
	}

	/**
	 * Handle incoming message
	 * FIX P1.1: Validate message size before parsing (DoS prevention)
	 * FIX P1.2: Track PONG responses to detect stale connections
	 */
	private handleMessage(data: string): void {
		try {
			// FIX P1.1: Validate message size before parsing
			const messageSize = new TextEncoder().encode(data).length;
			if (messageSize > this.maxMessageSize) {
				log.error(
					`Message rejected: size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds limit ${this.maxMessageSize / (1024 * 1024)}MB`
				);
				return;
			}

			const message = JSON.parse(data) as HubMessage;

			// FIX P1.2: Track PONG responses for connection health
			if (message.type === 'PONG') {
				this.lastPongTime = Date.now();
			}

			// Notify all handlers
			for (const handler of this.messageHandlers) {
				try {
					handler(message);
				} catch (error) {
					log.error(`Error in message handler:`, error);
				}
			}
		} catch (error) {
			log.error(`Failed to parse message:`, error);
		}
	}

	/**
	 * Set connection state
	 */
	private setState(state: ConnectionState, error?: Error): void {
		if (this.state === state) {
			return;
		}

		this.state = state;

		// Notify all handlers
		for (const handler of this.connectionHandlers) {
			try {
				handler(state, error);
			} catch (err) {
				log.error(`Error in connection handler:`, err);
			}
		}
	}

	/**
	 * Start ping/heartbeat
	 *
	 * FIX P1.1: Send real PING messages to detect half-open connections
	 * FIX P1.2: Check for PONG timeout to detect stale connections
	 */
	private startPing(): void {
		if (this.pingInterval <= 0) {
			return;
		}

		this.stopPing();

		// FIX P1.2: Reset lastPongTime when starting ping
		this.lastPongTime = Date.now();

		this.pingTimer = setInterval(() => {
			if (this.isReady()) {
				// FIX P1.2: Check if PONG timeout exceeded
				const timeSinceLastPong = Date.now() - this.lastPongTime;
				if (timeSinceLastPong > this.pongTimeout) {
					log.error(
						`PONG timeout exceeded (${Math.round(timeSinceLastPong / 1000)}s > ${this.pongTimeout / 1000}s). Connection appears stale.`
					);
					// Force disconnect and reconnect
					if (this.ws) {
						this.ws.close();
					}
					this.handleDisconnect();
					return;
				}

				// FIX P1.1: Send actual PING message (not just check readyState)
				const pingMessage = {
					id: generateUUID(),
					type: 'PING' as const,
					method: 'heartbeat',
					sessionId: 'global',
					timestamp: new Date().toISOString(),
				};

				try {
					this.ws!.send(JSON.stringify(pingMessage));
				} catch (error) {
					log.error(`Failed to send PING:`, error);
					this.handleDisconnect();
				}
			}
		}, this.pingInterval);
	}

	/**
	 * Stop ping/heartbeat
	 * FIX P1.2: Clear PONG timeout timer
	 */
	private stopPing(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}

		if (this.pongTimeoutTimer) {
			clearTimeout(this.pongTimeoutTimer);
			this.pongTimeoutTimer = null;
		}
	}
}
