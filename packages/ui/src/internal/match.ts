export function match<TValue extends string | number, TResult>(
	value: TValue,
	lookup: Record<TValue, TResult | ((...args: unknown[]) => TResult)>,
	...args: unknown[]
): TResult {
	const handler = lookup[value];
	if (handler !== undefined) {
		if (typeof handler === 'function') {
			return (handler as (...args: unknown[]) => TResult)(...args);
		}
		return handler as TResult;
	}

	const error = new Error(
		`Tried to handle "${String(value)}" but there is no handler defined. Only defined handlers are: ${Object.keys(
			lookup
		)
			.map((key) => `"${key}"`)
			.join(', ')}.`
	);
	if (Error.captureStackTrace) Error.captureStackTrace(error, match);
	throw error;
}
