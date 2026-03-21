/**
 * Tests for RoomStore session lifecycle event handlers
 *
 * Verifies that session.deleted and session.updated events are correctly
 * handled so the RoomContextPanel reflects live session state.
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

function makeSessions(): SessionSummary[] {
	return [
		{ id: 'session-1', title: 'Session One', status: 'active', lastActiveAt: 1000 },
		{ id: 'session-2', title: 'Session Two', status: 'active', lastActiveAt: 2000 },
	];
}

function makeOverview(): RoomOverview {
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
		sessions: makeSessions(),
		activeTasks: [],
		allTasks: [],
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomStore — session lifecycle events', () => {
	let hub: MockHub;

	beforeEach(async () => {
		hub = createMockHub();

		// Make getHub() resolve to our mock
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);

		// Default request mock: room.get returns overview, everything else resolves empty
		hub.request.mockImplementation((method: string) => {
			if (method === 'room.get') return Promise.resolve(makeOverview());
			if (method === 'goal.list') return Promise.resolve({ goals: [] });
			if (method === 'room.runtime.state') return Promise.resolve({ state: 'stopped' });
			if (method === 'room.runtime.models')
				return Promise.resolve({ leaderModel: null, workerModel: null });
			return Promise.resolve({});
		});

		// Select the room to start subscriptions
		await roomStore.select(ROOM_ID);
	});

	afterEach(async () => {
		// Reset to null room to clear subscriptions
		await roomStore.select(null);
		vi.clearAllMocks();
	});

	// -----------------------------------------------------------------------
	// session.deleted
	// -----------------------------------------------------------------------

	describe('session.deleted event', () => {
		it('removes the deleted session from sessions signal when roomId matches', () => {
			expect(roomStore.sessions.value).toHaveLength(2);

			hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });

			expect(roomStore.sessions.value).toHaveLength(1);
			expect(roomStore.sessions.value[0].id).toBe('session-2');
		});

		it('removes the correct session leaving others intact', () => {
			hub.fire('session.deleted', { sessionId: 'session-2', roomId: ROOM_ID });

			expect(roomStore.sessions.value).toHaveLength(1);
			expect(roomStore.sessions.value[0].id).toBe('session-1');
		});

		it('ignores deletion events for a different room', () => {
			hub.fire('session.deleted', { sessionId: 'session-1', roomId: OTHER_ROOM_ID });

			expect(roomStore.sessions.value).toHaveLength(2);
		});

		it('is a no-op when sessionId is not in the current room', () => {
			hub.fire('session.deleted', { sessionId: 'session-unknown', roomId: ROOM_ID });

			expect(roomStore.sessions.value).toHaveLength(2);
		});

		it('handles multiple sequential deletions', () => {
			hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });
			hub.fire('session.deleted', { sessionId: 'session-2', roomId: ROOM_ID });

			expect(roomStore.sessions.value).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// session.updated
	// -----------------------------------------------------------------------

	describe('session.updated event', () => {
		it('updates the title of a session when roomId matches', () => {
			hub.fire('session.updated', {
				sessionId: 'session-1',
				roomId: ROOM_ID,
				title: 'Renamed Session',
			});

			const updated = roomStore.sessions.value.find((s) => s.id === 'session-1');
			expect(updated?.title).toBe('Renamed Session');
		});

		it('updates the status of a session (e.g., archiving)', () => {
			hub.fire('session.updated', {
				sessionId: 'session-1',
				roomId: ROOM_ID,
				status: 'archived',
			});

			const updated = roomStore.sessions.value.find((s) => s.id === 'session-1');
			expect(updated?.status).toBe('archived');
		});

		it('preserves unchanged fields when doing a partial update', () => {
			hub.fire('session.updated', {
				sessionId: 'session-1',
				roomId: ROOM_ID,
				title: 'New Title',
			});

			const updated = roomStore.sessions.value.find((s) => s.id === 'session-1');
			expect(updated?.status).toBe('active'); // unchanged
			expect(updated?.lastActiveAt).toBe(1000); // unchanged
		});

		it('ignores update events for a different room', () => {
			hub.fire('session.updated', {
				sessionId: 'session-1',
				roomId: OTHER_ROOM_ID,
				title: 'Should not apply',
			});

			const session = roomStore.sessions.value.find((s) => s.id === 'session-1');
			expect(session?.title).toBe('Session One'); // unchanged
		});

		it('is a no-op when sessionId is not in the current room', () => {
			hub.fire('session.updated', {
				sessionId: 'session-unknown',
				roomId: ROOM_ID,
				title: 'Ghost Update',
			});

			expect(roomStore.sessions.value).toHaveLength(2);
		});

		it('updates lastActiveAt when provided', () => {
			hub.fire('session.updated', {
				sessionId: 'session-2',
				roomId: ROOM_ID,
				lastActiveAt: 9999,
			});

			const updated = roomStore.sessions.value.find((s) => s.id === 'session-2');
			expect(updated?.lastActiveAt).toBe(9999);
		});
	});

	// -----------------------------------------------------------------------
	// Subscription cleanup
	// -----------------------------------------------------------------------

	describe('subscription cleanup on room switch', () => {
		it('stops responding to events after room is deselected', async () => {
			// Deselect room
			await roomStore.select(null);

			// Reset sessions to empty (as doSelect clears them)
			// Now fire an event — it should not crash or update anything
			expect(() => {
				hub.fire('session.deleted', { sessionId: 'session-1', roomId: ROOM_ID });
			}).not.toThrow();

			expect(roomStore.sessions.value).toHaveLength(0);
		});
	});
});
