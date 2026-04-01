/**
 * Daemon App Cleanup Tests
 *
 * Tests for the daemon app cleanup logic, specifically:
 * - Pending RPC calls timeout behavior
 * - setInterval cleanup to prevent hangs on exit
 *
 * OFFLINE TESTS - No API calls required
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createDaemonApp } from '../../../src/app';
import type { Config } from '../../../src/config';

describe('Daemon App Cleanup', () => {
	let config: Config;
	let originalConsoleLog: typeof console.log;
	let originalConsoleError: typeof console.error;
	let originalAnthropicApiKey: string | undefined;
	let originalClaudeCodeOAuthToken: string | undefined;
	let originalAnthropicAuthToken: string | undefined;
	let originalGlmApiKey: string | undefined;
	let bunServeSpy: ReturnType<typeof spyOn> | null = null;
	const logs: string[] = [];

	beforeEach(() => {
		// Force unauthenticated startup for deterministic unit timing.
		// This avoids model initialization paths that can hit SDK/network timeouts in CI.
		originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
		originalClaudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
		originalGlmApiKey = process.env.GLM_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.GLM_API_KEY;

		// Capture console output for verification
		originalConsoleLog = console.log;
		originalConsoleError = console.error;
		console.log = (...args) => logs.push(args.join(' '));
		console.error = (...args) => logs.push(args.join(' '));

		// Avoid real socket binding in unit tests.
		bunServeSpy = spyOn(Bun, 'serve').mockImplementation(
			(_opts: Parameters<typeof Bun.serve>[0]) =>
				({
					stop() {},
				}) as never
		);

		// Use in-memory database for tests
		const tmpDir = process.env.TMPDIR || '/tmp';
		config = {
			host: 'localhost',
			port: 0, // Random port
			defaultModel: 'claude-sonnet-4-5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
			dbPath: ':memory:',
			maxSessions: 10,
			nodeEnv: 'test',
			workspaceRoot: `${tmpDir}/neokai-test-daemon-cleanup-${Date.now()}`,
			disableWorktrees: true,
		};
	});

	afterEach(() => {
		// Restore auth env vars
		if (originalAnthropicApiKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
		if (originalClaudeCodeOAuthToken !== undefined) {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOAuthToken;
		} else {
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		}
		if (originalAnthropicAuthToken !== undefined) {
			process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
		} else {
			delete process.env.ANTHROPIC_AUTH_TOKEN;
		}
		if (originalGlmApiKey !== undefined) {
			process.env.GLM_API_KEY = originalGlmApiKey;
		} else {
			delete process.env.GLM_API_KEY;
		}

		// Restore console
		console.log = originalConsoleLog;
		console.error = originalConsoleError;
		if (bunServeSpy) {
			bunServeSpy.mockRestore();
			bunServeSpy = null;
		}
		logs.length = 0;
	});

	describe('pending RPC calls timeout', () => {
		test('should complete cleanup immediately when no pending calls', async () => {
			const daemonContext = await createDaemonApp({
				config,
				verbose: true,
				standalone: false,
			});

			const messageHub = daemonContext.messageHub;

			// Verify no pending calls
			expect(messageHub.getPendingCallCount()).toBe(0);

			// Cleanup should complete quickly
			const cleanupStart = Date.now();
			await daemonContext.cleanup();
			const cleanupDuration = Date.now() - cleanupStart;

			// Should be very fast (< 1 second) since no pending calls
			expect(cleanupDuration).toBeLessThan(1000);

			// Verify success message
			const successLog = logs.find((log) => log.includes('Graceful shutdown complete'));
			expect(successLog).toBeTruthy();
		});

		test('should timeout and complete cleanup when pending calls never resolve', async () => {
			// This test specifically verifies the bug fix:
			// The setInterval must be cleared when the timeout fires first
			// Otherwise the process will hang on exit

			const daemonContext = await createDaemonApp({
				config,
				verbose: true,
				standalone: false,
			});

			const messageHub = daemonContext.messageHub;

			// Manually inject a mock pending call count
			// We'll monkey-patch getPendingCallCount to simulate hanging calls
			const originalGetPendingCallCount = messageHub.getPendingCallCount.bind(messageHub);
			let callCount = 5; // Simulate 5 hanging calls
			let callCountReturns = 0;

			messageHub.getPendingCallCount = () => {
				callCountReturns++;
				// Always return > 0 to simulate hanging calls
				return callCount;
			};

			// Run cleanup - this should timeout after 3 seconds
			// The critical bug fix: the setInterval must be cleared
			const cleanupStart = Date.now();
			await daemonContext.cleanup();
			const cleanupDuration = Date.now() - cleanupStart;

			// Restore original method
			messageHub.getPendingCallCount = originalGetPendingCallCount;

			// Cleanup should complete within ~3.5 seconds (3s timeout + overhead)
			// The bug would cause this to hang forever because the setInterval never clears
			expect(cleanupDuration).toBeGreaterThan(2500); // At least 2.5s (timeout period)
			expect(cleanupDuration).toBeLessThan(5000); // Less than 5s (timeout + overhead)

			// Verify the timeout message was logged
			const timeoutLog = logs.find(
				(log) => log.includes('Timeout:') && log.includes('calls still pending')
			);
			expect(timeoutLog).toBeTruthy();

			// Verify cleanup completed despite timeout
			const completeLog = logs.find((log) => log.includes('Graceful shutdown complete'));
			expect(completeLog).toBeTruthy();

			// Verify the interval was checked multiple times before timeout
			// This proves the setInterval was running
			expect(callCountReturns).toBeGreaterThan(10);
		});

		test('should stop checking immediately when pending calls reach zero', async () => {
			const daemonContext = await createDaemonApp({
				config,
				verbose: true,
				standalone: false,
			});

			const messageHub = daemonContext.messageHub;

			// Monkey-patch to simulate calls that resolve quickly
			const originalGetPendingCallCount = messageHub.getPendingCallCount.bind(messageHub);
			let checkCount = 0;

			messageHub.getPendingCallCount = () => {
				checkCount++;
				// Return 5 for first few checks, then 0
				if (checkCount < 5) {
					return 5;
				}
				return 0; // Calls resolved
			};

			// Run cleanup
			const cleanupStart = Date.now();
			await daemonContext.cleanup();
			const cleanupDuration = Date.now() - cleanupStart;

			// Restore original method
			messageHub.getPendingCallCount = originalGetPendingCallCount;

			// Should complete quickly (< 2 seconds) since calls "resolved"
			// (generous threshold for CI overhead; the actual timeout is 3s)
			expect(cleanupDuration).toBeLessThan(2000);

			// Verify success message (all calls completed)
			const completeLog = logs.find((log) => log.includes('All pending calls completed'));
			expect(completeLog).toBeTruthy();

			// Verify we didn't check many times (stopped when count hit 0)
			expect(checkCount).toBeLessThan(10);
		});
	});

	describe('unauthenticated startup', () => {
		let savedApiKey: string | undefined;
		let savedOAuthToken: string | undefined;
		let savedAuthToken: string | undefined;
		let savedGlmKey: string | undefined;

		beforeEach(() => {
			// Save and clear all credential env vars
			savedApiKey = process.env.ANTHROPIC_API_KEY;
			savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
			savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
			savedGlmKey = process.env.GLM_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			delete process.env.ANTHROPIC_AUTH_TOKEN;
			delete process.env.GLM_API_KEY;
		});

		afterEach(() => {
			// Restore credential env vars
			if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
			if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
			if (savedAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
			if (savedGlmKey !== undefined) process.env.GLM_API_KEY = savedGlmKey;
		});

		test('should start without credentials and log guidance', async () => {
			// Create config without any API key
			const unauthConfig = { ...config };
			delete unauthConfig.anthropicApiKey;
			delete unauthConfig.claudeCodeOAuthToken;
			delete unauthConfig.anthropicAuthToken;

			const daemonContext = await createDaemonApp({
				config: unauthConfig,
				verbose: true,
				standalone: false,
			});

			// Verify guidance was logged
			const noCredsLog = logs.find((log) => log.includes('NO CREDENTIALS DETECTED'));
			expect(noCredsLog).toBeTruthy();

			const skipModelLog = logs.find((log) => log.includes('Model initialization skipped'));
			expect(skipModelLog).toBeTruthy();

			// Should still have basic components
			expect(daemonContext.server).toBeDefined();
			expect(daemonContext.authManager).toBeDefined();
			expect(daemonContext.messageHub).toBeDefined();

			// Cleanup
			await daemonContext.cleanup();
		});
	});

	describe('daemon startup without --workspace (workspaceRoot: undefined)', () => {
		test('should start successfully without a workspaceRoot', async () => {
			// Omit workspaceRoot entirely — daemon must start without it
			const noWorkspaceConfig: Config = {
				...config,
				workspaceRoot: undefined,
			};

			const daemonContext = await createDaemonApp({
				config: noWorkspaceConfig,
				verbose: true,
				standalone: false,
			});

			// Core context components must be present
			expect(daemonContext.server).toBeDefined();
			expect(daemonContext.authManager).toBeDefined();
			expect(daemonContext.messageHub).toBeDefined();
			expect(daemonContext.sessionManager).toBeDefined();
			expect(daemonContext.settingsManager).toBeDefined();
			expect(daemonContext.fileIndex).toBeDefined();

			// FileIndex should be ready=false (init() was a no-op since no workspace)
			expect(daemonContext.fileIndex.isReady()).toBe(false);

			// Cleanup
			await daemonContext.cleanup();
		});

		test('should warn about sentinel rooms when workspaceRoot is undefined', async () => {
			// Use a real file-based DB so the pre-seeded sentinel row persists into the daemon.
			const tmpDir = process.env.TMPDIR || '/tmp';
			const sentinelDbPath = `${tmpDir}/neokai-sentinel-test-${Date.now()}.db`;

			const noWorkspaceConfig: Config = {
				...config,
				dbPath: sentinelDbPath,
				workspaceRoot: undefined,
			};

			// Seed the sentinel row before the daemon opens the database.
			const { Database } = await import('../../../src/storage/database');
			const db = new Database(sentinelDbPath);
			const { createReactiveDatabase } = await import('../../../src/storage/reactive-database');
			const reactiveDb = createReactiveDatabase(db);
			await db.initialize(reactiveDb);
			const rawDb = db.getDatabase();
			rawDb
				.prepare(
					`INSERT OR IGNORE INTO rooms
						(id, name, default_path, allowed_paths, status, created_at, updated_at)
					VALUES ('test-room-sentinel', 'Test', '__NEEDS_WORKSPACE_PATH__', '[]', 'active', datetime('now'), datetime('now'))`
				)
				.run();
			db.close(); // Close so the daemon can open it

			// Daemon should start (non-fatal warning, not an error)
			const daemonContext = await createDaemonApp({
				config: noWorkspaceConfig,
				verbose: true,
				standalone: false,
			});

			// Warning must have been logged
			const warnLog = logs.find((log) => log.includes('__NEEDS_WORKSPACE_PATH__'));
			expect(warnLog).toBeTruthy();

			await daemonContext.cleanup();

			// Clean up the temp DB file
			try {
				await import('fs/promises').then((fs) => fs.unlink(sentinelDbPath));
			} catch {
				// Ignore cleanup errors
			}
		});
	});
});
