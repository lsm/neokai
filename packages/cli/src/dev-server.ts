import { Elysia } from 'elysia';
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
	const { app: daemonApp } = daemonContext;

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

	// Create main Elysia app that combines both
	const app = new Elysia()
		// First: Proxy non-daemon requests to Vite dev server
		.get('/', async ({ request }) => {
			// Proxy root to Vite
			try {
				const viteResponse = await fetch(`http://localhost:${vitePort}/`, {
					method: request.method,
					headers: request.headers,
				});

				return new Response(viteResponse.body, {
					status: viteResponse.status,
					headers: viteResponse.headers,
				});
			} catch (error) {
				console.error('Vite proxy error:', error);
				return new Response('Failed to proxy to Vite', { status: 502 });
			}
		})
		// Then: Mount daemon routes (includes WebSocket at /ws)
		.use(daemonApp)
		// Finally: Catch-all proxy for assets, HMR, etc.
		.get('*', async ({ request }) => {
			const url = new URL(request.url);

			// Proxy to Vite dev server
			try {
				const viteUrl = `http://localhost:${vitePort}${url.pathname}${url.search}`;
				const viteResponse = await fetch(viteUrl, {
					method: request.method,
					headers: request.headers,
				});

				return new Response(viteResponse.body, {
					status: viteResponse.status,
					headers: viteResponse.headers,
				});
			} catch (error) {
				console.error('Vite proxy error:', error);
				return new Response('Failed to proxy to Vite', { status: 502 });
			}
		})
		.onStop(async () => {
			console.log('🛑 Stopping Vite dev server...');
			await vite.close();
			console.log('🛑 Stopping daemon...');
			await daemonContext.cleanup();
		});

	const port = config.port;
	app.listen({ hostname: config.host, port });

	console.log(`\n✨ Unified development server running!`);
	console.log(`   🌐 Frontend: http://localhost:${port}`);
	console.log(`   🔌 WebSocket: ws://localhost:${port}/ws`);
	console.log(`   🔥 HMR enabled (Vite on port ${vitePort}, proxied)`);
	console.log(`\n📝 Press Ctrl+C to stop\n`);

	// Graceful shutdown
	const shutdown = async (signal: string) => {
		console.log(`\n👋 Received ${signal}, shutting down gracefully...`);
		try {
			app.stop();
			process.exit(0);
		} catch (error) {
			console.error('❌ Error during shutdown:', error);
			process.exit(1);
		}
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}
