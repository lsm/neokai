/**
 * Tests for RoomStore tasks.byRoom LiveQuery subscription (Task 3.3)
 *
 * Verifies that tasks are updated exclusively via liveQuery.snapshot /
 * liveQuery.delta events rather than the legacy room.task.update event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskSummary } from '@neokai/shared';

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

const ROOM_ID = 'room-tasks-test';
const TASKS_SUB_ID = `tasks-byRoom-${ROOM_ID}`;

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

describe('RoomStore — tasks.byRoom LiveQuery subscription', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		setupHubRequests(hub);
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	it('subscribes to tasks.byRoom with a stable subscriptionId on room select', () => {
		const calls = hub.request.mock.calls as [string, unknown][];
		const subscribeCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'tasks.byRoom'
		);
		expect(subscribeCall).toBeDefined();
		expect(subscribeCall![1]).toMatchObject({
			queryName: 'tasks.byRoom',
			params: [ROOM_ID],
			subscriptionId: TASKS_SUB_ID,
		});
	});

	it('does NOT subscribe via legacy room.task.update event listener', () => {
		// Ensure no handler is registered for the old event
		expect(hub._handlers.has('room.task.update')).toBe(false);
	});

	it('populates tasks.value from liveQuery.snapshot', () => {
		const tasks = [makeTask('t1'), makeTask('t2')];
		hub.fire('liveQuery.snapshot', { subscriptionId: TASKS_SUB_ID, rows: tasks, version: 1 });
		expect(roomStore.tasks.value).toEqual(tasks);
	});

	it('ignores liveQuery.snapshot for a different subscriptionId', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: 'other-sub',
			rows: [makeTask('irrelevant')],
			version: 1,
		});
		expect(roomStore.tasks.value).toEqual([]);
	});

	it('appends tasks from liveQuery.delta added', () => {
		const t1 = makeTask('t1');
		hub.fire('liveQuery.snapshot', { subscriptionId: TASKS_SUB_ID, rows: [t1], version: 1 });
		const t2 = makeTask('t2');
		hub.fire('liveQuery.delta', { subscriptionId: TASKS_SUB_ID, added: [t2], version: 2 });
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1', 't2']);
	});

	it('removes tasks from liveQuery.delta removed', () => {
		const t1 = makeTask('t1');
		const t2 = makeTask('t2');
		hub.fire('liveQuery.snapshot', { subscriptionId: TASKS_SUB_ID, rows: [t1, t2], version: 1 });
		hub.fire('liveQuery.delta', { subscriptionId: TASKS_SUB_ID, removed: [t1], version: 2 });
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t2']);
	});

	it('replaces tasks from liveQuery.delta updated', () => {
		const t1 = makeTask('t1');
		hub.fire('liveQuery.snapshot', { subscriptionId: TASKS_SUB_ID, rows: [t1], version: 1 });
		const t1Updated = makeTask('t1', { status: 'in_progress', progress: 50 });
		hub.fire('liveQuery.delta', {
			subscriptionId: TASKS_SUB_ID,
			updated: [t1Updated],
			version: 2,
		});
		expect(roomStore.tasks.value[0].status).toBe('in_progress');
		expect(roomStore.tasks.value[0].progress).toBe(50);
	});

	it('ignores liveQuery.delta for a different subscriptionId', () => {
		const t1 = makeTask('t1');
		hub.fire('liveQuery.snapshot', { subscriptionId: TASKS_SUB_ID, rows: [t1], version: 1 });
		hub.fire('liveQuery.delta', {
			subscriptionId: 'other-sub',
			removed: [t1],
			version: 2,
		});
		// t1 should still be present
		expect(roomStore.tasks.value.map((t) => t.id)).toEqual(['t1']);
	});

	it('unsubscribes from tasks.byRoom on room deselect', async () => {
		hub.request.mockClear();
		await roomStore.select(null);
		const calls = hub.request.mock.calls as [string, unknown][];
		const unsubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.unsubscribe' &&
				(params as { subscriptionId: string }).subscriptionId === TASKS_SUB_ID
		);
		expect(unsubCall).toBeDefined();
	});

	it('re-subscribes to tasks.byRoom on reconnect', () => {
		hub.request.mockClear();
		hub.fireConnection('connected');
		const calls = hub.request.mock.calls as [string, unknown][];
		const resubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'tasks.byRoom'
		);
		expect(resubCall).toBeDefined();
		expect(resubCall![1]).toMatchObject({
			queryName: 'tasks.byRoom',
			params: [ROOM_ID],
			subscriptionId: TASKS_SUB_ID,
		});
	});

	it('does NOT re-subscribe on reconnect after room is deselected', async () => {
		await roomStore.select(null);
		hub.request.mockClear();
		hub.fireConnection('connected');
		const calls = hub.request.mock.calls as [string, unknown][];
		const resubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'tasks.byRoom'
		);
		expect(resubCall).toBeUndefined();
	});

	it('does not update tasks on legacy room.task.update event', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1')],
			version: 1,
		});
		// Legacy event should have no effect
		hub.fire('room.task.update', {
			roomId: ROOM_ID,
			task: makeTask('t1', { status: 'completed' }),
		});
		// tasks signal unchanged from snapshot
		expect(roomStore.tasks.value[0].status).toBe('pending');
	});

	it('resets tasks to [] on room deselect', async () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [makeTask('t1'), makeTask('t2')],
			version: 1,
		});
		expect(roomStore.tasks.value.length).toBe(2);
		await roomStore.select(null);
		expect(roomStore.tasks.value).toEqual([]);
	});

	it('does not optimistically append task after task.create RPC', async () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: TASKS_SUB_ID,
			rows: [],
			version: 1,
		});
		// Make task.create return a task
		hub.request.mockImplementation((method: string) => {
			if (method === 'task.create') {
				return Promise.resolve({ task: makeTask('new-task') });
			}
			if (method === 'room.runtime.models')
				return Promise.resolve({ leaderModel: null, workerModel: null });
			return Promise.resolve({ ok: true });
		});

		await roomStore.createTask('New Task', 'Description');

		// tasks.value should still be empty — LiveQuery delta will populate it
		expect(roomStore.tasks.value).toEqual([]);
	});
});
