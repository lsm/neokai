import type { Server } from 'bun';
import type { Config } from './config';
import type { WebSocketData } from './types/websocket';
import { Database } from './storage/database';
import { SessionManager } from './lib/session-manager';
import { AuthManager } from './lib/auth-manager';
import { SettingsManager } from './lib/settings-manager';
import { StateManager } from './lib/state-manager';
import { SubscriptionManager } from './lib/subscription-manager';
import { MessageHub, MessageHubRouter } from '@neokai/shared';
import { createDaemonHub } from './lib/daemon-hub';
import { setupRPCHandlers } from './lib/rpc-handlers';
import { WebSocketServerTransport } from './lib/websocket-server-transport';
import { createWebSocketHandlers } from './routes/setup-websocket';

export interface CreateDaemonAppOptions {
	config: Config;
	/**
	 * Whether to log initialization steps to console.
	 * Default: true
	 */
	verbose?: boolean;
	/**
	 * Whether this is running in standalone mode.
	 * In standalone mode, adds a GET / route with daemon info.
	 * In embedded mode (default), skips the root route.
	 * Default: false
	 */
	standalone?: boolean;
}

export interface DaemonAppContext {
	server: Server<WebSocketData>;
	db: Database;
	messageHub: MessageHub;
	sessionManager: SessionManager;
	authManager: AuthManager;
	settingsManager: SettingsManager;
	stateManager: StateManager;
	subscriptionManager: SubscriptionManager;
	transport: WebSocketServerTransport;
	/**
	 * Cleanup function for graceful shutdown.
	 * Closes all connections, stops sessions, and closes database.
	 */
	cleanup: () => Promise<void>;
}

/**
 * Creates and initializes the NeoKai daemon application.
 *
 * This factory function sets up:
 * - Database connection
 * - Authentication manager
 * - MessageHub with WebSocket transport
 * - Session manager for Claude Agent SDK
 * - State synchronization channels
 * - RPC handlers
 *
 * @param options Configuration and options
 * @returns Initialized Bun server and context for management
 */
