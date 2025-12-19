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
import { SimpleTitleQueue } from '../src/lib/simple-title-queue';
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
	titleQueue: SimpleTitleQueue;
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

	// Initialize Title Generation Queue (decoupled via EventBus)
	// This is critical for auto-title integration tests
	const titleQueue = new SimpleTitleQueue(db, eventBus, {
		maxRetries: 3,
		pollIntervalMs: 500, // Faster polling for tests (500ms instead of 1000ms)
		timeoutSecs: 30,
	});
	await titleQueue.start();

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

	// Reduced initial wait - most servers are ready much faster
	await Bun.sleep(50);

	const port = server.port;
	const baseUrl = `http://localhost:${port}`;

	// Verify server is ready with optimized retry loop
	let retries = 10; // More retries but shorter delays
	while (retries > 0) {
		try {
			const response = await fetch(baseUrl, {
				signal: AbortSignal.timeout(100), // Add timeout to fail fast
			});
			if (response.ok) break;
		} catch (error) {
			retries--;
			if (retries === 0) {
				throw new Error(`Server failed to start at ${baseUrl}: ${error}`);
			}
			await Bun.sleep(20); // Reduced from 100ms
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
		titleQueue,
		baseUrl,
		workspacePath: config.workspaceRoot,
		config,
		cleanup: async () => {
			// First stop title generation queue
			await titleQueue.stop();

			// Then cleanup session resources
			await sessionManager.cleanup();

			// Reduced wait - most async operations complete faster
			await Bun.sleep(20);

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
 * Make HTTP request to test server
 */
export async function request(
	baseUrl: string,
	method: string,
	path: string,
	body?: unknown,
	headers?: Record<string, string>
): Promise<Response> {
	const url = `${baseUrl}${path}`;
	const options: RequestInit = {
		method,
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
	};

	if (body) {
		options.body = JSON.stringify(body);
	}

	return await fetch(url, options);
}

/**
 * Assert response is successful and return JSON body
 */
export async function assertSuccessResponse<T>(
	response: Response,
	expectedStatus = 200
): Promise<T> {
	if (response.status !== expectedStatus) {
		const text = await response.text();
		throw new Error(`Expected status ${expectedStatus}, got ${response.status}. Body: ${text}`);
	}

	const body = await response.json();
	if (!body) {
		throw new Error('Response body is empty');
	}
	return body as T;
}

/**
 * Assert response is an error
 */
export async function assertErrorResponse(
	response: Response,
	expectedStatus: number
): Promise<{ error: string; message?: string }> {
	if (response.status !== expectedStatus) {
		const text = await response.text();
		throw new Error(
			`Expected error status ${expectedStatus}, got ${response.status}. Body: ${text}`
		);
	}

	const body = await response.json();
	if (!body) {
		throw new Error('Error response body is empty');
	}
	// @ts-expect-error - body is typed as unknown, but we check it at runtime
	if (!body.error) {
		throw new Error("Error response should have 'error' field");
	}
	return body as { error: string; message?: string };
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
 * Wait for WebSocket to open and receive the first message
 * This avoids race conditions by setting up the message listener before waiting for OPEN
 */
export async function waitForWebSocketOpenAndMessage(
	ws: WebSocket,
	timeout = 5000
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const startTime = Date.now();

		const messageHandler = (event: MessageEvent) => {
			clearTimeout(timer);
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			ws.removeEventListener('open', openHandler);
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
			ws.removeEventListener('open', openHandler);
			reject(error);
		};

		const openHandler = () => {
			if (process.env.TEST_VERBOSE) {
				console.log(`WebSocket opened on client side, waiting for message...`);
			}
		};

		// Add all listeners immediately when WebSocket is created
		ws.addEventListener('message', messageHandler);
		ws.addEventListener('error', errorHandler);
		ws.addEventListener('open', openHandler);

		const timer = setTimeout(() => {
			ws.removeEventListener('message', messageHandler);
			ws.removeEventListener('error', errorHandler);
			ws.removeEventListener('open', openHandler);
			reject(
				new Error(
					`No WebSocket message received within ${timeout}ms (readyState: ${ws.readyState}, elapsed: ${Date.now() - startTime}ms)`
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

export function assertNotEquals<T>(actual: T, expected: T, message?: string) {
	if (actual === expected) {
		throw new Error(
			message || `Assertion failed: expected not to equal ${JSON.stringify(expected)}`
		);
	}
}

export function assertTrue(value: boolean, message?: string) {
	if (!value) {
		throw new Error(message || 'Assertion failed: expected true');
	}
}

export function assertFalse(value: boolean, message?: string) {
	if (value) {
		throw new Error(message || 'Assertion failed: expected false');
	}
}

export function assertGreaterThan(actual: number, expected: number, message?: string) {
	if (actual <= expected) {
		throw new Error(message || `Assertion failed: ${actual} is not greater than ${expected}`);
	}
}

export function assertContains<T>(array: T[], item: T, message?: string) {
	if (!array.includes(item)) {
		throw new Error(message || `Assertion failed: array does not contain ${JSON.stringify(item)}`);
	}
}

/**
 * Credential check utilities
 *
 * These functions check for the presence of authentication credentials in the test environment.
 * Tests that make actual API calls to Claude (sending messages, etc.) should use test.skipIf()
 * to skip when credentials are not available.
 *
 * Example usage:
 *   test.skipIf(!hasAnyCredentials())("test name", async () => { ... });
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
 * Skip test if no API key is available
 */
export function requiresApiKey(test: { skip: () => void }) {
	if (!hasApiKey()) {
		test.skip();
	}
}

/**
 * Skip test if no OAuth token is available
 */
export function requiresOAuthToken(test: { skip: () => void }) {
	if (!hasOAuthToken()) {
		test.skip();
	}
}

/**
 * Skip test if no credentials are available
 */
export function requiresCredentials(test: { skip: () => void }) {
	if (!hasAnyCredentials()) {
		test.skip();
	}
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
