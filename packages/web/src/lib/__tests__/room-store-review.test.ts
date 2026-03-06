// @ts-nocheck
/**
 * Tests for RoomStore review-related features:
 * - Toast notification when task transitions to review status
 * - reviewTaskCount computed signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toastsSignal } from '../toast';

// -------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
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
	return { id, title, status, priority: 'normal', progress: 0 };
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('RoomStore — review toast notification', () => {
	let roomStore: typeof import('../room-store').roomStore;

	beforeEach(async () => {
		// Clear toasts
		toastsSignal.value = [];

		// Fresh handler map and hub for each test
		mockEventHandlers = new Map();
		mockHub = makeMockHub();

		// Import after mock is set up; reset to null so select() re-initialises
		const mod = await import('../room-store.ts');
		roomStore = mod.roomStore;

		// Force deselect so the next select() always re-runs startSubscriptions
		if (roomStore.roomId.value !== null) {
			await roomStore.select(null);
		}
		mockEventHandlers.clear();
	});

	afterEach(() => {
		toastsSignal.value = [];
		vi.clearAllMocks();
	});

	it('does NOT fire a toast when an unknown task arrives in review (hydration guard)', async () => {
		// Simulates a race where room.task.update arrives before fetchInitialState
		// populates tasks — the task is not yet in local state (idx === -1).
		await roomStore.select('room-1');
		// tasks.value is empty (initial state not hydrated yet)
		roomStore.tasks.value = [];

		const handler = mockEventHandlers.get('room.task.update');
		expect(handler).toBeDefined();

		handler({ roomId: 'room-1', task: makeTask('t1', 'review', 'My Review Task') });

		// No toast because prevTask was null (not previously known)
		expect(toastsSignal.value.length).toBe(0);
	});

	it('fires a toast when existing task transitions from in_progress to review', async () => {
		await roomStore.select('room-1');

		// Seed with an in_progress task
		roomStore.tasks.value = [makeTask('t2', 'in_progress', 'Coding Task')];

		const handler = mockEventHandlers.get('room.task.update');
		handler({ roomId: 'room-1', task: makeTask('t2', 'review', 'Coding Task') });

		expect(toastsSignal.value.length).toBe(1);
		expect(toastsSignal.value[0].message).toBe('Task ready for review: Coding Task');
	});

	it('does NOT fire a toast when a task updates but stays in review', async () => {
		await roomStore.select('room-1');

		// Seed with an already-review task
		roomStore.tasks.value = [makeTask('t3', 'review', 'Already In Review')];

		const handler = mockEventHandlers.get('room.task.update');
		handler({ roomId: 'room-1', task: makeTask('t3', 'review', 'Already In Review') });

		expect(toastsSignal.value.length).toBe(0);
	});

	it('does NOT fire a toast for task updates with non-review status', async () => {
		await roomStore.select('room-1');

		const handler = mockEventHandlers.get('room.task.update');
		handler({ roomId: 'room-1', task: makeTask('t4', 'in_progress') });

		expect(toastsSignal.value.length).toBe(0);
	});

	it('does NOT fire a toast for events from a different room', async () => {
		await roomStore.select('room-1');

		const handler = mockEventHandlers.get('room.task.update');
		handler({ roomId: 'room-99', task: makeTask('t5', 'review', 'Other Room Task') });

		expect(toastsSignal.value.length).toBe(0);
	});
});

describe('RoomStore — reviewTaskCount computed signal', () => {
	let roomStore: typeof import('../room-store').roomStore;

	beforeEach(async () => {
		mockEventHandlers = new Map();
		mockHub = makeMockHub();

		const mod = await import('../room-store.ts');
		roomStore = mod.roomStore;

		if (roomStore.roomId.value !== null) {
			await roomStore.select(null);
		}
		mockEventHandlers.clear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('returns 0 when no tasks are in review', async () => {
		await roomStore.select('room-1');

		roomStore.tasks.value = [makeTask('t1', 'pending'), makeTask('t2', 'in_progress')];

		expect(roomStore.reviewTaskCount.value).toBe(0);
	});

	it('counts tasks in review status', async () => {
		await roomStore.select('room-1');

		roomStore.tasks.value = [
			makeTask('t1', 'review'),
			makeTask('t2', 'in_progress'),
			makeTask('t3', 'review'),
		];

		expect(roomStore.reviewTaskCount.value).toBe(2);
	});

	it('updates reactively when tasks change', async () => {
		await roomStore.select('room-1');

		roomStore.tasks.value = [makeTask('t1', 'pending')];
		expect(roomStore.reviewTaskCount.value).toBe(0);

		roomStore.tasks.value = [makeTask('t1', 'review')];
		expect(roomStore.reviewTaskCount.value).toBe(1);
	});
});
