/**
 * Connection Manager
 *
 * Manages the WebSocket connection lifecycle for MessageHub.
 * Provides both blocking and non-blocking connection access patterns.
 *
 * ## Usage Patterns:
 *
 * ### Non-blocking (preferred for UI):
 * ```typescript
 * const hub = connectionManager.getHubIfConnected();
 * if (!hub) {
 *   toast.error('Not connected');
 *   return;
 * }
 * await hub.call(...);
 * ```
 *
 * ### Blocking (for initialization):
 * ```typescript
 * const hub = await connectionManager.getHub();
 * ```
 *
 * ### Event-driven (for waiting):
 * ```typescript
 * await connectionManager.onConnected();
 * const hub = connectionManager.getHubOrThrow();
 * ```
 */

import { MessageHub, WebSocketClientTransport } from '@liuboer/shared';
import { appState, connectionState } from './state';
import { globalStore } from './global-store';
import { ConnectionNotReadyError, ConnectionTimeoutError } from './errors';
import { createDeferred } from './timeout';

/**
 * Type for connection event handlers
 */
type ConnectionHandler = () => void;

/**
 * Get the daemon WebSocket base URL
 *
 * In development, use the Vite dev server's proxy (same origin).
 * In production, connect directly to daemon port.
 */
function getDaemonWsUrl(): string {
	if (typeof window === 'undefined') {
		return 'ws://localhost:8283';
	}

	const hostname = window.location.hostname;
	const port = window.location.port;
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

	// In unified server mode (CLI), daemon and web share the same port
	// The CLI runs daemon+web on the same port (default 9283, or custom via --port)
	// Always use same origin when running through the CLI
	if (port) {
		// Use same origin - the unified server handles both web and WebSocket
		return `${protocol}//${hostname}:${port}`;
	}

	// Fallback for no port (unlikely in practice)
	return `${protocol}//${hostname}:8283`;
}

/**
 * ConnectionManager - manages MessageHub connection lifecycle
 *
 * Responsibilities:
 * - Lazy connection initialization
 * - Connection caching and reuse
 * - WebSocket transport configuration
 * - Connection state management
 * - Non-blocking connection access for UI responsiveness
 */
export class ConnectionManager {
	private messageHub: MessageHub | null = null;
	private transport: WebSocketClientTransport | null = null;
	private baseUrl: string;
	private connectionPromise: Promise<MessageHub> | null = null;
	private visibilityHandler: (() => void) | null = null;
	private pageHideHandler: (() => void) | null = null;

	// Event-driven connection handlers
	private connectionHandlers: Set<ConnectionHandler> = new Set();

	constructor(baseUrl?: string) {
		this.baseUrl = baseUrl || getDaemonWsUrl();
		console.log(`[ConnectionManager] Initialized with baseUrl: ${this.baseUrl}`);
		this.setupVisibilityHandlers();
	}

	// ========================================
	// Non-Blocking Access Methods (NEW)
	// ========================================

	/**
	 * Get the MessageHub instance if currently connected (NON-BLOCKING)
	 *
	 * Returns null immediately if not connected. Use this for UI handlers
	 * that should not block on connection.
	 *
	 * @returns MessageHub if connected, null otherwise
	 *
	 * @example
	 * ```typescript
	 * const hub = connectionManager.getHubIfConnected();
	 * if (!hub) {
	 *   toast.error('Not connected to server');
	 *   return;
	 * }
	 * await hub.call('session.create', data);
	 * ```
	 */
	getHubIfConnected(): MessageHub | null {
		if (this.messageHub && this.transport?.isReady()) {
			return this.messageHub;
		}
		return null;
	}

	/**
	 * Get the MessageHub instance or throw immediately (NON-BLOCKING)
	 *
	 * Throws ConnectionNotReadyError if not connected. Use this when you
	 * want to handle connection errors explicitly.
	 *
	 * @throws {ConnectionNotReadyError} If not connected
	 * @returns MessageHub instance
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   const hub = connectionManager.getHubOrThrow();
	 *   await hub.call('session.create', data);
	 * } catch (err) {
	 *   if (err instanceof ConnectionNotReadyError) {
	 *     toast.error('Please wait for connection...');
	 *   }
	 * }
	 * ```
	 */
	getHubOrThrow(): MessageHub {
		const hub = this.getHubIfConnected();
		if (!hub) {
			throw new ConnectionNotReadyError('WebSocket not connected');
		}
		return hub;
	}

