/**
 * Error Classifier - Unified API error classification
 *
 * Single point of truth for classifying API errors from agent output:
 * - terminal:    unrecoverable errors (4xx, invalid model, etc.) → fail task immediately
 * - rate_limit:  429 rate limits with parseable retry-after → pause with backoff
 * - recoverable: transient errors (5xx, network) → bounce/retry
 *
 * Consolidates the previously separate rate-limit-utils detection into one place.
 * rate-limit-utils.ts remains for its parsing logic but is no longer imported
 * directly in room-runtime.ts.
 */

import { parseRateLimitReset } from './rate-limit-utils';

export type ErrorClass = 'terminal' | 'rate_limit' | 'recoverable';

export interface ErrorClassification {
	class: ErrorClass;
	reason: string;
	/** HTTP status code if extracted from the error message, undefined otherwise */
	statusCode?: number;
	/**
	 * For rate_limit: Unix timestamp (ms) when the limit resets.
	 * Consumers should set a backoff until this time.
	 */
	resetsAt?: number;
}

/**
 * HTTP status codes that are terminal (unrecoverable client errors).
 * 429 is handled separately as rate_limit (not terminal) because it has
 * a parseable retry-after time and the underlying credentials are valid.
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
 * Classify an API error message.
 *
 * Evaluation order (first match wins):
 * 1. HTTP status code — most authoritative signal
 *    - 400/401/403/404/422 → terminal
 *    - 429 → rate_limit (with resetsAt if parseable)
 *    - 5xx → recoverable
 * 2. Text patterns — fallback for messages without an HTTP code
 *    - "invalid model", "invalid api key", etc. → terminal
 *
 * Returns null when the message is not recognised as an API error.
 *
 * @example
 * classifyError('API Error: 400 {"error":{"message":"Invalid model: xyz"}}')
 * // → { class: 'terminal', reason: '...', statusCode: 400 }
 *
 * classifyError("You've hit your limit · resets 1pm (America/New_York)")
 * // → { class: 'rate_limit', reason: '...', statusCode: 429, resetsAt: <timestamp> }
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
	// ── 1. HTTP status code ──────────────────────────────────────────────────
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

		if (statusCode === 429) {
			const resetsAt = parseRateLimitReset(message) ?? undefined;
			return {
				class: 'rate_limit',
				reason: `Rate limit reached (HTTP 429)${resetsAt ? ` — resets at ${new Date(resetsAt).toLocaleTimeString()}` : ''}`,
				statusCode: 429,
				resetsAt,
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

	// ── 2. Text patterns (no explicit HTTP code) ─────────────────────────────
	// Also catches the Anthropic usage-limit message ("You've hit your limit…")
	const resetsAt = parseRateLimitReset(message);
	if (resetsAt !== null) {
		return {
			class: 'rate_limit',
			reason: `Rate limit reached — resets at ${new Date(resetsAt).toLocaleTimeString()}`,
			resetsAt,
		};
	}

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
 * Returns the classification when terminal, null otherwise.
 */
export function detectTerminalError(message: string): ErrorClassification | null {
	const c = classifyError(message);
	return c?.class === 'terminal' ? c : null;
}
