// @ts-nocheck
/**
 * Tests for Room Agent URL routing
 *
 * Tests the /room/:roomId/agent route pattern including:
 * - Path extraction and creation
 * - Navigation function
 * - popstate handling
 * - Page-load initialization with correct signals
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getRoomIdFromPath,
	getRoomAgentFromPath,
	createRoomAgentPath,
	navigateToRoomAgent,
	initializeRouter,
	cleanupRouter,
} from '../router';
import {
	currentSessionIdSignal,
	currentRoomIdSignal,
	currentRoomSessionIdSignal,
	currentRoomTaskIdSignal,
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	navSectionSignal,
} from '../signals';

let originalHistory: unknown;
let originalLocation: unknown;
let mockHistory: unknown;
let mockLocation: unknown;

describe('Room Agent Router', () => {
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

	describe('createRoomAgentPath', () => {
		it('creates correct path', () => {
			expect(createRoomAgentPath('abc-123')).toBe('/room/abc-123/agent');
		});
	});

	describe('getRoomAgentFromPath', () => {
		it('extracts roomId from agent route', () => {
			expect(getRoomAgentFromPath('/room/abc-def-123/agent')).toBe('abc-def-123');
		});

		it('extracts roomId from full UUID agent route', () => {
			expect(getRoomAgentFromPath('/room/550e8400-e29b-41d4-a716-446655440000/agent')).toBe(
				'550e8400-e29b-41d4-a716-446655440000'
			);
		});

		it('returns null for non-agent routes', () => {
			expect(getRoomAgentFromPath('/room/abc-123')).toBeNull();
			expect(getRoomAgentFromPath('/room/abc-123/session/xyz')).toBeNull();
			expect(getRoomAgentFromPath('/room/abc-123/task/xyz')).toBeNull();
			expect(getRoomAgentFromPath('/')).toBeNull();
			expect(getRoomAgentFromPath('/session/abc-123')).toBeNull();
		});

		it('rejects paths with trailing content after agent', () => {
			expect(getRoomAgentFromPath('/room/abc-123/agent/extra')).toBeNull();
		});

		it('returns null for empty and malformed paths', () => {
			expect(getRoomAgentFromPath('')).toBeNull();
			expect(getRoomAgentFromPath('/room//agent')).toBeNull();
			expect(getRoomAgentFromPath('/room/agent')).toBeNull();
		});

		it('returns null for legacy chat path', () => {
			expect(getRoomAgentFromPath('/room/abc-123/chat')).toBeNull();
		});
	});

	describe('getRoomIdFromPath', () => {
		it('extracts roomId from agent path', () => {
			expect(getRoomIdFromPath('/room/abc-def-123/agent')).toBe('abc-def-123');
		});

		it('extracts roomId from full UUID agent path', () => {
			expect(getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/agent')).toBe(
				'550e8400-e29b-41d4-a716-446655440000'
			);
		});

		it('extracts roomId from plain room path (not just agent)', () => {
			expect(getRoomIdFromPath('/room/abc-def-123')).toBe('abc-def-123');
		});

		it('extracts roomId from legacy /chat compat path', () => {
			expect(getRoomIdFromPath('/room/abc-def-123/chat')).toBe('abc-def-123');
		});

		it('returns null for non-room paths', () => {
			expect(getRoomIdFromPath('/session/abc-123')).toBeNull();
			expect(getRoomIdFromPath('/')).toBeNull();
			expect(getRoomIdFromPath('')).toBeNull();
		});
	});

	describe('navigateToRoomAgent', () => {
		it('pushes correct URL and sets signals', () => {
			const roomId = 'abc-def-123';
			navigateToRoomAgent(roomId);

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{ roomId, path: '/room/abc-def-123/agent' },
				'',
				'/room/abc-def-123/agent'
			);
			expect(currentRoomIdSignal.value).toBe(roomId);
			expect(currentRoomSessionIdSignal.value).toBe(`room:chat:${roomId}`);
			expect(currentRoomTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
			expect(currentSpaceIdSignal.value).toBeNull();
			expect(navSectionSignal.value).toBe('rooms');
		});

		it('uses replaceState when replace=true', () => {
			navigateToRoomAgent('abc-123', true);

			expect(mockHistory.replaceState).toHaveBeenCalled();
			expect(mockHistory.pushState).not.toHaveBeenCalled();
		});

		it('updates signals even when already on same path', () => {
			const roomId = 'abc-def-123';
			mockLocation.pathname = `/room/${roomId}/agent`;

			navigateToRoomAgent(roomId);

			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(currentRoomIdSignal.value).toBe(roomId);
			expect(currentRoomSessionIdSignal.value).toBe(`room:chat:${roomId}`);
			expect(currentRoomTaskIdSignal.value).toBeNull();
		});
	});

	describe('initializeRouter with agent route', () => {
		it('sets correct signals on page load for agent route', () => {
			const roomId = 'abc-def-123';
			mockLocation.pathname = `/room/${roomId}/agent`;

			initializeRouter();

			expect(currentRoomIdSignal.value).toBe(roomId);
			expect(currentRoomSessionIdSignal.value).toBe(`room:chat:${roomId}`);
			expect(currentRoomTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
			expect(currentSpaceIdSignal.value).toBeNull();
			expect(navSectionSignal.value).toBe('rooms');
		});

		it('does not set agent signals for plain room route', () => {
			const roomId = 'abc-def-123';
			mockLocation.pathname = `/room/${roomId}`;

			initializeRouter();

			expect(currentRoomIdSignal.value).toBe(roomId);
			expect(currentRoomSessionIdSignal.value).toBeNull();
			expect(currentRoomTaskIdSignal.value).toBeNull();
		});
	});

	describe('popstate handling for agent route', () => {
		it('restores agent signals on back/forward navigation', () => {
			const roomId = 'abc-def-123';
			mockLocation.pathname = '/';
			initializeRouter();

			// Simulate popstate to agent route
			mockLocation.pathname = `/room/${roomId}/agent`;
			const event = new PopStateEvent('popstate', {
				state: { roomId, path: `/room/${roomId}/agent` },
			});
			window.dispatchEvent(event);

			expect(currentRoomIdSignal.value).toBe(roomId);
			expect(currentRoomSessionIdSignal.value).toBe(`room:chat:${roomId}`);
			expect(currentRoomTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
			expect(navSectionSignal.value).toBe('rooms');
		});
	});
});
