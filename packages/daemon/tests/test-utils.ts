/**
 * Test utilities for Bun native server integration tests
 */

import type { Server } from 'bun';
import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from daemon package directory
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, '../.env') });
import { Database } from '../src/storage/database';
import { SessionManager } from '../src/lib/session-manager';
import { AuthManager } from '../src/lib/auth-manager';
import { SettingsManager } from '../src/lib/settings-manager';
import { StateManager } from '../src/lib/state-manager';
import { SubscriptionManager } from '../src/lib/subscription-manager';
import { MessageHub, MessageHubRouter } from '@liuboer/shared';
import { setupRPCHandlers } from '../src/lib/rpc-handlers';
import { WebSocketServerTransport } from '../src/lib/websocket-server-transport';
import { createWebSocketHandlers } from '../src/routes/setup-websocket';
import type { Config } from '../src/config';

export interface TestContext {
	server: Server;
	db: Database;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	messageHub: MessageHub;
	transport: WebSocketServerTransport;
	stateManager: StateManager;
	subscriptionManager: SubscriptionManager;
	authManager: AuthManager;
	baseUrl: string;
	workspacePath: string;
	config: Config;
	cleanup: () => Promise<void>;
}

/**
 * Global model cache for tests - reused across test app instances
 * This saves 100-200ms per test by avoiding repeated API calls to load models
 */
let globalModelsCache: Map<string, unknown> | null = null;

/**
 * Options for createTestApp
 */
export interface TestAppOptions {
	/**
	 * Whether to use git worktrees for session isolation.
	 * Default: false (disabled for speed - most tests don't need worktree isolation)
	 * Set to true in tests that specifically test worktree functionality.
	 */
	useWorktrees?: boolean;
}

