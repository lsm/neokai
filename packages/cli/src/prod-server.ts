import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { createDaemonApp } from '@liuboer/daemon/app';
import type { Config } from '@liuboer/daemon/config';
import { resolve } from 'path';
import { createLogger, generateUUID } from '@liuboer/shared';
import { UnixSocketTransport } from '@liuboer/shared/message-hub/unix-socket-transport';
import type { ClientConnection, HubMessage } from '@liuboer/shared';
import type { HubMessageWithMetadata } from '@liuboer/shared/message-hub/protocol';

const log = createLogger('liuboer:cli:prod-server');

export async function startProdServer(config: Config) {
	log.info('🚀 Starting production server...');

	// Create daemon app (returns Bun server)
	const daemonContext = await createDaemonApp({
		config,
		verbose: true,
		standalone: false, // Skip root info route in embedded mode
	});

	// Stop the daemon's internal server (we'll create a unified one)
	daemonContext.server.stop();

	// Initialize IPC socket if configured (for yuanshen orchestrator)
	let ipcTransport: UnixSocketTransport | undefined;
	let ipcClientId: string | undefined;
	if (config.ipcSocketPath) {
		log.info(`🔌 Starting IPC socket server at ${config.ipcSocketPath}...`);
		ipcTransport = new UnixSocketTransport({
			name: 'ipc-server',
			socketPath: config.ipcSocketPath,
			mode: 'server',
			debug: false, // Less verbose in production
		});
		await ipcTransport.initialize();

		// Generate a unique client ID for the IPC connection
		ipcClientId = generateUUID();

		// Register IPC as a ClientConnection with the router
		// This allows the yuanshen orchestrator to receive events
		const router = daemonContext.messageHub.getRouter();
		if (router) {
			const ipcConnection: ClientConnection = {
				id: ipcClientId,
				send: (data: string) => {
					try {
						const message = JSON.parse(data) as HubMessage;
						ipcTransport!.send(message);
					} catch (error) {
						log.error('[IPC] Failed to send message:', error);
					}
				},
				isOpen: () => ipcTransport?.isReady() ?? false,
				canAccept: () => true,
				metadata: { type: 'ipc', role: 'yuanshen-orchestrator' },
			};
			router.registerConnection(ipcConnection);
			log.info(`[IPC] Registered as client: ${ipcClientId}`);
		}

		// Handle messages from yuanshen orchestrator
		// Forward ALL messages through the transport's message handler path
		ipcTransport.onMessage((message) => {
			log.info(`[IPC] Received: ${message.type} ${message.method}`);

			// Add clientId to message for proper routing/response handling
			(message as HubMessageWithMetadata).clientId = ipcClientId;

			// Forward to the transport's handler which notifies MessageHub
			// This enables full RPC support (CALL/RESULT/EVENT/SUBSCRIBE)
			daemonContext.transport.handleClientMessage(message, ipcClientId);
		});

		log.info(`✅ IPC socket server ready at ${config.ipcSocketPath}`);
	}

	// Get path to web dist folder
	const distPath = resolve(import.meta.dir, '../../web/dist');
	log.info(`📦 Serving static files from: ${distPath}`);

	// Get WebSocket handlers from daemon
	const { createWebSocketHandlers } = await import('@liuboer/daemon/routes/setup-websocket');
	const wsHandlers = createWebSocketHandlers(
		daemonContext.transport,
		daemonContext.sessionManager,
		daemonContext.subscriptionManager
	);

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
				if (path.match(/\.(js|css|woff2?|ttf|svg|png|jpg|jpeg|gif|ico)$/)) {
					c.header('Cache-Control', 'public, max-age=31536000, immutable');
				}
				// Don't cache HTML (for SPA updates)
				else if (path.endsWith('.html')) {
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
	const server = Bun.serve({
		hostname: config.host,
		port: config.port,

		async fetch(req, server) {
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

			// WebSocket upgrade at /ws (daemon WebSocket)
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

			// Delegate all other requests to Hono for static file serving
			return app.fetch(req);
		},

		websocket: wsHandlers,

		error(error) {
			log.error('Server error:', error);
			return new Response(
				JSON.stringify({
					error: 'Internal server error',
					message: error instanceof Error ? error.message : String(error),
				}),
				{
					status: 500,
					headers: {
						'Content-Type': 'application/json',
					},
				}
			);
		},
	});

	log.info(`\n✨ Production server running!`);
	log.info(`   🌐 UI: http://localhost:${config.port}`);
	log.info(`   🔌 WebSocket: ws://localhost:${config.port}/ws`);
	if (config.ipcSocketPath) {
		log.info(`   🔗 IPC Socket: ${config.ipcSocketPath}`);
	}
	log.info(`\n📝 Press Ctrl+C to stop\n`);

	// Graceful shutdown - second Ctrl+C exits immediately
	let isShuttingDown = false;

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
			log.info('🛑 Stopping server...');
			server.stop();

			if (ipcTransport) {
				log.info('🛑 Closing IPC socket...');
				await ipcTransport.close();
			}

			log.info('🛑 Cleaning up daemon...');
			await daemonContext.cleanup();

			log.info('✨ Shutdown complete');
			process.exit(0);
		} catch (error) {
			log.error('❌ Error during shutdown:', error);
			process.exit(1);
		}
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}
