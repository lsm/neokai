/**
 * Tests for RoomStore per-query subscription methods
 *
 * Verifies that subscribeRoomTasks, subscribeRoomGoals, subscribeRoomSkills
 * can be called independently, that unsubscribing one query does not affect
 * others, and that the stale-event guard works per-query.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NeoTask, RoomGoal, GoalStatus, AppSkill } from '@neokai/shared';

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

const ROOM_ID = 'room-per-query-test';
const TASKS_SUB_ID = `tasks-byRoom-${ROOM_ID}`;
const GOALS_SUB_ID = `goals-byRoom-${ROOM_ID}`;
const SKILLS_SUB_ID = `skills-byRoom-${ROOM_ID}`;

function makeTask(id: string, overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id,
		roomId: ROOM_ID,
		title: `Task ${id}`,
		description: '',
		status: 'pending',
		priority: 'normal',
		progress: 0,
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as NeoTask;
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

function makeSkill(
	id: string,
	overrides: Partial<AppSkill> = {}
): AppSkill & { overriddenByRoom: boolean } {
	return {
		id,
		name: `Skill ${id}`,
		description: '',
		sourceType: 'builtin',
		enabled: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		overriddenByRoom: false,
		...overrides,
	} as AppSkill & { overriddenByRoom: boolean };
}

function setupHubRequests(hub: MockHub): void {
	hub.request.mockImplementation((method: string) => {
		if (method === 'room.get') return Promise.resolve({ room: { id: ROOM_ID }, sessions: [] });
		if (method === 'room.runtime.state') return Promise.reject(new Error('no runtime'));
		return Promise.resolve({ ok: true });
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomStore — per-query subscribe methods', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		setupHubRequests(hub);
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	it('subscribeRoomGoals only sends goals.byRoom subscribe request', async () => {
		await roomStore.subscribeRoomGoals(ROOM_ID);

		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCalls = calls.filter(([method]) => method === 'liveQuery.subscribe');

		// Should have exactly one liveQuery.subscribe call for goals
		expect(subscribeCalls).toHaveLength(1);
		expect(subscribeCalls[0]![1]).toMatchObject({
			queryName: 'goals.byRoom',
			params: [ROOM_ID],
			subscriptionId: GOALS_SUB_ID,
		});
	});

	it('subscribeRoomTasks only sends tasks.byRoom subscribe request', async () => {
		await roomStore.subscribeRoomTasks(ROOM_ID);

		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCalls = calls.filter(([method]) => method === 'liveQuery.subscribe');

		expect(subscribeCalls).toHaveLength(1);
		expect(subscribeCalls[0]![1]).toMatchObject({
			queryName: 'tasks.byRoom',
			params: [ROOM_ID],
			subscriptionId: TASKS_SUB_ID,
		});
	});

	it('subscribeRoomSkills only sends skills.byRoom subscribe request', async () => {
		await roomStore.subscribeRoomSkills(ROOM_ID);

		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCalls = calls.filter(([method]) => method === 'liveQuery.subscribe');

		expect(subscribeCalls).toHaveLength(1);
		expect(subscribeCalls[0]![1]).toMatchObject({
			queryName: 'skills.byRoom',
			params: [ROOM_ID],
			subscriptionId: SKILLS_SUB_ID,
		});
	});

	it('subscribeRoomGoals sets and clears goalStore.loading', async () => {
		// After subscribing (before snapshot), loading should be true
		await roomStore.subscribeRoomGoals(ROOM_ID);
		expect(roomStore.goalsLoading.value).toBe(true);

		// Snapshot clears loading
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		expect(roomStore.goalsLoading.value).toBe(false);
	});

	it('subscribeRoomGoals processes snapshot and delta events', async () => {
		await roomStore.subscribeRoomGoals(ROOM_ID);

		// Snapshot populates goals
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);

		// Delta adds goals
		hub.fire('liveQuery.delta', {
			subscriptionId: GOALS_SUB_ID,
			added: [makeGoal('g2')],
			version: 2,
		});
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1', 'g2']);
	});

	it('subscribeRoomTasks processes snapshot and delta events', async () => {
		await roomStore.subscribeRoomTasks(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);

		hub.fire('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			added: [makeTask('t2')],
			version: 2,
		});
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
	});

	it('subscribeRoomSkills processes snapshot and delta events', async () => {
		await roomStore.subscribeRoomSkills(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: SKILLS_SUB_ID,
			rows: [makeSkill('s1')],
			version: 1,
		});
		expect(roomStore.roomSkills.value.map((s) => s.id)).toEqual(['s1']);

		hub.fire('liveQuery.delta', {
			subscriptionId: SKILLS_SUB_ID,
			added: [makeSkill('s2')],
			version: 2,
		});
		expect(roomStore.roomSkills.value.map((s) => s.id)).toEqual(['s1', 's2']);
	});

	it('per-query methods guard against double subscription', async () => {
		await roomStore.subscribeRoomGoals(ROOM_ID);
		const callsBefore = hub.request.mock.calls.length;

		// Second call should be a no-op
		await roomStore.subscribeRoomGoals(ROOM_ID);
		expect(hub.request.mock.calls.length).toBe(callsBefore);
	});
});

describe('RoomStore — per-query unsubscribe isolation', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		setupHubRequests(hub);
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	it('unsubscribing goals does not affect tasks subscription', async () => {
		// Subscribe both independently
		await roomStore.subscribeRoomTasks(ROOM_ID);
		await roomStore.subscribeRoomGoals(ROOM_ID);

		// Seed both with data
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});

		// Unsubscribe goals only
		hub.request.mockClear();
		roomStore.unsubscribeRoomGoals(ROOM_ID);

		// Verify unsubscribe was sent for goals
		const calls = hub.request.mock.calls as [string, unknown][];
		const unsubCalls = calls.filter(
			([method, params]) =>
				method === 'liveQuery.unsubscribe' &&
				(params as { subscriptionId: string }).subscriptionId === GOALS_SUB_ID
		);
		expect(unsubCalls).toHaveLength(1);

		// Tasks should still receive delta events
		hub.fire('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			added: [makeTask('t2')],
			version: 2,
		});
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1', 't2']);

		// Goals should NOT receive delta events (stale guard)
		hub.fire('liveQuery.delta', {
			subscriptionId: GOALS_SUB_ID,
			added: [makeGoal('g2')],
			version: 2,
		});
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);
	});

	it('unsubscribing tasks does not affect goals subscription', async () => {
		await roomStore.subscribeRoomTasks(ROOM_ID);
		await roomStore.subscribeRoomGoals(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});

		// Unsubscribe tasks only
		hub.request.mockClear();
		roomStore.unsubscribeRoomTasks(ROOM_ID);

		const calls = hub.request.mock.calls as [string, unknown][];
		const unsubCalls = calls.filter(
			([method, params]) =>
				method === 'liveQuery.unsubscribe' &&
				(params as { subscriptionId: string }).subscriptionId === TASKS_SUB_ID
		);
		expect(unsubCalls).toHaveLength(1);

		// Goals should still work
		hub.fire('liveQuery.delta', {
			subscriptionId: GOALS_SUB_ID,
			added: [makeGoal('g2')],
			version: 2,
		});
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1', 'g2']);

		// Tasks should be guarded
		hub.fire('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			added: [makeTask('t2')],
			version: 2,
		});
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);
	});

	it('unsubscribing skills does not affect tasks or goals', async () => {
		await roomStore.subscribeRoomTasks(ROOM_ID);
		await roomStore.subscribeRoomGoals(ROOM_ID);
		await roomStore.subscribeRoomSkills(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: SKILLS_SUB_ID,
			rows: [makeSkill('s1')],
			version: 1,
		});

		roomStore.unsubscribeRoomSkills(ROOM_ID);

		// Tasks and goals should still work
		hub.fire('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			added: [makeTask('t2')],
			version: 2,
		});
		hub.fire('liveQuery.delta', {
			subscriptionId: GOALS_SUB_ID,
			added: [makeGoal('g2')],
			version: 2,
		});

		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1', 'g2']);
	});

	it('reconnect re-subscribes only the active queries', async () => {
		await roomStore.subscribeRoomTasks(ROOM_ID);
		await roomStore.subscribeRoomGoals(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [],
			version: 1,
		});

		// Unsubscribe goals
		roomStore.unsubscribeRoomGoals(ROOM_ID);

		// Reconnect
		hub.request.mockClear();
		hub.fireConnection('connected');

		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCalls = calls.filter(([method]) => method === 'liveQuery.subscribe');

		// Only tasks should be re-subscribed, not goals
		expect(subscribeCalls).toHaveLength(1);
		expect(subscribeCalls[0]![1]).toMatchObject({
			queryName: 'tasks.byRoom',
			subscriptionId: TASKS_SUB_ID,
		});
	});
});

describe('RoomStore — per-query stale-event guard', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		setupHubRequests(hub);
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	it('discards stale goal events after unsubscribeRoomGoals', async () => {
		await roomStore.subscribeRoomGoals(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});

		// Capture handlers before unsubscribe
		const snapshotHandlers = [...(hub._handlers.get('liveQuery.snapshot') ?? [])];

		roomStore.unsubscribeRoomGoals(ROOM_ID);

		// Fire stale snapshot
		for (const h of snapshotHandlers) {
			(h as (data: unknown) => void)({
				subscriptionId: GOALS_SUB_ID,
				rows: [makeGoal('g1'), makeGoal('g2')],
				version: 2,
			});
		}

		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);
	});

	it('discards stale task events after unsubscribeRoomTasks', async () => {
		await roomStore.subscribeRoomTasks(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});

		const deltaHandlers = [...(hub._handlers.get('liveQuery.delta') ?? [])];

		roomStore.unsubscribeRoomTasks(ROOM_ID);

		for (const h of deltaHandlers) {
			(h as (data: unknown) => void)({
				subscriptionId: TASKS_SUB_ID,
				added: [makeTask('t2')],
				version: 2,
			});
		}

		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);
	});

	it('goals guard re-establishes after re-subscription', async () => {
		await roomStore.subscribeRoomGoals(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});

		roomStore.unsubscribeRoomGoals(ROOM_ID);
		await roomStore.subscribeRoomGoals(ROOM_ID);

		// New snapshot should be accepted
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1'), makeGoal('g2')],
			version: 2,
		});
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1', 'g2']);
	});
});

describe('RoomStore — subscribeRoom/unsubscribeRoom backward compatibility', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		setupHubRequests(hub);
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	it('subscribeRoom subscribes to all three queries', async () => {
		await roomStore.subscribeRoom(ROOM_ID);

		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCalls = calls.filter(([method]) => method === 'liveQuery.subscribe');

		const queryNames = subscribeCalls.map(
			([, params]) => (params as { queryName: string }).queryName
		);
		expect(queryNames).toContain('tasks.byRoom');
		expect(queryNames).toContain('goals.byRoom');
		expect(queryNames).toContain('skills.byRoom');
	});

	it('unsubscribeRoom unsubscribes from all three queries', async () => {
		await roomStore.subscribeRoom(ROOM_ID);

		hub.request.mockClear();
		roomStore.unsubscribeRoom(ROOM_ID);

		const calls = hub.request.mock.calls as [string, unknown][];
		const unsubCalls = calls.filter(([method]) => method === 'liveQuery.unsubscribe');

		const subIds = unsubCalls.map(
			([, params]) => (params as { subscriptionId: string }).subscriptionId
		);
		expect(subIds).toContain(TASKS_SUB_ID);
		expect(subIds).toContain(GOALS_SUB_ID);
		expect(subIds).toContain(SKILLS_SUB_ID);
	});

	it('all three queries receive snapshot events after subscribeRoom', async () => {
		await roomStore.subscribeRoom(ROOM_ID);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: SKILLS_SUB_ID,
			rows: [makeSkill('s1')],
			version: 1,
		});

		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);
		expect(roomStore.goals.value.map((g) => g.id)).toEqual(['g1']);
		expect(roomStore.roomSkills.value.map((s) => s.id)).toEqual(['s1']);
	});

	it('goalStore.loading is set by subscribeRoomGoals and cleared by snapshot', async () => {
		await roomStore.subscribeRoom(ROOM_ID);
		expect(roomStore.goalsLoading.value).toBe(true);

		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [makeGoal('g1')],
			version: 1,
		});
		expect(roomStore.goalsLoading.value).toBe(false);
	});

	it('goalStore.loading is cleared by unsubscribeRoomGoals', async () => {
		await roomStore.subscribeRoomGoals(ROOM_ID);
		expect(roomStore.goalsLoading.value).toBe(true);

		roomStore.unsubscribeRoomGoals(ROOM_ID);
		expect(roomStore.goalsLoading.value).toBe(false);
	});

	it('reconnect re-subscribes all three after subscribeRoom', async () => {
		await roomStore.subscribeRoom(ROOM_ID);

		// Clear initial loading
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: GOALS_SUB_ID,
			rows: [],
			version: 1,
		});
		hub.fire('liveQuery.snapshot', {
			subscriptionId: SKILLS_SUB_ID,
			rows: [],
			version: 1,
		});

		hub.request.mockClear();
		hub.fireConnection('connected');

		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCalls = calls.filter(([method]) => method === 'liveQuery.subscribe');
		const queryNames = subscribeCalls.map(
			([, params]) => (params as { queryName: string }).queryName
		);

		expect(queryNames).toContain('tasks.byRoom');
		expect(queryNames).toContain('goals.byRoom');
		expect(queryNames).toContain('skills.byRoom');
	});
});
