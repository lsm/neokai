/**
 * Tests for RoomStore session lifecycle event handlers
 *
 * Verifies that:
 * - session.deleted triggers a room.get re-fetch
 * - session.updated does NOT trigger a re-fetch (avoids ~250 ms draft-save storm)
 * - After deletion, if the user is viewing the deleted session they are navigated
 *   back to the room dashboard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionSummary, RoomOverview } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that touch the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../connection-manager', () => ({
	connectionManager: {
		getHub: vi.fn(),
		getHubIfConnected: vi.fn(),
	},
}));

vi.mock('../toast', () => ({ toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

vi.mock('../router', () => ({ navigateToRoom: vi.fn() }));

// Use a plain mutable object so tests can set .value directly.
// room-store.ts only reads currentRoomSessionIdSignal.value, so a plain
// object with a writable value property is sufficient.
const mockSignals = vi.hoisted(() => ({
	currentRoomSessionIdSignal: { value: null as string | null },
	currentRoomIdSignal: { value: null as string | null },
	currentRoomTaskIdSignal: { value: null as string | null },
	currentSessionIdSignal: { value: null as string | null },
	currentSpaceIdSignal: { value: null as string | null },
	currentSpaceSessionIdSignal: { value: null as string | null },
	currentSpaceTaskIdSignal: { value: null as string | null },
	navSectionSignal: { value: 'lobby' as string },
}));

vi.mock('../signals', () => mockSignals);

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { connectionManager } from '../connection-manager';
import { navigateToRoom } from '../router';
import { roomStore } from '../room-store';

// ---------------------------------------------------------------------------
// Mock hub factory
// ---------------------------------------------------------------------------

type EventHandler<T = unknown> = (data: T) => void;

interface MockHub {
	_handlers: Map<string, EventHandler[]>;
	onEvent: <T>(method: string, handler: EventHandler<T>) => () => void;
	request: ReturnType<typeof vi.fn>;
	joinChannel: ReturnType<typeof vi.fn>;
	leaveChannel: ReturnType<typeof vi.fn>;
	fire: <T>(method: string, data: T) => void;
}

function createMockHub(): MockHub {
	const _handlers = new Map<string, EventHandler[]>();
	return {
		_handlers,
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
		request: vi.fn(),
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		fire: <T>(method: string, data: T) => {
			for (const h of _handlers.get(method) ?? []) h(data);
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID = 'room-abc';
const OTHER_ROOM_ID = 'room-xyz';

function twoSessionOverview(): RoomOverview {
	return {
		room: {
			id: ROOM_ID,
			name: 'Test Room',
			allowedPaths: [],
			defaultPath: '/tmp',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			background: null,
			instructions: null,
			config: {},
		} as unknown as RoomOverview['room'],
		sessions: [
			{ id: 'session-1', title: 'Session One', status: 'active', lastActiveAt: 1000 },
			{ id: 'session-2', title: 'Session Two', status: 'active', lastActiveAt: 2000 },
		] as SessionSummary[],
		activeTasks: [],
		allTasks: [],
	};
}

function oneSessionOverview(): RoomOverview {
	const o = twoSessionOverview();
	o.sessions = [{ id: 'session-2', title: 'Session Two', status: 'active', lastActiveAt: 2000 }];
	return o;
}

/** Count calls to hub.request for a specific RPC method */
function countRequests(hub: MockHub, method: string): number {
	return (hub.request.mock.calls as [string, ...unknown[]][]).filter(([m]) => m === method).length;
}

