/**
 * Error Classifier - Classifies errors as terminal or recoverable
 *
 * Terminal errors indicate unrecoverable failures that should immediately fail a task.
 * Recoverable errors may succeed on retry (network issues, 5xx, temporary limits).
 */

export type ErrorClass = 'recoverable' | 'terminal';

export interface ErrorClassification {
	class: ErrorClass;
	reason: string;
	/** HTTP status code if extracted from the error message, undefined otherwise */
	statusCode?: number;
}

/**
 * HTTP status codes that are terminal (unrecoverable client errors).
 * Note: 429 (rate limit) is intentionally excluded — it is handled separately
 * by rate-limit-utils.ts which parses retry-after timing.
 */
const TERMINAL_HTTP_CODES = new Set([400, 401, 403, 404, 422]);

/**
 * Text patterns that indicate terminal errors regardless of HTTP status code.
 * Applied case-insensitively against the full error message.
 */
const TERMINAL_TEXT_PATTERNS: readonly RegExp[] = [
	/invalid model/i,
	/invalid api key/i,
	/authentication failed/i,
	/quota exceeded/i,
	/account suspended/i,
	/model does not exist/i,
	/model not found/i,
	/no such model/i,
];

/** Pattern to extract HTTP status code from SDK error messages like "API Error: 400 ..." */
const API_ERROR_PATTERN = /API Error:\s*(\d{3})/;

/**
 * Extract the HTTP status code from an error message.
 * Returns undefined if no recognizable HTTP error code is found.
 */
function extractHttpStatus(message: string): number | undefined {
	const match = message.match(API_ERROR_PATTERN);
	if (!match) return undefined;
	return parseInt(match[1], 10);
}

/**
 * Classify an error message as terminal or recoverable.
 *
 * HTTP status codes are checked first (they carry the most reliable signal).
 * Text patterns are a fallback for messages that lack an explicit HTTP code.
 *
 * Returns an ErrorClassification if the message matches a known error pattern,
 * or null if it is not recognized as an API error.
 *
 * @example
 * classifyError('API Error: 400 {"error":{"message":"Invalid model: xyz"}}')
 * // → { class: 'terminal', reason: '...', statusCode: 400 }
 *
 * classifyError('API Error: 500 Internal Server Error')
 * // → { class: 'recoverable', reason: '...', statusCode: 500 }
 *
 * classifyError('Invalid model: claude-bad-v0')
 * // → { class: 'terminal', reason: '...' }
 *
 * classifyError('some unrelated text')
 * // → null
 */
export function classifyError(message: string): ErrorClassification | null {
	// Check HTTP status code first — it is the most authoritative signal.
	const statusCode = extractHttpStatus(message);
	if (statusCode !== undefined) {
		const excerpt = message.slice(0, 300);
		if (TERMINAL_HTTP_CODES.has(statusCode)) {
			return {
				class: 'terminal',
				reason: `Unrecoverable API error (HTTP ${statusCode}): ${excerpt}`,
				statusCode,
			};
		}
		if (statusCode >= 500 && statusCode < 600) {
			return {
				class: 'recoverable',
				reason: `Transient server error (HTTP ${statusCode}) — will retry`,
				statusCode,
			};
		}
	}

	// Fall back to text patterns — these catch misconfigurations that may not
	// include an explicit HTTP status code in the message.
	for (const pattern of TERMINAL_TEXT_PATTERNS) {
		if (pattern.test(message)) {
			const excerpt = message.slice(0, 300);
			return {
				class: 'terminal',
				reason: `Terminal error detected: ${excerpt}`,
			};
		}
	}

	return null;
}

/**
 * Check whether a message contains a terminal error that should fail a task immediately.
 *
 * Returns the classification when the error is terminal, null otherwise.
 * Callers should still invoke isRateLimitError() separately for 429 rate-limit handling.
 */
export function detectTerminalError(message: string): ErrorClassification | null {
	const classification = classifyError(message);
	return classification?.class === 'terminal' ? classification : null;
}
