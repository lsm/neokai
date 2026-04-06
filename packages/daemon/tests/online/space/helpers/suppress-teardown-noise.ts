/**
 * Suppress known teardown errors in space online tests.
 *
 * After daemon.waitForExit() closes the database and MCP transports, in-flight
 * SDK async work (MCP Protocol.connect retries, session updates via
 * ReactiveDatabase) may throw or reject. These errors are harmless — the daemon
 * is shutting down — but bun's test runner treats them as fatal "unhandled
 * errors between tests", causing exit code 1 despite 0 test failures.
 *
 * We register BOTH `uncaughtException` and `unhandledRejection` handlers
 * because the SDK's synchronous `throw` inside `connect()` surfaces as an
 * uncaught exception, while async DB operations surface as unhandled rejections.
 *
 * The handler is always active once this module is imported. The narrow regex
 * ensures only the two known teardown errors are suppressed; any other error
 * is logged with a grep-able prefix and sets exitCode = 1 so CI still fails.
 *
 * Usage: import this module for side effects in any space test file:
 *   import './helpers/suppress-teardown-noise';
 */

// Matches the known harmless errors that fire during daemon teardown.
// Anchored to start-of-string to avoid matching mid-message substrings.
const TEARDOWN_NOISE = /^Already connected to a transport|^Cannot use a closed database/i;

function handleError(label: string, reason: unknown): void {
	const message = reason instanceof Error ? reason.message : String(reason);

	if (TEARDOWN_NOISE.test(message)) {
		return; // swallow known teardown noise
	}

	// Log unexpected errors rather than re-throwing — throwing from inside
	// these handlers fires outside test context and produces unhelpful output.
	// eslint-disable-next-line no-console
	console.error(`[${label}]`, reason);
	process.exitCode = 1;
}

// Install once — idempotent since this module is only evaluated once per process.
// eslint-disable-next-line no-console
console.log('[suppress-teardown-noise] handlers registered');

process.on('unhandledRejection', (reason: unknown) => {
	handleError('UNHANDLED REJECTION', reason);
});

process.on('uncaughtException', (error: Error) => {
	handleError('UNCAUGHT EXCEPTION', error);
});
