/**
 * cron-utils Tests
 *
 * Tests for cron expression parsing and next-run calculation:
 * - isValidCronExpression: valid/invalid expressions
 * - getNextRunAt: 5-field cron and preset expansion
 * - Timezone-aware scheduling
 * - getSystemTimezone fallback
 */

import { describe, test, expect } from 'bun:test';
import { isValidCronExpression, getNextRunAt, getSystemTimezone } from '../../../../src/lib/room/runtime/cron-utils';

describe('isValidCronExpression', () => {
	test('accepts valid 5-field cron expressions', () => {
		expect(isValidCronExpression('0 9 * * *')).toBe(true);    // 9am daily
		expect(isValidCronExpression('0 0 * * *')).toBe(true);    // midnight daily
		expect(isValidCronExpression('0 0 * * 0')).toBe(true);    // weekly Sunday
		expect(isValidCronExpression('30 14 1 * *')).toBe(true);  // 2:30pm on 1st of month
		expect(isValidCronExpression('*/5 * * * *')).toBe(true);  // every 5 minutes
	});

	test('accepts preset aliases', () => {
		expect(isValidCronExpression('@hourly')).toBe(true);
		expect(isValidCronExpression('@daily')).toBe(true);
		expect(isValidCronExpression('@midnight')).toBe(true);
		expect(isValidCronExpression('@weekly')).toBe(true);
		expect(isValidCronExpression('@monthly')).toBe(true);
		expect(isValidCronExpression('@yearly')).toBe(true);
		expect(isValidCronExpression('@annually')).toBe(true);
	});

	test('accepts case-insensitive presets', () => {
		expect(isValidCronExpression('@DAILY')).toBe(true);
		expect(isValidCronExpression('@Daily')).toBe(true);
		expect(isValidCronExpression('@HOURLY')).toBe(true);
	});

	test('rejects invalid expressions', () => {
		expect(isValidCronExpression('')).toBe(false);
		expect(isValidCronExpression('not-a-cron')).toBe(false);
		expect(isValidCronExpression('0 25 * * *')).toBe(false);  // hour 25 is invalid
		expect(isValidCronExpression('60 * * * *')).toBe(false);  // minute 60 is invalid
	});
});

describe('getNextRunAt', () => {
	test('returns a unix timestamp in seconds for a valid cron', () => {
		const next = getNextRunAt('0 9 * * *', 'UTC');
		expect(next).not.toBeNull();
		// Should be a reasonable future timestamp (within a day or just over)
		const nowSec = Math.floor(Date.now() / 1000);
		expect(next).toBeGreaterThan(nowSec);
		expect(next).toBeLessThan(nowSec + 2 * 24 * 3600); // within 2 days
	});

	test('respects afterMs parameter', () => {
		// "0 9 * * *" at 9am UTC
		// If we are at 8:59am UTC, next should be 1 minute away
		const now = new Date();
		const todayAt9am = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0)
		);

		// Get next run starting from 1 minute before 9am today
		const oneMinBefore = todayAt9am.getTime() - 60_000;
		const next = getNextRunAt('0 9 * * *', 'UTC', oneMinBefore);
		expect(next).not.toBeNull();
		// next should be exactly todayAt9am (or tomorrow if already past 9am today)
		const nextDate = new Date(next! * 1000);
		expect(nextDate.getUTCHours()).toBe(9);
		expect(nextDate.getUTCMinutes()).toBe(0);
	});

	test('expands @daily preset', () => {
		const next = getNextRunAt('@daily', 'UTC');
		expect(next).not.toBeNull();
		const nextDate = new Date(next! * 1000);
		expect(nextDate.getUTCHours()).toBe(0);
		expect(nextDate.getUTCMinutes()).toBe(0);
	});

	test('expands @weekly preset', () => {
		const next = getNextRunAt('@weekly', 'UTC');
		expect(next).not.toBeNull();
		const nextDate = new Date(next! * 1000);
		// @weekly = every Sunday at midnight
		expect(nextDate.getUTCDay()).toBe(0); // Sunday
		expect(nextDate.getUTCHours()).toBe(0);
	});

	test('returns null for invalid expression', () => {
		const next = getNextRunAt('not-valid', 'UTC');
		expect(next).toBeNull();
	});

	test('two successive calls give different (sequential) timestamps', () => {
		const nowMs = Date.now();
		const next1 = getNextRunAt('@hourly', 'UTC', nowMs);
		const next2 = getNextRunAt('@hourly', 'UTC', next1! * 1000 + 1000); // start from after next1
		expect(next1).not.toBeNull();
		expect(next2).not.toBeNull();
		expect(next2).toBeGreaterThan(next1!);
	});
});

describe('getSystemTimezone', () => {
	test('returns a non-empty string', () => {
		const tz = getSystemTimezone();
		expect(typeof tz).toBe('string');
		expect(tz.length).toBeGreaterThan(0);
	});
});
