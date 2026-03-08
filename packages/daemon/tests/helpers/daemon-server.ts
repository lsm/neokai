/**
 * Test helper for running daemon server in tests
 *
 * Provides two modes:
 * 1. In-process (default): Runs daemon in same process for coverage collection
 * 2. Spawned process: Runs daemon as separate process for true isolation
 *
 * ## Dev Proxy Integration
 *
 * When NEOKAI_USE_DEV_PROXY=1 is set, the helper will:
 * 1. Start Dev Proxy before creating the daemon server
 * 2. Set proxy environment variables (HTTPS_PROXY, NODE_USE_ENV_PROXY, etc.)
 * 3. Stop Dev Proxy when the daemon server is cleaned up
 *
 * This allows tests to run without making real API calls to Anthropic.
 */

import { spawn } from 'child_process';
import path from 'path';
import { MessageHub, WebSocketClientTransport } from '@neokai/shared';
import { createDaemonApp, type DaemonAppContext } from '../../src/app';
import { getConfig } from '../../src/config';
import { installAutoMock, simpleTextResponse, type MockControls } from './mock-sdk';
import {
	createDevProxyController,
	type DevProxyController,
	type DevProxyOptions,
} from './dev-proxy';
import {
	createMockApiServer,
	type MockApiServer,
	type MockApiServerOptions,
} from './mock-api-server';

export interface DaemonServerOptions {
	/**
	 * Port for the daemon server
	 * Default: random port in 19400-20400 range
	 */
	port?: number;

	/**
	 * Environment variables to pass to the daemon process
	 */
	env?: Record<string, string>;

	/**
	 * Dev Proxy options for mocking HTTP requests
	 * Only used when NEOKAI_USE_DEV_PROXY=1 is set
	 */
	devProxy?: DevProxyOptions;

	/**
	 * Force enable Dev Proxy even without NEOKAI_USE_DEV_PROXY=1
	 * Default: false
	 */
	useDevProxy?: boolean;
}

export interface DaemonServerContext {
	/**
	 * Child process PID for sending signals
	 */
	pid: number;

	/**
	 * MessageHub client for communicating with the daemon
	 */
	messageHub: MessageHub;

	/**
	 * Base URL for the daemon server
	 */
	baseUrl: string;

	/**
	 * Kill the daemon server
	 */
	kill: (signal?: NodeJS.Signals) => boolean;

	/**
	 * Wait for the daemon to exit
	 */
	waitForExit: () => Promise<void>;

	/**
	 * Track a session for cleanup
	 */
	trackSession: (sessionId: string) => void;

	/**
	 * Cleanup all tracked sessions using session.delete RPC
	 */
	cleanup: () => Promise<void>;

	/**
	 * Mock controls (only available when NEOKAI_AGENT_SDK_MOCK is set).
	 * Use to override responses per-session or change defaults.
	 */
	mockControls: MockControls | null;

	/**
	 * Mock API server (only when NEOKAI_USE_DEV_PROXY=1 or useDevProxy=true).
	 * This is a simpler alternative to Dev Proxy that uses ANTHROPIC_BASE_URL.
	 */
	mockApiServer: MockApiServer | null;

	/**
	 * Dev Proxy controller (legacy, kept for compatibility).
	 * Use mockApiServer instead - it's simpler and more reliable.
	 */
	devProxy: DevProxyController | null;
}

/**
 * Spawn a daemon server as a child process
 *
 * This creates a real daemon server running in a separate process,
 * allowing true process isolation and proper WebSocket testing.
 */
