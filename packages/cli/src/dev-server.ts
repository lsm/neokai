import { createDaemonApp } from '@liuboer/daemon/app';
import type { Config } from '@liuboer/daemon/config';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'path';

export async function startDevServer(config: Config) {
	console.log('🔧 Starting unified development server...');

	// Create daemon app in embedded mode (no root route)
	const daemonContext = await createDaemonApp({
		config,
		verbose: true,
		standalone: false, // Skip root info route in embedded mode
	});

	// Stop the daemon's internal server (we'll create a unified one)
	daemonContext.server.stop();

	// Create Vite dev server on a different internal port
	console.log('📦 Starting Vite dev server...');
	const vitePort = 5173;
	const vite = await createViteServer({
		configFile: resolve(import.meta.dir, '../../web/vite.config.ts'),
		root: resolve(import.meta.dir, '../../web/src'),
		server: {
			port: vitePort,
			strictPort: true,
			hmr: {
				protocol: 'ws',
				host: 'localhost',
				port: vitePort,
			},
		},
	});
	await vite.listen();
	console.log(`✅ Vite dev server running on port ${vitePort}`);

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
				console.error('Vite proxy error:', error);
				return new Response('Failed to proxy to Vite', { status: 502 });
			}
		},

		websocket: wsHandlers,

		error(error) {
			console.error('Server error:', error);
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

	console.log(`\n✨ Unified development server running!`);
	console.log(`   🌐 Frontend: http://localhost:${config.port}`);
	console.log(`   🔌 WebSocket: ws://localhost:${config.port}/ws`);
	console.log(`   🔥 HMR enabled (Vite on port ${vitePort}, proxied)`);
	console.log(`\n📝 Press Ctrl+C to stop\n`);

	// Graceful shutdown
	const shutdown = async (signal: string) => {
		console.log(`\n👋 Received ${signal}, shutting down gracefully...`);
		try {
			server.stop();
			console.log('🛑 Stopping Vite dev server...');
			await vite.close();
			console.log('🛑 Stopping daemon...');
			await daemonContext.cleanup();
			process.exit(0);
		} catch (error) {
			console.error('❌ Error during shutdown:', error);
			process.exit(1);
		}
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}