	/**
	 * Wait for connection to be established (EVENT-DRIVEN)
	 *
	 * Returns a promise that resolves when connected. Does not block
	 * with polling - uses event-driven approach.
	 *
	 * @param timeout - Optional timeout in milliseconds (default: 10000)
	 * @throws {ConnectionTimeoutError} If timeout exceeded
	 *
	 * @example
	 * ```typescript
	 * await connectionManager.onConnected(5000);
	 * const hub = connectionManager.getHubOrThrow();
	 * ```
	 */
	onConnected(timeout: number = 10000): Promise<void> {
		// Already connected - resolve immediately
		if (this.isConnected()) {
			return Promise.resolve();
		}

		const { promise, resolve, reject } = createDeferred<void>();

		// Set up timeout
		const timer = setTimeout(() => {
			this.connectionHandlers.delete(handler);
			reject(new ConnectionTimeoutError(timeout));
		}, timeout);

		// Handler to call when connected
		const handler = () => {
			clearTimeout(timer);
			this.connectionHandlers.delete(handler);
			resolve();
		};

		// Register handler
		this.connectionHandlers.add(handler);

		return promise;
	}

	/**
	 * Register a callback for when connection is established
	 *
	 * @param callback - Function to call when connected
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsub = connectionManager.onceConnected(() => {
	 *   console.log('Connected!');
	 * });
	 * // Later: unsub() to cancel
	 * ```
	 */
	onceConnected(callback: ConnectionHandler): () => void {
		// Already connected - call immediately
		if (this.isConnected()) {
			callback();
			return () => {};
		}

		const handler = () => {
			this.connectionHandlers.delete(handler);
			callback();
		};

		this.connectionHandlers.add(handler);

		return () => {
			this.connectionHandlers.delete(handler);
		};
	}

	// ========================================
	// Blocking Access Methods (Existing)
	// ========================================

	/**
	 * Get the MessageHub instance, creating connection if needed (BLOCKING)
	 *
	 * NOTE: This method can block for several seconds. For UI handlers,
	 * prefer getHubIfConnected() or getHubOrThrow() instead.
	 *
	 * PHASE 3.3 FIX: Prevent race condition where multiple concurrent calls
	 * could create duplicate connections
	 */
	async getHub(): Promise<MessageHub> {
		// Return existing connected hub
		if (this.messageHub && this.transport?.isReady()) {
			return this.messageHub;
		}

		// If already connecting, wait for that
		if (this.connectionPromise) {
			return this.connectionPromise;
		}

		// Start new connection - assign immediately to prevent race
		this.connectionPromise = (async () => {
			try {
				const hub = await this.connect();
				return hub;
			} catch (error) {
				// On error, clear promise so next call can retry
				this.connectionPromise = null;
				throw error;
			}
		})();

		// Return the promise (no finally block to clear it)
		// connectionPromise stays set until disconnect() is called
		return this.connectionPromise;
	}

