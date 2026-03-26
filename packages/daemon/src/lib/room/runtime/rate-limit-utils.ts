/**
 * Rate Limit Utilities
 *
 * Parses rate limit error messages and detects rate limit backoff periods.
 * Used by room runtime to pause nagging when API rate limits are hit.
 */

import type { RateLimitBackoff } from '../state/session-group-repository';

/**
 * Pattern for Anthropic rate limit error messages.
 * Example: "You've hit your limit · resets 1pm (America/New_York)"
 */
const RATE_LIMIT_PATTERN =
	/You've hit your limit.*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/**
 * Parse rate limit reset time from error message.
 *
 * Handles two input formats:
 *
 * 1. SDK `rate_limit_event` JSON (e.g. from `mirrorSession`):
 *    Only returns a timestamp for `status: 'rejected'` — the actual limit hit.
 *    `status: 'allowed'` / `'allowed_warning'` events are informational (orange badge
 *    in the UI) and must NOT trigger pause/backoff, so null is returned immediately.
 *
 * 2. Anthropic usage-limit text pattern:
 *    "You've hit your limit · resets 1pm (America/New_York)"
 *    (from actual 4xx API error responses)
 *
 * @param errorMessage - The rate limit error message (text or JSON string)
 * @returns The reset timestamp in ms, or null if not parseable / not an actual limit hit
 *
 * @example
 * parseRateLimitReset("You've hit your limit · resets 1pm (America/New_York)")
 * // Returns timestamp for 1pm in America/New_York timezone
 *
 * parseRateLimitReset(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1749600000}}))
 * // Returns 1749600000 * 1000 (resetsAt in ms)
 *
 * parseRateLimitReset(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed',resetsAt:1749600000}}))
 * // Returns null — informational only, not an actual error
 */
export function parseRateLimitReset(errorMessage: string): number | null {
	// ── Structured SDK rate_limit_event JSON ─────────────────────────────────
	// These messages are emitted for ALL rate limit state changes, not just errors.
	// Only 'rejected' status means the API actually blocked the request.
	if (errorMessage.includes('"type":"rate_limit_event"')) {
		try {
			const parsed = JSON.parse(errorMessage) as {
				type?: string;
				rate_limit_info?: { status?: string; resetsAt?: number };
			};
			if (parsed.type === 'rate_limit_event') {
				const info = parsed.rate_limit_info;
				if (info?.status === 'rejected' && typeof info.resetsAt === 'number') {
					// SDK resetsAt is in seconds; convert to ms for callers
					return info.resetsAt * 1000;
				}
				// 'allowed' / 'allowed_warning' → informational, not a limit hit
				return null;
			}
		} catch {
			// JSON parse failed — fall through to text pattern below
		}
	}

	// ── Anthropic usage-limit text (from actual 4xx API responses) ───────────
	const match = errorMessage.match(RATE_LIMIT_PATTERN);
	if (!match) return null;

	const hourStr = match[1]; // e.g., "1" or "12"
	const minuteStr = match[2]; // e.g., "30" or undefined
	const amPm = match[3]; // "am" or "pm"
	const timezoneStr = match[4]; // e.g., "America/New_York"

	try {
		let hours = parseInt(hourStr, 10);
		const minutes = minuteStr ? parseInt(minuteStr, 10) : 0;

		// Convert to 24-hour format
		if (amPm.toLowerCase() === 'pm' && hours !== 12) {
			hours += 12;
		} else if (amPm.toLowerCase() === 'am' && hours === 12) {
			hours = 0;
		}

		const now = new Date();

		// Calculate timezone offset for the specified timezone
		// The error message contains a time in a specific timezone (e.g., "1pm (America/New_York)")
		// We need to convert this to a UTC timestamp
		let timezoneOffsetMs = 0;
		if (timezoneStr) {
			try {
				// Get the timezone offset by finding what UTC time corresponds to
				// "today at hours:minutes" in the target timezone
				const targetDate = new Date(
					now.getFullYear(),
					now.getMonth(),
					now.getDate(),
					hours,
					minutes,
					0,
					0
				);

				// Format this date in the target timezone to get its representation
				const tzFormatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezoneStr,
					year: 'numeric',
					month: 'numeric',
					day: 'numeric',
					hour: 'numeric',
					minute: 'numeric',
					second: 'numeric',
					hour12: false,
				});

				const tzParts = tzFormatter.formatToParts(targetDate);
				const tzDay = parseInt(tzParts.find((p) => p.type === 'day')?.value ?? '0', 10);

				// The target date's local components should match the parsed time
				// If tz shows a different day, it means we crossed a day boundary
				// (e.g., "1pm UTC" when server is at 2am EST means the reset is tomorrow in UTC)
				let dayOffset = 0;
				if (tzDay !== now.getDate()) {
					dayOffset = tzDay > now.getDate() ? 0 : 1; // tomorrow if tz is ahead
				}

				// Get offset between local time and target timezone in ms
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezoneStr,
					hour: 'numeric',
					minute: 'numeric',
					hour12: false,
				});

				// Calculate offset: if target time is "earlier" in local time than now in tz,
				// then the reset is tomorrow
				const nowInTzParts = formatter.formatToParts(now);
				const nowInTzHour = parseInt(nowInTzParts.find((p) => p.type === 'hour')?.value ?? '0', 10);
				const nowInTzMinute = parseInt(
					nowInTzParts.find((p) => p.type === 'minute')?.value ?? '0',
					10
				);

				const targetMinutes = hours * 60 + minutes;
				const nowInTzMinutes = nowInTzHour * 60 + nowInTzMinute;

				if (targetMinutes <= nowInTzMinutes) {
					dayOffset = 1;
				}

				// Create the reset date in the target timezone
				const resetDate = new Date(
					now.getFullYear(),
					now.getMonth(),
					now.getDate() + dayOffset,
					hours,
					minutes,
					0
				);

				// Get UTC offset for the target timezone
				const utcOffsetFormatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezoneStr,
					timeZoneName: 'short',
				});
				const offsetStr = utcOffsetFormatter.format(resetDate).split(' ').pop() ?? 'UTC';

				// Parse offset like "GMT-5" or "GMT+0"
				const offsetMatch = offsetStr.match(/GMT([+-])(\d+)/);
				if (offsetMatch) {
					const offsetSign = offsetMatch[1] === '+' ? 1 : -1;
					const offsetHours = parseInt(offsetMatch[2], 10);
					timezoneOffsetMs = offsetSign * offsetHours * 60 * 60 * 1000;
				}

				// Adjust reset time to UTC
				const resetUtcDate = new Date(resetDate.getTime() - timezoneOffsetMs);

				// If reset time is in the past, add another day
				if (resetUtcDate.getTime() <= now.getTime()) {
					resetDate.setDate(resetDate.getDate() + 1);
				}

				return new Date(resetDate.getTime() - timezoneOffsetMs).getTime();
			} catch {
				// Fallback: if timezone parsing fails, treat time as local time
				timezoneOffsetMs = 0;
			}
		}

		// Create reset time based on current date (treat time as local)
		const resetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);

		// If reset time is in the past, assume it's tomorrow
		if (resetDate.getTime() <= now.getTime()) {
			resetDate.setDate(resetDate.getDate() + 1);
		}

		return resetDate.getTime();
	} catch {
		return null;
	}
}

