/**
 * Tests for RoomStore computed signals:
 * - tasksByGoalId: Map of goal ID → linked NeoTask[]
 * - orphanTasks: Tasks not linked to any goal
 * - orphanTasksActive: Orphan tasks with draft/pending/in_progress
 * - orphanTasksReview: Orphan tasks with review/needs_attention/rate_limited/usage_limited
 * - orphanTasksDone: Orphan tasks with completed/cancelled
 * (orphanTasksArchived was removed — archived tasks are excluded server-side)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NeoTask, TaskStatus, RoomGoal } from '@neokai/shared';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

let mockEventHandlers: Array<{ name: string; handler: (event: unknown) => void }>;
let mockHub: ReturnType<typeof makeMockHub>;

function makeMockHub() {
	return {
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		onEvent: vi.fn((eventName: string, handler: (e: unknown) => void) => {
			const entry = { name: eventName, handler };
			mockEventHandlers.push(entry);
			return () => {
				const idx = mockEventHandlers.indexOf(entry);
				if (idx >= 0) mockEventHandlers.splice(idx, 1);
			};
		}),
		onConnection: vi.fn(() => () => {}),
		request: vi.fn(async (method: string) => {
			if (method === 'room.get') {
				return { room: { id: 'room-1' }, sessions: [], allTasks: [] };
			}
			if (method === 'goal.list') return { goals: [] };
			if (method === 'room.runtime.state') throw new Error('no runtime');
			return {};
		}),
	};
}

vi.mock('../connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(async () => mockHub),
		getHubIfConnected: vi.fn(() => mockHub),
	},
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeTask(id: string, status: TaskStatus, title = `Task ${id}`): NeoTask {
	return {
		id,
		roomId: 'room-1',
		title,
		status,
		priority: 'normal',
		description: '',
		progress: 0,
		dependsOn: [],
		createdAt: 0,
		updatedAt: 0,
	};
}

function makeGoal(id: string, linkedTaskIds: string[] = []): RoomGoal {
	return {
		id,
		roomId: 'room-1',
		title: `Goal ${id}`,
		description: '',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds,
		metrics: {},
		createdAt: 0,
		updatedAt: 0,
	};
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('RoomStore — computed goal/task signals', () => {
	let roomStore: typeof import('../room-store').roomStore;

	beforeEach(async () => {
		mockEventHandlers = [];
		mockHub = makeMockHub();
		vi.resetModules();
		const mod = await import('../room-store');
		roomStore = mod.roomStore;
		await roomStore.select('room-1');
	});

	describe('tasksByGoalId', () => {
		it('returns empty map when no goals', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending')]);
			roomStore.goalStore.applySnapshot([]);
			const map = roomStore.tasksByGoalId.value;
			expect(map.size).toBe(0);
		});

		it('maps goals to their linked tasks', () => {
			roomStore.taskStore.applySnapshot([
				makeTask('t1', 'pending'),
				makeTask('t2', 'in_progress'),
				makeTask('t3', 'completed'),
			]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1', 't2']), makeGoal('g2', ['t3'])]);
			const map = roomStore.tasksByGoalId.value;
			expect(map.get('g1')?.map((t) => t.id)).toEqual(['t1', 't2']);
			expect(map.get('g2')?.map((t) => t.id)).toEqual(['t3']);
		});

		it('skips linked task IDs that do not exist in tasks signal', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending')]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1', 'nonexistent'])]);
			const map = roomStore.tasksByGoalId.value;
			expect(map.has('g1')).toBe(true);
			expect(map.get('g1')?.map((t) => t.id)).toEqual(['t1']);
		});

		it('includes goal with empty linkedTaskIds as a key with empty array', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending')]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', []), makeGoal('g2', ['t1'])]);
			const map = roomStore.tasksByGoalId.value;
			expect(map.has('g1')).toBe(true);
			expect(map.get('g1')).toEqual([]);
			expect(map.has('g2')).toBe(true);
			expect(map.get('g2')?.map((t) => t.id)).toEqual(['t1']);
		});
	});

	describe('orphanTasks', () => {
		it('returns all tasks when no goals exist', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending'), makeTask('t2', 'draft')]);
			roomStore.goalStore.applySnapshot([]);
			expect(roomStore.orphanTasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
		});

		it('excludes tasks linked to any goal', () => {
			roomStore.taskStore.applySnapshot([
				makeTask('t1', 'pending'),
				makeTask('t2', 'in_progress'),
				makeTask('t3', 'completed'),
			]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1', 't3'])]);
			expect(roomStore.orphanTasks.value.map((t) => t.id)).toEqual(['t2']);
		});

		it('returns empty when all tasks are linked', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending')]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1'])]);
			expect(roomStore.orphanTasks.value).toEqual([]);
		});
	});

	describe('orphanTasksActive', () => {
		it('includes draft, pending, and in_progress orphan tasks', () => {
			roomStore.taskStore.applySnapshot([
				makeTask('t1', 'draft'),
				makeTask('t2', 'pending'),
				makeTask('t3', 'in_progress'),
				makeTask('t4', 'review'),
				makeTask('t5', 'completed'),
				makeTask('t6', 'needs_attention'),
				makeTask('t7', 'cancelled'),
			]);
			roomStore.goalStore.applySnapshot([]);
			const ids = roomStore.orphanTasksActive.value.map((t) => t.id);
			expect(ids).toEqual(['t1', 't2', 't3']);
		});
	});

	describe('orphanTasksReview', () => {
		it('includes review, needs_attention, rate_limited, and usage_limited orphan tasks', () => {
			roomStore.taskStore.applySnapshot([
				makeTask('t1', 'draft'),
				makeTask('t2', 'review'),
				makeTask('t3', 'needs_attention'),
				makeTask('t4', 'completed'),
				makeTask('t5', 'rate_limited'),
				makeTask('t6', 'usage_limited'),
			]);
			roomStore.goalStore.applySnapshot([]);
			const ids = roomStore.orphanTasksReview.value.map((t) => t.id);
			expect(ids).toEqual(['t2', 't3', 't5', 't6']);
		});
	});

	describe('orphanTasksDone', () => {
		it('includes completed and cancelled orphan tasks', () => {
			roomStore.taskStore.applySnapshot([
				makeTask('t1', 'in_progress'),
				makeTask('t2', 'completed'),
				makeTask('t3', 'cancelled'),
			]);
			roomStore.goalStore.applySnapshot([]);
			const ids = roomStore.orphanTasksDone.value.map((t) => t.id);
			expect(ids).toEqual(['t2', 't3']);
		});
	});

	describe('non-archived TaskStatus values are covered by orphan buckets', () => {
		it('every non-archived status falls into exactly one bucket', () => {
			// Note: archived tasks are excluded server-side by the tasks.byRoom LiveQuery,
			// so the tasks signal never contains archived tasks in production.
			roomStore.taskStore.applySnapshot([
				makeTask('draft', 'draft'),
				makeTask('pending', 'pending'),
				makeTask('in_progress', 'in_progress'),
				makeTask('review', 'review'),
				makeTask('needs_attention', 'needs_attention'),
				makeTask('completed', 'completed'),
				makeTask('cancelled', 'cancelled'),
				makeTask('rate_limited', 'rate_limited'),
				makeTask('usage_limited', 'usage_limited'),
			]);
			roomStore.goalStore.applySnapshot([]);

			const active = new Set(roomStore.orphanTasksActive.value.map((t) => t.id));
			const review = new Set(roomStore.orphanTasksReview.value.map((t) => t.id));
			const done = new Set(roomStore.orphanTasksDone.value.map((t) => t.id));

			// No overlap
			const buckets = [active, review, done];
			for (let i = 0; i < buckets.length; i++) {
				for (let j = i + 1; j < buckets.length; j++) {
					for (const id of buckets[i]) {
						expect(buckets[j].has(id)).toBe(false);
					}
				}
			}

			// All 9 non-archived statuses covered
			expect(active.size + review.size + done.size).toBe(9);
			expect(review.has('rate_limited')).toBe(true);
			expect(review.has('usage_limited')).toBe(true);
		});
	});


	describe('filtered orphan tasks exclude linked tasks', () => {
		it('does not include linked tasks in any orphan bucket', () => {
			roomStore.taskStore.applySnapshot([
				makeTask('t1', 'draft'),
				makeTask('t2', 'review'),
				makeTask('t3', 'completed'),
			]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1', 't2', 't3'])]);

			expect(roomStore.orphanTasksActive.value).toEqual([]);
			expect(roomStore.orphanTasksReview.value).toEqual([]);
			expect(roomStore.orphanTasksDone.value).toEqual([]);
		});
	});

	describe('edge cases', () => {
		it('returns empty arrays when tasks and goals are both empty', () => {
			roomStore.taskStore.applySnapshot([]);
			roomStore.goalStore.applySnapshot([]);
			expect(roomStore.tasksByGoalId.value.size).toBe(0);
			expect(roomStore.orphanTasks.value).toEqual([]);
			expect(roomStore.orphanTasksActive.value).toEqual([]);
			expect(roomStore.orphanTasksReview.value).toEqual([]);
			expect(roomStore.orphanTasksDone.value).toEqual([]);
		});

		it('handles a goal linking to the same task as another goal', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending')]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1']), makeGoal('g2', ['t1'])]);
			// t1 appears under both goals
			expect(roomStore.tasksByGoalId.value.get('g1')?.map((t) => t.id)).toEqual(['t1']);
			expect(roomStore.tasksByGoalId.value.get('g2')?.map((t) => t.id)).toEqual(['t1']);
			// t1 is linked, so no orphans
			expect(roomStore.orphanTasks.value).toEqual([]);
		});

		it('handles no tasks linked (all are orphans)', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending'), makeTask('t2', 'review')]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', [])]);
			expect(roomStore.orphanTasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
			expect(roomStore.tasksByGoalId.value.get('g1')).toEqual([]);
		});
	});

	describe('reactivity', () => {
		it('updates tasksByGoalId when tasks signal changes', () => {
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1', 't2'])]);
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending')]);
			expect(roomStore.tasksByGoalId.value.get('g1')?.map((t) => t.id)).toEqual(['t1']);

			// Add t2
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending'), makeTask('t2', 'in_progress')]);
			expect(roomStore.tasksByGoalId.value.get('g1')?.map((t) => t.id)).toEqual(['t1', 't2']);
		});

		it('updates tasksByGoalId when goals signal changes', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending'), makeTask('t2', 'review')]);
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1'])]);
			expect(roomStore.tasksByGoalId.value.get('g1')?.map((t) => t.id)).toEqual(['t1']);

			// Change goals to link t2 instead
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t2'])]);
			expect(roomStore.tasksByGoalId.value.get('g1')?.map((t) => t.id)).toEqual(['t2']);
		});

		it('updates orphanTasks when a task becomes linked to a goal', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'draft'), makeTask('t2', 'pending')]);
			roomStore.goalStore.applySnapshot([]);
			expect(roomStore.orphanTasks.value.map((t) => t.id)).toEqual(['t1', 't2']);

			// Link t1 to a goal
			roomStore.goalStore.applySnapshot([makeGoal('g1', ['t1'])]);
			expect(roomStore.orphanTasks.value.map((t) => t.id)).toEqual(['t2']);
		});

		it('updates orphan buckets when task status changes', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'pending')]);
			roomStore.goalStore.applySnapshot([]);
			expect(roomStore.orphanTasksActive.value.map((t) => t.id)).toEqual(['t1']);
			expect(roomStore.orphanTasksReview.value).toEqual([]);

			// Change t1 status to review
			roomStore.taskStore.applySnapshot([makeTask('t1', 'review')]);
			expect(roomStore.orphanTasksActive.value).toEqual([]);
			expect(roomStore.orphanTasksReview.value.map((t) => t.id)).toEqual(['t1']);
		});

		it('updates orphanTasksDone when task transitions to completed', () => {
			roomStore.taskStore.applySnapshot([makeTask('t1', 'in_progress')]);
			roomStore.goalStore.applySnapshot([]);
			expect(roomStore.orphanTasksActive.value.map((t) => t.id)).toEqual(['t1']);
			expect(roomStore.orphanTasksDone.value).toEqual([]);

			// Complete the task
			roomStore.taskStore.applySnapshot([makeTask('t1', 'completed')]);
			expect(roomStore.orphanTasksActive.value).toEqual([]);
			expect(roomStore.orphanTasksDone.value.map((t) => t.id)).toEqual(['t1']);
		});
	});
});
