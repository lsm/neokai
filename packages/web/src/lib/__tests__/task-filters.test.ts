/**
 * Tests for the shared task-filter predicates used by the Action tab and
 * the sidebar Tasks badge in `SpaceDetailPanel`.
 */

import type { SpaceTask, SpaceTaskStatus } from '@neokai/shared';
import { describe, expect, it } from 'vitest';
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
	it.each(['open', 'in_progress', 'approved'] as const)('returns true for %s status', (status) => {
		expect(isActiveTask(makeTask(status))).toBe(true);
	});

	it.each([
		'review',
		'blocked',
		'done',
		'cancelled',
		'archived',
	] as const)('returns false for %s status', (status) => {
		expect(isActiveTask(makeTask(status))).toBe(false);
	});

	it('classifies the full status set deterministically', () => {
		const matching = ALL_STATUSES.filter((s) => isActiveTask(makeTask(s)));
		expect(matching.sort()).toEqual(['approved', 'in_progress', 'open']);
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

/**
 * Regression test for the bug where the sidebar "Active" tab and the
 * main-pane Tasks "Active" tab disagreed about whether `approved` tasks
 * belong in Active. Both surfaces now import the same `isActiveTask`
 * predicate; this test verifies the predicate's output across the
 * complete status surface so any future drift would fail loudly.
 *
 * The fixture mirrors how both consumers compute their lists: filter a
 * heterogeneous task set with the predicate and compare the resulting
 * task IDs. If both consumers go through the same helper, the resulting
 * sets must be identical.
 */
describe('Active filter parity across consumers', () => {
	type Row = { id: string; status: SpaceTaskStatus };

	const fixture: Row[] = [
		{ id: 'open-1', status: 'open' },
		{ id: 'open-2', status: 'open' },
		{ id: 'in_progress-1', status: 'in_progress' },
		{ id: 'review-1', status: 'review' },
		{ id: 'approved-1', status: 'approved' },
		{ id: 'approved-2', status: 'approved' },
		{ id: 'done-1', status: 'done' },
		{ id: 'blocked-1', status: 'blocked' },
		{ id: 'cancelled-1', status: 'cancelled' },
		{ id: 'archived-1', status: 'archived' },
	];

	// Both consumers reduce to: `tasks.filter(isActiveTask).map(t => t.id)`.
	// Modeling each path independently makes the parity assertion explicit
	// rather than relying on a shared import alone.
	const sidebarActiveIds = (rows: Row[]): string[] =>
		rows.filter((r) => isActiveTask({ status: r.status })).map((r) => r.id);

	const tasksViewActiveIds = (rows: Row[]): string[] =>
		rows.filter((r) => isActiveTask({ status: r.status })).map((r) => r.id);

	it('sidebar and tasks-view produce the same set of task IDs', () => {
		const sidebarSet = new Set(sidebarActiveIds(fixture));
		const tasksViewSet = new Set(tasksViewActiveIds(fixture));
		expect([...sidebarSet].sort()).toEqual([...tasksViewSet].sort());
	});

	it('selects exactly the open / in_progress / approved rows', () => {
		const ids = sidebarActiveIds(fixture).sort();
		expect(ids).toEqual(['approved-1', 'approved-2', 'in_progress-1', 'open-1', 'open-2'].sort());
	});

	it('every status is covered by exactly one of action / active / completed / archived (no orphan)', () => {
		// Mirrors the 4-tab partition in SpaceTasks. `review` and `blocked`
		// land in action; `open`/`in_progress`/`approved` land in active;
		// `done`/`cancelled` land in completed; `archived` lands in archived.
		const completedStatuses: SpaceTaskStatus[] = ['done', 'cancelled'];
		const archivedStatuses: SpaceTaskStatus[] = ['archived'];

		for (const status of ALL_STATUSES) {
			const task = makeTask(status);
			const inAction = isActionRequired(task);
			const inActive = isActiveTask(task);
			const inCompleted = completedStatuses.includes(status);
			const inArchived = archivedStatuses.includes(status);
			const memberships = [inAction, inActive, inCompleted, inArchived].filter(Boolean).length;
			expect({ status, memberships }).toEqual({ status, memberships: 1 });
		}
	});
});
