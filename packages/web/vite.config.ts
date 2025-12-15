import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
	plugins: [preact(), tailwindcss()],

	root: 'src',
	publicDir: '../public',

	build: {
		outDir: '../dist',
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'src/index.html'),
			},
		},
	},

	server: {
		// NOTE: When using dev-server.ts (make dev), these settings are OVERRIDDEN
		// by the createViteServer() options which uses port 5173 internally.
		// These defaults are for standalone Vite development (make web).
		port: 9283,
		strictPort: true,
		host: true,
		allowedHosts: ['localhost', '127.0.0.1', 'ai0.tailcd822a.ts.net', 'tts.tailcd822a.ts.net'],
		hmr: {
			overlay: true,
			protocol: 'ws',
			host: 'localhost',
		},
		watch: {
			// Watch for changes in all relevant files
			// Exclude database, temporary files, and worktrees to prevent rebuild loops
			ignored: ['**/node_modules/**', '**/dist/**', '**/data/**', '**/tmp/**', '**/.worktrees/**'],
			usePolling: false, // Use native file system events
		},
		// Proxy API and WebSocket requests to daemon
		proxy: {
			'/api': {
				target: process.env.DAEMON_URL || 'http://localhost:8283',
				changeOrigin: true,
				ws: true, // Enable WebSocket proxying
			},
			// Also proxy WebSocket connections directly
			'/ws': {
				target: 'ws://localhost:8283',
				changeOrigin: true,
				ws: true,
			},
		},
	},

	optimizeDeps: {
		include: ['preact', '@preact/signals', 'marked', 'highlight.js', 'clsx', 'date-fns'],
		exclude: ['@liuboer/shared'], // Exclude local packages from pre-bundling
	},

	resolve: {
		alias: [
			{ find: 'react', replacement: 'preact/compat' },
			{ find: 'react-dom', replacement: 'preact/compat' },
			// Handle subpath imports (e.g., @liuboer/shared/sdk/type-guards)
			{ find: /^@liuboer\/shared\/(.+)$/, replacement: resolve(__dirname, '../shared/src/$1') },
			// Handle main package import
			{ find: '@liuboer/shared', replacement: resolve(__dirname, '../shared/src/mod.ts') },
		],
		extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
	},
});
