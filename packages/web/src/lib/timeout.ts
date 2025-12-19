/**
 * Timeout Utility
 *
 * Provides utilities for adding timeouts to async operations.
 */

/**
 * Error thrown when an operation times out
 */
export class TimeoutError extends Error {
	public readonly operation: string;
	public readonly timeoutMs: number;

	constructor(operation: string, timeoutMs: number) {
		super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
		this.name = 'TimeoutError';
		this.operation = operation;
		this.timeoutMs = timeoutMs;

		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}
}

/**
 * Wrap an async operation with a timeout
 *
 * @param operation - Async function to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name for error messages
 * @returns Promise that resolves with operation result or rejects on timeout
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   () => fetchData(),
 *   5000,
 *   'fetchData'
 * );
 * ```
 */
export async function withTimeout<T>(
	operation: () => Promise<T>,
	timeoutMs: number,
	operationName: string
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			reject(new TimeoutError(operationName, timeoutMs));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([operation(), timeoutPromise]);
		return result;
	} finally {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Create a deferred promise that can be resolved/rejected externally
 *
 * @returns Object with promise and resolve/reject functions
 *
 * @example
 * ```typescript
 * const { promise, resolve, reject } = createDeferred<string>();
 * // Later...
 * resolve('done');
 * // Or...
 * reject(new Error('failed'));
 * ```
 */
export function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

/**
 * Create a promise that resolves after a delay
 *
 * @param ms - Delay in milliseconds
 * @returns Promise that resolves after the delay
 */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a timeout promise that rejects after specified time
 *
 * @param ms - Timeout in milliseconds
 * @param operationName - Name for error message
 * @returns Promise that rejects after timeout
 */
export function timeout(ms: number, operationName: string): Promise<never> {
	return new Promise((_resolve, reject) => {
		setTimeout(() => {
			reject(new TimeoutError(operationName, ms));
		}, ms);
	});
}

/**
 * Race multiple promises against a timeout
 *
 * @param promises - Array of promises to race
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name for timeout error
 * @returns First promise to resolve, or throws TimeoutError
 */
export async function raceWithTimeout<T>(
	promises: Promise<T>[],
	timeoutMs: number,
	operationName: string
): Promise<T> {
	return Promise.race([...promises, timeout(timeoutMs, operationName)]);
}
