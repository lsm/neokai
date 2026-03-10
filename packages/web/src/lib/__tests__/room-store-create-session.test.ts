/**
 * Tests for RoomStore.createSession — verifies that new sessions created from the
 * Room UI do NOT pass a hardcoded title so that the daemon can auto-generate one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreateSessionRequest, CreateSessionResponse } from '@neokai/shared/api.js';

// -------------------------------------------------------
// Mocks — must be at top level for vi.mock hoisting
// -------------------------------------------------------

let mockRequestFn: ReturnType<typeof vi.fn>;

function makeMockHub() {
	mockRequestFn = vi.fn(async (method: string): Promise<unknown> => {
		if (method === 'room.get') {
			return {
				room: { id: 'room-1', defaultPath: '/workspace', allowedPaths: [] },
				sessions: [],
				allTasks: [],
			};
		}
		if (method === 'goal.list') return { goals: [] };
		if (method === 'room.runtime.state') throw new Error('no runtime');
		if (method === 'session.create') {
			const res: CreateSessionResponse = { sessionId: 'new-session-id' };
			return res;
		}
		return {};
	});

	return {
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		onEvent: vi.fn(() => () => {}),
		request: mockRequestFn,
	};
}

vi.mock('../connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(async () => makeMockHub()),
		getHubIfConnected: vi.fn(() => makeMockHub()),
	},
}));

import { connectionManager } from '../connection-manager.js';

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('RoomStore.createSession', () => {
	let roomStore: typeof import('../room-store').roomStore;

	beforeEach(async () => {
		const hub = makeMockHub();
		vi.mocked(connectionManager.getHub).mockResolvedValue(hub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(hub as never);

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

		const createCall = mockRequestFn.mock.calls.find(
			(args): args is [string, CreateSessionRequest] => args[0] === 'session.create'
		);
		expect(createCall).toBeDefined();
		const params = createCall![1];
		// title must be undefined so the daemon sets titleGenerated: false
		// and auto-generates a title after the first assistant response
		expect(params.title).toBeUndefined();
		expect(params.roomId).toBe('room-1');
	});

	it('passes title through when explicitly provided', async () => {
		await roomStore.createSession('My Custom Title');

		const createCall = mockRequestFn.mock.calls.find(
			(args): args is [string, CreateSessionRequest] => args[0] === 'session.create'
		);
		expect(createCall).toBeDefined();
		expect(createCall![1].title).toBe('My Custom Title');
	});

	it('throws when no room is selected', async () => {
		await roomStore.select(null);

		await expect(roomStore.createSession()).rejects.toThrow('No room selected');
	});
});
