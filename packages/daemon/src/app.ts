import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import type { Config } from './config';
import { Database } from './storage/database';
import { SessionManager } from './lib/session-manager';
import { AuthManager } from './lib/auth-manager';
import { StateManager } from './lib/state-manager';
import { SubscriptionManager } from './lib/subscription-manager';
import { MessageHub, MessageHubRouter, EventBus } from '@liuboer/shared';
import { setupRPCHandlers } from './lib/rpc-handlers';
import { WebSocketServerTransport } from './lib/websocket-server-transport';
import { setupMessageHubWebSocket } from './routes/setup-websocket';

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
	app: Elysia<any>;
	db: Database;
	messageHub: MessageHub;
	sessionManager: SessionManager;
	authManager: AuthManager;
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
 * Creates and initializes the Liuboer daemon application.
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
 * @returns Initialized Elysia app and context for management
 */
export async function createDaemonApp(options: CreateDaemonAppOptions): Promise<DaemonAppContext> {
	const { config, verbose = true, standalone = false } = options;
	const log = verbose ? console.log : () => {};

	// Initialize database
	const db = new Database(config.dbPath);
	await db.initialize();
	log(`✅ Database initialized at ${config.dbPath}`);

	// Initialize authentication manager
	const authManager = new AuthManager(db, config);
	await authManager.initialize();
	log('✅ Authentication manager initialized');

	// Check authentication status - MUST be configured via environment variables
	const authStatus = await authManager.getAuthStatus();
	if (authStatus.isAuthenticated) {
		log(`✅ Authenticated via ${authStatus.method} (source: ${authStatus.source})`);
	} else {
		console.error('\n❌ AUTHENTICATION REQUIRED');
		console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
		console.error('Authentication credentials must be provided via environment variables.');
		console.error('\nOption 1: Anthropic API Key (Recommended)');
		console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
		console.error('\nOption 2: Claude Code OAuth Token');
		console.error('  export CLAUDE_CODE_OAUTH_TOKEN=...');
		console.error('\nGet your API key from: https://console.anthropic.com/');
		console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
		throw new Error('Authentication required');
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
	log('✅ MessageHubRouter initialized (clean - no application logic)');

	// 2. Initialize MessageHub (protocol layer)
	const messageHub = new MessageHub({
		defaultSessionId: 'global',
		debug: config.nodeEnv === 'development',
	});

	// 3. Register Router with MessageHub (MessageHub owns routing)
	messageHub.registerRouter(router);
	log('✅ Router registered with MessageHub');

	// 4. Initialize Transport (I/O layer) - needs router for client management
	const transport = new WebSocketServerTransport({
		name: 'websocket-server',
		debug: config.nodeEnv === 'development',
		router, // For client management only, not routing
	});

	// 5. Register Transport with MessageHub
	messageHub.registerTransport(transport);
	log('✅ MessageHub initialized with corrected architecture');
	log('   Flow: MessageHub (protocol) → Router (routing) → ClientConnection (I/O)');

	// FIX: Initialize EventBus (breaks circular dependency!)
	const eventBus = new EventBus({
		debug: config.nodeEnv === 'development',
	});
	log('✅ EventBus initialized (mediator pattern for component coordination)');

	// Initialize session manager (with EventBus, no StateManager dependency!)
	const sessionManager = new SessionManager(db, messageHub, authManager, eventBus, {
		defaultModel: config.defaultModel,
		maxTokens: config.maxTokens,
		temperature: config.temperature,
		workspaceRoot: config.workspaceRoot,
	});
	log('✅ Session manager initialized (no circular dependency!)');
	log(`   Environment: ${config.nodeEnv}`);
	log(`   Workspace root: ${config.workspaceRoot}`);

	// Initialize State Manager (listens to EventBus, clean dependency graph!)
	const stateManager = new StateManager(
		messageHub,
		sessionManager,
		authManager,
		config,
		eventBus // FIX: Listens to events instead of being called directly
	);
	log('✅ State manager initialized (fine-grained channels + per-channel versioning)');

	// Setup RPC handlers
	setupRPCHandlers({
		messageHub,
		sessionManager,
		authManager,
		config,
	});
	log('✅ RPC handlers registered');

	// Initialize Subscription Manager (application layer)
	const subscriptionManager = new SubscriptionManager(messageHub);
	log('✅ Subscription manager initialized (application-level subscription patterns)');

	// Create application
	const app = new Elysia()
		.use(
			cors({
				origin: '*',
				methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
				allowedHeaders: ['Content-Type'],
			})
		)
		.onError(({ error, set }) => {
			console.error('Error:', error);
			set.status = 500;
			return {
				error: 'Internal server error',
				message: error instanceof Error ? error.message : String(error),
			};
		});

	// Only add root info route in standalone mode
	if (standalone) {
		app.get('/', () => ({
			name: 'Liuboer Daemon',
			version: '0.1.0',
			status: 'running',
			protocol: 'WebSocket-only (MessageHub RPC + Pub/Sub)',
			endpoints: {
				webSocket: '/ws',
			},
			note: 'All operations use MessageHub protocol with bidirectional RPC and Pub/Sub. Session routing via message.sessionId field. REST API has been removed.',
		}));
	}

	// Mount MessageHub WebSocket routes (setupMessageHubWebSocket modifies app in-place)
	setupMessageHubWebSocket(app as any, transport, sessionManager, subscriptionManager);

	// Cleanup function for graceful shutdown
	const cleanup = async () => {
		log('   1/5 Stopping server...');
		app.stop();

		// Wait for pending RPC calls (with 5s timeout)
		log('   2/5 Waiting for pending RPC calls...');
		const pendingCallsCount = (messageHub as any)['pendingCalls']?.size || 0;
		if (pendingCallsCount > 0) {
			log(`       ${pendingCallsCount} pending calls detected`);
			await Promise.race([
				new Promise((resolve) => {
					const checkInterval = setInterval(() => {
						const remaining = (messageHub as any)['pendingCalls']?.size || 0;
						if (remaining === 0) {
							clearInterval(checkInterval);
							resolve(null);
						}
					}, 100);
				}),
				new Promise((resolve) => setTimeout(resolve, 5000)),
			]);
			const remaining = (messageHub as any)['pendingCalls']?.size || 0;
			if (remaining > 0) {
				log(`       ⚠️  Timeout: ${remaining} calls still pending`);
			} else {
				log(`       ✅ All pending calls completed`);
			}
		}

		// Cleanup MessageHub (rejects remaining calls)
		log('   3/5 Cleaning up MessageHub...');
		messageHub.cleanup();

		// Stop all agent sessions
		log('   4/5 Stopping agent sessions...');
		await sessionManager.cleanup();

		// Close database
		log('   5/5 Closing database...');
		db.close();

		log('✅ Graceful shutdown complete');
	};

	return {
		app: app as any,
		db,
		messageHub,
		sessionManager,
		authManager,
		stateManager,
		subscriptionManager,
		transport,
		cleanup,
	};
}
