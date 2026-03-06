// @ts-nocheck
/**
 * Tests for RoomStore.createSession — verifies that new sessions created from the
 * Room UI do NOT pass a hardcoded title so that the daemon can auto-generate one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// -------------------------------------------------------
// Mocks — must be at top level for vi.mock hoisting
// -------------------------------------------------------

let mockHub: ReturnType<typeof makeMockHub>;

function makeMockHub() {
	return {
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		onEvent: vi.fn(() => () => {}),
		request: vi.fn(async (method: string) => {
			if (method === 'room.get') {
				return {
					room: { id: 'room-1', defaultPath: '/workspace', allowedPaths: [] },
					sessions: [],
					allTasks: [],
				};
			}
			if (method === 'goal.list') return { goals: [] };
			if (method === 'room.runtime.state') throw new Error('no runtime');
			if (method === 'session.create') return { sessionId: 'new-session-id', session: {} };
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
// Tests
// -------------------------------------------------------

describe('RoomStore.createSession', () => {
	let roomStore: typeof import('../room-store').roomStore;

	beforeEach(async () => {
		mockHub = makeMockHub();

		const mod = await import('../room-store.ts');
		roomStore = mod.roomStore;

		// Ensure fresh state: deselect before selecting
		if (roomStore.roomId.value !== null) {
			await roomStore.select(null);
		}
		await roomStore.select('room-1');
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('sends title: undefined when called without arguments (enables auto-title generation)', async () => {
		const sessionId = await roomStore.createSession();

		expect(sessionId).toBe('new-session-id');

		const call = mockHub.request.mock.calls.find(([method]) => method === 'session.create');
		expect(call).toBeDefined();
		const [, params] = call;
		// title must be undefined so the daemon sets titleGenerated: false
		// and auto-generates a title after the first assistant response
		expect(params.title).toBeUndefined();
		expect(params.roomId).toBe('room-1');
	});

	it('passes title through when explicitly provided', async () => {
		await roomStore.createSession('My Custom Title');

		const call = mockHub.request.mock.calls.find(([method]) => method === 'session.create');
		expect(call).toBeDefined();
		const [, params] = call;
		expect(params.title).toBe('My Custom Title');
	});

	it('throws when no room is selected', async () => {
		await roomStore.select(null);

		await expect(roomStore.createSession()).rejects.toThrow('No room selected');
	});
});
