import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Testing Configuration
 * See https://playwright.dev/docs/test-configuration
 *
 * Parallel Execution Strategy:
 * - Project 1: "read-only" - Tests that don't create sessions (fully parallel)
 * - Project 2: "isolated-sessions" - Tests with proper cleanup (parallel)
 * - Project 3: "serial" - Complex tests requiring serial execution
 */
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

	/* Reporter to use */
	reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],

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

		/* Action timeout - increased for AI API calls and waitForFunction */
		actionTimeout: 35000,
	},

	/* Global timeout for each test - increased for AI API calls */
	timeout: 60000,

	/* Expect timeout for assertions - increased for AI API calls */
	expect: {
		timeout: 35000,
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
				'**/worktree-isolation.e2e.ts', // Worktree isolation tests
				'**/message-removal.e2e.ts', // Message output removal tests
				'**/connection-overlay.e2e.ts', // Connection overlay tests
				'**/message-pagination.e2e.ts', // Message pagination tests
				'**/file-operations.e2e.ts', // File operations tests
				'**/character-counter.e2e.ts', // Character counter tests
				'**/mobile-responsive.e2e.ts', // Mobile responsiveness tests
				'**/session-status-indicators.e2e.ts', // Session status indicators tests
				'**/scroll-responsiveness.e2e.ts', // Scroll responsiveness tests
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
		reuseExistingServer: !process.env.CI,
		stdout: 'ignore',
		stderr: 'pipe',
		timeout: 120 * 1000,
		env: {
			NODE_ENV: 'test',
		},
	},
});