	/**
	 * Connect to daemon WebSocket with MessageHub
	 */
	private async connect(): Promise<MessageHub> {
		console.log('[ConnectionManager] Connecting to WebSocket...');

		// Set initial connecting state
		connectionState.value = 'connecting';

		// Create MessageHub
		this.messageHub = new MessageHub({
			defaultSessionId: 'global',
			debug: false,
		});

		// Listen to connection state changes and update global state
		this.messageHub.onConnection((state, error) => {
			console.log(`[ConnectionManager] Connection state: ${state}`, error);
			connectionState.value = state;

			// Notify connection handlers when connected
			if (state === 'connected') {
				this.notifyConnectionHandlers();
			}
		});

		// Expose to window for testing
		if (
			typeof window !== 'undefined' &&
			(window.location.hostname === 'localhost' || process.env.NODE_ENV === 'test')
		) {
			window.__messageHub = this.messageHub;
			window.appState = appState;
			window.__messageHubReady = false; // Will be set to true after connection
			window.connectionManager = this; // Expose for testing

			// Also expose currentSessionIdSignal for testing
			import('./signals.ts').then(({ currentSessionIdSignal }) => {
				window.currentSessionIdSignal = currentSessionIdSignal;
			});
		}

		// Create WebSocket transport with auto-reconnect
		this.transport = new WebSocketClientTransport({
			url: `${this.baseUrl}/ws`,
			autoReconnect: true,
			maxReconnectAttempts: 10,
			reconnectDelay: 1000,
			pingInterval: 30000,
		});

		// Register transport
		this.messageHub.registerTransport(this.transport);

		// Initialize transport (establishes WebSocket connection)
		await this.transport.initialize();

		// Wait for connection to be established (event-driven, not polling)
		await this.waitForConnectionEventDriven(5000);

		console.log('[ConnectionManager] WebSocket connected');

		// Mark ready for testing
		if (typeof window !== 'undefined' && window.__messageHub) {
			window.__messageHubReady = true;
		}

		return this.messageHub;
	}

