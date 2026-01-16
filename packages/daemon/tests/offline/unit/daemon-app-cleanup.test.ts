/**
 * Daemon App Cleanup Tests
 *
 * Tests for the daemon app cleanup logic, specifically:
 * - Pending RPC calls timeout behavior
 * - setInterval cleanup to prevent hangs on exit
 *
 * OFFLINE TESTS - No API calls required
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonApp } from '../../../src/app';
import type { Config } from '../../../src/config';

describe('Daemon App Cleanup', () => {
	let config: Config;
	let originalConsoleLog: typeof console.log;
	let originalConsoleError: typeof console.error;
	const logs: string[] = [];

	beforeEach(() => {
		// Set fake API key for auth (createDaemonApp requires authentication)
		process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-for-unit-tests';

		// Capture console output for verification
		originalConsoleLog = console.log;
		originalConsoleError = console.error;
		console.log = (...args) => logs.push(args.join(' '));
		console.error = (...args) => logs.push(args.join(' '));

		// Use in-memory database for tests
		const tmpDir = process.env.TMPDIR || '/tmp';
		config = {
			host: 'localhost',
			port: 0, // Random port
			defaultModel: 'claude-sonnet-4-5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
			anthropicApiKey: 'sk-ant-test-key-for-unit-tests',
			dbPath: ':memory:',
			maxSessions: 10,
			nodeEnv: 'test',
			workspaceRoot: `${tmpDir}/liuboer-test-daemon-cleanup-${Date.now()}`,
			disableWorktrees: true,
		};
	});

	afterEach(() => {
		// Clean up env var
		delete process.env.ANTHROPIC_API_KEY;

		// Restore console
		console.log = originalConsoleLog;
		console.error = originalConsoleError;
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

			// Should complete quickly (< 1 second) since calls "resolved"
			expect(cleanupDuration).toBeLessThan(1000);

			// Verify success message (all calls completed)
			const completeLog = logs.find((log) => log.includes('All pending calls completed'));
			expect(completeLog).toBeTruthy();

			// Verify we didn't check many times (stopped when count hit 0)
			expect(checkCount).toBeLessThan(10);
		});
	});
});
