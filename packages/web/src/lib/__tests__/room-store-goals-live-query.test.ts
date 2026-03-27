/**
 * Tests for RoomStore goal LiveQuery subscription (Task 3.2/3.3)
 *
 * Verifies that goals are updated exclusively via liveQuery.snapshot /
 * liveQuery.delta events rather than legacy goal.created / goal.updated /
 * goal.completed events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoomGoal, GoalStatus } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type EventHandler<T = unknown> = (data: T) => void;

interface MockHub {
	_handlers: Map<string, EventHandler[]>;
	_connectionHandlers: EventHandler[];
	onEvent: <T>(method: string, handler: EventHandler<T>) => () => void;
	onConnection: (handler: EventHandler<string>) => () => void;
	request: ReturnType<typeof vi.fn>;
	joinChannel: ReturnType<typeof vi.fn>;
	leaveChannel: ReturnType<typeof vi.fn>;
	fire: <T>(method: string, data: T) => void;
	fireConnection: (state: string) => void;
}

function createMockHub(): MockHub {
	const _handlers = new Map<string, EventHandler[]>();
	const _connectionHandlers: EventHandler[] = [];
	return {
		_handlers,
		_connectionHandlers,
		onEvent: <T>(method: string, handler: EventHandler<T>) => {
			if (!_handlers.has(method)) _handlers.set(method, []);
			_handlers.get(method)!.push(handler as EventHandler);
			return () => {
				const list = _handlers.get(method);
				if (list) {
					const i = list.indexOf(handler as EventHandler);
					if (i >= 0) list.splice(i, 1);
				}
			};
		},
		onConnection: (handler: EventHandler<string>) => {
			_connectionHandlers.push(handler as EventHandler);
			return () => {
				const i = _connectionHandlers.indexOf(handler as EventHandler);
				if (i >= 0) _connectionHandlers.splice(i, 1);
			};
		},
		request: vi.fn(),
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		fire: <T>(method: string, data: T) => {
			for (const h of _handlers.get(method) ?? []) h(data);
		},
		fireConnection: (state: string) => {
			for (const h of _connectionHandlers) h(state);
		},
	};
}

vi.mock('../connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(),
		getHubIfConnected: vi.fn(),
	},
}));
vi.mock('../toast', () => ({ toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../router', () => ({ navigateToRoom: vi.fn() }));
vi.mock('../signals', () => ({
	currentRoomSessionIdSignal: { value: null },
	currentRoomIdSignal: { value: null },
	currentRoomTaskIdSignal: { value: null },
	currentSessionIdSignal: { value: null },
	currentSpaceIdSignal: { value: null },
	currentSpaceSessionIdSignal: { value: null },
	currentSpaceTaskIdSignal: { value: null },
	navSectionSignal: { value: 'lobby' },
}));

import { connectionManager } from '../connection-manager.js';
import { roomStore } from '../room-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID = 'room-test';
const GOALS_SUB_ID = `goals-byRoom-${ROOM_ID}`;

function makeGoal(id: string, overrides: Partial<RoomGoal> = {}): RoomGoal {
	return {
		id,
		roomId: ROOM_ID,
		title: `Goal ${id}`,
		description: '',
		status: 'active' as GoalStatus,
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function setupHubRequests(hub: MockHub): void {
	hub.request.mockImplementation((method: string) => {
		if (method === 'room.get')
			return Promise.resolve({ room: { id: ROOM_ID }, sessions: [], allTasks: [] });
		if (method === 'room.runtime.state') return Promise.reject(new Error('no runtime'));
		// liveQuery.subscribe and liveQuery.unsubscribe return { ok: true }
		return Promise.resolve({ ok: true });
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomStore — goals.byRoom LiveQuery subscription', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		setupHubRequests(hub);
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		await roomStore.select(ROOM_ID);
		// LiveQuery subscriptions are now managed by useRoomLiveQuery hook;
		// simulate hook mount by calling subscribeRoom directly.
		await roomStore.subscribeRoom(ROOM_ID);
	});

	afterEach(async () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	it('subscribes to goals.byRoom with a stable subscriptionId on room select', () => {
		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'goals.byRoom'
		);
		expect(subscribeCall).toBeDefined();
		expect(subscribeCall![1]).toMatchObject({
			queryName: 'goals.byRoom',
			params: [ROOM_ID],
			subscriptionId: GOALS_SUB_ID,
		});
	});

	it('does NOT subscribe via legacy goal.list on room select', () => {
		const calls = hub.request.mock.calls as [string, unknown][];
		const goalListCall = calls.find(([method]) => method === 'goal.list');
		expect(goalListCall).toBeUndefined();
	});

	it('populates goals.value from liveQuery.snapshot', () => {
		const goals = [makeGoal('g1'), makeGoal('g2')];
		hub.fire('liveQuery.snapshot', { subscriptionId: GOALS_SUB_ID, rows: goals, version: 1 });
		expect(roomStore.goals.value).toEqual(goals);
	});

	it('ignores liveQuery.snapshot for a different subscriptionId', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: 'other-sub',
			rows: [makeGoal('irrelevant')],
			version: 1,
		});
		expect(roomStore.goals.value).toEqual([]);
	});

	it('appends goals from liveQuery.delta added', () => {
		const g1 = makeGoal('g1');
		hub.fire('liveQuery.snapshot', { subscriptionId: GOALS_SUB_ID, rows: [g1], version: 1 });
		const g2 = makeGoal('g2');
		hub.fire('liveQuery.delta', { subscriptionId: GOALS_SUB_ID, added: [g2], version: 2 });
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1', 'g2']);
	});

	it('removes goals from liveQuery.delta removed', () => {
		const g1 = makeGoal('g1');
		const g2 = makeGoal('g2');
		hub.fire('liveQuery.snapshot', { subscriptionId: GOALS_SUB_ID, rows: [g1, g2], version: 1 });
		hub.fire('liveQuery.delta', { subscriptionId: GOALS_SUB_ID, removed: [g1], version: 2 });
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g2']);
	});

	it('replaces goals from liveQuery.delta updated', () => {
		const g1 = makeGoal('g1');
		hub.fire('liveQuery.snapshot', { subscriptionId: GOALS_SUB_ID, rows: [g1], version: 1 });
		const g1Updated = makeGoal('g1', { status: 'completed' as GoalStatus, progress: 100 });
		hub.fire('liveQuery.delta', {
			subscriptionId: GOALS_SUB_ID,
			updated: [g1Updated],
			version: 2,
		});
		expect(roomStore.goals.value[0].status).toBe('completed');
		expect(roomStore.goals.value[0].progress).toBe(100);
	});

	it('ignores liveQuery.delta for a different subscriptionId', () => {
		const g1 = makeGoal('g1');
		hub.fire('liveQuery.snapshot', { subscriptionId: GOALS_SUB_ID, rows: [g1], version: 1 });
		hub.fire('liveQuery.delta', {
			subscriptionId: 'other-sub',
			removed: [g1],
			version: 2,
		});
		// g1 should still be present
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);
	});

	it('unsubscribes from goals.byRoom when unsubscribeRoom is called (hook unmount)', () => {
		hub.request.mockClear();
		roomStore.unsubscribeRoom(ROOM_ID);
		const calls = hub.request.mock.calls as [string, unknown][];
		const unsubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.unsubscribe' &&
				(params as { subscriptionId: string }).subscriptionId === GOALS_SUB_ID
		);
		expect(unsubCall).toBeDefined();
	});

	it('re-subscribes to goals.byRoom on reconnect', () => {
		hub.request.mockClear();
		hub.fireConnection('connected');
		const calls = hub.request.mock.calls as [string, unknown][];
		const resubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'goals.byRoom'
		);
		expect(resubCall).toBeDefined();
		expect(resubCall![1]).toMatchObject({
			queryName: 'goals.byRoom',
			params: [ROOM_ID],
			subscriptionId: GOALS_SUB_ID,
		});
	});

	it('does NOT re-subscribe on reconnect after unsubscribeRoom (hook unmount)', () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		hub.request.mockClear();
		hub.fireConnection('connected');
		const calls = hub.request.mock.calls as [string, unknown][];
		const resubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'goals.byRoom'
		);
		expect(resubCall).toBeUndefined();
	});

	it('does not update goals on legacy goal.updated event', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		// Legacy event should have no effect
		hub.fire('goal.updated', { roomId: ROOM_ID, goalId: 'g1', goal: makeGoal('g1-modified') });
		// goals signal unchanged from snapshot
		expect(roomStore.goals.value[0].id).toBe('g1');
	});

	it('sets goalsLoading to true before subscribing and false on first snapshot', () => {
		// After room select, goalsLoading is true because the mock hub did not fire a snapshot.
		expect(roomStore.goalsLoading.value).toBe(true);

		// When the server delivers the snapshot, goalsLoading clears.
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		expect(roomStore.goalsLoading.value).toBe(false);
	});

	it('resets goalsLoading to false on room deselect (even if snapshot never arrived)', async () => {
		// goalsLoading is true (snapshot not yet delivered)
		expect(roomStore.goalsLoading.value).toBe(true);

		await roomStore.select(null);

		expect(roomStore.goalsLoading.value).toBe(false);
	});

	it('sets goalsLoading to true on reconnect and false on subsequent snapshot', () => {
		// Deliver initial snapshot to clear loading
		hub.fire('liveQuery.snapshot', { subscriptionId: GOALS_SUB_ID, rows: [], version: 1 });
		expect(roomStore.goalsLoading.value).toBe(false);

		// Reconnect triggers re-subscribe which sets loading = true
		hub.request.mockClear();
		hub.fireConnection('connected');
		expect(roomStore.goalsLoading.value).toBe(true);

		// New snapshot clears it
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 2,
		});
		expect(roomStore.goalsLoading.value).toBe(false);
	});
});
