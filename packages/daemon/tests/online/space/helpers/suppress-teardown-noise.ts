/**
 * Suppress known teardown rejections in space online tests.
 *
 * After daemon.waitForExit() closes the database and MCP transports, in-flight
 * SDK async work (MCP Protocol.connect retries, session updates via
 * ReactiveDatabase) may reject. These rejections are harmless — the daemon is
 * shutting down — but bun's test runner treats them as fatal "unhandled errors
 * between tests", causing exit code 1 despite 0 test failures.
 *
 * The handler is **guarded** so it only suppresses during the teardown phase
 * (between enterTeardown() and leaveTeardown()). During normal test execution,
 * unknown rejections are logged and the process exit code is set to 1 so CI
 * still fails on genuine unhandled errors.
 *
 * Usage in test files:
 *   import { enterTeardown, leaveTeardown } from './helpers/suppress-teardown-noise';
 *
 *   beforeEach(() => { leaveTeardown(); });
 *   afterEach(async () => {
 *       enterTeardown();
 *       // ... daemon.kill() + daemon.waitForExit() ...
 *   });
 */

// Matches the known harmless errors that fire during daemon teardown.
// Anchored to start-of-string to avoid matching mid-message substrings.
const TEARDOWN_NOISE = /^Already connected to a transport|^Cannot use a closed database/i;

let isTearingDown = false;

/** Call at the start of afterEach, before daemon cleanup. */
export function enterTeardown(): void {
	isTearingDown = true;
}

/** Call at the start of beforeEach, to re-enable normal rejection handling. */
export function leaveTeardown(): void {
	isTearingDown = false;
}

// Install once — idempotent since this module is only evaluated once per process.
process.on('unhandledRejection', (reason: unknown) => {
	const message = reason instanceof Error ? reason.message : String(reason);

	if (isTearingDown && TEARDOWN_NOISE.test(message)) {
		return; // swallow known teardown noise
	}

	// Log unexpected rejections rather than throwing, since throwing from
	// inside unhandledRejection fires outside test context and produces
	// unhelpful "unhandled error between tests" output regardless.
	// eslint-disable-next-line no-console
	console.error('[UNHANDLED REJECTION]', reason);
	process.exitCode = 1;
});
