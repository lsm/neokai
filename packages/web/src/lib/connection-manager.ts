/**
 * Connection Manager
 *
 * Manages the WebSocket connection lifecycle for MessageHub.
 * Simpler and more focused than MessageHubAPIClient.
 */

import { MessageHub, WebSocketClientTransport } from '@liuboer/shared';
import { appState, connectionState } from './state';

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
 */
export class ConnectionManager {
	private messageHub: MessageHub | null = null;
	private transport: WebSocketClientTransport | null = null;
	private baseUrl: string;
	private connectionPromise: Promise<MessageHub> | null = null;
	private visibilityHandler: (() => void) | null = null;
	private pageHideHandler: (() => void) | null = null;

	constructor(baseUrl?: string) {
		this.baseUrl = baseUrl || getDaemonWsUrl();
		console.log(`[ConnectionManager] Initialized with baseUrl: ${this.baseUrl}`);
		this.setupVisibilityHandlers();
	}

	/**
	 * Get the MessageHub instance, creating connection if needed
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
		});

		// Expose to window for testing
		if (
			typeof window !== 'undefined' &&
			(window.location.hostname === 'localhost' || process.env.NODE_ENV === 'test')
		) {
			(window as any).__messageHub = this.messageHub;
			(window as any).appState = appState;
			(window as any).__messageHubReady = false; // Will be set to true after connection
			(window as any).connectionManager = this; // Expose for testing

			// Also expose currentSessionIdSignal for testing
			import('./signals.ts').then(({ currentSessionIdSignal }) => {
				(window as any).currentSessionIdSignal = currentSessionIdSignal;
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

		// Wait for connection to be established
		await this.waitForConnection(5000);

		console.log('[ConnectionManager] WebSocket connected');

		// Mark ready for testing
		if (typeof window !== 'undefined' && (window as any).__messageHub) {
			(window as any).__messageHubReady = true;
		}

		return this.messageHub;
	}

	/**
	 * Wait for WebSocket to be ready
	 */
	private async waitForConnection(timeout: number): Promise<void> {
		const start = Date.now();

		while (!this.messageHub?.isConnected()) {
			if (Date.now() - start > timeout) {
				throw new Error('WebSocket connection timeout');
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
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
	 */
	private async validateConnectionOnResume(): Promise<void> {
		if (!this.messageHub || !this.transport) {
			return;
		}

		try {
			// Send a lightweight health check with short timeout
			// If this fails, the connection is dead and needs reconnect
			await this.messageHub.call('system.health', {}, { timeout: 3000 });
			console.log('[ConnectionManager] Connection validated successfully');
		} catch (error) {
			console.error('[ConnectionManager] Connection validation failed, forcing reconnect:', error);

			// Update connection state to show we're reconnecting
			connectionState.value = 'reconnecting';

			// Force close and let auto-reconnect handle it
			if (this.transport) {
				this.transport.close();
			}
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
			// Close the WebSocket transport (will trigger reconnect if autoReconnect is enabled)
			this.transport.close();
		}
	}
}

// Singleton instance
export const connectionManager = new ConnectionManager();
