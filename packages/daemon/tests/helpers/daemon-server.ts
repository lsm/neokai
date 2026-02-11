/**
 * Test helper for running daemon server in tests
 *
 * Provides two modes:
 * 1. In-process (default): Runs daemon in same process for coverage collection
 * 2. Spawned process: Runs daemon as separate process for true isolation
 */

import { spawn } from 'child_process';
import path from 'path';
import { MessageHub, WebSocketClientTransport } from '@neokai/shared';
import { createDaemonApp, type DaemonAppContext } from '../../src/app';
import { getConfig } from '../../src/config';

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
}

/**
 * Spawn a daemon server as a child process
 *
 * This creates a real daemon server running in a separate process,
 * allowing true process isolation and proper WebSocket testing.
 */
async function spawnDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServerContext> {
	const { port: userPort = 19400 + Math.floor(Math.random() * 1000), env: customEnv = {} } =
		options;

	// Create a standalone daemon server entry point
	const serverPath = path.join(__dirname, 'standalone-server.ts');

	// Spawn the daemon server
	const daemonProcess = spawn('bun', ['run', serverPath], {
		env: {
			...process.env,
			PORT: userPort.toString(),
			NODE_ENV: 'test',
			...customEnv,
		},
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
	const { port: userPort = 19400 + Math.floor(Math.random() * 1000), env: customEnv = {} } =
		options;

	// Apply custom env vars
	for (const [key, value] of Object.entries(customEnv)) {
		process.env[key] = value;
	}

	// Create temp workspace for this test
	const workspace = `/tmp/daemon-online-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await Bun.$`mkdir -p ${workspace}`;

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
