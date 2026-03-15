/**
 * Error Classifier - Unified API error classification
 *
 * Single point of truth for classifying API errors from agent output:
 * - terminal:    unrecoverable errors (4xx) → fail task immediately
 * - rate_limit:  429 rate limits with parseable retry-after → pause with backoff
 * - recoverable: transient errors (5xx) → bounce/retry
 *
 * Detection strategy: match only structured "API Error: NNN" messages from the
 * Claude Agent SDK. Free-form text patterns are intentionally avoided because
 * they cause false positives when workers discuss error handling in prose
 * (e.g. "implemented handling for invalid model errors").
 *
 * The Anthropic usage-limit text pattern ("You've hit your limit · resets …")
 * is kept as a rate_limit fallback because it is highly specific and not
 * something a worker would write as normal explanatory output.
 */

import { parseRateLimitReset } from './rate-limit-utils';

export type ErrorClass = 'terminal' | 'rate_limit' | 'recoverable';

export interface ErrorClassification {
	class: ErrorClass;
	reason: string;
	/** HTTP status code extracted from the error message, if present */
	statusCode?: number;
	/**
	 * For rate_limit: Unix timestamp (ms) when the limit resets.
	 * Consumers should set a backoff until this time.
	 */
	resetsAt?: number;
}

/**
 * HTTP status codes that are terminal (unrecoverable client errors).
 * 429 is handled separately as rate_limit because the underlying credentials
 * are valid and the limit resets after a known period.
 */
const TERMINAL_HTTP_CODES = new Set([400, 401, 403, 404, 422]);

/**
 * Pattern to extract HTTP status code from SDK error messages like "API Error: 400 ...".
 * Anchored to start of line (multiline flag) to prevent false positives when worker output
 * contains "API Error: NNN" mid-sentence (e.g. "we handle API Error: 400 from provider").
 */
const API_ERROR_PATTERN = /^API Error:\s*(\d{3})/m;

/**
 * Extract the HTTP status code from a message.
 * Returns undefined if no recognisable "API Error: NNN" prefix is found.
 */
function extractHttpStatus(message: string): number | undefined {
	const match = message.match(API_ERROR_PATTERN);
	if (!match) return undefined;
	return parseInt(match[1], 10);
}

/**
 * Classify an error message from agent output.
 *
 * Only matches structured "API Error: NNN" messages produced by the Claude
 * Agent SDK, plus the Anthropic usage-limit text for rate_limit detection.
 * Free-form prose does NOT trigger classification.
 *
 * Evaluation order (first match wins):
 * 1. "API Error: NNN" — HTTP status code determines class
 *    - 400/401/403/404/422 → terminal
 *    - 429               → rate_limit (with resetsAt if parseable)
 *    - 5xx              → recoverable
 * 2. Anthropic usage-limit text → rate_limit (specific, not prose-writable)
 *
 * Returns null when the message is not an API error.
 *
 * @example
 * classifyError('API Error: 400 {"error":{"message":"Invalid model: xyz"}}')
 * // → { class: 'terminal', reason: '...', statusCode: 400 }
 *
 * classifyError("You've hit your limit · resets 1pm (America/New_York)")
 * // → { class: 'rate_limit', reason: '...', resetsAt: <timestamp> }
 *
 * classifyError('API Error: 500 Internal Server Error')
 * // → { class: 'recoverable', reason: '...', statusCode: 500 }
 *
 * classifyError('implemented handling for invalid model errors')
 * // → null  (prose — no false positive)
 */
export function classifyError(message: string): ErrorClassification | null {
	// ── 1. Structured "API Error: NNN" from the SDK ──────────────────────────
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

	// ── 2. Anthropic usage-limit text (specific, cannot appear in normal prose)
	const resetsAt = parseRateLimitReset(message);
	if (resetsAt !== null) {
		return {
			class: 'rate_limit',
			reason: `Rate limit reached — resets at ${new Date(resetsAt).toLocaleTimeString()}`,
			resetsAt,
		};
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