/**
 * Create a test application instance with in-memory database
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
	const { useWorktrees = false } = options;
	// Use in-memory database for tests
	const dbPath = `:memory:`;
	const db = new Database(dbPath);
	await db.initialize();

	// Test config - use temp directory for workspace root
	const tmpDir = process.env.TMPDIR || '/tmp';
	const testWorkspaceRoot = `${tmpDir}/liuboer-test-${Date.now()}`;

	const config: Config = {
		host: 'localhost',
		port: 0, // Will be assigned randomly
		defaultModel: 'claude-sonnet-4-5-20250929',
		maxTokens: 8192,
		temperature: 1.0,
		anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
		claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		dbPath,
		maxSessions: 10,
		nodeEnv: 'test',
		workspaceRoot: testWorkspaceRoot,
		disableWorktrees: !useWorktrees, // Disable worktrees by default for speed
	};

	// Initialize authentication manager
	// Note: Credentials are read from environment variables, not set in database
	const authManager = new AuthManager(db, config);
	await authManager.initialize();

	// Check authentication status
	const authStatus = await authManager.getAuthStatus();
	// Only log auth status if TEST_VERBOSE is set
	if (process.env.TEST_VERBOSE) {
		console.log(
			'[TEST] Auth status:',
			authStatus.isAuthenticated ? `Authenticated via ${authStatus.method}` : 'Not authenticated'
		);
		if (!authStatus.isAuthenticated) {
			console.log(
				'[TEST] WARNING: No authentication configured! Tests requiring API calls will be skipped.'
			);
		}
	}

	// Initialize MessageHub architecture
	const router = new MessageHubRouter({
		logger: console,
		debug: false,
	});

	const messageHub = new MessageHub({
		defaultSessionId: 'global',
		debug: false,
	});

	messageHub.registerRouter(router);

	const transport = new WebSocketServerTransport({
		name: 'test-ws',
		debug: false,
		router,
	});

	messageHub.registerTransport(transport);

	// Initialize settings manager
	const settingsManager = new SettingsManager(db, config.workspaceRoot);

	// Initialize EventBus (breaks circular dependency!)
	const { EventBus } = await import('@liuboer/shared');
	const eventBus = new EventBus({
		debug: process.env.TEST_VERBOSE === '1', // Enable debug with TEST_VERBOSE=1
	});

	// Create session manager with EventBus and SettingsManager
	const sessionManager = new SessionManager(
		db,
		messageHub,
		authManager,
		settingsManager,
		eventBus, // Pass EventBus instead of StateManager
		{
			defaultModel: config.defaultModel,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			workspaceRoot: config.workspaceRoot,
			disableWorktrees: config.disableWorktrees, // Disable worktrees by default for tests
		}
	);

	// Initialize State Manager (listens to EventBus)
	const stateManager = new StateManager(
		messageHub,
		sessionManager,
		authManager,
		settingsManager,
		config,
		eventBus
	);

	// Setup RPC handlers
	setupRPCHandlers({
		messageHub,
		sessionManager,
		authManager,
		settingsManager,
		config,
		eventBus,
	});

	// Initialize Subscription Manager
	const subscriptionManager = new SubscriptionManager(messageHub);

	// Create WebSocket handlers
	const wsHandlers = createWebSocketHandlers(transport, sessionManager, subscriptionManager);

	// Create Bun server with native WebSocket support
	const server = Bun.serve({
		hostname: 'localhost',
		port: 0, // OS assigns free port

		fetch(req, server) {
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
						connectionSessionId: 'global',
					},
				});

				if (upgraded) {
					return; // WebSocket upgrade successful
				}

				return new Response('WebSocket upgrade failed', { status: 500 });
			}

			// Root info route
			if (url.pathname === '/') {
				return Response.json(
					{
						name: 'Liuboer Test Daemon',
						version: '0.1.0',
						status: 'running',
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
			if (process.env.TEST_VERBOSE) {
				console.error('Test app error:', error);
			}
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

	// Initialize model service if authentication is available
	if (authStatus.isAuthenticated) {
		try {
			const { initializeModels, setModelsCache, getModelsCache } =
				await import('../src/lib/model-service');

			// If we have a cached copy, reuse it to save 100-200ms
			if (globalModelsCache) {
				setModelsCache(globalModelsCache as Map<string, never>);
			} else {
				// First time - actually load models
				await initializeModels();
				// Save for future tests
				globalModelsCache = getModelsCache();
			}
		} catch (error) {
			// Silently fail - tests will handle missing models gracefully
			if (process.env.TEST_VERBOSE) {
				console.log('[TEST] Model initialization skipped:', error);
			}
		}
	}

	// Initial wait for server binding
	await Bun.sleep(100);

	const port = server.port;
	const baseUrl = `http://localhost:${port}`;

	// Verify server is ready with retry loop (longer timeouts for CI)
	let retries = 20; // More retries for CI environments
	while (retries > 0) {
		try {
			const response = await fetch(baseUrl, {
				signal: AbortSignal.timeout(500), // Longer timeout for slow CI
			});
			if (response.ok) break;
		} catch (error) {
			retries--;
			if (retries === 0) {
				throw new Error(`Server failed to start at ${baseUrl}: ${error}`);
			}
			await Bun.sleep(100); // More time between retries
		}
	}

	return {
		server,
		db,
		sessionManager,
		settingsManager,
		messageHub,
		transport,
		stateManager,
		subscriptionManager,
		authManager,
		baseUrl,
		workspacePath: config.workspaceRoot,
		config,
		cleanup: async () => {
			// Cleanup session resources (interrupts SDK queries)
			await sessionManager.cleanup();

			// Wait for SDK queries to gracefully stop after interrupt
			// This prevents "Cannot use a closed database" errors in CI
			await Bun.sleep(100);

			// Now cleanup MessageHub (removes RPC handlers)
			messageHub.cleanup();

			// Note: We don't clear globalModelsCache here - it's reused across tests
			// Individual tests can clear it if needed for isolation

			// Close database and stop server
			db.close();
			server.stop();
		},
	};
}

/**
 * Create WebSocket connection to test server and return both the WebSocket and a promise for the first message
 * Note: Uses unified /ws endpoint - sessionId is passed in message payloads, not URL
 */
export function createWebSocketWithFirstMessage(
	baseUrl: string,
	_sessionId: string,
	timeout = 5000
): { ws: WebSocket; firstMessagePromise: Promise<unknown> } {
	const wsUrl = baseUrl.replace('http://', 'ws://');
	const ws = new WebSocket(`${wsUrl}/ws`);

	// Set up message listener IMMEDIATELY (synchronously)
	const firstMessagePromise = new Promise((resolve, reject) => {
		const messageHandler = (event: MessageEvent) => {
			clearTimeout(timer);
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			try {
				const data = JSON.parse(event.data as string);
				resolve(data);
			} catch {
				reject(new Error('Failed to parse WebSocket message'));
			}
		};

		const errorHandler = (error: Event) => {
			clearTimeout(timer);
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			reject(error);
		};

		ws.addEventListener('message', messageHandler);
		ws.addEventListener('error', errorHandler);

		const timer = setTimeout(() => {
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			reject(new Error(`No WebSocket message received within ${timeout}ms`));
		}, timeout);
	});

	return { ws, firstMessagePromise };
}

