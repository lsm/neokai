// @ts-nocheck
/**
 * Tests that navigateToRoom does NOT clobber currentRoomActiveTabSignal,
 * and that non-room navigation clears currentRoomAgentActiveSignal.
 *
 * The P0 fix ensures navigateToRoom leaves the tab signal untouched so
 * callers (like navigateToRoomTab) can set it independently.
 *
 * The P1 fix ensures navigating away from rooms clears the agent-active
 * signal to prevent stale state from affecting future room visits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { navigateToRoom, navigateToHome, cleanupRouter } from '../router';
import {
	currentRoomIdSignal,
	currentRoomSessionIdSignal,
	currentRoomTaskIdSignal,
	currentRoomAgentActiveSignal,
	currentRoomActiveTabSignal,
	currentSessionIdSignal,
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	navSectionSignal,
} from '../signals';

let originalHistory: unknown;
let originalLocation: unknown;
let mockHistory: unknown;
let mockLocation: unknown;

describe('navigateToRoom tab signal behavior', () => {
	beforeEach(() => {
		originalHistory = window.history;
		originalLocation = window.location;

		mockHistory = {
			pushState: vi.fn(),
			replaceState: vi.fn(),
			state: null,
		};

		mockLocation = {
			pathname: '/',
		};

		Object.defineProperty(window, 'history', {
			value: mockHistory,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, 'location', {
			value: mockLocation,
			writable: true,
			configurable: true,
		});

		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		navSectionSignal.value = 'home';

		vi.clearAllMocks();
		cleanupRouter();
	});

	afterEach(() => {
		Object.defineProperty(window, 'history', {
			value: originalHistory,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, 'location', {
			value: originalLocation,
			writable: true,
			configurable: true,
		});
		cleanupRouter();
	});

	it('does NOT reset currentRoomActiveTabSignal on fresh navigation', () => {
		// If the tab was set to 'tasks' before calling navigateToRoom,
		// navigateToRoom must NOT overwrite it — callers manage the tab signal.
		currentRoomActiveTabSignal.value = 'tasks';

		navigateToRoom('room-abc-123');

		expect(currentRoomActiveTabSignal.value).toBe('tasks');
	});

	it('does NOT reset currentRoomActiveTabSignal on same-path navigation', () => {
		mockLocation.pathname = '/room/room-abc-123';
		currentRoomActiveTabSignal.value = 'goals';

		navigateToRoom('room-abc-123');

		expect(currentRoomActiveTabSignal.value).toBe('goals');
	});

	it('clears room session signal on navigation', () => {
		currentRoomSessionIdSignal.value = 'some-session';

		navigateToRoom('room-abc-123');

		expect(currentRoomSessionIdSignal.value).toBeNull();
	});

	it('clears room task signal on navigation', () => {
		currentRoomTaskIdSignal.value = 'some-task';

		navigateToRoom('room-abc-123');

		expect(currentRoomTaskIdSignal.value).toBeNull();
	});

	it('sets currentRoomAgentActiveSignal to false', () => {
		currentRoomAgentActiveSignal.value = true;

		navigateToRoom('room-abc-123');

		expect(currentRoomAgentActiveSignal.value).toBe(false);
	});

	it('sets the room id signal correctly', () => {
		navigateToRoom('room-xyz-789');

		expect(currentRoomIdSignal.value).toBe('room-xyz-789');
	});

	it('pushes correct URL to history for new navigation', () => {
		navigateToRoom('room-abc-123');

		expect(mockHistory.pushState).toHaveBeenCalledWith(
			expect.objectContaining({ roomId: 'room-abc-123' }),
			'',
			'/room/room-abc-123'
		);
	});

	it('preserves tab signal when navigating between rooms', () => {
		mockLocation.pathname = '/room/old-room-id';
		currentRoomActiveTabSignal.value = 'agents';

		navigateToRoom('new-room-id');

		// navigateToRoom must NOT clobber the tab signal — Room.tsx
		// handleTabChange or BottomTabBar set it independently
		expect(currentRoomActiveTabSignal.value).toBe('agents');
		expect(currentRoomIdSignal.value).toBe('new-room-id');
	});
});

describe('non-room navigation clears agent-active signal', () => {
	beforeEach(() => {
		originalHistory = window.history;
		originalLocation = window.location;

		mockHistory = {
			pushState: vi.fn(),
			replaceState: vi.fn(),
			state: null,
		};

		mockLocation = {
			pathname: '/room/some-room',
		};

		Object.defineProperty(window, 'history', {
			value: mockHistory,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, 'location', {
			value: mockLocation,
			writable: true,
			configurable: true,
		});

		currentRoomAgentActiveSignal.value = true;
		currentRoomIdSignal.value = 'some-room';

		vi.clearAllMocks();
		cleanupRouter();
	});

	afterEach(() => {
		Object.defineProperty(window, 'history', {
			value: originalHistory,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, 'location', {
			value: originalLocation,
			writable: true,
			configurable: true,
		});
		cleanupRouter();
	});

	it('navigateToHome clears agent-active signal', () => {
		navigateToHome();

		expect(currentRoomAgentActiveSignal.value).toBe(false);
		expect(currentRoomIdSignal.value).toBeNull();
	});
});
