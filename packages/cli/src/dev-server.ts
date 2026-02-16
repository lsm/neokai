import { createDaemonApp } from '@neokai/daemon/app';
import type { Config } from '@neokai/daemon/config';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'path';
import { createLogger, type MessageHub } from '@neokai/shared';
import { createNeoClientTransport, RoomNeo } from '@neokai/neo';
import { RoomManager } from '@neokai/daemon/lib/room';
import {
	findAvailablePort,
	createCorsPreflightResponse,
	isWebSocketPath,
	createJsonErrorResponse,
	printServerUrls,
} from './cli-utils';

const log = createLogger('kai:cli:dev-server');

export async function startDevServer(config: Config) {
	log.info('🔧 Starting unified development server...');

	// Register signal handlers FIRST, before any async operations
	// This ensures Ctrl+C works even if startup hangs
	let isShuttingDown = false;
	let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
	let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
	let server: ReturnType<typeof Bun.serve> | null = null;
	let unregisterNeoTransport: (() => void) | null = null;
	let unregisterRoomLifecycle: (() => void) | null = null;
	let neoHub: MessageHub | null = null;
	let roomNeos: Map<string, RoomNeo> = new Map();

	const shutdown = async (signal: string) => {
		if (isShuttingDown) {
			// Second Ctrl+C - force exit immediately
			log.warn('Forcing exit...');
			process.exit(1);
		}
		isShuttingDown = true;

		log.info(
			`\n👋 Received ${signal}, shutting down gracefully... (Press Ctrl+C again to force exit)`
		);

		try {
			if (server) {
				log.info('🛑 Stopping unified server...');
				server.stop();
			}

			if (vite) {
				log.info('🛑 Stopping Vite dev server...');
				// Add timeout for Vite close - it can hang on active HMR connections
				await Promise.race([
					vite.close(),
					new Promise<void>((resolve) => {
						setTimeout(() => {
							log.warn('⚠️  Vite close timed out after 3s, continuing...');
							resolve();
						}, 3000);
					}),
				]);
			}

			if (unregisterRoomLifecycle) {
				unregisterRoomLifecycle();
				unregisterRoomLifecycle = null;
			}

			if (neoHub) {
				log.info('🛑 Cleaning up Neo...');
				neoHub.cleanup();
				if (unregisterNeoTransport) {
					unregisterNeoTransport();
				}
			}

			// Cleanup RoomNeo instances
			if (roomNeos.size > 0) {
				log.info('🛑 Cleaning up RoomNeo instances...');
				await Promise.all(
					Array.from(roomNeos.values()).map(async (roomNeo) => {
						try {
							await roomNeo.destroy();
						} catch (error) {
							log.error('Error destroying RoomNeo:', error);
						}
					})
				);
				roomNeos.clear();
			}

			if (daemonContext) {
				log.info('🛑 Cleaning up daemon...');
				// Add timeout for daemon cleanup as well
				await Promise.race([
					daemonContext.cleanup(),
					new Promise<void>((resolve) => {
						setTimeout(() => {
							log.warn('⚠️  Daemon cleanup timed out after 5s, continuing...');
							resolve();
						}, 5000);
					}),
				]);
			}

			log.info('✨ Shutdown complete');
			process.exit(0);
		} catch (error) {
			log.error('❌ Error during shutdown:', error);
			process.exit(1);
		}
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	// Create daemon app in embedded mode (no root route)
	daemonContext = await createDaemonApp({
		config,
		verbose: true,
		standalone: false, // Skip root info route in embedded mode
	});

	// Create Neo client with in-process transport
	// Neo connects to daemon via InProcessTransport, acting as a proper client
	log.info('🤖 Initializing Neo AI client...');

	const neoTransport = createNeoClientTransport({ name: 'neo-to-daemon' });

	// Register Neo's server transport with daemon's MessageHub
	// This allows Neo to make RPC calls to daemon through the transport layer
	unregisterNeoTransport = daemonContext.messageHub.registerTransport(
		neoTransport.serverTransport,
		'neo', // Named transport
		false // Not primary (websocket is primary)
	);

	// Initialize Neo's client transport
	await neoTransport.clientTransport.initialize();

	neoHub = neoTransport.neoClientHub;

	log.info('🤖 Neo AI client connected via in-process transport');

	// Wait for transport to be ready with timeout
	const readyStart = Date.now();
	while (!neoTransport.clientTransport.isReady()) {
		if (Date.now() - readyStart > 5000) {
			throw new Error('Transport failed to become ready within 5s timeout');
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	const startRoomNeo = async (roomId: string) => {
		if (roomNeos.has(roomId)) {
			return;
		}

		try {
			log.info(`   Starting RoomNeo for room ${roomId.slice(0, 8)}...`);
			const roomNeo = new RoomNeo(roomId, neoHub, { workspacePath: config.workspaceRoot });
			await roomNeo.initialize();
			roomNeos.set(roomId, roomNeo);
			log.info(`   ✓ RoomNeo initialized for room ${roomId.slice(0, 8)}`);
		} catch (error) {
			log.error(`   ✗ Failed to initialize RoomNeo for room ${roomId.slice(0, 8)}:`, error);
		}
	};

	const stopRoomNeo = async (roomId: string) => {
		const roomNeo = roomNeos.get(roomId);
		if (!roomNeo) {
			return;
		}

		try {
			log.info(`   Stopping RoomNeo for room ${roomId.slice(0, 8)}...`);
			await roomNeo.destroy();
			roomNeos.delete(roomId);
			log.info(`   ✓ RoomNeo stopped for room ${roomId.slice(0, 8)}`);
		} catch (error) {
			log.error(`   ✗ Failed to stop RoomNeo for room ${roomId.slice(0, 8)}:`, error);
		}
	};

	// Join global channel to receive room lifecycle events
	await neoHub.joinChannel('global');

	// Dynamically manage RoomNeo lifecycle as rooms are created/archived
	const unsubRoomCreated = neoHub.onEvent<{ roomId: string }>('room.created', (event) => {
		void startRoomNeo(event.roomId);
	});
	const unsubRoomArchived = neoHub.onEvent<{ roomId: string }>('room.archived', (event) => {
		void stopRoomNeo(event.roomId);
	});
	unregisterRoomLifecycle = () => {
		unsubRoomCreated();
		unsubRoomArchived();
	};

	// Create RoomNeo instances for active rooms at startup
	log.info('🤖 Initializing RoomNeo instances...');
	const roomManager = new RoomManager(daemonContext.db.getDatabase());
	const rooms = roomManager.listRooms(false); // Only active rooms
	for (const room of rooms) {
		await startRoomNeo(room.id);
	}

	log.info(`🤖 ${roomNeos.size} RoomNeo instance(s) initialized`);

	// Stop the daemon's internal server (we'll create a unified one)
	daemonContext.server.stop();

	// Find an available port for Vite dev server
	log.info('📦 Starting Vite dev server...');
	const vitePort = await findAvailablePort();
	log.info(`   Found available Vite port: ${vitePort}`);
	vite = await createViteServer({
		configFile: resolve(import.meta.dir, '../../web/vite.config.ts'),
		root: resolve(import.meta.dir, '../../web/src'),
		server: {
			port: vitePort,
			strictPort: false, // Allow Vite to find another port if needed
			hmr: {
				protocol: 'ws',
				host: config.host,
				port: vitePort,
			},
		},
	});
	await vite.listen();
	log.info(`✅ Vite dev server running on port ${vitePort}`);

	// Get WebSocket handlers from daemon
	const { createWebSocketHandlers } = await import('@neokai/daemon/routes/setup-websocket');
	const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

	// Create unified Bun server that combines daemon + Vite proxy
	server = Bun.serve({
		hostname: config.host,
		port: config.port,
		idleTimeout: 255, // Max value (255 sec) - prevent timeout on long requests

		async fetch(req, server) {
			const url = new URL(req.url);

			// CORS preflight
			if (req.method === 'OPTIONS') {
				return createCorsPreflightResponse();
			}

			// WebSocket upgrade at /ws (daemon WebSocket)
			if (isWebSocketPath(url.pathname)) {
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

			// Proxy all other requests to Vite dev server
			try {
				const viteUrl = `http://localhost:${vitePort}${url.pathname}${url.search}`;

				// Build fetch options, including body for non-GET requests
				const fetchOptions: RequestInit = {
					method: req.method,
					headers: {
						...Object.fromEntries(req.headers.entries()),
						// Override host to match Vite's expected host
						host: `localhost:${vitePort}`,
					},
				};

				// Forward request body for methods that may have one
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					fetchOptions.body = req.body;
					// Bun supports streaming body via duplex
					(fetchOptions as Record<string, unknown>).duplex = 'half';
				}

				const viteResponse = await fetch(viteUrl, fetchOptions);

				// Create response with Vite's response
				return new Response(viteResponse.body, {
					status: viteResponse.status,
					headers: viteResponse.headers,
				});
			} catch (error) {
				log.error('Vite proxy error:', error);
				return new Response('Failed to proxy to Vite', { status: 502 });
			}
		},

		websocket: wsHandlers,

		error(error) {
			log.error('Server error:', error);
			return createJsonErrorResponse(error instanceof Error ? error.message : String(error));
		},
	});

	console.log(`\n✨ Unified development server running!`);
	printServerUrls(config.port, config.host);
	console.log(`   🔥 HMR enabled (Vite on port ${vitePort}, proxied)`);
	console.log(`\n📝 Press Ctrl+C to stop\n`);
}
