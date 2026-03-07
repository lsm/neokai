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
	// const timezoneStr = match[4]; // e.g., "America/New_York" - not used for simple parsing

	try {
		let hours = parseInt(hourStr, 10);
		const minutes = minuteStr ? parseInt(minuteStr, 10) : 0;

		// Convert to 24-hour format
		if (amPm.toLowerCase() === 'pm' && hours !== 12) {
			hours += 12;
		} else if (amPm.toLowerCase() === 'am' && hours === 12) {
			hours = 0;
		}

		// Create reset time based on current date
		const now = new Date();
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
