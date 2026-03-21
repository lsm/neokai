// @ts-nocheck
/**
 * Tests for RoomStore computed signals:
 * - tasksByGoalId: Map of goal ID → linked TaskSummary[]
 * - orphanTasks: Tasks not linked to any goal
 * - orphanTasksActive: Orphan tasks with draft/pending/in_progress
 * - orphanTasksReview: Orphan tasks with review/needs_attention
 * - orphanTasksDone: Orphan tasks with completed/cancelled
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

let mockEventHandlers: Map<string, (event: unknown) => void>;
let mockHub: ReturnType<typeof makeMockHub>;

function makeMockHub() {
	return {
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		onEvent: vi.fn((eventName: string, handler: (e: unknown) => void) => {
			mockEventHandlers.set(eventName, handler);
			return () => mockEventHandlers.delete(eventName);
		}),
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

function makeTask(id: string, status: string, title = `Task ${id}`) {
	return { id, title, status, priority: 'normal', progress: 0, dependsOn: [] };
}

function makeGoal(id: string, linkedTaskIds: string[] = []) {
	return {
		id,
		roomId: 'room-1',
		title: `Goal ${id}`,
		description: '',
		status: 'active',
		priority: 'normal',
		linkedTaskIds,
		metrics: {},
	};
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('RoomStore — computed goal/task signals', () => {
	let roomStore: typeof import('../room-store').roomStore;

	beforeEach(async () => {
		mockEventHandlers = new Map();
		mockHub = makeMockHub();
		vi.resetModules();
		const mod = await import('../room-store');
		roomStore = mod.roomStore;
		await roomStore.select('room-1');
	});

	describe('tasksByGoalId', () => {
		it('returns empty map when no goals', () => {
			roomStore.tasks.value = [makeTask('t1', 'pending')];
			roomStore.goals.value = [];
			const map = roomStore.tasksByGoalId.value;
			expect(map.size).toBe(0);
		});

		it('maps goals to their linked tasks', () => {
			roomStore.tasks.value = [
				makeTask('t1', 'pending'),
				makeTask('t2', 'in_progress'),
				makeTask('t3', 'completed'),
			];
			roomStore.goals.value = [makeGoal('g1', ['t1', 't2']), makeGoal('g2', ['t3'])];
			const map = roomStore.tasksByGoalId.value;
			expect(map.get('g1')?.map((t) => t.id)).toEqual(['t1', 't2']);
			expect(map.get('g2')?.map((t) => t.id)).toEqual(['t3']);
		});

		it('skips linked task IDs that do not exist in tasks signal', () => {
			roomStore.tasks.value = [makeTask('t1', 'pending')];
			roomStore.goals.value = [makeGoal('g1', ['t1', 'nonexistent'])];
			const map = roomStore.tasksByGoalId.value;
			expect(map.get('g1')?.map((t) => t.id)).toEqual(['t1']);
		});
	});

	describe('orphanTasks', () => {
		it('returns all tasks when no goals exist', () => {
			roomStore.tasks.value = [makeTask('t1', 'pending'), makeTask('t2', 'draft')];
			roomStore.goals.value = [];
			expect(roomStore.orphanTasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
		});

		it('excludes tasks linked to any goal', () => {
			roomStore.tasks.value = [
				makeTask('t1', 'pending'),
				makeTask('t2', 'in_progress'),
				makeTask('t3', 'completed'),
			];
			roomStore.goals.value = [makeGoal('g1', ['t1', 't3'])];
			expect(roomStore.orphanTasks.value.map((t) => t.id)).toEqual(['t2']);
		});

		it('returns empty when all tasks are linked', () => {
			roomStore.tasks.value = [makeTask('t1', 'pending')];
			roomStore.goals.value = [makeGoal('g1', ['t1'])];
			expect(roomStore.orphanTasks.value).toEqual([]);
		});
	});

	describe('orphanTasksActive', () => {
		it('includes draft, pending, and in_progress orphan tasks', () => {
			roomStore.tasks.value = [
				makeTask('t1', 'draft'),
				makeTask('t2', 'pending'),
				makeTask('t3', 'in_progress'),
				makeTask('t4', 'review'),
				makeTask('t5', 'completed'),
				makeTask('t6', 'needs_attention'),
				makeTask('t7', 'cancelled'),
			];
			roomStore.goals.value = [];
			const ids = roomStore.orphanTasksActive.value.map((t) => t.id);
			expect(ids).toEqual(['t1', 't2', 't3']);
		});
	});

	describe('orphanTasksReview', () => {
		it('includes review and needs_attention orphan tasks', () => {
			roomStore.tasks.value = [
				makeTask('t1', 'draft'),
				makeTask('t2', 'review'),
				makeTask('t3', 'needs_attention'),
				makeTask('t4', 'completed'),
			];
			roomStore.goals.value = [];
			const ids = roomStore.orphanTasksReview.value.map((t) => t.id);
			expect(ids).toEqual(['t2', 't3']);
		});
	});

	describe('orphanTasksDone', () => {
		it('includes completed and cancelled orphan tasks', () => {
			roomStore.tasks.value = [
				makeTask('t1', 'in_progress'),
				makeTask('t2', 'completed'),
				makeTask('t3', 'cancelled'),
			];
			roomStore.goals.value = [];
			const ids = roomStore.orphanTasksDone.value.map((t) => t.id);
			expect(ids).toEqual(['t2', 't3']);
		});
	});

	describe('all 7 TaskStatus values are covered', () => {
		it('every status falls into exactly one bucket', () => {
			roomStore.tasks.value = [
				makeTask('draft', 'draft'),
				makeTask('pending', 'pending'),
				makeTask('in_progress', 'in_progress'),
				makeTask('review', 'review'),
				makeTask('needs_attention', 'needs_attention'),
				makeTask('completed', 'completed'),
				makeTask('cancelled', 'cancelled'),
			];
			roomStore.goals.value = [];

			const active = new Set(roomStore.orphanTasksActive.value.map((t) => t.id));
			const review = new Set(roomStore.orphanTasksReview.value.map((t) => t.id));
			const done = new Set(roomStore.orphanTasksDone.value.map((t) => t.id));

			// No overlap
			for (const id of active) {
				expect(review.has(id)).toBe(false);
				expect(done.has(id)).toBe(false);
			}
			for (const id of review) {
				expect(done.has(id)).toBe(false);
			}

			// All covered
			expect(active.size + review.size + done.size).toBe(7);
		});
	});

	describe('filtered orphan tasks exclude linked tasks', () => {
		it('does not include linked tasks in any orphan bucket', () => {
			roomStore.tasks.value = [
				makeTask('t1', 'draft'),
				makeTask('t2', 'review'),
				makeTask('t3', 'completed'),
			];
			roomStore.goals.value = [makeGoal('g1', ['t1', 't2', 't3'])];

			expect(roomStore.orphanTasksActive.value).toEqual([]);
			expect(roomStore.orphanTasksReview.value).toEqual([]);
			expect(roomStore.orphanTasksDone.value).toEqual([]);
		});
	});
});
