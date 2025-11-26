import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact()],

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
    port: 9283,
    strictPort: true,
    host: true,
    hmr: {
      overlay: true,
      protocol: 'ws',
      host: 'localhost',
    },
    watch: {
      // Watch for changes in all relevant files
      ignored: ['**/node_modules/**', '**/dist/**'],
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
    alias: {
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
      '@liuboer/shared': resolve(__dirname, '../shared/src'),
    },
  },

  css: {
    postcss: {
      plugins: [],
    },
  },
});