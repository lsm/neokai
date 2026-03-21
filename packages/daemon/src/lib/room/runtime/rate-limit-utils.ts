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
 * @param errorMessage - The rate limit error message
 * @returns The reset timestamp in ms, or null if not parseable
 *
 * @example
 * parseRateLimitReset("You've hit your limit · resets 1pm (America/New_York)")
 * // Returns timestamp for 1pm in America/New_York timezone
 */
export function parseRateLimitReset(errorMessage: string): number | null {
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
 * @param message - The message to check
 * @returns true if the message is a rate limit error
 */
export function isRateLimitError(message: string): boolean {
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
