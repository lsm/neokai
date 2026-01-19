/**
 * UnixSocketTransport - MessageHub transport over Unix domain sockets
 *
 * Enables IPC between yuanshen (Zig) and daemons using Unix sockets.
 * Uses NDJSON (newline-delimited JSON) for message framing.
 *
 * DESIGN PRINCIPLES:
 * 1. Same API as other transports (WebSocket, Stdio)
 * 2. Server mode: listens on socket path
 * 3. Client mode: connects to socket path
 * 4. Logs stay on stdout/stderr (no mixing with protocol)
 */

import type {
	IMessageTransport,
	ConnectionState,
	ConnectionStateHandler,
	UnsubscribeFn,
} from './types.ts';
import type { HubMessage } from './protocol.ts';
import { isValidMessage } from './protocol.ts';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

/**
 * Options for UnixSocketTransport
 */
export interface UnixSocketTransportOptions {
	/**
	 * Transport name for debugging
	 */
	name?: string;

	/**
	 * Unix socket path
	 */
	socketPath: string;

	/**
	 * Operating mode
	 * - 'server': Listen on socket path for connections
	 * - 'client': Connect to socket path
	 */
	mode: 'server' | 'client';

	/**
	 * Enable debug logging
	 * @default false
	 */
	debug?: boolean;
}

/**
 * UnixSocketTransport - IPC transport over Unix domain sockets
 */
export class UnixSocketTransport implements IMessageTransport {
	readonly name: string;

	private state: ConnectionState = 'disconnected';
	private messageHandlers = new Set<(message: HubMessage) => void>();
	private connectionHandlers = new Set<ConnectionStateHandler>();

	private readonly socketPath: string;
	private readonly mode: 'server' | 'client';
	private readonly debug: boolean;

	private server?: net.Server;
	private socket?: net.Socket;
	private readline?: ReadlineInterface;

	constructor(options: UnixSocketTransportOptions) {
		this.name = options.name || 'unix-socket';
		this.socketPath = options.socketPath;
		this.mode = options.mode;
		this.debug = options.debug || false;
	}

	/**
	 * Initialize transport
	 */
	async initialize(): Promise<void> {
		this.setState('connecting');

		if (this.mode === 'server') {
			await this.initializeServer();
		} else {
			await this.initializeClient();
		}
	}

	private async initializeServer(): Promise<void> {
		// Remove existing socket file if present
		try {
			fs.unlinkSync(this.socketPath);
		} catch {
			// Ignore if doesn't exist
		}

		return new Promise((resolve, reject) => {
			this.server = net.createServer((socket) => {
				this.log('Client connected');
				this.handleConnection(socket);
			});

			this.server.on('error', (error) => {
				this.log('Server error:', error);
				this.setState('error', error);
				reject(error);
			});

			this.server.listen(this.socketPath, () => {
				this.log('Server listening on', this.socketPath);
				this.setState('connected');
				resolve();
			});
		});
	}

	private async initializeClient(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection(this.socketPath, () => {
				this.log('Connected to', this.socketPath);
				this.handleConnection(this.socket!);
				resolve();
			});

			this.socket.on('error', (error) => {
				this.log('Connection error:', error);
				this.setState('error', error);
				reject(error);
			});
		});
	}

	private handleConnection(socket: net.Socket): void {
		this.socket = socket;

		// Set up readline for line-based reading
		this.readline = createInterface({
			input: socket,
			crlfDelay: Infinity,
		});

		this.readline.on('line', (line: string) => {
			this.handleLine(line);
		});

		this.readline.on('close', () => {
			this.log('Connection closed');
			this.setState('disconnected');
		});

		socket.on('error', (error: Error) => {
			this.log('Socket error:', error);
			this.setState('error', error);
		});

		this.setState('connected');
	}

	/**
	 * Send a message
	 */
	async send(message: HubMessage): Promise<void> {
		if (!this.isReady() || !this.socket) {
			throw new Error('UnixSocketTransport not connected');
		}

		const line = JSON.stringify(message) + '\n';
		this.log('Sending:', message.type, message.method);

		return new Promise<void>((resolve, reject) => {
			this.socket!.write(line, 'utf8', (error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Close transport
	 */
	async close(): Promise<void> {
		this.log('Closing transport');

		if (this.readline) {
			this.readline.close();
			this.readline = undefined;
		}

		if (this.socket) {
			this.socket.destroy();
			this.socket = undefined;
		}

		if (this.server) {
			this.server.close();
			this.server = undefined;

			// Clean up socket file
			try {
				fs.unlinkSync(this.socketPath);
			} catch {
				// Ignore
			}
		}

		this.setState('disconnected');
	}

	/**
	 * Check if transport is ready
	 */
	isReady(): boolean {
		return this.state === 'connected';
	}

	/**
	 * Get connection state
	 */
	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Register handler for incoming messages
	 */
	onMessage(handler: (message: HubMessage) => void): UnsubscribeFn {
		this.messageHandlers.add(handler);
		return () => {
			this.messageHandlers.delete(handler);
		};
	}

	/**
	 * Register handler for connection state changes
	 */
	onConnectionChange(handler: ConnectionStateHandler): UnsubscribeFn {
		this.connectionHandlers.add(handler);
		return () => {
			this.connectionHandlers.delete(handler);
		};
	}

	/**
	 * Handle incoming line
	 */
	private handleLine(line: string): void {
		if (!line.trim()) return;

		try {
			const message = JSON.parse(line);

			if (!isValidMessage(message)) {
				this.log('Invalid message received:', line.substring(0, 100));
				return;
			}

			this.log('Received:', message.type, message.method);

			for (const handler of this.messageHandlers) {
				try {
					handler(message);
				} catch (error) {
					console.error(`[${this.name}] Error in message handler:`, error);
				}
			}
		} catch (error) {
			this.log('Failed to parse message:', line.substring(0, 100), error);
		}
	}

	/**
	 * Set connection state and notify handlers
	 */
	private setState(state: ConnectionState, error?: Error): void {
		if (this.state === state) return;

		this.state = state;
		this.log('State changed to:', state);

		for (const handler of this.connectionHandlers) {
			try {
				handler(state, error);
			} catch (err) {
				console.error(`[${this.name}] Error in connection handler:`, err);
			}
		}
	}

	/**
	 * Debug logging
	 */
	private log(...args: unknown[]): void {
		if (this.debug) {
			console.error(`[${this.name}]`, ...args);
		}
	}
}

/**
 * Generate a socket path for a daemon
 * @internal - Test utility only
 */
export function getDaemonSocketPath(name: string): string {
	const tmpDir = process.env.TMPDIR || '/tmp';
	return `${tmpDir}/liuboer-${name}.sock`;
}
