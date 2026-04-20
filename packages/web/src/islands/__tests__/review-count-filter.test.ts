// @ts-nocheck
/**
 * Tests for the reviewCount filtering logic used in RoomContextPanel.
 *
 * Verifies that reviewCount includes all four actionable statuses:
 * 'review', 'needs_attention', 'rate_limited', 'usage_limited'.
 *
 * The filtering logic is extracted here as a pure function test rather than
 * rendering the full component, since the component depends on many store signals.
 */

import { describe, it, expect } from 'vitest';
import type { TaskStatus } from '@neokai/shared/types/neo';

// Extract the same filtering logic used in RoomContextPanel
function computeReviewCount(tasks: Array<{ status: TaskStatus }>): number {
	return tasks.filter(
		(t) =>
			t.status === 'review' ||
			t.status === 'needs_attention' ||
			t.status === 'rate_limited' ||
			t.status === 'usage_limited'
	).length;
}

function computeActiveCount(tasks: Array<{ status: TaskStatus }>): number {
	return tasks.filter(
		(t) => t.status === 'draft' || t.status === 'pending' || t.status === 'in_progress'
	).length;
}

describe('RoomContextPanel review/active count logic', () => {
	describe('reviewCount', () => {
		it('counts tasks with review status', () => {
			const tasks = [{ status: 'review' as TaskStatus }];
			expect(computeReviewCount(tasks)).toBe(1);
		});

		it('counts tasks with needs_attention status', () => {
			const tasks = [{ status: 'needs_attention' as TaskStatus }];
			expect(computeReviewCount(tasks)).toBe(1);
		});

		it('counts tasks with rate_limited status', () => {
			const tasks = [{ status: 'rate_limited' as TaskStatus }];
			expect(computeReviewCount(tasks)).toBe(1);
		});

		it('counts tasks with usage_limited status', () => {
			const tasks = [{ status: 'usage_limited' as TaskStatus }];
			expect(computeReviewCount(tasks)).toBe(1);
		});

		it('counts all four actionable statuses together', () => {
			const tasks = [
				{ status: 'review' as TaskStatus },
				{ status: 'needs_attention' as TaskStatus },
				{ status: 'rate_limited' as TaskStatus },
				{ status: 'usage_limited' as TaskStatus },
			];
			expect(computeReviewCount(tasks)).toBe(4);
		});

		it('excludes non-review statuses from reviewCount', () => {
			const tasks = [
				{ status: 'draft' as TaskStatus },
				{ status: 'pending' as TaskStatus },
				{ status: 'in_progress' as TaskStatus },
				{ status: 'completed' as TaskStatus },
				{ status: 'cancelled' as TaskStatus },
				{ status: 'archived' as TaskStatus },
			];
			expect(computeReviewCount(tasks)).toBe(0);
		});

		it('returns 0 for empty task list', () => {
			expect(computeReviewCount([])).toBe(0);
		});

		it('correctly counts mixed statuses', () => {
			const tasks = [
				{ status: 'in_progress' as TaskStatus },
				{ status: 'review' as TaskStatus },
				{ status: 'completed' as TaskStatus },
				{ status: 'rate_limited' as TaskStatus },
				{ status: 'draft' as TaskStatus },
				{ status: 'usage_limited' as TaskStatus },
				{ status: 'needs_attention' as TaskStatus },
				{ status: 'archived' as TaskStatus },
			];
			expect(computeReviewCount(tasks)).toBe(4);
		});
	});

	describe('activeCount', () => {
		it('counts draft, pending, and in_progress tasks', () => {
			const tasks = [
				{ status: 'draft' as TaskStatus },
				{ status: 'pending' as TaskStatus },
				{ status: 'in_progress' as TaskStatus },
			];
			expect(computeActiveCount(tasks)).toBe(3);
		});

		it('excludes review-related statuses from activeCount', () => {
			const tasks = [
				{ status: 'review' as TaskStatus },
				{ status: 'needs_attention' as TaskStatus },
				{ status: 'rate_limited' as TaskStatus },
				{ status: 'usage_limited' as TaskStatus },
			];
			expect(computeActiveCount(tasks)).toBe(0);
		});

		it('excludes completed, cancelled, and archived from activeCount', () => {
			const tasks = [
				{ status: 'completed' as TaskStatus },
				{ status: 'cancelled' as TaskStatus },
				{ status: 'archived' as TaskStatus },
			];
			expect(computeActiveCount(tasks)).toBe(0);
		});
	});

	describe('activeCount and reviewCount are mutually exclusive', () => {
		it('no task status belongs to both active and review sets', () => {
			const allStatuses: TaskStatus[] = [
				'draft',
				'pending',
				'in_progress',
				'review',
				'completed',
				'needs_attention',
				'cancelled',
				'archived',
				'rate_limited',
				'usage_limited',
			];

			for (const status of allStatuses) {
				const tasks = [{ status }];
				const isActive = computeActiveCount(tasks) > 0;
				const isReview = computeReviewCount(tasks) > 0;
				// No status should be counted in both categories
				expect(isActive && isReview).toBe(false);
			}
		});
	});
});
