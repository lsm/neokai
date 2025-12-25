import type { KnipConfig } from 'knip';

const config: KnipConfig = {
	// Monorepo workspace configuration
	workspaces: {
		'packages/cli': {
			entry: ['src/dev-server.ts', 'src/prod-server.ts'],
		},
		'packages/daemon': {
			entry: ['src/app.ts', 'src/lib/rpc-handlers/*.ts'],
		},
		'packages/shared': {
			entry: ['src/mod.ts'],
		},
		'packages/web': {
			// Web entry is client.tsx (rendered by vite), not index.ts
			entry: ['src/client.tsx', 'src/index.html'],
		},
	},

	// Ignore patterns
	ignore: [
		'**/*.test.ts',
		'**/*.test.tsx',
		'**/__tests__/**',
		'**/dist/**',
		'**/node_modules/**',
		'**/*.d.ts',
		'packages/e2e/**', // E2E tests have different patterns
		'e2e/**', // E2E test files
		'docs/**',
		'examples/**', // Example scripts
		'scripts/**', // Utility scripts
		'**/*.config.ts',
		'**/*.config.js',
		'packages/web/vite.config.ts',
		'packages/web/tailwind.config.ts',
		'packages/web/postcss.config.js',
		'packages/web/src/index.ts', // Standalone dev server, not used in production
		'packages/daemon/scripts/**', // Database recovery scripts
		'packages/daemon/tests/manual/**', // Manual test scripts
		'packages/daemon/tests/mocks/**', // Test mocks
		'packages/shared/src/sdk/**', // SDK types from Claude Agent SDK (not all used)
	],

	// Workspace dependencies (don't flag as unlisted)
	ignoreWorkspaces: [],

	// Ignore specific binaries (build tools)
	ignoreBinaries: [
		'tailwindcss', // PostCSS plugin
		'playwright', // E2E testing
	],

	// Ignore specific dependencies (external tools, runtime only)
	ignoreDependencies: [
		'@liuboer/*', // Workspace dependencies
		'@testing-library/preact', // Used in tests
		'dotenv', // Used in development scripts
		'happy-dom', // Used in unit tests
	],

	// Ignore unused exports from these files (public API)
	ignoreExportsUsedInFile: {
		interface: true,
		type: true,
	},

	// Include entry source files in project
	includeEntryExports: true,
};

export default config;
