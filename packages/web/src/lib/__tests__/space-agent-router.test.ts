// @ts-nocheck
/**
 * Tests for Space Agent URL routing
 *
 * Tests the /space/:spaceId/agent route pattern including:
 * - Path extraction and creation
 * - Navigation function
 * - popstate handling
 * - Page-load initialization with correct signals
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getSpaceIdFromPath,
	getSpaceAgentFromPath,
	createSpaceAgentPath,
	navigateToSpaceAgent,
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

describe('Space Agent Router', () => {
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

	describe('createSpaceAgentPath', () => {
		it('creates correct path for UUID spaceId', () => {
			expect(createSpaceAgentPath('abc-123')).toBe('/space/abc-123/agent');
		});

		it('creates correct path for slug spaceId', () => {
			expect(createSpaceAgentPath('my-space')).toBe('/space/my-space/agent');
		});
	});

	describe('getSpaceAgentFromPath', () => {
		it('extracts spaceId from agent route', () => {
			expect(getSpaceAgentFromPath('/space/abc-def-123/agent')).toBe('abc-def-123');
		});

		it('extracts spaceId from full UUID agent route', () => {
			expect(getSpaceAgentFromPath('/space/550e8400-e29b-41d4-a716-446655440000/agent')).toBe(
				'550e8400-e29b-41d4-a716-446655440000'
			);
		});

		it('returns null for non-agent space routes', () => {
			expect(getSpaceAgentFromPath('/space/abc-123')).toBeNull();
			expect(getSpaceAgentFromPath('/space/abc-123/session/xyz')).toBeNull();
			expect(getSpaceAgentFromPath('/space/abc-123/task/xyz')).toBeNull();
			expect(getSpaceAgentFromPath('/')).toBeNull();
			expect(getSpaceAgentFromPath('/room/abc-123/agent')).toBeNull();
		});

		it('rejects paths with trailing content after agent', () => {
			expect(getSpaceAgentFromPath('/space/abc-123/agent/extra')).toBeNull();
		});

		it('returns null for empty and malformed paths', () => {
			expect(getSpaceAgentFromPath('')).toBeNull();
			expect(getSpaceAgentFromPath('/space//agent')).toBeNull();
			expect(getSpaceAgentFromPath('/space/agent')).toBeNull();
		});
	});

	describe('getSpaceIdFromPath', () => {
		it('extracts spaceId from agent path', () => {
			expect(getSpaceIdFromPath('/space/abc-def-123/agent')).toBe('abc-def-123');
		});

		it('extracts spaceId from plain space path', () => {
			expect(getSpaceIdFromPath('/space/abc-def-123')).toBe('abc-def-123');
		});
	});

	describe('navigateToSpaceAgent', () => {
		it('pushes correct URL and sets signals', () => {
			const spaceId = 'abc-def-123';
			navigateToSpaceAgent(spaceId);

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{ spaceId, path: '/space/abc-def-123/agent' },
				'',
				'/space/abc-def-123/agent'
			);
			expect(currentSpaceIdSignal.value).toBe(spaceId);
			expect(currentSpaceSessionIdSignal.value).toBe(`space:chat:${spaceId}`);
			expect(currentSpaceTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
			expect(currentRoomIdSignal.value).toBeNull();
			expect(currentRoomSessionIdSignal.value).toBeNull();
			expect(navSectionSignal.value).toBe('spaces');
		});

		it('uses replaceState when replace=true', () => {
			navigateToSpaceAgent('abc-123', true);

			expect(mockHistory.replaceState).toHaveBeenCalled();
			expect(mockHistory.pushState).not.toHaveBeenCalled();
		});

		it('updates signals even when already on same path', () => {
			const spaceId = 'abc-def-123';
			mockLocation.pathname = `/space/${spaceId}/agent`;

			navigateToSpaceAgent(spaceId);

			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(currentSpaceIdSignal.value).toBe(spaceId);
			expect(currentSpaceSessionIdSignal.value).toBe(`space:chat:${spaceId}`);
			expect(currentSpaceTaskIdSignal.value).toBeNull();
			expect(navSectionSignal.value).toBe('spaces');
		});

		it('clears room signals when navigating to space agent', () => {
			currentRoomIdSignal.value = 'some-room';
			currentRoomSessionIdSignal.value = 'room:chat:some-room';

			navigateToSpaceAgent('abc-123');

			expect(currentRoomIdSignal.value).toBeNull();
			expect(currentRoomSessionIdSignal.value).toBeNull();
			expect(currentRoomTaskIdSignal.value).toBeNull();
		});
	});

	describe('initializeRouter with space agent route', () => {
		it('sets correct signals on page load for agent route', () => {
			const spaceId = 'abc-def-123';
			mockLocation.pathname = `/space/${spaceId}/agent`;

			initializeRouter();

			expect(currentSpaceIdSignal.value).toBe(spaceId);
			expect(currentSpaceSessionIdSignal.value).toBe(`space:chat:${spaceId}`);
			expect(currentSpaceTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
			expect(currentRoomIdSignal.value).toBeNull();
			expect(navSectionSignal.value).toBe('spaces');
		});

		it('does not set agent signals for plain space route', () => {
			const spaceId = 'abc-def-123';
			mockLocation.pathname = `/space/${spaceId}`;

			initializeRouter();

			expect(currentSpaceIdSignal.value).toBe(spaceId);
			expect(currentSpaceSessionIdSignal.value).toBeNull();
			expect(currentSpaceTaskIdSignal.value).toBeNull();
		});
	});

	describe('popstate handling for space agent route', () => {
		it('restores space agent signals on back/forward navigation', () => {
			const spaceId = 'abc-def-123';
			mockLocation.pathname = '/';
			initializeRouter();

			// Simulate popstate to space agent route
			mockLocation.pathname = `/space/${spaceId}/agent`;
			const event = new PopStateEvent('popstate', {
				state: { spaceId, path: `/space/${spaceId}/agent` },
			});
			window.dispatchEvent(event);

			expect(currentSpaceIdSignal.value).toBe(spaceId);
			expect(currentSpaceSessionIdSignal.value).toBe(`space:chat:${spaceId}`);
			expect(currentSpaceTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
			expect(currentRoomIdSignal.value).toBeNull();
			expect(navSectionSignal.value).toBe('spaces');
		});

		it('does not set synthetic session ID for plain space route on popstate', () => {
			const spaceId = 'abc-def-123';
			mockLocation.pathname = '/';
			initializeRouter();

			mockLocation.pathname = `/space/${spaceId}`;
			const event = new PopStateEvent('popstate', {
				state: { spaceId, path: `/space/${spaceId}` },
			});
			window.dispatchEvent(event);

			expect(currentSpaceIdSignal.value).toBe(spaceId);
			expect(currentSpaceSessionIdSignal.value).toBeNull();
		});
	});
});