	/**
	 * Wait for WebSocket to be ready (EVENT-DRIVEN - replaces polling)
	 */
	private waitForConnectionEventDriven(timeout: number): Promise<void> {
		// Already connected
		if (this.messageHub?.isConnected()) {
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new ConnectionTimeoutError(timeout, 'WebSocket connection timeout'));
			}, timeout);

			const unsub = this.messageHub!.onConnection((state) => {
				if (state === 'connected') {
					clearTimeout(timer);
					unsub();
					resolve();
				} else if (state === 'error') {
					clearTimeout(timer);
					unsub();
					reject(new ConnectionNotReadyError('WebSocket connection error'));
				}
			});
		});
	}

	/**
	 * Notify all registered connection handlers
	 */
	private notifyConnectionHandlers(): void {
		// Copy to array to allow handlers to remove themselves
		const handlers = Array.from(this.connectionHandlers);
		for (const handler of handlers) {
			try {
				handler();
			} catch (error) {
				console.error('[ConnectionManager] Error in connection handler:', error);
			}
		}
	}

	/**
	 * Disconnect from WebSocket
	 */
	async disconnect(): Promise<void> {
		console.log('[ConnectionManager] Disconnecting...');

		// Update connection state
		connectionState.value = 'disconnected';

		// Cleanup visibility handlers
		this.cleanupVisibilityHandlers();

		// Clear connection handlers
		this.connectionHandlers.clear();

		if (this.transport) {
			this.transport.close();
			this.transport = null;
		}

		this.messageHub = null;
		this.connectionPromise = null; // Clear connection promise on disconnect

		console.log('[ConnectionManager] Disconnected');
	}

	/**
	 * Check if currently connected
	 */
	isConnected(): boolean {
		return this.messageHub?.isConnected() || false;
	}

	/**
	 * Get current connection state
	 */
	getConnectionState(): typeof connectionState.value {
		return connectionState.value;
	}

	/**
	 * Setup page visibility handlers to detect Safari background tab issues
	 * Safari pauses WebSocket activity when tab is backgrounded
	 */
	private setupVisibilityHandlers(): void {
		if (typeof document === 'undefined') {
			return; // Not in browser environment
		}

		// Handle visibility changes (tab switch, minimize)
		this.visibilityHandler = () => {
			if (document.hidden) {
				console.log('[ConnectionManager] Page hidden - connection may be paused by browser');
			} else {
				console.log('[ConnectionManager] Page visible - validating connection');
				// IMPORTANT: Reset reconnect state when returning to page
				// This allows fresh reconnection attempts after being backgrounded
				if (this.transport) {
					this.transport.resetReconnectState();
				}
				this.validateConnectionOnResume();
			}
		};

		// Handle page hide (navigation away, close tab)
		this.pageHideHandler = () => {
			console.log('[ConnectionManager] Page hiding - marking connection as stale');
		};

		document.addEventListener('visibilitychange', this.visibilityHandler);
		document.addEventListener('pagehide', this.pageHideHandler);
	}

	/**
	 * Validate connection when returning from background
	 * Safari may have paused the WebSocket, so we need to check if it's still alive
	 *
	 * CRITICAL FIX: After successful health check, we MUST:
	 * 1. Force re-establish subscriptions (they may be stale on server)
	 * 2. Refresh all state channels (fetch latest state)
	 *
	 * This fixes the "sticky bug" where UI appears connected but doesn't
	 * receive updates after returning from background.
	 */
	private async validateConnectionOnResume(): Promise<void> {
		if (!this.messageHub || !this.transport) {
			// No connection exists - try to reconnect from scratch
			console.log('[ConnectionManager] No existing connection on resume, initiating reconnect');
			await this.reconnect();
			return;
		}

		try {
			// Send a lightweight health check with short timeout
			// If this fails, the connection is dead and needs reconnect
			await this.messageHub.call('system.health', {}, { timeout: 3000 });
			console.log('[ConnectionManager] Connection validated successfully');

			// CRITICAL FIX: Force resubscribe even when health check succeeds
			// Safari may pause WebSocket without closing it, causing server-side
			// subscriptions to timeout while client thinks it's still connected.
			// This ensures subscriptions are re-established on the server.
			// The debounce in resubscribeAll() prevents subscription storms.
			this.messageHub.forceResubscribe();

			// CRITICAL: Refresh ALL state (both session and global)
			// This ensures UI is in sync even if events were missed during background
			await Promise.all([appState.refreshAll(), globalStore.refresh()]);

			console.log('[ConnectionManager] Subscriptions and state refreshed after validation');
		} catch (error) {
			console.error('[ConnectionManager] Connection validation failed, forcing reconnect:', error);

			// FIX: Use forceReconnect() instead of close()
			// close() sets closed=true which prevents auto-reconnect
			if (this.transport) {
				this.transport.forceReconnect();
			}
		}
	}

	/**
	 * Manually trigger a reconnection attempt
	 * Use this when user clicks "Reconnect" button or to recover from permanent failure
	 */
	async reconnect(): Promise<void> {
		console.log('[ConnectionManager] Manual reconnect initiated');

		// Reset transport state to allow fresh connection
		if (this.transport) {
			this.transport.resetReconnectState();
			// Close existing connection if any
			if (this.transport.isReady()) {
				this.transport.forceReconnect();
				return; // forceReconnect will handle the reconnection
			}
		}

		// Clear existing state for fresh connection
		this.messageHub = null;
		this.connectionPromise = null;

		// Update UI state
		connectionState.value = 'connecting';

		// Attempt fresh connection
		try {
			await this.getHub();
			console.log('[ConnectionManager] Reconnection successful');
		} catch (error) {
			console.error('[ConnectionManager] Reconnection failed:', error);
			connectionState.value = 'failed';
		}
	}

	/**
	 * Cleanup visibility handlers
	 */
	private cleanupVisibilityHandlers(): void {
		if (typeof document === 'undefined') {
			return;
		}

		if (this.visibilityHandler) {
			document.removeEventListener('visibilitychange', this.visibilityHandler);
			this.visibilityHandler = null;
		}

		if (this.pageHideHandler) {
			document.removeEventListener('pagehide', this.pageHideHandler);
			this.pageHideHandler = null;
		}
	}

	/**
	 * Simulate disconnection for testing purposes
	 * This closes the WebSocket but allows auto-reconnect to work
	 */
	simulateDisconnect(): void {
		if (this.transport) {
			console.log('[ConnectionManager] Simulating disconnect for testing');
			// Use forceReconnect() instead of close() - close() sets closed=true which prevents reconnection
			this.transport.forceReconnect();
		}
	}

	/**
	 * Simulate permanent disconnection for testing purposes
	 * This closes the WebSocket and prevents auto-reconnect
	 * Use this for testing UI states when disconnected
	 */
	simulatePermanentDisconnect(): void {
		if (this.transport) {
			console.log('[ConnectionManager] Simulating permanent disconnect for testing');
			this.transport.close();
		}
		connectionState.value = 'disconnected';
	}
}

// Singleton instance
export const connectionManager = new ConnectionManager();
