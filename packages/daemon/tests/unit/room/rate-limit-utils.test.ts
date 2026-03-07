import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import {
	parseRateLimitReset,
	isRateLimitError,
	createRateLimitBackoff,
} from '../../../src/lib/room/runtime/rate-limit-utils';

describe('rate-limit-utils', () => {
	describe('isRateLimitError', () => {
		it('should match rate limit messages with middle dot', () => {
			expect(isRateLimitError("You've hit your limit · resets 10pm (America/New_York)")).toBe(true);
			expect(isRateLimitError("You've hit your limit · resets 3am (America/New_York)")).toBe(true);
		});

		it('should match rate limit messages with hour only', () => {
			expect(isRateLimitError("You've hit your limit · resets 1pm (UTC)")).toBe(true);
			expect(isRateLimitError("You've hit your limit · resets 12am (Europe/London)")).toBe(true);
		});

		it('should match rate limit messages with hour:minute', () => {
			expect(isRateLimitError("You've hit your limit · resets 1:30pm (America/Los_Angeles)")).toBe(
				true
			);
			expect(isRateLimitError("You've hit your limit · resets 11:45am (Asia/Tokyo)")).toBe(true);
		});

		it('should not match non-rate-limit messages', () => {
			expect(isRateLimitError('Some other error message')).toBe(false);
			expect(isRateLimitError('Rate limit exceeded')).toBe(false);
			expect(isRateLimitError('Too many requests')).toBe(false);
			expect(isRateLimitError('')).toBe(false);
		});

		it('should be case insensitive', () => {
			expect(isRateLimitError("YOU'VE HIT YOUR LIMIT · RESETS 1PM (UTC)")).toBe(true);
			expect(isRateLimitError("You've Hit Your Limit · Resets 1Pm (UTC)")).toBe(true);
		});
	});

	describe('parseRateLimitReset', () => {
		let originalDateNow: typeof Date.now;
		let mockNow: number;

		beforeEach(() => {
			// Mock Date.now to return a fixed time: 2026-03-06 10:00:00 UTC
			mockNow = new Date(2026, 2, 6, 10, 0, 0).getTime();
			originalDateNow = Date.now;
			Date.now = () => mockNow;
		});

		afterEach(() => {
			Date.now = originalDateNow;
		});

		it('should parse rate limit message with hour only (pm)', () => {
			// "resets 1pm" should give us 13:00 today
			const result = parseRateLimitReset("You've hit your limit · resets 1pm (America/New_York)");
			expect(result).not.toBeNull();

			const resetDate = new Date(result!);
			expect(resetDate.getHours()).toBe(13);
			expect(resetDate.getMinutes()).toBe(0);
		});

		it('should parse rate limit message with hour only (am)', () => {
			// "resets 3am" - since it's currently 10am, this should be tomorrow 3am
			const result = parseRateLimitReset("You've hit your limit · resets 3am (America/New_York)");
			expect(result).not.toBeNull();

			const resetDate = new Date(result!);
			expect(resetDate.getHours()).toBe(3);
			expect(resetDate.getMinutes()).toBe(0);
		});

		it('should parse rate limit message with hour:minute', () => {
			const result = parseRateLimitReset(
				"You've hit your limit · resets 1:30pm (America/New_York)"
			);
			expect(result).not.toBeNull();

			const resetDate = new Date(result!);
			expect(resetDate.getHours()).toBe(13);
			expect(resetDate.getMinutes()).toBe(30);
		});

		it('should handle 12pm (noon)', () => {
			const result = parseRateLimitReset("You've hit your limit · resets 12pm (UTC)");
			expect(result).not.toBeNull();

			const resetDate = new Date(result!);
			expect(resetDate.getHours()).toBe(12);
		});

		it('should handle 12am (midnight)', () => {
			const result = parseRateLimitReset("You've hit your limit · resets 12am (UTC)");
			expect(result).not.toBeNull();

			const resetDate = new Date(result!);
			expect(resetDate.getHours()).toBe(0);
		});

		it('should return null for non-matching messages', () => {
			expect(parseRateLimitReset('Some other error')).toBeNull();
			expect(parseRateLimitReset('')).toBeNull();
		});

		it('should return timestamp in the future when time is in the past', () => {
			// Current time is 10:00, reset time is 3am (already passed today)
			const result = parseRateLimitReset("You've hit your limit · resets 3am (UTC)");
			expect(result).not.toBeNull();
			expect(result!).toBeGreaterThan(mockNow);
		});
	});

	describe('createRateLimitBackoff', () => {
		let originalDateNow: typeof Date.now;
		const mockDetectedAt = 1709508000000; // Fixed timestamp

		beforeEach(() => {
			originalDateNow = Date.now;
			Date.now = () => mockDetectedAt;
		});

		afterEach(() => {
			Date.now = originalDateNow;
		});

		it('should create backoff object for worker', () => {
			const backoff = createRateLimitBackoff(
				"You've hit your limit · resets 1pm (America/New_York)",
				'worker'
			);

			expect(backoff).not.toBeNull();
			expect(backoff!.detectedAt).toBe(mockDetectedAt);
			expect(backoff!.resetsAt).toBeGreaterThan(mockDetectedAt);
			expect(backoff!.sessionRole).toBe('worker');
		});

		it('should create backoff object for leader', () => {
			const backoff = createRateLimitBackoff(
				"You've hit your limit · resets 1pm (America/New_York)",
				'leader'
			);

			expect(backoff).not.toBeNull();
			expect(backoff!.sessionRole).toBe('leader');
		});

		it('should return null for non-rate-limit messages', () => {
			const backoff = createRateLimitBackoff('Some other error', 'worker');
			expect(backoff).toBeNull();
		});
	});
});
