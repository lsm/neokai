/**
 * Error Classifier - Unified API error classification
 *
 * Single point of truth for classifying API errors from agent output:
 * - terminal:    unrecoverable errors (4xx) → fail task immediately
 * - rate_limit:  HTTP 429 rate limits with parseable retry-after → pause with backoff
 * - usage_limit: daily/weekly usage cap limits → immediately attempt fallback model, skip backoff
 *                Detected via: SDK rate_limit_event (status:'rejected') OR
 *                Anthropic usage-limit text "You've hit your limit · resets …"
 * - recoverable: transient errors (5xx) → bounce/retry
 *
 * Detection strategy:
 * 1. Structured "API Error: NNN" messages from the Claude Agent SDK (HTTP status code determines class)
 * 2. SDK rate_limit_event JSON: only 'rejected' status is an actual error;
 *    'allowed' / 'allowed_warning' are informational (orange badge in UI) → returns null
 * 3. Anthropic usage-limit text pattern "You've hit your limit · resets …" (actual 4xx response)
 *
 * Free-form prose does NOT trigger classification to avoid false positives
 * (e.g. "implemented handling for invalid model errors").
 */

import { parseRateLimitReset } from './rate-limit-utils';

export type ErrorClass = 'terminal' | 'rate_limit' | 'usage_limit' | 'recoverable';

export interface ErrorClassification {
	class: ErrorClass;
	reason: string;
	/** HTTP status code extracted from the error message, if present */
	statusCode?: number;
	/**
	 * For rate_limit / usage_limit: Unix timestamp (ms) when the limit resets.
	 * Consumers should set a backoff until this time for rate_limit;
	 * for usage_limit this is informational only (backoff is skipped).
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
 * Evaluation order (first match wins):
 * 1. "API Error: NNN" — HTTP status code determines class
 *    - 400/401/403/404/422 → terminal
 *    - 429               → rate_limit (with resetsAt if parseable)
 *    - 5xx              → recoverable
 * 2. SDK rate_limit_event JSON (from mirrorSession event streaming):
 *    - status 'rejected'              → usage_limit (actual limit hit, trigger fallback)
 *    - status 'allowed'/'allowed_warning' → null (informational only, do NOT pause)
 * 3. Anthropic usage-limit text "You've hit your limit · resets …" → usage_limit
 *
 * Returns null when the message is not an API error (including SDK info messages).
 *
 * @example
 * classifyError('API Error: 400 {"error":{"message":"Invalid model: xyz"}}')
 * // → { class: 'terminal', reason: '...', statusCode: 400 }
 *
 * classifyError("You've hit your limit · resets 1pm (America/New_York)")
 * // → { class: 'usage_limit', reason: '...', resetsAt: <timestamp> }
 *
 * classifyError('API Error: 429 {"error":{"message":"rate limit exceeded"}}')
 * // → { class: 'rate_limit', reason: '...', resetsAt: <timestamp> }
 *
 * classifyError('API Error: 500 Internal Server Error')
 * // → { class: 'recoverable', reason: '...', statusCode: 500 }
 *
 * classifyError('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1749600000},...}')
 * // → null  (SDK info message — orange badge in UI, agent can continue)
 *
 * classifyError('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1749600000},...}')
 * // → { class: 'usage_limit', reason: '...', resetsAt: 1749600000000 }
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

	// ── 2. SDK rate_limit_event JSON (from mirrorSession event streaming) ────
	//     These messages are emitted for ALL rate limit state changes, not just errors.
	//     Only 'rejected' status means the API actually blocked the request.
	//     'allowed' / 'allowed_warning' are informational (orange badge in UI) — never pause.
	if (message.includes('"type":"rate_limit_event"')) {
		try {
			const parsed = JSON.parse(message) as {
				type?: string;
				rate_limit_info?: { status?: string; resetsAt?: number };
			};
			if (parsed.type === 'rate_limit_event') {
				const info = parsed.rate_limit_info;
				if (info?.status === 'rejected') {
					const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : undefined;
					return {
						class: 'usage_limit',
						reason: `Usage limit reached (rate_limit_event: rejected)${resetsAt ? ` — resets at ${new Date(resetsAt).toLocaleTimeString()}` : ''}`,
						resetsAt,
					};
				}
				// 'allowed' / 'allowed_warning' → informational, not an error; skip all text matching
				return null;
			}
		} catch {
			// JSON parse failed — fall through to text patterns
		}
	}

	// ── 3. Anthropic usage-limit text (specific, cannot appear in normal prose).
	//     Classified as usage_limit — falling back to an alternative model keeps the
	//     task moving instead of waiting hours until the daily/weekly cap resets.
	const usageLimitResetsAt = parseRateLimitReset(message);
	if (usageLimitResetsAt !== null) {
		return {
			class: 'usage_limit',
			reason: `Usage limit reached — would reset at ${new Date(usageLimitResetsAt).toLocaleTimeString()}`,
			resetsAt: usageLimitResetsAt,
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