/**
 * Check if a message contains a rate limit error.
 *
 * Returns true for:
 * - Anthropic usage-limit text matching RATE_LIMIT_PATTERN
 * - SDK `rate_limit_event` JSON with `status: 'rejected'`
 *
 * Returns false for SDK `rate_limit_event` JSON with non-rejected status
 * (those are informational, not actual errors).
 *
 * @param message - The message to check
 * @returns true if the message represents an actual rate limit hit
 */
export function isRateLimitError(message: string): boolean {
	if (message.includes('"type":"rate_limit_event"')) {
		try {
			const parsed = JSON.parse(message) as {
				type?: string;
				rate_limit_info?: { status?: string };
			};
			if (parsed.type === 'rate_limit_event') {
				return parsed.rate_limit_info?.status === 'rejected';
			}
		} catch {
			// fall through to text pattern
		}
	}
	return RATE_LIMIT_PATTERN.test(message);
}

/**
 * Create a RateLimitBackoff object from an error message.
 *
 * @param errorMessage - The rate limit error message
 * @param sessionRole - Which session hit the limit ('worker' or 'leader')
 * @returns RateLimitBackoff object, or null if not parseable
 */
export function createRateLimitBackoff(
	errorMessage: string,
	sessionRole: 'worker' | 'leader'
): RateLimitBackoff | null {
	const resetsAt = parseRateLimitReset(errorMessage);
	if (!resetsAt) return null;

	return {
		detectedAt: Date.now(),
		resetsAt,
		sessionRole,
	};
}
