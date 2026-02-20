import { defineConfig, devices } from '@playwright/test';
import type { CoverageReportOptions } from 'monocart-reporter';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';

// Safety check: Prevent running E2E tests when a dev server is running
// This prevents accidentally killing the development server
if (!process.env.PLAYWRIGHT_BASE_URL) {
	// Look for dev server lock file by traversing up to repo root
	let currentDir = __dirname;
	for (let i = 0; i < 5; i++) {
		const lockFile = join(currentDir, 'tmp', '.dev-server-running');
		if (existsSync(lockFile)) {
			const port = readFileSync(lockFile, 'utf-8').trim();
			console.error(`
ERROR: A development server appears to be running (lock file found).

To run E2E tests against your dev server, use one of:
  make self-test TEST=tests/your-test.e2e.ts     (for 'make self' on port 9983)
  make run-test PORT=${port || 'YOUR_PORT'} TEST=tests/your-test.e2e.ts

Or set PLAYWRIGHT_BASE_URL explicitly:
  PLAYWRIGHT_BASE_URL=http://localhost:${port || 'YOUR_PORT'} bunx playwright test tests/your-test.e2e.ts
`);
			process.exit(1);
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
}

// Create isolated temp directories for this test run
// This ensures e2e tests NEVER affect production databases or workspaces
const testRunId = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const e2eTempDir = join(tmpdir(), 'neokai-e2e', testRunId);
const e2eWorkspaceDir = join(e2eTempDir, 'workspace');
const e2eDatabaseDir = join(e2eTempDir, 'database');

// Ensure directories exist
mkdirSync(e2eWorkspaceDir, { recursive: true });
mkdirSync(e2eDatabaseDir, { recursive: true });

console.log(`\n📁 E2E Test Isolation:
   Temp Dir: ${e2eTempDir}
   Workspace: ${e2eWorkspaceDir}
   Database: ${e2eDatabaseDir}/daemon.db
\n`);

/**
 * Monocart Coverage Reporter Configuration
 * See https://github.com/nicolo-ribaudo/monocart-reporter
 *
 * Coverage collection for frontend code (V8 coverage from browser)
 */
const coverageOptions: CoverageReportOptions = {
	// Output directory for coverage reports
	outputDir: './coverage',

	// Report formats (similar to Istanbul)
	reports: [
		// HTML report for visual browsing
		['v8'],
		['html-spa', { subdir: 'html' }],
		// LCOV for CI integration (Coveralls)
		['lcovonly', { file: 'lcov.info' }],
		// Console summary
		['console-summary'],
		// JSON for programmatic access
		['json', { file: 'coverage.json' }],
	],

	// Include all source files for coverage (even if not executed)
	all: ['../web/src/**/*.{ts,tsx}'],

	// Source filter - only collect coverage for our app code
	sourceFilter: (sourcePath: string) => {
		// Debug: log source paths to understand what we're receiving
		if (process.env.DEBUG_COVERAGE) {
			console.log('Coverage source path:', sourcePath);
		}

		// FIRST: Exclude anonymous/inline scripts (Playwright internals) - check before any includes
		// The path might be just "anonymous-1.js" or a URL containing it
		if (sourcePath.includes('anonymous')) return false;

		// Exclude node_modules and external libraries
		if (sourcePath.includes('node_modules')) return false;
		// Exclude Vite internals and chunks
		if (sourcePath.includes('/@vite/')) return false;
		if (sourcePath.includes('/@precss/')) return false;
		if (sourcePath.includes('chunk-')) return false;
		if (sourcePath.includes('.jsv=')) return false;
		// Exclude .js files (only want .ts/.tsx source files)
		if (sourcePath.endsWith('.js') && !sourcePath.endsWith('.tsx.js')) return false;

		// Exclude shared package files (message-hub, transport, etc.)
		// These are infrastructure files that aren't directly tested by UI tests
		if (
			sourcePath.includes('message-hub') ||
			sourcePath.includes('transport') ||
			sourcePath.includes('event-bus') ||
			sourcePath.includes('typed-hub') ||
			sourcePath.includes('router.ts')
		)
			return false;

		// Include our application source files only
		// These are actual source files, not anonymous scripts
		if (sourcePath.endsWith('.tsx')) return true;
		if (
			sourcePath.endsWith('.ts') &&
			!sourcePath.endsWith('.test.ts') &&
			!sourcePath.endsWith('.d.ts')
		)
			return true;

		return false;
	},

	// Watermarks for coverage thresholds (yellow/green)
	watermarks: {
		statements: [50, 80],
		functions: [50, 80],
		branches: [50, 80],
		lines: [50, 80],
	},
};

/**
 * Playwright E2E Testing Configuration
 * See https://playwright.dev/docs/test-configuration
 *
 * Parallel Execution Strategy:
 * - Project 1: "read-only" - Tests that don't create sessions (fully parallel)
 * - Project 2: "isolated-sessions" - Tests with proper cleanup (parallel)
 * - Project 3: "serial" - Complex tests requiring serial execution
 *
 * Coverage:
 * - Uses monocart-reporter for V8 coverage from browser
 * - Run with `bun run test:coverage` to generate coverage reports
 */

// Check if coverage is enabled
const collectCoverage = process.env.COVERAGE === 'true';

export default defineConfig({
	testDir: './tests',

	/* Run tests in files in parallel (enabled for Phase 1 + 2) */
	fullyParallel: true,

	/* Fail the build on CI if you accidentally left test.only in the source code */
	forbidOnly: !!process.env.CI,

	/* Retry on CI only (reduced to 1 for faster feedback) */
	retries: process.env.CI ? 1 : 0,

	/* Allow multiple workers for parallel execution */
	workers: process.env.CI ? 2 : 4,

	/* Reporter to use - add monocart when coverage is enabled */
	reporter: collectCoverage
		? [['monocart-reporter', { name: 'NeoKai E2E Coverage', coverage: coverageOptions }], ['list']]
		: [['html', { outputFolder: 'playwright-report' }], ['list']],

	/* Shared settings for all the projects below */
	use: {
		/* Base URL to use in actions like `await page.goto('/')` */
		/* Can be overridden via PLAYWRIGHT_BASE_URL for in-process server testing */
		baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9283',

		/* Collect trace when retrying the failed test */
		trace: 'on-first-retry',

		/* Screenshot on failure */
		screenshot: 'only-on-failure',

		/* Video on failure */
		video: 'retain-on-failure',

		/* Action timeout - increased for AI API calls and waitForFunction in CI */
		actionTimeout: 60000,
	},

	/* Global timeout for each test - increased for AI API calls in CI */
	timeout: 120000,

	/* Expect timeout for assertions - increased for AI API calls in CI */
	expect: {
		timeout: 60000,
	},

	/* Global setup - runs before ALL tests start */
	globalSetup: './global-setup.ts',

	/* Global teardown - runs after ALL tests complete */
	globalTeardown: './global-teardown',

	/* Configure projects for parallel execution */
	projects: [
		// Group 0: Smoke tests (quick critical path tests) - run first
		{
			name: 'smoke',
			testDir: './tests/smoke',
			testMatch: '**/*.e2e.ts',
			use: { ...devices['Desktop Chrome'] },
			// Smoke tests should be fast (< 1 minute total)
		},
		// Group 1: Read-only tests (no session creation) - fully parallel
		{
			name: 'read-only',
			testDir: './tests/read-only',
			testMatch: '**/*.e2e.ts',
			use: { ...devices['Desktop Chrome'] },
		},
		// Group 2: Core tests (critical functionality) - parallel
		{
			name: 'core',
			testDir: './tests/core',
			testMatch: '**/*.e2e.ts',
			use: { ...devices['Desktop Chrome'] },
		},
		// Group 3: Feature tests (secondary functionality) - parallel
		{
			name: 'features',
			testDir: './tests/features',
			testMatch: '**/*.e2e.ts',
			use: { ...devices['Desktop Chrome'] },
		},
		// Group 4: Settings tests - parallel
		{
			name: 'settings',
			testDir: './tests/settings',
			testMatch: '**/*.e2e.ts',
			use: { ...devices['Desktop Chrome'] },
		},
		// Group 5: Responsive tests (mobile, tablet) - parallel
		{
			name: 'responsive',
			testDir: './tests/responsive',
			testMatch: '**/*.e2e.ts',
			use: { ...devices['Desktop Chrome'] },
		},
		// Group 6: Serial tests (stress tests, error scenarios) - run sequentially
		{
			name: 'serial',
			testDir: './tests/serial',
			testMatch: '**/*.e2e.ts',
			use: { ...devices['Desktop Chrome'] },
			fullyParallel: false,
		},
	],

	/* Run your local test server before starting the tests */
	webServer: {
		// Build web package first, then start production-like server for E2E tests
		// This avoids HMR overhead and tests against production-like environment
		command: 'cd ../web && bun run build && cd ../cli && NODE_ENV=test bun run main.ts',
		url: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9283',
		// When PLAYWRIGHT_BASE_URL is set externally (CI, self-test, run-test),
		// reuse that server. Otherwise, start a fresh isolated test server.
		// This prevents tests from accidentally connecting to production servers
		// and ensures teardown can safely clean up all test data.
		reuseExistingServer: !!process.env.PLAYWRIGHT_BASE_URL,
		stdout: 'ignore',
		stderr: 'pipe',
		timeout: 120 * 1000,
		env: {
			NODE_ENV: 'test',
			DEFAULT_MODEL: 'sonnet', // Maps to GLM-4.7 for E2E tests
			// Isolated paths for this test run
			NEOKAI_WORKSPACE_PATH: e2eWorkspaceDir,
			DB_PATH: join(e2eDatabaseDir, 'daemon.db'),
		},
	},
});