async function spawnDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServerContext> {
	const {
		port: userPort = 19400 + Math.floor(Math.random() * 1000),
		env: customEnv = {},
		devProxy: devProxyOptions,
		useDevProxy = false,
	} = options;

	// Start Dev Proxy if requested
	let devProxy: DevProxyController | null = null;
	const shouldUseDevProxy = useDevProxy || process.env.NEOKAI_USE_DEV_PROXY === '1';

	if (shouldUseDevProxy) {
		devProxy = createDevProxyController({
			setEnvVars: true,
			...devProxyOptions,
		});
		await devProxy.start();
	}

	// Create a standalone daemon server entry point
	const serverPath = path.join(__dirname, 'standalone-server.ts');

	// Build environment for daemon process
	const daemonEnv: Record<string, string> = {
		...process.env,
		PORT: userPort.toString(),
		NODE_ENV: 'test',
		NEOKAI_SDK_STARTUP_TIMEOUT_MS: process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS || '30000',
		...customEnv,
	};

	// Include Dev Proxy env vars if proxy is running
	if (devProxy?.isRunning()) {
		daemonEnv.HTTPS_PROXY = devProxy.proxyUrl;
		daemonEnv.HTTP_PROXY = devProxy.proxyUrl;
		daemonEnv.NODE_USE_ENV_PROXY = '1';
		if (process.env.NODE_EXTRA_CA_CERTS) {
			daemonEnv.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
		}
	}

	// Spawn the daemon server
	const daemonProcess = spawn('bun', ['run', serverPath], {
		env: daemonEnv,
		stdio: 'pipe',
		// Don't use detached: true - we want to be able to track and kill the process
		detached: false,
	});

	// Wait for the server to be ready
	let stderrOutput = '';
	let stdoutOutput = '';
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Daemon server startup timeout')), 20000);

		const onData = (data: Buffer) => {
			const output = data.toString();
			stderrOutput += output;
			stdoutOutput += output;
			if (process.env.TEST_VERBOSE) {
				console.error(`[DAEMON-PROCESS] ${output.trim()}`);
			}
			if (output.includes('Running on port')) {
				clearTimeout(timeout);
				daemonProcess.stdout!.off('data', onData);
				daemonProcess.stderr!.off('data', onData);
				resolve();
			}
		};

		daemonProcess.stdout!.on('data', onData);
		daemonProcess.stderr!.on('data', onData);

		daemonProcess.on('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});

		daemonProcess.on('exit', (code) => {
			clearTimeout(timeout);
			reject(
				new Error(
					`Daemon server exited with code ${code}\nStderr: ${stderrOutput}\nStdout: ${stdoutOutput}`
				)
			);
		});
	});

	// Create WebSocket client to communicate with the daemon
	const wsUrl = `ws://127.0.0.1:${userPort}/ws`;
	const transport = new WebSocketClientTransport({
		url: wsUrl,
		autoReconnect: false, // Don't auto-reconnect in tests
	});

	const messageHub = new MessageHub({
		defaultSessionId: 'global',
	});

	messageHub.registerTransport(transport);
	await transport.initialize();

	// Track sessions for cleanup
	const trackedSessions: string[] = [];

	const cleanup = async () => {
		// Delete all tracked sessions via RPC
		for (const sessionId of trackedSessions) {
			try {
				await messageHub.request('session.delete', { sessionId });
			} catch {
				// Session may already be deleted, ignore errors
			}
		}
		trackedSessions.length = 0;
	};

	return {
		pid: daemonProcess.pid!,
		messageHub,
		baseUrl: `http://127.0.0.1:${userPort}`,
		mockControls: null, // Mock not available in spawned process mode
		mockApiServer: null, // Not used in spawned process mode
		devProxy,
		kill: (signal: NodeJS.Signals = 'SIGTERM') => daemonProcess.kill(signal),
		waitForExit: async () => {
			// Cleanup tracked sessions before exiting
			await cleanup();
			await new Promise<void>((resolve) => {
				if (daemonProcess.killed) {
					resolve();
					return;
				}
				daemonProcess.once('exit', () => resolve());
			});
			// Stop mock API server or Dev Proxy if they were started
			if (mockApiServer) {
				await mockApiServer.stop();
				mockApiServer.restoreEnv();
			}
			if (devProxy) {
				await devProxy.stop();
				devProxy.restoreEnv();
			}
		},
		trackSession: (sessionId: string) => {
			trackedSessions.push(sessionId);
		},
		cleanup,
	};
}

/**
 * Create an in-process daemon server for tests
 *
 * This runs the daemon in the same process as the tests, enabling:
 * - Coverage collection for daemon code
 * - Faster startup/shutdown
 * - Simpler debugging
 *
 * The daemon starts its own HTTP/WebSocket server. We connect to it
 * using WebSocketClientTransport, just like a real client.
 */
