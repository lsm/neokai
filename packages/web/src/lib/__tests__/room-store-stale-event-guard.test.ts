/**
 * Tests for RoomStore stale-event guard (Task 3.6)
 *
 * Verifies that snapshot and delta events are discarded after unsubscribeRoom
 * is called, even if the event was already queued in the JS event loop (i.e.,
 * the handler function was captured before cleanup ran).
 *
 * This guards against rapid room switching where:
 * 1. Events arrive for subscription A while the JS engine is in the middle of
 *    switching to subscription B.
 * 2. In-flight events from a prior connection arrive after re-subscription.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskSummary, RoomGoal, GoalStatus } from '@neokai/shared';

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

const ROOM_ID = 'room-stale-guard';
const TASKS_SUB_ID = `tasks-byRoom-${ROOM_ID}`;
const GOALS_SUB_ID = `goals-byRoom-${ROOM_ID}`;

function makeTask(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
	return {
		id,
		roomId: ROOM_ID,
		title: `Task ${id}`,
		description: '',
		status: 'pending',
		priority: 'normal',
		progress: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as TaskSummary;
}

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
		return Promise.resolve({ ok: true });
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomStore — stale-event guard (Task 3.6)', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		setupHubRequests(hub);
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		await roomStore.select(ROOM_ID);
		await roomStore.subscribeRoom(ROOM_ID);
	});

	afterEach(async () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	it('discards a stale task snapshot after unsubscribeRoom (simulated in-flight event)', () => {
		// Populate state via initial snapshot
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);

		// Capture the live snapshot handlers BEFORE unsubscribeRoom removes them.
		// This simulates an event already queued in the JS event loop that fires
		// after the guard is cleared but before handler teardown completes.
		const snapshotHandlers = [...(hub._handlers.get('liveQuery.snapshot') ?? [])];

		// Perform room switch teardown — clears the stale-event guard immediately.
		roomStore.unsubscribeRoom(ROOM_ID);

		// Manually invoke the captured (now-stale) handler as if it were a queued event.
		const staleRows = [makeTask('t1'), makeTask('t2')];
		for (const h of snapshotHandlers) {
			(h as (data: unknown) => void)({
				subscriptionId: TASKS_SUB_ID,
				rows: staleRows,
				version: 2,
			});
		}

		// Stale snapshot must NOT have updated tasks.value.
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);
	});

	it('discards a stale task delta after unsubscribeRoom (simulated in-flight event)', () => {
		// Populate state
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});

		// Capture delta handlers before teardown
		const deltaHandlers = [...(hub._handlers.get('liveQuery.delta') ?? [])];

		roomStore.unsubscribeRoom(ROOM_ID);

		// Fire a stale delta that would have added t2
		for (const h of deltaHandlers) {
			(h as (data: unknown) => void)({
				subscriptionId: TASKS_SUB_ID,
				added: [makeTask('t2')],
				version: 2,
			});
		}

		// Stale delta must NOT have modified tasks.value.
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);
	});

	it('discards a stale goal snapshot after unsubscribeRoom (simulated in-flight event)', () => {
		// Populate state
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);

		const snapshotHandlers = [...(hub._handlers.get('liveQuery.snapshot') ?? [])];

		roomStore.unsubscribeRoom(ROOM_ID);

		// Fire stale goal snapshot
		for (const h of snapshotHandlers) {
			(h as (data: unknown) => void)({
				subscriptionId: GOALS_SUB_ID,
				rows: [makeGoal('g1'), makeGoal('g2')],
				version: 2,
			});
		}

		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);
	});

	it('discards a stale goal delta after unsubscribeRoom (simulated in-flight event)', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});

		const deltaHandlers = [...(hub._handlers.get('liveQuery.delta') ?? [])];

		roomStore.unsubscribeRoom(ROOM_ID);

		for (const h of deltaHandlers) {
			(h as (data: unknown) => void)({
				subscriptionId: GOALS_SUB_ID,
				added: [makeGoal('g2')],
				version: 2,
			});
		}

		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);
	});

	it('processes events normally while subscription is active', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		hub.fire('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			added: [makeTask('t2')],
			version: 2,
		});
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
	});

	it('re-establishes guard after subscribeRoom is called again for the same room', async () => {
		// Initial snapshot
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});

		// Unsubscribe and re-subscribe (simulates component remount)
		roomStore.unsubscribeRoom(ROOM_ID);
		await roomStore.subscribeRoom(ROOM_ID);

		// New snapshot should be accepted
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1'), makeTask('t2')],
			version: 2,
		});
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
	});
});
