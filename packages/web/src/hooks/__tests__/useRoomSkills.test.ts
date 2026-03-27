/**
 * Tests for useRoomSkills hook and the skills.byRoom LiveQuery subscription
 * wired into RoomStore.
 *
 * Tests are structured in two groups:
 * 1. RoomStore skills.byRoom LiveQuery subscription — verifies signal population,
 *    delta handling, stale-event guard, reconnect, and unsubscribe.
 * 2. useRoomSkills hook — verifies skill signal exposure and RPC calls for
 *    setOverride / clearOverride.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSkill } from '@neokai/shared';
import type { EffectiveRoomSkill } from '../../lib/room-store';

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

vi.mock('../../lib/connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(),
		getHubIfConnected: vi.fn(),
	},
}));
vi.mock('../../lib/toast', () => ({ toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../lib/router', () => ({ navigateToRoom: vi.fn() }));
vi.mock('../../lib/signals', () => ({
	currentRoomSessionIdSignal: { value: null },
	currentRoomIdSignal: { value: null },
	currentRoomTaskIdSignal: { value: null },
	currentSessionIdSignal: { value: null },
	currentSpaceIdSignal: { value: null },
	currentSpaceSessionIdSignal: { value: null },
	currentSpaceTaskIdSignal: { value: null },
	navSectionSignal: { value: 'lobby' },
}));

import { connectionManager } from '../../lib/connection-manager.js';
import { roomStore } from '../../lib/room-store.js';
import { useRoomSkills } from '../useRoomSkills.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID = 'room-skills-test';
const SKILLS_SUB_ID = `skills-byRoom-${ROOM_ID}`;

function makeSkill(id: string, overrides: Partial<EffectiveRoomSkill> = {}): EffectiveRoomSkill {
	return {
		id,
		name: `skill-${id}`,
		displayName: `Skill ${id}`,
		description: '',
		sourceType: 'builtin' as AppSkill['sourceType'],
		config: { type: 'builtin', commandName: `skill-${id}` },
		enabled: true,
		builtIn: false,
		validationStatus: 'valid' as AppSkill['validationStatus'],
		createdAt: Date.now(),
		overriddenByRoom: false,
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
// Group 1: RoomStore skills.byRoom LiveQuery subscription
// ---------------------------------------------------------------------------

describe('RoomStore — skills.byRoom LiveQuery subscription', () => {
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

	it('subscribes to skills.byRoom with a stable subscriptionId', () => {
		const calls = hub.request.mock.calls as [string, unknown][];
		const subCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'skills.byRoom'
		);
		expect(subCall).toBeDefined();
		expect(subCall![1]).toMatchObject({
			queryName: 'skills.byRoom',
			params: [ROOM_ID],
			subscriptionId: SKILLS_SUB_ID,
		});
	});

	it('populates roomSkills.value from liveQuery.snapshot', () => {
		const skills = [makeSkill('s1'), makeSkill('s2')];
		hub.fire('liveQuery.snapshot', { subscriptionId: SKILLS_SUB_ID, rows: skills, version: 1 });
		expect(roomStore.roomSkills.value).toEqual(skills);
	});

	it('ignores liveQuery.snapshot for a different subscriptionId', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: 'other-sub',
			rows: [makeSkill('irrelevant')],
			version: 1,
		});
		expect(roomStore.roomSkills.value).toEqual([]);
	});

	it('appends skills from liveQuery.delta added', () => {
		const s1 = makeSkill('s1');
		hub.fire('liveQuery.snapshot', { subscriptionId: SKILLS_SUB_ID, rows: [s1], version: 1 });
		const s2 = makeSkill('s2');
		hub.fire('liveQuery.delta', { subscriptionId: SKILLS_SUB_ID, added: [s2], version: 2 });
		expect(roomStore.roomSkills.value.map((s) => s.id)).toEqual(['s1', 's2']);
	});

	it('removes skills from liveQuery.delta removed', () => {
		const s1 = makeSkill('s1');
		const s2 = makeSkill('s2');
		hub.fire('liveQuery.snapshot', { subscriptionId: SKILLS_SUB_ID, rows: [s1, s2], version: 1 });
		hub.fire('liveQuery.delta', { subscriptionId: SKILLS_SUB_ID, removed: [s1], version: 2 });
		expect(roomStore.roomSkills.value.map((s) => s.id)).toEqual(['s2']);
	});

	it('updates skills from liveQuery.delta updated', () => {
		const s1 = makeSkill('s1');
		hub.fire('liveQuery.snapshot', { subscriptionId: SKILLS_SUB_ID, rows: [s1], version: 1 });
		const s1Updated = makeSkill('s1', { enabled: false, overriddenByRoom: true });
		hub.fire('liveQuery.delta', {
			subscriptionId: SKILLS_SUB_ID,
			updated: [s1Updated],
			version: 2,
		});
		expect(roomStore.roomSkills.value[0].enabled).toBe(false);
		expect(roomStore.roomSkills.value[0].overriddenByRoom).toBe(true);
	});

	it('ignores liveQuery.delta for a different subscriptionId', () => {
		const s1 = makeSkill('s1');
		hub.fire('liveQuery.snapshot', { subscriptionId: SKILLS_SUB_ID, rows: [s1], version: 1 });
		hub.fire('liveQuery.delta', {
			subscriptionId: 'other-sub',
			removed: [s1],
			version: 2,
		});
		expect(roomStore.roomSkills.value.map((s) => s.id)).toEqual(['s1']);
	});

	it('discards stale events after unsubscribeRoom (stale-event guard)', () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: SKILLS_SUB_ID,
			rows: [makeSkill('s1')],
			version: 1,
		});
		expect(roomStore.roomSkills.value).toHaveLength(1);

		// Simulate unsubscribe — activeSubscriptionIds is cleared immediately
		roomStore.unsubscribeRoom(ROOM_ID);

		// Events fired after unsubscribe must be discarded
		hub.fire('liveQuery.delta', {
			subscriptionId: SKILLS_SUB_ID,
			removed: [makeSkill('s1')],
			version: 2,
		});
		// The list should still contain s1 because the event was stale
		expect(roomStore.roomSkills.value).toHaveLength(1);
	});

	it('unsubscribes from skills.byRoom when unsubscribeRoom is called', () => {
		hub.request.mockClear();
		roomStore.unsubscribeRoom(ROOM_ID);
		const calls = hub.request.mock.calls as [string, unknown][];
		const unsubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.unsubscribe' &&
				(params as { subscriptionId: string }).subscriptionId === SKILLS_SUB_ID
		);
		expect(unsubCall).toBeDefined();
	});

	it('re-subscribes to skills.byRoom on reconnect', () => {
		hub.request.mockClear();
		hub.fireConnection('connected');
		const calls = hub.request.mock.calls as [string, unknown][];
		const resubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'skills.byRoom'
		);
		expect(resubCall).toBeDefined();
		expect(resubCall![1]).toMatchObject({
			queryName: 'skills.byRoom',
			params: [ROOM_ID],
			subscriptionId: SKILLS_SUB_ID,
		});
	});

	it('does NOT re-subscribe on reconnect after unsubscribeRoom', () => {
		roomStore.unsubscribeRoom(ROOM_ID);
		hub.request.mockClear();
		hub.fireConnection('connected');
		const calls = hub.request.mock.calls as [string, unknown][];
		const resubCall = calls.find(
			([method, params]) =>
				method === 'liveQuery.subscribe' &&
				(params as { queryName: string }).queryName === 'skills.byRoom'
		);
		expect(resubCall).toBeUndefined();
	});

	it('clears roomSkills on room deselect', async () => {
		hub.fire('liveQuery.snapshot', {
			subscriptionId: SKILLS_SUB_ID,
			rows: [makeSkill('s1')],
			version: 1,
		});
		expect(roomStore.roomSkills.value).toHaveLength(1);
		await roomStore.select(null);
		expect(roomStore.roomSkills.value).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Group 2: useRoomSkills hook
// ---------------------------------------------------------------------------

describe('useRoomSkills hook', () => {
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

	it('returns skills from roomStore.roomSkills signal', () => {
		const s1 = makeSkill('s1');
		hub.fire('liveQuery.snapshot', { subscriptionId: SKILLS_SUB_ID, rows: [s1], version: 1 });

		// Call hook directly (outside Preact rendering context — signal.value is synchronous)
		const { skills } = useRoomSkills(ROOM_ID);
		expect(skills).toEqual([s1]);
	});

	it('reflects delta updates in subsequent hook calls', () => {
		const s1 = makeSkill('s1');
		hub.fire('liveQuery.snapshot', { subscriptionId: SKILLS_SUB_ID, rows: [s1], version: 1 });

		const s2 = makeSkill('s2');
		hub.fire('liveQuery.delta', { subscriptionId: SKILLS_SUB_ID, added: [s2], version: 2 });

		const { skills } = useRoomSkills(ROOM_ID);
		expect(skills.map((s) => s.id)).toEqual(['s1', 's2']);
	});

	it('setOverride calls room.setSkillOverride RPC with correct params', async () => {
		const { setOverride } = useRoomSkills(ROOM_ID);
		await setOverride('skill-abc', false);
		expect(hub.request).toHaveBeenCalledWith('room.setSkillOverride', {
			roomId: ROOM_ID,
			skillId: 'skill-abc',
			enabled: false,
		});
	});

	it('clearOverride calls room.clearSkillOverride RPC with correct params', async () => {
		const { clearOverride } = useRoomSkills(ROOM_ID);
		await clearOverride('skill-abc');
		expect(hub.request).toHaveBeenCalledWith('room.clearSkillOverride', {
			roomId: ROOM_ID,
			skillId: 'skill-abc',
		});
	});
});