export async function createDaemonApp(options: CreateDaemonAppOptions): Promise<DaemonAppContext> {
	const { config, verbose = true, standalone = false } = options;
	const logInfo = verbose ? console.log : () => {};
	const logError = verbose ? console.error : () => {};

	// Initialize database
	const db = new Database(config.dbPath);
	await db.initialize();

	// Initialize authentication manager
	const authManager = new AuthManager(db, config);
	await authManager.initialize();

	// Initialize settings manager
	const settingsManager = new SettingsManager(db, config.workspaceRoot);

	// Check authentication status
	const authStatus = await authManager.getAuthStatus();

	// Initialize dynamic models on app startup (global cache fallback)
	if (authStatus.isAuthenticated) {
		const { initializeModels } = await import('./lib/model-service');
		await initializeModels();
	} /* v8 ignore next 3 */ else {
		logInfo('[Daemon] NO CREDENTIALS DETECTED - set ANTHROPIC_API_KEY or authenticate via OAuth');
		logInfo('[Daemon] Model initialization skipped - no credentials available');
	}

	// PHASE 3 ARCHITECTURE (FIXED): MessageHub owns Router, Transport is pure I/O
	// 1. Initialize MessageHubRouter (routing layer - pure routing, no app logic)
	const router = new MessageHubRouter({
		logger: console,
		debug: config.nodeEnv === 'development',
		// Rate limit: Allow burst of subscriptions on connection
		// Development/Production: 50 ops/sec (18 subscriptions on connect + overhead)
		// E2E tests: 100 ops/sec (7 parallel workers connecting simultaneously)
		subscriptionRateLimit: config.nodeEnv === 'test' ? 100 : 50,
	});

	// 2. Initialize MessageHub (protocol layer)
	const messageHub = new MessageHub({
		defaultSessionId: 'global',
		debug: config.nodeEnv === 'development',
	});

	// 3. Register Router with MessageHub (MessageHub owns routing)
	messageHub.registerRouter(router);

	// 4. Initialize Transport (I/O layer) - needs router for client management
	const transport = new WebSocketServerTransport({
		name: 'websocket-server',
		debug: config.nodeEnv === 'development',
		router, // For client management only, not routing
	});

	// 5. Register Transport with MessageHub
	messageHub.registerTransport(transport);

	// Initialize DaemonHub (TypedHub-based event coordination)
	const eventBus = createDaemonHub('daemon');
	await eventBus.initialize();

	// Initialize session manager (with EventBus, SettingsManager, no StateManager dependency!)
	const sessionManager = new SessionManager(
		db,
		messageHub,
		authManager,
		settingsManager,
		eventBus,
		{
			defaultModel: config.defaultModel,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			workspaceRoot: config.workspaceRoot,
		}
	);

	// Initialize State Manager (listens to EventBus, clean dependency graph!)
	const stateManager = new StateManager(
		messageHub,
		sessionManager,
		authManager,
		settingsManager,
		config,
		eventBus // FIX: Listens to events instead of being called directly
	);

	// Setup RPC handlers
	setupRPCHandlers({
		messageHub,
		sessionManager,
		authManager,
		settingsManager,
		config,
		daemonHub: eventBus,
		db,
	});

	// Initialize Subscription Manager (application layer)
	const subscriptionManager = new SubscriptionManager(messageHub);

	// Create WebSocket handlers
	const wsHandlers = createWebSocketHandlers(transport, sessionManager, subscriptionManager);

	// Create Bun server with native WebSocket support
	const server = Bun.serve({
		hostname: config.host,
		port: config.port,

		async fetch(req, server) {
			const url = new URL(req.url);

			// CORS preflight
			if (req.method === 'OPTIONS') {
				return new Response(null, {
					headers: {
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type',
					},
				});
			}

			// WebSocket upgrade at /ws
			if (url.pathname === '/ws') {
				const upgraded = server.upgrade(req, {
					data: {
						// Initial connection session is 'global'
						connectionSessionId: 'global',
					},
				});

				if (upgraded) {
					return; // WebSocket upgrade successful
				}

				return new Response('WebSocket upgrade failed', { status: 500 });
			}

			// Root info route (only in standalone mode)
			if (standalone && url.pathname === '/') {
				return Response.json(
					{
						name: 'NeoKai Daemon',
						version: '0.1.1',
						status: 'running',
						protocol: 'WebSocket-only (MessageHub RPC + Pub/Sub)',
						endpoints: {
							webSocket: '/ws',
						},
						note: 'All operations use MessageHub protocol with bidirectional RPC and Pub/Sub. Session routing via message.sessionId field. REST API has been removed.',
					},
					{
						headers: { 'Access-Control-Allow-Origin': '*' },
					}
				);
			}

			// 404 for unknown routes
			return new Response('Not found', {
				status: 404,
				headers: { 'Access-Control-Allow-Origin': '*' },
			});
		},

		websocket: wsHandlers,

		error(error) {
			logError('Server error:', error);
			return new Response(
				JSON.stringify({
					error: 'Internal server error',
					message: error instanceof Error ? error.message : String(error),
				}),
				{
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				}
			);
		},
	});

	// Cleanup function for graceful shutdown
	let isCleanedUp = false;
	const cleanup = async () => {
		if (isCleanedUp) {
			return;
		}
		isCleanedUp = true;

		try {
			try {
				server.stop();
			} catch {
				// Server already stopped
			}

			// Wait for pending RPC calls (with 3s timeout)
			const pendingCallsCount = messageHub.getPendingCallCount();
			if (pendingCallsCount > 0) {
				let checkInterval: ReturnType<typeof setInterval> | null = null;
				let resolved = false;
				await Promise.race([
					new Promise((resolve) => {
						checkInterval = setInterval(() => {
							const remaining = messageHub.getPendingCallCount();
							if (remaining === 0) {
								clearInterval(checkInterval!);
								checkInterval = null;
								resolved = true;
								logInfo('[Daemon] All pending calls completed');
								resolve(null);
							}
						}, 100);
					}),
					new Promise((resolve) =>
						setTimeout(() => {
							if (!resolved) {
								const remaining = messageHub.getPendingCallCount();
								logInfo(`[Daemon] Timeout: ${remaining} calls still pending after 3s`);
							}
							resolve(null);
						}, 3000)
					),
				]);
				// CRITICAL: Clear interval if timeout fired first (prevents hang on exit)
				if (checkInterval) {
					clearInterval(checkInterval);
				}
			}

			// Cleanup MessageHub (rejects remaining calls)
			messageHub.cleanup();

			// Stop all agent sessions
			await sessionManager.cleanup();

			// Close database
			db.close();

			logInfo('[Daemon] Graceful shutdown complete');
		} catch (error) {
			logError('Error during cleanup:', error);
			throw error;
		}
	};

	return {
		server,
		db,
		messageHub,
		sessionManager,
		authManager,
		settingsManager,
		stateManager,
		subscriptionManager,
		transport,
		cleanup,
	};
}
