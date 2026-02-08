/**
 * Wait Helpers for Behavior Testing
 *
 * Utilities for waiting on asynchronous behavior in integration tests.
 */

/**
 * Wait for a condition to become true, with timeout
 *
 * @example
 * await waitForCondition(() => messages.length > 0, 5000);
 */
export async function waitForCondition(
	condition: () => boolean,
	timeoutMs: number = 5000,
	checkIntervalMs: number = 100
): Promise<void> {
	const startTime = Date.now();

	while (!condition()) {
		if (Date.now() - startTime > timeoutMs) {
			throw new Error(
				`Condition not met within ${timeoutMs}ms timeout (checked every ${checkIntervalMs}ms)`
			);
		}
		await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
	}
}

/**
 * Wait for a promise-based condition to become true, with timeout
 *
 * @example
 * await waitForAsyncCondition(async () => {
 *   const result = await rpcCall();
 *   return result.status === 'ready';
 * }, 5000);
 */
export async function waitForAsyncCondition(
	condition: () => Promise<boolean>,
	timeoutMs: number = 5000,
	checkIntervalMs: number = 100
): Promise<void> {
	const startTime = Date.now();

	while (true) {
		const met = await condition();
		if (met) {
			return;
		}

		if (Date.now() - startTime > timeoutMs) {
			throw new Error(
				`Async condition not met within ${timeoutMs}ms timeout (checked every ${checkIntervalMs}ms)`
			);
		}

		await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
	}
}

/**
 * Wait for a specific duration (use sparingly, prefer waitForCondition)
 *
 * @example
 * await waitFor(1000); // Wait 1 second
 */
export async function waitFor(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect values from a subscription until condition met or timeout
 *
 * @example
 * const values = await collectSubscriptionValues(
 *   messageHub,
 *   'state.session',
 *   (collected) => collected.length >= 3,
 *   { sessionId },
 *   5000
 * );
 */
export async function collectSubscriptionValues<T>(
	messageHub: {
		subscribe: (channel: string, handler: (data: T) => void, options?: unknown) => void;
	},
	channel: string,
	stopCondition: (collected: T[]) => boolean,
	subscriptionOptions?: unknown,
	timeoutMs: number = 5000
): Promise<T[]> {
	const collected: T[] = [];

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(
				new Error(
					`collectSubscriptionValues timed out after ${timeoutMs}ms, collected ${collected.length} values`
				)
			);
		}, timeoutMs);

		messageHub.subscribe(
			channel,
			(data: T) => {
				collected.push(data);

				if (stopCondition(collected)) {
					clearTimeout(timeout);
					resolve(collected);
				}
			},
			subscriptionOptions
		);
	});
}
