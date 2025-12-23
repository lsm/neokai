import { createDaemonApp } from '@liuboer/daemon/app';
import type { Config } from '@liuboer/daemon/config';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'path';
import * as net from 'net';
import { createLogger } from '@liuboer/shared';

const log = createLogger('liuboer:cli:dev-server');

/**
 * Find an available port by creating a temporary server
 */
async function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				const port = address.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('Failed to get port')));
			}
		});
		server.on('error', reject);
	});
}

export async function startDevServer(config: Config) {
	log.info('🔧 Starting unified development server...');

	// Create daemon app in embedded mode (no root route)
	const daemonContext = await createDaemonApp({
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
	const vite = await createViteServer({
		configFile: resolve(import.meta.dir, '../../web/vite.config.ts'),
		root: resolve(import.meta.dir, '../../web/src'),
		server: {
			port: vitePort,
			strictPort: false, // Allow Vite to find another port if needed
			hmr: {
				protocol: 'ws',
				host: 'localhost',
				port: vitePort,
			},
		},
	});
	await vite.listen();
	log.info(`✅ Vite dev server running on port ${vitePort}`);

	// Get WebSocket handlers from daemon
	const { createWebSocketHandlers } = await import('@liuboer/daemon/routes/setup-websocket');
	const wsHandlers = createWebSocketHandlers(
		daemonContext.transport,
		daemonContext.sessionManager,
		daemonContext.subscriptionManager
	);

	// Create unified Bun server that combines daemon + Vite proxy
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

	log.info(`\n✨ Unified development server running!`);
	log.info(`   🌐 Frontend: http://localhost:${config.port}`);
	log.info(`   🔌 WebSocket: ws://localhost:${config.port}/ws`);
	log.info(`   🔥 HMR enabled (Vite on port ${vitePort}, proxied)`);
	log.info(`\n📝 Press Ctrl+C to stop\n`);

	// Graceful shutdown
	const shutdown = async (signal: string) => {
		log.info(`\n👋 Received ${signal}, shutting down gracefully...`);
		try {
			server.stop();
			log.info('🛑 Stopping Vite dev server...');
			await vite.close();
			log.info('🛑 Stopping daemon...');
			await daemonContext.cleanup();
			process.exit(0);
		} catch (error) {
			log.error('❌ Error during shutdown:', error);
			process.exit(1);
		}
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}
