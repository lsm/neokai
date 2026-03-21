/**
 * Tests for RoomStore session lifecycle event handlers
 *
 * Verifies that session.deleted and session.updated events trigger a room.get
 * re-fetch so the RoomContextPanel always reflects the server's authoritative
 * session list. This approach self-heals missed events during WebSocket gaps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionSummary, RoomOverview } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mock connectionManager before importing room-store (module-level side-effect)
// ---------------------------------------------------------------------------

type EventHandler<T = unknown> = (data: T) => void;

interface MockHub {
	_handlers: Map<string, EventHandler[]>;
	onEvent: <T>(method: string, handler: EventHandler<T>) => () => void;
	request: ReturnType<typeof vi.fn>;
	joinChannel: ReturnType<typeof vi.fn>;
	leaveChannel: ReturnType<typeof vi.fn>;
	/** Fire a registered event handler by name */
	fire: <T>(method: string, data: T) => void;
}

function createMockHub(): MockHub {
	const _handlers = new Map<string, EventHandler[]>();

	const hub: MockHub = {
		_handlers,
		onEvent: <T>(method: string, handler: EventHandler<T>) => {
			if (!_handlers.has(method)) _handlers.set(method, []);
			_handlers.get(method)!.push(handler as EventHandler);
			return () => {
				const list = _handlers.get(method);
				if (list) {
					const idx = list.indexOf(handler as EventHandler);
					if (idx >= 0) list.splice(idx, 1);
				}
			};
		},
		request: vi.fn(),
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		fire: <T>(method: string, data: T) => {
			const list = _handlers.get(method) ?? [];
			for (const h of list) h(data);
		},
	};
	return hub;
}

vi.mock('../connection-manager', () => {
	return {
		connectionManager: {
			getHub: vi.fn(),
			getHubIfConnected: vi.fn(),
		},
	};
});

vi.mock('../toast', () => ({ toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

// Import after mocks are set up
import { connectionManager } from '../connection-manager';
import { roomStore } from '../room-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID = 'room-abc';
const OTHER_ROOM_ID = 'room-xyz';

function makeSessions(overrides: Partial<SessionSummary>[] = []): SessionSummary[] {
	const base: SessionSummary[] = [
		{ id: 'session-1', title: 'Session One', status: 'active', lastActiveAt: 1000 },
		{ id: 'session-2', title: 'Session Two', status: 'active', lastActiveAt: 2000 },
	];
	return overrides.length > 0 ? base.map((s, i) => ({ ...s, ...(overrides[i] ?? {}) })) : base;
}

function makeOverview(sessions?: SessionSummary[]): RoomOverview {
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
		sessions: sessions ?? makeSessions(),
		activeTasks: [],
		allTasks: [],
	};
}

/** Count how many times hub.request was called with the given method */
function countRequests(hub: MockHub, method: string): number {
	return (hub.request.mock.calls as [string, ...unknown[]][]).filter(([m]) => m === method).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomStore — session lifecycle events (re-fetch approach)', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();

		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);

		hub.request.mockImplementation((method: string) => {
			if (method === 'room.get') return Promise.resolve(makeOverview());
			if (method === 'goal.list') return Promise.resolve({ goals: [] });
			if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
			if (method === 'room.runtime.models')
				return Promise.resolve({ leaderModel: null, workerModel: null });
			return Promise.resolve({});
		});

		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	// -----------------------------------------------------------------------
	// session.deleted
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
			// Server returns only session-2 after session-1 is deleted
			hub.request.mockImplementation((method: string) => {
				if (method === 'room.get')
					return Promise.resolve(
						makeOverview([
							{ id: 'session-2', title: 'Session Two', status: 'active', lastActiveAt: 2000 },
						])
					);
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

			// Give any potential async re-fetch a chance to run
			await new Promise((r) => setTimeout(r, 20));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});

		it('does NOT trigger a re-fetch when roomId is absent', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.deleted', { sessionId: 'session-1' });

			await new Promise((r) => setTimeout(r, 20));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});
	});

	// -----------------------------------------------------------------------
	// session.updated
	// -----------------------------------------------------------------------

	describe('session.updated event', () => {
		it('triggers a room.get re-fetch when roomId matches', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.updated', { sessionId: 'session-1', roomId: ROOM_ID, status: 'archived' });

			await vi.waitFor(() => {
				expect(countRequests(hub, 'room.get')).toBeGreaterThan(before);
			});
		});

		it('updates sessions signal from server response after update', async () => {
			// Server returns session-1 with archived status
			hub.request.mockImplementation((method: string) => {
				if (method === 'room.get')
					return Promise.resolve(
						makeOverview([
							{ id: 'session-1', title: 'Session One', status: 'archived', lastActiveAt: 1000 },
							{ id: 'session-2', title: 'Session Two', status: 'active', lastActiveAt: 2000 },
						])
					);
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

		it('does NOT trigger a re-fetch for a different room', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.updated', { sessionId: 'session-1', roomId: OTHER_ROOM_ID, title: 'X' });

			await new Promise((r) => setTimeout(r, 20));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});

		it('does NOT trigger a re-fetch when roomId is absent', async () => {
			const before = countRequests(hub, 'room.get');

			hub.fire('session.updated', { sessionId: 'session-1', title: 'X' });

			await new Promise((r) => setTimeout(r, 20));

			expect(countRequests(hub, 'room.get')).toBe(before);
		});
	});

	// -----------------------------------------------------------------------
	// Subscription cleanup
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
