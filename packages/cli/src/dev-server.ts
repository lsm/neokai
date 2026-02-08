import { createDaemonApp } from '@neokai/daemon/app';
import type { Config } from '@neokai/daemon/config';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'path';
import { createLogger } from '@neokai/shared';
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
	const wsHandlers = createWebSocketHandlers(
		daemonContext.transport,
		daemonContext.sessionManager,
		daemonContext.subscriptionManager
	);

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
