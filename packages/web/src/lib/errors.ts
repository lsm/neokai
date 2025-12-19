/**
 * Connection Error Types
 *
 * Proper error hierarchy for connection-related issues.
 * These errors enable better error handling and user feedback.
 */

/**
 * Base class for all connection-related errors
 */
export class ConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConnectionError';
		// Maintains proper stack trace in V8 environments
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}
}

/**
 * Thrown when an operation is attempted but connection is not ready
 */
export class ConnectionNotReadyError extends ConnectionError {
	constructor(message = 'Connection not ready') {
		super(message);
		this.name = 'ConnectionNotReadyError';
	}
}

/**
 * Thrown when connection attempt times out
 */
export class ConnectionTimeoutError extends ConnectionError {
	public readonly timeoutMs: number;

	constructor(timeoutMs: number, message?: string) {
		super(message || `Connection timed out after ${timeoutMs}ms`);
		this.name = 'ConnectionTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Thrown when an RPC call times out
 */
export class RPCTimeoutError extends ConnectionError {
	public readonly method: string;
	public readonly timeoutMs: number;

	constructor(method: string, timeoutMs: number) {
		super(`RPC call "${method}" timed out after ${timeoutMs}ms`);
		this.name = 'RPCTimeoutError';
		this.method = method;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Thrown when max reconnection attempts are exceeded
 */
export class MaxReconnectAttemptsError extends ConnectionError {
	public readonly attempts: number;

	constructor(attempts: number) {
		super(`Max reconnection attempts (${attempts}) exceeded`);
		this.name = 'MaxReconnectAttemptsError';
		this.attempts = attempts;
	}
}

/**
 * Type guard to check if an error is a ConnectionError
 */
export function isConnectionError(error: unknown): error is ConnectionError {
	return error instanceof ConnectionError;
}

/**
 * Type guard to check if an error is recoverable
 * (i.e., the operation can be retried)
 */
export function isRecoverableConnectionError(error: unknown): boolean {
	if (!isConnectionError(error)) {
		return false;
	}
	// Timeout errors are generally recoverable
	if (error instanceof ConnectionTimeoutError || error instanceof RPCTimeoutError) {
		return true;
	}
	// Not ready errors are recoverable (wait for connection)
	if (error instanceof ConnectionNotReadyError) {
		return true;
	}
	// Max reconnect attempts is not recoverable without user action
	if (error instanceof MaxReconnectAttemptsError) {
		return false;
	}
	return true;
}
