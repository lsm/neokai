// @ts-nocheck
/**
 * Tests that navigateToRoom resets currentRoomActiveTabSignal to 'overview'.
 *
 * Covers the fix where both the same-path and navigation branches of
 * navigateToRoom() must set currentRoomActiveTabSignal.value = 'overview',
 * ensuring the tab state is properly reset when navigating to a room dashboard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { navigateToRoom, cleanupRouter } from '../router';
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

describe('navigateToRoom tab reset', () => {
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

	it('sets currentRoomActiveTabSignal to overview on fresh navigation', () => {
		// Pre-condition: tab was set to something else (e.g. tasks)
		currentRoomActiveTabSignal.value = 'tasks';

		navigateToRoom('room-abc-123');

		expect(currentRoomActiveTabSignal.value).toBe('overview');
	});

	it('sets currentRoomActiveTabSignal to overview when already on same room path', () => {
		// Simulate being already on the room path
		mockLocation.pathname = '/room/room-abc-123';
		currentRoomActiveTabSignal.value = 'goals';

		navigateToRoom('room-abc-123');

		expect(currentRoomActiveTabSignal.value).toBe('overview');
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

	it('does not push to history when already on the same room path', () => {
		mockLocation.pathname = '/room/room-abc-123';

		navigateToRoom('room-abc-123');

		expect(mockHistory.pushState).not.toHaveBeenCalled();
		expect(mockHistory.replaceState).not.toHaveBeenCalled();
	});

	it('uses replaceState when replace flag is true', () => {
		navigateToRoom('room-abc-123', true);

		expect(mockHistory.replaceState).toHaveBeenCalledWith(
			expect.objectContaining({ roomId: 'room-abc-123' }),
			'',
			'/room/room-abc-123'
		);
		expect(mockHistory.pushState).not.toHaveBeenCalled();
	});

	it('resets tab to overview even when navigating from a different room', () => {
		mockLocation.pathname = '/room/old-room-id';
		currentRoomActiveTabSignal.value = 'agents';

		navigateToRoom('new-room-id');

		expect(currentRoomActiveTabSignal.value).toBe('overview');
		expect(currentRoomIdSignal.value).toBe('new-room-id');
	});
});
