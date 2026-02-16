/**
 * Production server for compiled binary distribution.
 * Serves web assets from Bun-embedded files instead of the filesystem.
 */

import { createDaemonApp } from '@neokai/daemon/app';
import type { Config } from '@neokai/daemon/config';
import { createLogger, type MessageHub } from '@neokai/shared';
import { createNeoClientTransport, RoomNeo } from '@neokai/neo';
import { RoomManager } from '@neokai/daemon/lib/room';
import {
	createCorsPreflightResponse,
	isWebSocketPath,
	createJsonErrorResponse,
	shouldHaveImmutableCache,
	isHtmlFile,
} from './cli-utils';
import { embeddedAssets } from './embedded-assets';

const log = createLogger('kai:cli:prod-server');

export async function startProdServer(config: Config) {
	log.info('Starting production server...');

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
			log.warn('Forcing exit...');
			process.exit(1);
		}
		isShuttingDown = true;

		log.info(
			`\nReceived ${signal}, shutting down gracefully... (Press Ctrl+C again to force exit)`
		);

		try {
			if (server) {
				log.info('Stopping server...');
				server.stop();
			}

			if (unregisterRoomLifecycle) {
				unregisterRoomLifecycle();
				unregisterRoomLifecycle = null;
			}

			if (neoHub) {
				log.info('Cleaning up Neo...');
				neoHub.cleanup();
				if (unregisterNeoTransport) {
					unregisterNeoTransport();
				}
			}

			// Cleanup RoomNeo instances
			if (roomNeos.size > 0) {
				log.info('Cleaning up RoomNeo instances...');
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
				log.info('Cleaning up daemon...');
				await Promise.race([
					daemonContext.cleanup(),
					new Promise<void>((resolve) => {
						setTimeout(() => {
							log.warn('Daemon cleanup timed out after 5s, continuing...');
							resolve();
						}, 5000);
					}),
				]);
			}

			log.info('Shutdown complete');
			process.exit(0);
		} catch (error) {
			log.error('Error during shutdown:', error);
			process.exit(1);
		}
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	// Create daemon app (returns Bun server)
	try {
		daemonContext = await createDaemonApp({
			config,
			verbose: true,
			standalone: false,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error(`[Server] Fatal: Failed to initialize daemon: ${message}`, error);
		throw error;
	}

	// Stop the daemon's internal server (we'll create a unified one)
	daemonContext.server.stop();

	// Create Neo client with in-process transport
	log.info('Initializing Neo AI client...');

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

	log.info('Neo AI client connected via in-process transport');

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
	log.info('Initializing RoomNeo instances...');
	const roomManager = new RoomManager(daemonContext.db.getDatabase());
	const rooms = roomManager.listRooms(false); // Only active rooms
	for (const room of rooms) {
		await startRoomNeo(room.id);
	}

	log.info(`${roomNeos.size} RoomNeo instance(s) initialized`);

	// Get WebSocket handlers from daemon
	const { createWebSocketHandlers } = await import('@neokai/daemon/routes/setup-websocket');
	const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

	// Pre-load index.html for SPA fallback
	const indexAsset = embeddedAssets.get('/index.html');
	let indexHtmlContent: string | null = null;
	if (indexAsset) {
		indexHtmlContent = await Bun.file(indexAsset.filePath).text();
	}

	log.info(`Serving ${embeddedAssets.size} embedded web assets`);

	// Create unified server serving embedded assets + daemon WebSocket
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
					return;
				}

				return new Response('WebSocket upgrade failed', { status: 500 });
			}

			// Serve embedded static assets
			const asset = embeddedAssets.get(url.pathname);
			if (asset) {
				const headers: Record<string, string> = {
					'Content-Type': asset.mimeType,
				};

				if (shouldHaveImmutableCache(url.pathname)) {
					headers['Cache-Control'] = 'public, max-age=31536000, immutable';
				} else if (isHtmlFile(url.pathname)) {
					headers['Cache-Control'] = 'no-cache';
				}

				return new Response(Bun.file(asset.filePath), { headers });
			}

			// SPA fallback: serve index.html for unmatched routes
			if (indexHtmlContent) {
				return new Response(indexHtmlContent, {
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': 'no-cache',
					},
				});
			}

			return new Response('Not found', { status: 404 });
		},

		websocket: wsHandlers,

		error(error) {
			log.error('Server error:', error);
			return createJsonErrorResponse(error instanceof Error ? error.message : String(error));
		},
	});

	log.info(`\nProduction server running!`);
	log.info(`   UI: http://localhost:${config.port}`);
	log.info(`   WebSocket: ws://localhost:${config.port}/ws`);
	log.info(`\nPress Ctrl+C to stop\n`);
}
