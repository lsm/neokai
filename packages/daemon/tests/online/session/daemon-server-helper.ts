/**
 * Test helper for spawning daemon server as a separate process
 *
 * This is used for SIGINT testing where we need true process isolation.
 * The test runner communicates with the daemon via WebSocket.
 */

import { spawn } from 'child_process';
import path from 'path';
import { MessageHub, WebSocketClientTransport } from '@liuboer/shared';

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
	 * Child process PID for sending SIGINT
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
}

/**
 * Spawn a daemon server as a child process
 *
 * This creates a real daemon server running in a separate process,
 * allowing true process isolation for SIGINT testing.
 */
export async function spawnDaemonServer(
	options: DaemonServerOptions = {}
): Promise<DaemonServerContext> {
	const { port: userPort = 19400 + Math.floor(Math.random() * 1000), env: customEnv = {} } =
		options;

	// Create a standalone daemon server entry point
	const serverPath = path.join(__dirname, 'standalone-daemon-server.ts');

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
			console.error(`[DAEMON-PROCESS] ${output.trim()}`);
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

	return {
		pid: daemonProcess.pid!,
		messageHub,
		baseUrl: `http://127.0.0.1:${userPort}`,
		kill: (signal: NodeJS.Signals = 'SIGTERM') => daemonProcess.kill(signal),
		waitForExit: () =>
			new Promise<void>((resolve) => {
				if (daemonProcess.killed) {
					resolve();
					return;
				}
				daemonProcess.once('exit', () => resolve());
			}),
	};
}
