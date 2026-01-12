import { defineConfig, devices } from '@playwright/test';
import type { CoverageReportOptions } from 'monocart-reporter';

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
		// LCOV for CI integration (Codecov, Coveralls, etc.)
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
		if (sourcePath.includes('/@preact/')) return false;
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
	testMatch: '**/*.e2e.ts',

	/* Run tests in files in parallel (enabled for Phase 1 + 2) */
	fullyParallel: true,

	/* Fail the build on CI if you accidentally left test.only in the source code */
	forbidOnly: !!process.env.CI,

	/* Retry on CI only */
	retries: process.env.CI ? 2 : 0,

	/* Allow multiple workers for parallel execution */
	workers: process.env.CI ? 2 : 4,

	/* Reporter to use - add monocart when coverage is enabled */
	reporter: collectCoverage
		? [['monocart-reporter', { name: 'Liuboer E2E Coverage', coverage: coverageOptions }], ['list']]
		: [['html', { outputFolder: 'playwright-report' }], ['list']],

	/* Shared settings for all the projects below */
	use: {
		/* Base URL to use in actions like `await page.goto('/')` */
		baseURL: 'http://localhost:9283',

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
		// Group 1: Read-only tests (no session creation) - fully parallel
		{
			name: 'read-only',
			testMatch: ['**/home.e2e.ts', '**/ui-components.e2e.ts'],
			use: { ...devices['Desktop Chrome'] },
		},
		// Group 2: Isolated sessions (with cleanup) - parallel
		{
			name: 'isolated-sessions',
			testMatch: [
				'**/chat-flow-improved.e2e.ts',
				'**/message-send-receive.e2e.ts',
				'**/session-management.e2e.ts', // Session management with cleanup
				'**/chat-flow.e2e.ts', // Will add cleanup
				'**/model-switcher.e2e.ts', // Model switcher UI tests
				'**/draft-persistence.e2e.ts', // Draft persistence tests
				'**/draft-clearing-bug.e2e.ts', // Draft clearing bug fix tests
				'**/scroll-to-bottom-button.e2e.ts', // Scroll to bottom button tests
				'**/mcp-toggle.e2e.ts', // MCP toggle functionality tests
				'**/settings-modal.e2e.ts', // Settings modal tests
				'**/slash-command-autocomplete.e2e.ts', // Slash command autocomplete tests
				'**/session-archive.e2e.ts', // Session archive functionality tests
				'**/auto-title-generation.e2e.ts', // Auto-title generation tests
				'**/auto-scroll-toggle.e2e.ts', // Auto-scroll toggle tests
				'**/context-dropdown.e2e.ts', // Context dropdown tests
				'**/file-attachment.e2e.ts', // File attachment tests
				'**/interrupt-button.e2e.ts', // Interrupt button tests
				'**/message-input-ux.e2e.ts', // Message input UX tests
				'**/page-refresh.e2e.ts', // Page refresh tests
				'**/reconnection-message-sync.e2e.ts', // Reconnection message sync tests
				'**/session-list-ordering.e2e.ts', // Session list ordering tests
				'**/connection-state.e2e.ts', // Connection state tests (creates sessions)
				'**/session-export.e2e.ts', // Session export tests
				'**/processing-state.e2e.ts', // Processing state display tests
				'**/error-handling.e2e.ts', // Error handling tests
				'**/tools-modal-complete.e2e.ts', // Tools modal complete tests
				'**/2-stage-creation.e2e.ts', // 2-stage session creation tests
				'**/default-model-haiku.e2e.ts', // Default model configuration tests
				'**/worktree-isolation.e2e.ts', // Worktree isolation tests
				'**/message-removal.e2e.ts', // Message output removal tests
				'**/connection-overlay.e2e.ts', // Connection overlay tests
				'**/message-pagination.e2e.ts', // Message pagination tests
				'**/file-operations.e2e.ts', // File operations tests
				'**/character-counter.e2e.ts', // Character counter tests
				'**/mobile-responsive.e2e.ts', // Mobile responsiveness tests
				'**/session-status-indicators.e2e.ts', // Session status indicators tests
				'**/scroll-responsiveness.e2e.ts', // Scroll responsiveness tests
				'**/thinking-level-selector.e2e.ts', // Thinking level selector tests
				'**/context-usage-dropdown.e2e.ts', // Context usage dropdown tests
				'**/recent-sessions-home.e2e.ts', // Recent sessions home page tests
			],
			use: { ...devices['Desktop Chrome'] },
		},
		// Group 3: Complex/Serial tests (stress tests, error scenarios)
		{
			name: 'serial',
			testMatch: [
				'**/multi-session-concurrent.e2e.ts',
				'**/session-switching-comprehensive.e2e.ts',
				'**/interruption-error.e2e.ts',
			],
			use: { ...devices['Desktop Chrome'] },
			fullyParallel: false, // Keep these serial for now
		},
	],

	/* Run your local dev server before starting the tests */
	webServer: {
		command: 'cd ../cli && NODE_ENV=test bun run dev',
		url: 'http://localhost:9283',
		// In CI, we start the server separately to get better logging
		// Use PW_TEST_REUSE_CONTEXT=1 to skip server startup in CI
		reuseExistingServer: !!process.env.PW_TEST_REUSE_CONTEXT || !process.env.CI,
		stdout: 'ignore',
		stderr: 'pipe',
		timeout: 120 * 1000,
		env: {
			NODE_ENV: 'test',
			DEFAULT_MODEL: 'haiku', // Use Haiku for faster and cheaper tests
		},
	},
});
