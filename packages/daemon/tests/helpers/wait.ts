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
 * Supports room-based onEvent() API. If subscriptionOptions contains a room,
 * the client will join that room before listening and leave it after.
 *
 * @example
 * const values = await collectSubscriptionValues(
 *   messageHub,
 *   'state.session',
 *   (collected) => collected.length >= 3,
 *   { room: 'session:abc123' },
 *   5000
 * );
 */
export async function collectSubscriptionValues<T>(
	messageHub: {
		onEvent: (channel: string, handler: (data: T) => void) => () => void;
		joinRoom?: (room: string) => void;
		leaveRoom?: (room: string) => void;
	},
	channel: string,
	stopCondition: (collected: T[]) => boolean,
	subscriptionOptions?: { room?: string },
	timeoutMs: number = 5000
): Promise<T[]> {
	const collected: T[] = [];
	const room = subscriptionOptions?.room;

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			unsubscribe();
			if (room && messageHub.leaveRoom) {
				// Leave room (fire-and-forget)
				messageHub.leaveRoom(room);
			}
		};

		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`collectSubscriptionValues timed out after ${timeoutMs}ms, collected ${collected.length} values`
				)
			);
		}, timeoutMs);

		const unsubscribe = messageHub.onEvent(channel, (data: T) => {
			collected.push(data);

			if (stopCondition(collected)) {
				cleanup();
				resolve(collected);
			}
		});

		// Join the room if specified and wait for acknowledgment
		// This ensures events are routed to this client
		if (room && messageHub.joinRoom) {
			messageHub.joinRoom(room).catch(() => {
				// Join failed, but continue - events might still work
			});
		}
	});
}
