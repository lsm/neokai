/**
 * useAsyncOperation Hook
 *
 * Manages loading and error state for async operations.
 * Eliminates the repetitive try/catch + setLoading pattern.
 *
 * @example
 * ```typescript
 * const { execute, loading, error } = useAsyncOperation(
 *   async (id: string) => {
 *     return await api.deleteSession(id);
 *   },
 *   { onError: (err) => toast.error(err.message) }
 * );
 *
 * <button onClick={() => execute(sessionId)} disabled={loading}>
 *   {loading ? 'Deleting...' : 'Delete'}
 * </button>
 * ```
 */

import { useState, useCallback, useRef } from 'preact/hooks';

export interface UseAsyncOperationOptions {
	/** Called when the operation throws an error */
	onError?: (error: Error) => void;
	/** Called when the operation completes successfully */
	onSuccess?: <T>(result: T) => void;
	/** Reset error state before each execution (default: true) */
	resetErrorOnExecute?: boolean;
}

export interface UseAsyncOperationResult<TArgs extends unknown[], TResult> {
	/** Execute the async operation */
	execute: (...args: TArgs) => Promise<TResult | undefined>;
	/** Whether the operation is currently running */
	loading: boolean;
	/** The last error that occurred, if any */
	error: Error | null;
	/** Reset the error state */
	reset: () => void;
}

/**
 * Hook for managing async operation state
 *
 * @param operation - The async function to wrap
 * @param options - Configuration options
 * @returns Operation executor with loading/error state
 */
export function useAsyncOperation<TArgs extends unknown[], TResult>(
	operation: (...args: TArgs) => Promise<TResult>,
	options: UseAsyncOperationOptions = {}
): UseAsyncOperationResult<TArgs, TResult> {
	const { onError: _onError, onSuccess: _onSuccess, resetErrorOnExecute = true } = options;

	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	// Use ref to always have latest operation without re-creating execute
	const operationRef = useRef(operation);
	operationRef.current = operation;

	const optionsRef = useRef(options);
	optionsRef.current = options;

	const execute = useCallback(
		async (...args: TArgs): Promise<TResult | undefined> => {
			if (resetErrorOnExecute) {
				setError(null);
			}

			setLoading(true);
			try {
				const result = await operationRef.current(...args);
				optionsRef.current.onSuccess?.(result);
				return result;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				setError(error);
				optionsRef.current.onError?.(error);
				return undefined;
			} finally {
				setLoading(false);
			}
		},
		[resetErrorOnExecute]
	);

	const reset = useCallback(() => {
		setError(null);
		setLoading(false);
	}, []);

	return {
		execute,
		loading,
		error,
		reset,
	};
}
