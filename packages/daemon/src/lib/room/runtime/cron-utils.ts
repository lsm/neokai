/**
 * Cron utilities for recurring mission scheduling.
 *
 * Thin wrapper around the `croner` library with timezone support.
 * Precision note: up to 30s jitter from the scheduler tick interval (acceptable for @hourly+).
 *
 * Supported formats:
 * - 5-field cron: `0 9 * * *` (minute hour dom month dow)
 * - Presets: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`/`@annually`
 * - `@midnight` (alias for `@daily`)
 */

import { Cron } from 'croner';

/**
 * Parse and validate a cron expression (including presets).
 * Returns null if the expression is invalid.
 */
export function parseCronExpression(expression: string): boolean {
	// Normalize presets before passing to croner
	const normalized = normalizePreset(expression);
	try {
		// Attempt to construct a Cron to validate — catch invalid expressions
		const cron = new Cron(normalized, { paused: true });
		// Check if at least one next run is calculable
		const next = cron.nextRun();
		return next !== null;
	} catch {
		return false;
	}
}

/**
 * Calculate the next run timestamp (Unix seconds) after a given base time.
 * Honors timezone.
 *
 * @param expression Cron expression or preset
 * @param timezone IANA timezone string (e.g. "America/New_York") or "UTC"
 * @param afterMs Epoch millis to compute next run after (default: now)
 * @returns Unix seconds of next run, or null if the expression produces no future run
 */
export function getNextRunAt(
	expression: string,
	timezone: string,
	afterMs?: number
): number | null {
	const normalized = normalizePreset(expression);
	const startAt = afterMs !== undefined ? new Date(afterMs) : new Date();

	try {
		const cron = new Cron(normalized, {
			timezone,
			startAt,
			paused: true,
		});
		const next = cron.nextRun();
		if (!next) return null;
		return Math.floor(next.getTime() / 1000);
	} catch {
		return null;
	}
}

/**
 * Return the system's local IANA timezone name.
 * Falls back to "UTC" if unavailable.
 */
export function getSystemTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	} catch {
		return 'UTC';
	}
}

// ---- Preset normalization ----

const PRESET_MAP: Record<string, string> = {
	'@hourly': '0 * * * *',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@weekly': '0 0 * * 0',
	'@monthly': '0 0 1 * *',
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
};

function normalizePreset(expression: string): string {
	const lower = expression.trim().toLowerCase();
	return PRESET_MAP[lower] ?? expression.trim();
}
