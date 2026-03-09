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
 * 2. Set ANTHROPIC_BASE_URL to point to Dev Proxy (e.g., http://127.0.0.1:8000)
 * 3. Stop Dev Proxy and restore ANTHROPIC_BASE_URL when the daemon server is cleaned up
 *
 * This allows tests to run without making real API calls to Anthropic.
 *
 * The ANTHROPIC_BASE_URL approach is more reliable than proxy environment variables
 * because SDK subprocesses properly inherit it.
 */

import { spawn } from 'child_process';
import path from 'path';
import { MessageHub, WebSocketClientTransport } from '@neokai/shared';
import { createDaemonApp, type DaemonAppContext } from '../../src/app';
import { getConfig } from '../../src/config';
import {
	createDevProxyController,
	type DevProxyController,
	type DevProxyOptions,
} from './dev-proxy';

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
	 * Dev Proxy controller (only when NEOKAI_USE_DEV_PROXY=1 or useDevProxy=true).
	 * Sets ANTHROPIC_BASE_URL to point to Dev Proxy for API mocking.
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
	// Sets ANTHROPIC_BASE_URL to Dev Proxy URL for SDK to use mocked responses
	let devProxy: DevProxyController | null = null;
	const shouldUseDevProxy = useDevProxy || process.env.NEOKAI_USE_DEV_PROXY === '1';

	if (shouldUseDevProxy) {
		devProxy = createDevProxyController({
			setEnvVars: true, // Sets ANTHROPIC_BASE_URL to proxy URL
			...devProxyOptions,
		});
		try {
			await devProxy.start();
			// Proxy env vars are set by DevProxyController when setEnvVars: true
		} catch (error) {
			// If Dev Proxy can't start (not installed, etc.), skip it and continue without mocking
			// Tests will use real API calls if credentials are available
			console.warn(
				'Warning: Could not start Dev Proxy, continuing without mocking. Error: ' +
					(error instanceof Error ? error.message : String(error))
			);
			devProxy = null;
		}
	}

	// Create a standalone daemon server entry point
	const serverPath = path.join(__dirname, 'standalone-server.ts');

	// Build environment for daemon process
	const daemonEnv: Record<string, string> = {
		...process.env,
		NEOKAI_USE_DEV_PROXY: shouldUseDevProxy ? '1' : process.env.NEOKAI_USE_DEV_PROXY,
		ANTHROPIC_BASE_URL: shouldUseDevProxy
			? 'http://127.0.0.1:8000'
			: process.env.ANTHROPIC_BASE_URL,
		PORT: userPort.toString(),
		NODE_ENV: 'test',
		NEOKAI_SDK_STARTUP_TIMEOUT_MS: process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS || '30000',
		...customEnv,
	};

	// Note: Proxy env vars are inherited from parent process via ...process.env
	// Dev Proxy will intercept requests to api.anthropic.com

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
			// Stop Dev Proxy (no need to restore env in spawned mode)
			if (devProxy) {
				await devProxy.stop();
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

	// Start Dev Proxy if requested
	// Sets ANTHROPIC_BASE_URL to Dev Proxy URL for SDK to use mocked responses
	let devProxy: DevProxyController | null = null;
	const shouldUseDevProxy = useDevProxy || process.env.NEOKAI_USE_DEV_PROXY === '1';

	if (shouldUseDevProxy) {
		devProxy = createDevProxyController({
			setEnvVars: true, // Sets ANTHROPIC_BASE_URL to proxy URL
			...devProxyOptions,
		});
		try {
			await devProxy.start();
			// Proxy env vars are set by DevProxyController when setEnvVars: true
		} catch (error) {
			// If Dev Proxy can't start (not installed, etc.), skip it and continue without mocking
			// Tests will use real API calls if credentials are available
			console.warn(
				'Warning: Could not start Dev Proxy, continuing without mocking. Error: ' +
					(error instanceof Error ? error.message : String(error))
			);
			devProxy = null;
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

			// Stop Dev Proxy and restore environment variables if Dev Proxy was started
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
