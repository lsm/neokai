// @ts-nocheck
/**
 * Tests for RoomStore review-related features:
 * - Toast notification when task transitions to review status via liveQuery.delta
 * - reviewTaskCount computed signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toastsSignal } from '../toast';

// -------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
// -------------------------------------------------------

let mockEventHandlers: Map<string, (event: unknown) => void>;
let mockHub: ReturnType<typeof makeMockHub>;

const ROOM_ID = 'room-1';
const TASKS_SUB_ID = `tasks-byRoom-${ROOM_ID}`;

function makeMockHub() {
	return {
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		onEvent: vi.fn((eventName: string, handler: (e: unknown) => void) => {
			if (!mockEventHandlers.has(eventName)) {
				mockEventHandlers.set(eventName, []);
			}
			(mockEventHandlers.get(eventName) as unknown[]).push(handler);
			return () => {
				const handlers = mockEventHandlers.get(eventName) as unknown[];
				if (handlers) {
					const i = handlers.indexOf(handler);
					if (i >= 0) handlers.splice(i, 1);
				}
			};
		}),
		onConnection: vi.fn(() => () => {}),
		request: vi.fn(async (method: string) => {
			if (method === 'room.get') {
				return { room: { id: ROOM_ID }, sessions: [], allTasks: [] };
			}
			if (method === 'room.runtime.state') throw new Error('no runtime');
			return { ok: true };
		}),
	};
}

function fireEvent(eventName: string, data: unknown) {
	const handlers = mockEventHandlers.get(eventName) as ((e: unknown) => void)[] | undefined;
	if (handlers) {
		for (const h of handlers) h(data);
	}
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

describe('RoomStore — review toast notification (via liveQuery.delta)', () => {
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

		// Force deselect so the next select() always re-runs startSubscriptions.
		// Also unsubscribeRoom so liveQueryActive is cleared between tests.
		roomStore.unsubscribeRoom(ROOM_ID);
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
		// Simulates a race where liveQuery.delta arrives before the snapshot
		// populates tasks — the task is not yet in local state.
		await roomStore.select(ROOM_ID);
		await roomStore.subscribeRoom(ROOM_ID);
		roomStore.tasks.value = [];

		// Delta with an 'updated' task that is not in current state
		fireEvent('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			updated: [makeTask('t1', 'review', 'My Review Task')],
			version: 2,
		});

		// No toast because prevTask was not found in current state
		expect(toastsSignal.value.length).toBe(0);
	});

	it('fires a toast when existing task transitions from in_progress to review', async () => {
		await roomStore.select(ROOM_ID);
		await roomStore.subscribeRoom(ROOM_ID);

		// Seed with an in_progress task via snapshot
		fireEvent('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t2', 'in_progress', 'Coding Task')],
			version: 1,
		});

		// Transition to review via delta
		fireEvent('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			updated: [makeTask('t2', 'review', 'Coding Task')],
			version: 2,
		});

		expect(toastsSignal.value.length).toBe(1);
		expect(toastsSignal.value[0].message).toBe('Task ready for review: Coding Task');
	});

	it('does NOT fire a toast when a task updates but stays in review', async () => {
		await roomStore.select(ROOM_ID);
		await roomStore.subscribeRoom(ROOM_ID);

		// Seed with an already-review task
		fireEvent('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t3', 'review', 'Already In Review')],
			version: 1,
		});

		fireEvent('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			updated: [makeTask('t3', 'review', 'Already In Review')],
			version: 2,
		});

		expect(toastsSignal.value.length).toBe(0);
	});

	it('does NOT fire a toast for task updates with non-review status', async () => {
		await roomStore.select(ROOM_ID);
		await roomStore.subscribeRoom(ROOM_ID);

		fireEvent('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t4', 'pending', 'Pending Task')],
			version: 1,
		});

		fireEvent('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			updated: [makeTask('t4', 'in_progress', 'Pending Task')],
			version: 2,
		});

		expect(toastsSignal.value.length).toBe(0);
	});

	it('does NOT fire a toast for delta events with a different subscriptionId', async () => {
		await roomStore.select(ROOM_ID);
		await roomStore.subscribeRoom(ROOM_ID);

		fireEvent('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t5', 'in_progress', 'Other Room Task')],
			version: 1,
		});

		// Delta for a different subscription (e.g., goals.byRoom)
		fireEvent('liveQuery.delta', {
			subscriptionId: 'goals-byRoom-room-1',
			updated: [makeTask('t5', 'review', 'Other Room Task')],
			version: 2,
		});

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
		await roomStore.select(ROOM_ID);

		roomStore.tasks.value = [makeTask('t1', 'pending'), makeTask('t2', 'in_progress')];

		expect(roomStore.reviewTaskCount.value).toBe(0);
	});

	it('counts tasks in review status', async () => {
		await roomStore.select(ROOM_ID);

		roomStore.tasks.value = [
			makeTask('t1', 'review'),
			makeTask('t2', 'in_progress'),
			makeTask('t3', 'review'),
		];

		expect(roomStore.reviewTaskCount.value).toBe(2);
	});

	it('updates reactively when tasks change', async () => {
		await roomStore.select(ROOM_ID);

		roomStore.tasks.value = [makeTask('t1', 'pending')];
		expect(roomStore.reviewTaskCount.value).toBe(0);

		roomStore.tasks.value = [makeTask('t1', 'review')];
		expect(roomStore.reviewTaskCount.value).toBe(1);
	});
});
