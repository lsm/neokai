import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { createDaemonApp } from '@liuboer/daemon/app';
import type { Config } from '@liuboer/daemon/config';
import { resolve } from 'path';

export async function startProdServer(config: Config) {
	console.log('🚀 Starting production server...');

	// Create daemon app (returns Bun server)
	const daemonContext = await createDaemonApp({
		config,
		verbose: true,
		standalone: false, // Skip root info route in embedded mode
	});

	// Stop the daemon's internal server (we'll create a unified one)
	daemonContext.server.stop();

	// Get path to web dist folder
	const distPath = resolve(import.meta.dir, '../../web/dist');
	console.log(`📦 Serving static files from: ${distPath}`);

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

	console.log(`\n✨ Production server running!`);
	console.log(`   🌐 UI: http://localhost:${config.port}`);
	console.log(`   🔌 WebSocket: ws://localhost:${config.port}/ws`);
	console.log(`\n📝 Press Ctrl+C to stop\n`);

	// Graceful shutdown
	const shutdown = async (signal: string) => {
		console.log(`\n👋 Received ${signal}, shutting down gracefully...`);
		try {
			server.stop();
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
