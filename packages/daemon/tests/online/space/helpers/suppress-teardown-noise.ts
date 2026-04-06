/**
 * Suppress known teardown rejections in space online tests.
 *
 * After daemon.waitForExit() closes the database and MCP transports, in-flight
 * SDK async work (MCP Protocol.connect retries, session updates via
 * ReactiveDatabase) may reject. These rejections are harmless — the daemon is
 * shutting down — but bun's test runner treats them as fatal "unhandled errors
 * between tests", causing exit code 1 despite 0 test failures.
 *
 * The handler is always active once this module is imported. The narrow regex
 * ensures only the two known teardown errors are suppressed; any other
 * unhandled rejection is logged with a grep-able prefix and sets exitCode = 1
 * so CI still fails.
 *
 * Usage: import this module for side effects in any space test file:
 *   import './helpers/suppress-teardown-noise';
 */

// Matches the known harmless errors that fire during daemon teardown.
// Anchored to start-of-string to avoid matching mid-message substrings.
const TEARDOWN_NOISE = /^Already connected to a transport|^Cannot use a closed database/i;

// Install once — idempotent since this module is only evaluated once per process.
process.on('unhandledRejection', (reason: unknown) => {
	const message = reason instanceof Error ? reason.message : String(reason);

	if (TEARDOWN_NOISE.test(message)) {
		return; // swallow known teardown noise
	}

	// Log unexpected rejections rather than throwing, since throwing from
	// inside unhandledRejection fires outside test context and produces
	// unhelpful "unhandled error between tests" output regardless.
	// eslint-disable-next-line no-console
	console.error('[UNHANDLED REJECTION]', reason);
	process.exitCode = 1;
});