/**
 * Create WebSocket connection to test server (legacy, for backward compatibility)
 * Note: Uses unified /ws endpoint - sessionId is passed in message payloads, not URL
 */
export function createWebSocket(baseUrl: string, _sessionId: string): WebSocket {
	const wsUrl = baseUrl.replace('http://', 'ws://');
	const ws = new WebSocket(`${wsUrl}/ws`);

	// Set up error handler immediately to catch early errors
	ws.addEventListener('error', (error) => {
		if (process.env.TEST_VERBOSE) {
			console.error('WebSocket error in test:', error);
		}
	});

	return ws;
}

/**
 * Wait for WebSocket to be in a specific state
 */
export async function waitForWebSocketState(
	ws: WebSocket,
	state: number,
	timeout = 5000
): Promise<void> {
	const startTime = Date.now();
	while (ws.readyState !== state) {
		if (Date.now() - startTime > timeout) {
			throw new Error(`WebSocket did not reach state ${state} within ${timeout}ms`);
		}
		await Bun.sleep(10);
	}
}

/**
 * Wait for WebSocket message
 * Sets up listener immediately to avoid race conditions
 */
export async function waitForWebSocketMessage(ws: WebSocket, timeout = 5000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		// Set up handlers first, before any timing checks
		const messageHandler = (event: MessageEvent) => {
			clearTimeout(timer);
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			try {
				const data = JSON.parse(event.data as string);
				resolve(data);
			} catch {
				reject(new Error('Failed to parse WebSocket message'));
			}
		};

		const errorHandler = (error: Event) => {
			clearTimeout(timer);
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			reject(error);
		};

		// Add listeners immediately
		ws.addEventListener('message', messageHandler);
		ws.addEventListener('error', errorHandler);

		// Then set timeout
		const timer = setTimeout(() => {
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			reject(
				new Error(
					`No WebSocket message received within ${timeout}ms (readyState: ${ws.readyState})`
				)
			);
		}, timeout);
	});
}

/**
 * Assertions
 */
export function assertEquals<T>(actual: T, expected: T, message?: string) {
	if (actual !== expected) {
		throw new Error(
			message ||
				`Assertion failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
		);
	}
}

export function assertExists<T>(value: T, message?: string): asserts value {
	if (value === null || value === undefined) {
		throw new Error(message || 'Assertion failed: value does not exist');
	}
}

/**
 * Credential check utilities
 *
 * These functions check for the presence of authentication credentials in the test environment.
 *
 * IMPORTANT: Tests that require API credentials should be placed in tests/online/ folder.
 * These tests will FAIL if credentials are not available - we do NOT use skipIf() because:
 * 1. It makes test status unclear (skipped vs passed)
 * 2. It hides missing credentials in CI
 * 3. Online tests should explicitly require credentials
 *
 * Example: Tests in tests/online/ folder will fail with clear error if credentials missing.
 */

/**
 * Check if API key is available in test environment
 */
export function hasApiKey(): boolean {
	return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Check if OAuth token is available in test environment
 */
export function hasOAuthToken(): boolean {
	return !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/**
 * Check if any authentication credentials are available
 */
export function hasAnyCredentials(): boolean {
	return hasApiKey() || hasOAuthToken();
}

/**
 * Call RPC handler directly (for integration tests)
 * Bypasses transport layer to test handlers directly
 */
export async function callRPCHandler<T = unknown>(
	messageHub: MessageHub,
	method: string,
	data: Record<string, unknown> = {}
): Promise<T> {
	// Access the handler directly from MessageHub's internal handlers map
	const handler = (
		messageHub as { rpcHandlers: Map<string, (data: unknown) => Promise<unknown>> }
	).rpcHandlers.get(method);
	if (!handler) {
		throw new Error(`RPC handler not found: ${method}`);
	}

	// Call handler with data
	const result = await handler(data);
	return result as T;
}
