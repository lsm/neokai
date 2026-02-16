import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { createDaemonApp } from '@neokai/daemon/app';
import type { Config } from '@neokai/daemon/config';
import { resolve } from 'path';
import { createLogger, type MessageHub } from '@neokai/shared';
import { createNeoClientTransport, RoomNeo } from '@neokai/neo';
import { RoomManager } from '@neokai/daemon/lib/room';
import {
	createCorsPreflightResponse,
	isWebSocketPath,
	createJsonErrorResponse,
	shouldHaveImmutableCache,
	isHtmlFile,
	printServerUrls,
} from './cli-utils';

const log = createLogger('kai:cli:prod-server');

export async function startProdServer(config: Config) {
	log.info('🚀 Starting production server...');

	// Register signal handlers FIRST, before any async operations
	// This ensures Ctrl+C works even if startup hangs
	let isShuttingDown = false;
	let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
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
				log.info('🛑 Stopping server...');
				server.stop();
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
				// Add timeout for daemon cleanup
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

	// Create daemon app (returns Bun server)
	daemonContext = await createDaemonApp({
		config,
		verbose: true,
		standalone: false, // Skip root info route in embedded mode
	});

	// Stop the daemon's internal server (we'll create a unified one)
	daemonContext.server.stop();

	// Create Neo client with in-process transport
	log.info('🤖 Initializing Neo AI client...');

	const neoTransport = createNeoClientTransport({ name: 'neo-to-daemon' });

	// Register Neo's server transport with daemon's MessageHub
	unregisterNeoTransport = daemonContext.messageHub.registerTransport(
		neoTransport.serverTransport,
		'neo',
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

	// Get path to web dist folder
	const distPath = resolve(import.meta.dir, '../../web/dist');
	log.info(`📦 Serving static files from: ${distPath}`);

	// Get WebSocket handlers from daemon
	const { createWebSocketHandlers } = await import('@neokai/daemon/routes/setup-websocket');
	const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

	// Create Hono app for static file serving
	const app = new Hono();

	// Serve static files with compression and caching
	app.use(
		'/*',
		serveStatic({
			root: distPath,
			// Pre-compressed file support (serves .br, .gz based on Accept-Encoding)
			precompressed: true,
			// Cache headers for production assets
			onFound: (path, c) => {
				// Cache static assets aggressively (immutable files with content hashes)
				if (shouldHaveImmutableCache(path)) {
					c.header('Cache-Control', 'public, max-age=31536000, immutable');
				}
				// Don't cache HTML (for SPA updates)
				else if (isHtmlFile(path)) {
					c.header('Cache-Control', 'no-cache');
				}
			},
		})
	);

	// SPA fallback - serve index.html for client-side routes
	app.get('*', async (c) => {
		const html = await Bun.file(resolve(distPath, 'index.html')).text();
		return c.html(html, {
			headers: {
				'Cache-Control': 'no-cache',
			},
		});
	});

	// Create unified server with daemon + Hono static files
	server = Bun.serve({
		hostname: config.host,
		port: config.port,

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

			// Delegate all other requests to Hono for static file serving
			return app.fetch(req);
		},

		websocket: wsHandlers,

		error(error) {
			log.error('Server error:', error);
			return createJsonErrorResponse(error instanceof Error ? error.message : String(error));
		},
	});

	console.log(`\n✨ Production server running!`);
	printServerUrls(config.port, config.host);
	console.log(`\n📝 Press Ctrl+C to stop\n`);
}