async function createInProcessDaemonServer(
	options: DaemonServerOptions = {}
): Promise<DaemonServerContext & { daemonContext: DaemonAppContext }> {
	const {
		port: userPort = 19400 + Math.floor(Math.random() * 1000),
		env: customEnv = {},
		devProxy: devProxyOptions,
		useDevProxy = false,
	} = options;

	// Start mock API server if requested
	// This is simpler and more reliable than Dev Proxy - we just set ANTHROPIC_BASE_URL
	let mockApiServer: MockApiServer | null = null;
	let devProxy: DevProxyController | null = null;
	const shouldUseDevProxy = useDevProxy || process.env.NEOKAI_USE_DEV_PROXY === '1';

	if (shouldUseDevProxy) {
		try {
			mockApiServer = await createMockApiServer({
				port: devProxyOptions?.port || 8000,
				logLevel: 'warning',
			});
			await mockApiServer.start();
		} catch (error) {
			// If mock API server fails (e.g., not running on Bun), fall back to Dev Proxy
			if (error instanceof Error && error.message.includes('Bun')) {
				console.warn('Mock API server requires Bun, falling back to Dev Proxy');
			} else {
				console.warn('Failed to start mock API server, falling back to Dev Proxy:', error);
			}
			// Try Dev Proxy fallback
			const devProxyController = createDevProxyController({
				setEnvVars: true,
				...devProxyOptions,
			});
			await devProxyController.start();
			devProxy = devProxyController;
		}
	}

	// Apply custom env vars
	for (const [key, value] of Object.entries(customEnv)) {
		process.env[key] = value;
	}

	// Online tests do real provider calls and often need longer startup windows in CI.
	// Keep production default unchanged; override only in test daemon helper.
	if (!process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS) {
		process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = '30000';
	}

	// Create temp workspace for this test
	const workspace = `/tmp/daemon-online-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await Bun.$`mkdir -p ${workspace}`;

	// Set worktree base dir to keep worktrees under /tmp (avoids ~/.neokai path issues in CI)
	if (!process.env.TEST_WORKTREE_BASE_DIR) {
		process.env.TEST_WORKTREE_BASE_DIR = `/tmp/daemon-worktrees-${Date.now()}`;
	}

	// Configure daemon
	process.env.NEOKAI_WORKSPACE_PATH = workspace;
	const config = getConfig();
	config.port = userPort;
	config.dbPath = `${workspace}/daemon.db`;

	// Create daemon app in-process (starts its own server)
	const daemonContext = await createDaemonApp({
		config,
		verbose: false,
		standalone: false,
	});

	// Install SDK mock when NEOKAI_AGENT_SDK_MOCK is set
	let mockControls: MockControls | null = null;
	if (process.env.NEOKAI_AGENT_SDK_MOCK) {
		mockControls = installAutoMock(daemonContext, simpleTextResponse('mock response'));
	}

	// Connect to the daemon's WebSocket server (just like a real client)
	const wsUrl = `ws://127.0.0.1:${userPort}/ws`;
	const transport = new WebSocketClientTransport({
		url: wsUrl,
		autoReconnect: false, // Don't auto-reconnect in tests
	});

	const messageHub = new MessageHub({
		defaultSessionId: 'global',
	});

	messageHub.registerTransport(transport);
	await transport.initialize();

	// Track sessions for cleanup
	const trackedSessions: string[] = [];

	const cleanup = async () => {
		// Delete all tracked sessions via RPC with timeout
		for (const sessionId of trackedSessions) {
			try {
				// Use Promise.race to add timeout - session.delete may hang if SDK is busy
				await Promise.race([
					messageHub.request('session.delete', { sessionId }),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error('session.delete timeout')), 5000)
					),
				]);
			} catch {
				// Session may already be deleted or timeout, ignore errors
			}
		}
		trackedSessions.length = 0;
	};

	return {
		pid: process.pid, // Same process
		messageHub,
		baseUrl: `http://127.0.0.1:${userPort}`,
		daemonContext, // Expose for advanced usage
		mockControls,
		mockApiServer,
		devProxy,
		kill: () => {
			// For in-process, cleanup happens in waitForExit - just return true
			return true;
		},
		waitForExit: async () => {
			// Wrap entire cleanup in timeout to prevent test hangs
			const cleanupWithTimeout = async () => {
				// Cleanup tracked sessions before exiting (with timeout protection)
				await cleanup();
				// Close client transport
				try {
					await transport.close();
				} catch {
					// Transport may already be closed
				}
				// Then cleanup daemon (stops server, closes DB, etc.)
				await daemonContext.cleanup();
				// Cleanup temp workspace
				await Bun.$`rm -rf ${workspace}`.quiet();
			};

			try {
				await Promise.race([
					cleanupWithTimeout(),
					new Promise<void>((_, reject) =>
						setTimeout(() => reject(new Error('waitForExit timeout')), 10000)
					),
				]);
			} catch {
				// Timeout or error - force cleanup workspace anyway
				await Bun.$`rm -rf ${workspace}`.quiet();
			}

			// Stop mock API server or Dev Proxy if they were started
			if (mockApiServer) {
				await mockApiServer.stop();
				mockApiServer.restoreEnv();
			}
			if (devProxy) {
				await devProxy.stop();
				devProxy.restoreEnv();
			}
		},
		trackSession: (sessionId: string) => {
			trackedSessions.push(sessionId);
		},
		cleanup,
	};
}

/**
 * Default function to create daemon server for tests
 *
 * Uses in-process mode by default for coverage collection.
 * Set DAEMON_TEST_SPAWN=true to use spawned process mode for true isolation.
 */
export async function createDaemonServer(
	options: DaemonServerOptions = {}
): Promise<DaemonServerContext> {
	if (process.env.DAEMON_TEST_SPAWN === 'true') {
		return spawnDaemonServer(options);
	}
	return createInProcessDaemonServer(options);
}
