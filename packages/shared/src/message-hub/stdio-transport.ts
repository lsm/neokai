/**
 * StdioTransport - MessageHub transport over stdin/stdout for IPC
 *
 * Enables inter-process communication using newline-delimited JSON (NDJSON).
 * Each message is a single line of JSON followed by a newline character.
 *
 * DESIGN PRINCIPLES:
 * 1. Same API as other transports (WebSocket, InProcess)
 * 2. Async everywhere for consistency
 * 3. Supports both spawned child process and parent process modes
 * 4. Line-based framing for reliable message boundaries
 *
 * USAGE:
 * ```typescript
 * // In parent process (spawns child)
 * const child = spawn('zig-orchestrator', []);
 * const transport = new StdioTransport({
 *   mode: 'parent',
 *   childProcess: child,
 * });
 *
 * // In child process (communicates with parent)
 * const transport = new StdioTransport({
 *   mode: 'child',
 * });
 * ```
 */

import type { IMessageTransport, ConnectionState, ConnectionStateHandler } from './types.ts';
import type { HubMessage } from './protocol.ts';
import { isValidMessage } from './protocol.ts';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

// Define UnsubscribeFn locally (removed from types.ts)
type UnsubscribeFn = () => void;

/**
 * Options for StdioTransport
 */
export interface StdioTransportOptions {
	/**
	 * Transport name for debugging
	 */
	name?: string;

	/**
	 * Operating mode
	 * - 'parent': This process spawned a child, communicates via child's stdio
	 * - 'child': This process was spawned, communicates via own stdio
	 * - 'streams': Custom streams provided (for testing or special cases)
	 */
	mode: 'parent' | 'child' | 'streams';

	/**
	 * Child process (required for 'parent' mode)
	 */
	childProcess?: ChildProcess;

	/**
	 * Custom input stream (for 'streams' mode)
	 */
	inputStream?: Readable;

	/**
	 * Custom output stream (for 'streams' mode)
	 */
	outputStream?: Writable;

	/**
	 * Enable debug logging
	 * @default false
	 */
	debug?: boolean;
}

/**
 * StdioTransport - IPC transport over stdin/stdout
 *
 * Uses newline-delimited JSON for message framing.
 * Each message is serialized to a single line and terminated with \n.
 */
export class StdioTransport implements IMessageTransport {
	readonly name: string;

	private state: ConnectionState = 'disconnected';
	private messageHandlers = new Set<(message: HubMessage) => void>();
	private connectionHandlers = new Set<ConnectionStateHandler>();

	private readonly mode: 'parent' | 'child' | 'streams';
	private readonly debug: boolean;

	private childProcess?: ChildProcess;
	private inputStream?: Readable;
	private outputStream?: Writable;
	private readline?: ReadlineInterface;

	// Buffer for incomplete lines (should not happen with readline, but defensive)
	private buffer = '';

	constructor(options: StdioTransportOptions) {
		this.name = options.name || 'stdio';
		this.mode = options.mode;
		this.debug = options.debug || false;

		if (options.mode === 'parent') {
			if (!options.childProcess) {
				throw new Error("StdioTransport in 'parent' mode requires childProcess");
			}
			this.childProcess = options.childProcess;
			this.inputStream = options.childProcess.stdout || undefined;
			this.outputStream = options.childProcess.stdin || undefined;
		} else if (options.mode === 'child') {
			// Use process stdin/stdout
			this.inputStream = process.stdin;
			this.outputStream = process.stdout;
		} else if (options.mode === 'streams') {
			if (!options.inputStream || !options.outputStream) {
				throw new Error("StdioTransport in 'streams' mode requires inputStream and outputStream");
			}
			this.inputStream = options.inputStream;
			this.outputStream = options.outputStream;
		}
	}

	/**
	 * Initialize transport and start reading
	 */
	async initialize(): Promise<void> {
		if (!this.inputStream || !this.outputStream) {
			throw new Error('StdioTransport streams not configured');
		}

		this.setState('connecting');

		// Set up readline for line-based reading
		this.readline = createInterface({
			input: this.inputStream,
			crlfDelay: Infinity, // Treat \r\n as single line ending
		});

		// Handle incoming lines
		this.readline.on('line', (line: string) => {
			this.handleLine(line);
		});

		// Handle stream close
		this.readline.on('close', () => {
			this.log('Input stream closed');
			this.setState('disconnected');
		});

		// Handle errors
		this.inputStream.on('error', (error: Error) => {
			this.log('Input stream error:', error);
			this.setState('error', error);
		});

		this.outputStream.on('error', (error: Error) => {
			this.log('Output stream error:', error);
			this.setState('error', error);
		});

		// If parent mode, handle child process exit
		if (this.childProcess) {
			this.childProcess.on('exit', (code, signal) => {
				this.log(`Child process exited with code ${code}, signal ${signal}`);
				this.setState('disconnected');
			});

			this.childProcess.on('error', (error: Error) => {
				this.log('Child process error:', error);
				this.setState('error', error);
			});
		}

		this.setState('connected');
	}

	/**
	 * Send a message to peer
	 */
	async send(message: HubMessage): Promise<void> {
		if (!this.isReady()) {
			throw new Error('StdioTransport not connected');
		}

		if (!this.outputStream) {
			throw new Error('Output stream not available');
		}

		// Serialize message to single line JSON + newline
		const line = JSON.stringify(message) + '\n';

		this.log('Sending:', message.type, message.method);

		// Write to output stream
		return new Promise<void>((resolve, reject) => {
			this.outputStream!.write(line, 'utf8', (error) => {
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

		// Don't close stdin/stdout in child mode (would break the process)
		if (this.mode === 'parent' && this.childProcess) {
			// Give child process a chance to cleanup
			this.childProcess.stdin?.end();
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
		// Skip empty lines
		if (!line.trim()) {
			return;
		}

		try {
			const message = JSON.parse(line);

			// Validate message structure
			if (!isValidMessage(message)) {
				this.log('Invalid message received:', line.substring(0, 100));
				return;
			}

			this.log('Received:', message.type, message.method);

			// Dispatch to handlers
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
		if (this.state === state) {
			return;
		}

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
			console.log(`[${this.name}]`, ...args);
		}
	}
}

/**
 * Create a paired stdio transport for testing
 *
 * Creates two transports connected via streams that can communicate
 * without actual processes. Useful for unit tests.
 *
 * @returns [clientTransport, serverTransport]
 */
export function createStdioPair(
	options: { debug?: boolean } = {}
): [StdioTransport, StdioTransport] {
	// Use PassThrough streams to connect the two transports
	const { PassThrough } = require('node:stream') as typeof import('node:stream');

	// Client writes to clientToServer, Server reads from clientToServer
	const clientToServer = new PassThrough();
	// Server writes to serverToClient, Client reads from serverToClient
	const serverToClient = new PassThrough();

	const client = new StdioTransport({
		name: 'stdio-client',
		mode: 'streams',
		inputStream: serverToClient,
		outputStream: clientToServer,
		debug: options.debug,
	});

	const server = new StdioTransport({
		name: 'stdio-server',
		mode: 'streams',
		inputStream: clientToServer,
		outputStream: serverToClient,
		debug: options.debug,
	});

	return [client, server];
}
