/// <reference types="vitest" />

import preact from '@preact/preset-vite';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [preact()],

	test: {
		environment: 'happy-dom',
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
		exclude: ['node_modules', 'dist'],
		globals: true,
		setupFiles: ['./vitest.setup.ts'],
		coverage: {
			provider: 'v8',
			reportsDirectory: 'coverage',
			reporter: ['text', 'lcov'],
		},
	},

	resolve: {
		alias: [
			// Handle subpath imports (e.g., @liuboer/shared/sdk/type-guards)
			{
				find: /^@liuboer\/shared\/(.+)$/,
				replacement: resolve(__dirname, '../shared/src/$1'),
			},
			// Handle main package import
			{
				find: '@liuboer/shared',
				replacement: resolve(__dirname, '../shared/src/mod.ts'),
			},
		],
	},
});
