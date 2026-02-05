/**
 * Config Module-Level Initialization Tests
 *
 * Tests the module-level initialization code that runs when config.ts is imported.
 *
 * TESTING CHALLENGES:
 * The module-level code in config.ts (lines 14-24) runs immediately when the module
 * is imported. This code:
 * 1. Calls discoverCredentials() which uses homedir() from 'node:os'
 * 2. Logs to console.log and console.warn based on results
 * 3. Cannot be easily tested because:
 *    - Module code runs once on import (can't re-run without process restart)
 *    - ESM imports use 'node:os' which can't be mocked like CommonJS requires
 *    - homedir() reads from system database, not process.env.HOME
 *
 * COVERAGE NOTE:
 * Lines 14-24 of config.ts remain uncovered in automated tests because they
 * require:
 * - A controlled home directory (container/chroot OR system-level modification)
 * - OR refactoring to support HOME_DIR env var override
 * - OR manual testing/verification
 *
 * This test file documents the limitation and ensures the module loads correctly.
 * The actual credential discovery logic IS well-tested in:
 * - packages/daemon/tests/unit/core/credential-discovery.test.ts
 */

import { describe, expect, it } from 'bun:test';

describe('config module-level initialization', () => {
	describe('module loading', () => {
		it('should load config module without errors', async () => {
			// This test verifies the config module can be imported
			// The module-level init code runs during this import
			const configModule = await import('../../src/config');

			expect(configModule).toBeDefined();
			expect(typeof configModule.getConfig).toBe('function');
		});

		it('should load credential-discovery module', async () => {
			// Verify the credential discovery module is accessible
			const { discoverCredentials } = await import('../../src/lib/credential-discovery');

			expect(typeof discoverCredentials).toBe('function');
		});

		it('should not throw errors during module initialization', async () => {
			// Verify that importing the config module doesn't throw
			// This tests that the module-level code (lines 14-24) runs without errors
			const configModule = await import('../../src/config');
			expect(configModule).toBeDefined();
		});
	});

	describe('credential discovery function', () => {
		it('should accept a claudeDir parameter for testing', async () => {
			// This verifies that discoverCredentials can be tested with a custom dir
			// (which is what the unit tests do)
			const { discoverCredentials } = await import('../../src/lib/credential-discovery');

			const result = discoverCredentials('/nonexistent/path/.claude');

			expect(result).toHaveProperty('credentialSource');
			expect(result).toHaveProperty('settingsEnvApplied');
			expect(result).toHaveProperty('errors');
		});
	});
});