function mockHubRequests(hub: MockHub, overview: RoomOverview = twoSessionOverview()): void {
	hub.request.mockImplementation((method: string) => {
		if (method === 'room.get') return Promise.resolve(overview);
		if (method === 'goal.list') return Promise.resolve({ goals: [] });
		if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
		if (method === 'room.runtime.models')
			return Promise.resolve({ leaderModel: null, workerModel: null });
		return Promise.resolve({});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomStore — session lifecycle events', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);
		mockHubRequests(hub);
		mockSignals.currentRoomSessionIdSignal.value = null;
		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	// -----------------------------------------------------------------------
	// session.deleted — triggers room.get re-fetch
	// -----------------------------------------------------------------------

	describe('session.deleted event', () => {
		it('triggers a room.get re-fetch when roomId matches', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });

			await vi.waitFor(() => {
				expect(countRequests(hub, 'room.get')).toBeGreaterThan(before);
			});
		});

		it('updates sessions signal from server response after deletion', async () => {
			// Subsequent room.get returns only session-2
			hub.request.mockImplementation((method: string) => {
				if (method === 'room.get') return Promise.resolve(oneSessionOverview());
				if (method === 'goal.list') return Promise.resolve({ goals: [] });
				if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
				if (method === 'room.runtime.models')
					return Promise.resolve({ leaderModel: null, workerModel: null });
				return Promise.resolve({});
			});

			hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });

			await vi.waitFor(() => {
				expect(roomStore.sessions.value).toHaveLength(1);
				expect(roomStore.sessions.value[0].id).toBe('session-2');
			});
		});

		it('does NOT trigger a re-fetch for a different room', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.deleted', { sessionId: 'session-1', roomId: OTHER_ROOM_ID });

			await new Promise((r) => setTimeout(r, 20));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});

		it('does NOT trigger a re-fetch when roomId is absent', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.deleted', { sessionId: 'session-1' });

			await new Promise((r) => setTimeout(r, 20));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});

		it('navigates to room dashboard when the viewed session is deleted', async () => {
			// User is currently viewing session-1
			mockSignals.currentRoomSessionIdSignal.value = 'session-1';

			// Server no longer returns session-1 after deletion
			hub.request.mockImplementation((method: string) => {
				if (method === 'room.get') return Promise.resolve(oneSessionOverview());
				if (method === 'goal.list') return Promise.resolve({ goals: [] });
				if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
				if (method === 'room.runtime.models')
					return Promise.resolve({ leaderModel: null, workerModel: null });
				return Promise.resolve({});
			});

			hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });

			await vi.waitFor(() => {
				expect(navigateToRoom).toHaveBeenCalledWith(ROOM_ID);
			});
		});

		it('does NOT navigate when the deleted session is not the active one', async () => {
			// User is viewing session-2, session-1 is deleted
			mockSignals.currentRoomSessionIdSignal.value = 'session-2';

			hub.request.mockImplementation((method: string) => {
				if (method === 'room.get') return Promise.resolve(oneSessionOverview());
				if (method === 'goal.list') return Promise.resolve({ goals: [] });
				if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
				if (method === 'room.runtime.models')
					return Promise.resolve({ leaderModel: null, workerModel: null });
				return Promise.resolve({});
			});

			hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });

			await vi.waitFor(() => {
				expect(countRequests(hub, 'room.get')).toBeGreaterThan(0);
			});

			// Extra tick to ensure navigation would have fired if it was going to
			await new Promise((r) => setTimeout(r, 10));
			expect(navigateToRoom).not.toHaveBeenCalled();
		});

		it('does NOT navigate when no session is active (viewing room overview)', async () => {
			mockSignals.currentRoomSessionIdSignal.value = null;

			hub.request.mockImplementation((method: string) => {
				if (method === 'room.get') return Promise.resolve(oneSessionOverview());
				if (method === 'goal.list') return Promise.resolve({ goals: [] });
				if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
				if (method === 'room.runtime.models')
					return Promise.resolve({ leaderModel: null, workerModel: null });
				return Promise.resolve({});
			});

			hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });

			await vi.waitFor(() => {
				expect(countRequests(hub, 'room.get')).toBeGreaterThan(0);
			});
			await new Promise((r) => setTimeout(r, 10));
			expect(navigateToRoom).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// session.updated — triggers refresh only when status field is present
	// -----------------------------------------------------------------------

	describe('session.updated event', () => {
		it('triggers a room.get re-fetch when event carries a status field', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.updated', { sessionId: 'session-1', roomId: ROOM_ID, status: 'archived' });

			await vi.waitFor(() => {
				expect(countRequests(hub, 'room.get')).toBeGreaterThan(before);
			});
		});

		it('updates sessions signal from server response after status change', async () => {
			hub.request.mockImplementation((method: string) => {
				if (method === 'room.get')
					return Promise.resolve({
						...twoSessionOverview(),
						sessions: [
							{
								id: 'session-1',
								title: 'Session One',
								status: 'archived',
								lastActiveAt: 1000,
							},
							{ id: 'session-2', title: 'Session Two', status: 'active', lastActiveAt: 2000 },
						],
					});
				if (method === 'goal.list') return Promise.resolve({ goals: [] });
				if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
				if (method === 'room.runtime.models')
					return Promise.resolve({ leaderModel: null, workerModel: null });
				return Promise.resolve({});
			});

			hub.fire('session.updated', { sessionId: 'session-1', roomId: ROOM_ID, status: 'archived' });

			await vi.waitFor(() => {
				const s1 = roomStore.sessions.value.find((s) => s.id === 'session-1');
				expect(s1?.status).toBe('archived');
			});
		});

		it('does NOT trigger a re-fetch when event has no status field (draft save)', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.updated', {
				sessionId: 'session-1',
				roomId: ROOM_ID,
				title: 'New Title',
			});

			await new Promise((r) => setTimeout(r, 30));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});

		it('does NOT trigger a re-fetch for rapid consecutive draft saves', async () => {
			const before = countRequests(hub, 'room.get');

			// Simulate typing — 5 rapid draft saves without status field
			for (let i = 0; i < 5; i++) {
				hub.fire('session.updated', {
					sessionId: 'session-1',
					roomId: ROOM_ID,
					metadata: { inputDraft: `draft ${i}` },
				});
			}

			await new Promise((r) => setTimeout(r, 30));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});

		it('does NOT trigger a re-fetch for a different room', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.updated', {
				sessionId: 'session-1',
				roomId: OTHER_ROOM_ID,
				status: 'archived',
			});

			await new Promise((r) => setTimeout(r, 30));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});
	});

	// -----------------------------------------------------------------------
	// Subscription cleanup on room switch
	// -----------------------------------------------------------------------

	describe('subscription cleanup on room switch', () => {
		it('stops triggering re-fetches after room is deselected', async () => {
			await roomStore.select(null);

			const before = countRequests(hub, 'room.get');

			expect(() => {
				hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });
			}).not.toThrow();

			await new Promise((r) => setTimeout(r, 20));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});
	});
});
