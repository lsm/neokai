/**
 * Tests for the shared task-filter predicates used by the Action tab and
 * the sidebar Tasks badge in `SpaceDetailPanel`.
 */

import { describe, expect, it } from 'vitest';
import type { SpaceTask, SpaceTaskStatus } from '@neokai/shared';
import { isActionRequired, isActiveTask } from '../task-filters';

const ALL_STATUSES: SpaceTaskStatus[] = [
	'open',
	'in_progress',
	'review',
	'approved',
	'done',
	'blocked',
	'cancelled',
	'archived',
];

function makeTask(status: SpaceTaskStatus): Pick<SpaceTask, 'status'> {
	return { status };
}

describe('isActionRequired', () => {
	it('returns true for blocked tasks regardless of block_reason', () => {
		expect(isActionRequired(makeTask('blocked'))).toBe(true);
	});

	it('returns true for review tasks (awaiting approval)', () => {
		expect(isActionRequired(makeTask('review'))).toBe(true);
	});

	it.each([
		'open',
		'in_progress',
		'approved',
		'done',
		'cancelled',
		'archived',
	] as const)('returns false for %s status', (status) => {
		expect(isActionRequired(makeTask(status))).toBe(false);
	});

	it('only returns true for review and blocked across the full status set', () => {
		const matching = ALL_STATUSES.filter((s) => isActionRequired(makeTask(s)));
		expect(matching.sort()).toEqual(['blocked', 'review']);
	});
});

describe('isActiveTask', () => {
	it.each(['open', 'in_progress'] as const)('returns true for %s status', (status) => {
		expect(isActiveTask(makeTask(status))).toBe(true);
	});

	it.each([
		'review',
		'blocked',
		'approved',
		'done',
		'cancelled',
		'archived',
	] as const)('returns false for %s status', (status) => {
		expect(isActiveTask(makeTask(status))).toBe(false);
	});
});

describe('isActionRequired and isActiveTask are mutually exclusive', () => {
	it('no status satisfies both predicates simultaneously', () => {
		for (const status of ALL_STATUSES) {
			const task = makeTask(status);
			const both = isActionRequired(task) && isActiveTask(task);
			expect(both).toBe(false);
		}
	});
});
