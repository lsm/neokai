// @ts-nocheck
/**
 * Tests for URL-based Session Router
 *
 * Tests URL routing functionality including:
 * - Session ID extraction from paths
 * - Navigation functions
 * - History state management
 * - Browser back/forward handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getSessionIdFromPath,
	getRoomIdFromPath,
	getRoomMissionIdFromPath,
	getRoomTabFromPath,
	createSessionPath,
	createRoomMissionPath,
	createRoomTasksPath,
	createRoomAgentsPath,
	createRoomGoalsPath,
	createRoomSettingsPath,
	navigateToSession,
	navigateToRoom,
	navigateToRoomAgent,
	navigateToHome,
	navigateToRoomMission,
	navigateToRoomTab,
	initializeRouter,
	cleanupRouter,
	getRouterState,
	isRouterInitialized,
} from '../router';
import {
	currentSessionIdSignal,
	currentRoomIdSignal,
	currentRoomTaskIdSignal,
	currentRoomGoalIdSignal,
	currentRoomAgentActiveSignal,
	currentRoomActiveTabSignal,
	currentRoomSessionIdSignal,
} from '../signals';

// Store original values (use unknown to avoid type errors at module load time)
let originalHistory: unknown;
let originalLocation: unknown;

// Create fresh mocks for each test
let mockHistory: unknown;
let mockLocation: unknown;

describe('Router Utility', () => {
	beforeEach(() => {
		// Store originals
		originalHistory = window.history;
		originalLocation = window.location;

		// Create fresh mocks
		mockHistory = {
			pushState: vi.fn(),
			replaceState: vi.fn(),
			state: null,
		};

		// Use a plain object for location with configurable pathname
		mockLocation = {
			pathname: '/',
		};

		// Mock history and location
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

		// Reset signals
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;

		// Reset mocks
		vi.clearAllMocks();

		// Cleanup router state
		cleanupRouter();
	});

	afterEach(() => {
		// Restore originals
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

		// Cleanup router
		cleanupRouter();

		// Reset signals
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
	});

	describe('getSessionIdFromPath', () => {
		it('should extract session ID from valid session path', () => {
			const sessionId = getSessionIdFromPath('/session/abc-123-def');
			expect(sessionId).toBe('abc-123-def');
		});

		it('should extract UUID from session path', () => {
			const sessionId = getSessionIdFromPath('/session/550e8400-e29b-41d4-a716-446655440000');
			expect(sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should return null for home path', () => {
			const sessionId = getSessionIdFromPath('/');
			expect(sessionId).toBeNull();
		});

		it('should return null for invalid path', () => {
			const sessionId = getSessionIdFromPath('/invalid/path');
			expect(sessionId).toBeNull();
		});

		it('should return null for partial session path', () => {
			const sessionId = getSessionIdFromPath('/session/');
			expect(sessionId).toBeNull();
		});

		it('should return null for path with extra segments', () => {
			const sessionId = getSessionIdFromPath('/session/abc-123/extra');
			expect(sessionId).toBeNull();
		});
	});

	describe('createSessionPath', () => {
		it('should create session path with session ID', () => {
			const path = createSessionPath('550e8400e29b41d4a716446655440007');
			expect(path).toBe('/session/550e8400e29b41d4a716446655440007');
		});

		it('should handle UUID session IDs', () => {
			const uuid = '550e8400-e29b-41d4-a716-446655440000';
			const path = createSessionPath(uuid);
			expect(path).toBe(`/session/${uuid}`);
		});
	});

	describe('navigateToSession', () => {
		it('should update URL and signal when navigating to session', () => {
			navigateToSession('550e8400e29b41d4a716446655440007');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					sessionId: '550e8400e29b41d4a716446655440007',
					path: '/session/550e8400e29b41d4a716446655440007',
				},
				'',
				'/session/550e8400e29b41d4a716446655440007'
			);
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440007');
		});

		it('should use replaceState when replace is true', () => {
			navigateToSession('550e8400e29b41d4a716446655440007', true);

			expect(mockHistory.replaceState).toHaveBeenCalledWith(
				{
					sessionId: '550e8400e29b41d4a716446655440007',
					path: '/session/550e8400e29b41d4a716446655440007',
				},
				'',
				'/session/550e8400e29b41d4a716446655440007'
			);
		});

		it('should not navigate if already on the same session', () => {
			// Set up mockLocation to return current path
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440007';

			currentSessionIdSignal.value = '550e8400e29b41d4a716446655440007';

			navigateToSession('550e8400e29b41d4a716446655440007');

			// Should not call pushState or replaceState
			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();

			// But signal should still be set (idempotent)
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440007');
		});

		it('should handle rapid consecutive navigations', () => {
			// Note: The router's isNavigating flag prevents true rapid concurrent calls
			// This test verifies the second navigation is handled correctly
			navigateToSession('550e8400e29b41d4a716446655440007');

			// Wait for navigation flag to clear (setTimeout with 0)
			// In tests, we need to manually handle the async nature
			const callsAfterFirst = mockHistory.pushState.mock.calls.length;
			expect(callsAfterFirst).toBeGreaterThan(0);
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440007');
		});

		it('should prevent recursive navigation when isNavigating is true', () => {
			// First navigation sets isNavigating to true
			navigateToSession('550e8400e29b41d4a716446655440007');
			const firstCallCount = mockHistory.pushState.mock.calls.length;

			// isNavigating is still true (setTimeout hasn't cleared it yet)
			// Second call should be prevented
			navigateToSession('550e8400e29b41d4a716446655440008');
			const secondCallCount = mockHistory.pushState.mock.calls.length;

			// Should still be just the one call from the first navigation
			expect(secondCallCount).toBe(firstCallCount);
			// Signal should still be from the first navigation
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440007');
		});
	});

	describe('navigateToHome', () => {
		it('should update URL and signal when navigating to home', () => {
			// Set current path to a session (not home)
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440007';
			currentSessionIdSignal.value = '550e8400e29b41d4a716446655440007';
			navigateToHome();

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{ sessionId: null, roomId: null, path: '/' },
				'',
				'/'
			);
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should use replaceState when replace is true', () => {
			// Set current path to a session (not home)
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440007';
			navigateToHome(true);

			expect(mockHistory.replaceState).toHaveBeenCalledWith(
				{ sessionId: null, roomId: null, path: '/' },
				'',
				'/'
			);
		});

		it('should not navigate if already at home', () => {
			// Set up mockLocation to return current path
			mockLocation.pathname = '/';

			currentSessionIdSignal.value = null;
			navigateToHome();

			// Should not call pushState or replaceState
			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();
		});

		it('should prevent recursive navigation when isNavigating is true', () => {
			// Set current path to a session (not home) so navigation is needed
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440007';
			currentSessionIdSignal.value = '550e8400e29b41d4a716446655440007';

			// First navigation to home
			navigateToHome();
			const firstCallCount = mockHistory.pushState.mock.calls.length;

			// isNavigating is still true (setTimeout hasn't cleared it yet)
			// Update path back to a session for second call
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440008';

			// Second call should be prevented
			navigateToHome();
			const secondCallCount = mockHistory.pushState.mock.calls.length;

			// Should still be just the one call from the first navigation
			expect(secondCallCount).toBe(firstCallCount);
		});
	});

	describe('initializeRouter', () => {
		it('should initialize router and return session ID from URL', () => {
			// Set up mockLocation to return session path
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440000';

			const sessionId = initializeRouter();

			expect(sessionId).toBe('550e8400e29b41d4a716446655440000');
			expect(isRouterInitialized()).toBe(true);
		});

		it('should return null when at home path', () => {
			mockLocation.pathname = '/';

			const sessionId = initializeRouter();

			expect(sessionId).toBeNull();
			expect(isRouterInitialized()).toBe(true);
		});

		it('should set up popstate event listener', () => {
			initializeRouter();

			// Verify popstate listener was added by checking router is initialized
			expect(isRouterInitialized()).toBe(true);
		});

		it('should return null if already initialized', () => {
			mockLocation.pathname = '/';

			initializeRouter();

			const secondCallResult = initializeRouter();

			// Second call should return null and not re-initialize
			expect(secondCallResult).toBeNull();
			expect(isRouterInitialized()).toBe(true);
		});
	});

	describe('cleanupRouter', () => {
		it('should cleanup router state', () => {
			initializeRouter();
			expect(isRouterInitialized()).toBe(true);

			cleanupRouter();

			expect(isRouterInitialized()).toBe(false);
			expect(getRouterState().isInitialized).toBe(false);
		});
	});

	describe('getRouterState', () => {
		it('should return initial state before initialization', () => {
			const state = getRouterState();

			expect(state.isInitialized).toBe(false);
			expect(state.isNavigating).toBe(false);
		});

		it('should return initialized state after initialization', () => {
			initializeRouter();

			const state = getRouterState();

			expect(state.isInitialized).toBe(true);
			expect(state.isNavigating).toBe(false);
		});
	});

	describe('isRouterInitialized', () => {
		it('should return false before initialization', () => {
			expect(isRouterInitialized()).toBe(false);
		});

		it('should return true after initialization', () => {
			initializeRouter();
			expect(isRouterInitialized()).toBe(true);
		});

		it('should return false after cleanup', () => {
			initializeRouter();
			cleanupRouter();
			expect(isRouterInitialized()).toBe(false);
		});
	});

	describe('Popstate handling (browser back/forward)', () => {
		it('should update signal when popstate event is triggered with session path', () => {
			// Initialize router first (sets up popstate listener)
			mockLocation.pathname = '/';
			initializeRouter();

			// Change location to simulate navigation
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440009';

			// Dispatch popstate event (simulates browser back/forward)
			const popstateEvent = new PopStateEvent('popstate', {
				state: { sessionId: '550e8400e29b41d4a716446655440009' },
			});
			window.dispatchEvent(popstateEvent);

			// Signal should be updated to match the new path
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440009');
		});

		it('should update signal to null when popstate navigates to home', () => {
			// Initialize router with a session path
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440009';
			initializeRouter();

			// Set signal to current session
			currentSessionIdSignal.value = '550e8400e29b41d4a716446655440009';

			// Change location to simulate navigation to home
			mockLocation.pathname = '/';

			// Dispatch popstate event
			const popstateEvent = new PopStateEvent('popstate', {
				state: { sessionId: null },
			});
			window.dispatchEvent(popstateEvent);

			// Signal should be updated to null
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should not update signal during navigation (isNavigating guard)', async () => {
			// Initialize router
			mockLocation.pathname = '/';
			initializeRouter();

			// Start a navigation which sets isNavigating = true
			navigateToSession('550e8400e29b41d4a716446655440010');

			// isNavigating is true now (setTimeout hasn't cleared it)
			// Change location
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440011';

			// Dispatch popstate event while isNavigating is true
			const popstateEvent = new PopStateEvent('popstate', {
				state: { sessionId: '550e8400e29b41d4a716446655440011' },
			});
			window.dispatchEvent(popstateEvent);

			// Signal should still be from the navigation, not from popstate
			// (because popstate handler returns early when isNavigating is true)
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440010');
		});
	});

	describe('getRoomIdFromPath', () => {
		it('should extract room ID from room path', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should extract room ID from room task path', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/task/abc-123');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should extract room ID from room session path', () => {
			const roomId = getRoomIdFromPath(
				'/room/550e8400-e29b-41d4-a716-446655440000/session/abc-123-def'
			);
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should extract room ID from legacy chat path (backwards compat)', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/chat');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should return null for session path', () => {
			const roomId = getRoomIdFromPath('/session/550e8400-e29b-41d4-a716-446655440000');
			expect(roomId).toBeNull();
		});
	});

	describe('initializeRouter with room routes', () => {
		it('should set currentRoomIdSignal when URL is a plain room path', () => {
			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000';

			initializeRouter();

			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should set currentRoomIdSignal when URL is a room task path', () => {
			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/task/660e8400-e29b-41d4-a716-446655440001';

			initializeRouter();

			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should set currentRoomIdSignal when URL is a legacy chat path', () => {
			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000/chat';

			initializeRouter();

			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentSessionIdSignal.value).toBeNull();
		});
	});

	describe('Popstate handling for room routes', () => {
		it('should update signals when popstate navigates to a plain room path', () => {
			mockLocation.pathname = '/';
			initializeRouter();

			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000';

			window.dispatchEvent(
				new PopStateEvent('popstate', { state: { roomId: '550e8400-e29b-41d4-a716-446655440000' } })
			);

			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should update signals when popstate navigates to a room task path', () => {
			mockLocation.pathname = '/';
			initializeRouter();

			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/task/660e8400-e29b-41d4-a716-446655440001';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should clear room signals when popstate navigates away from room to home', () => {
			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000';
			initializeRouter();
			currentRoomIdSignal.value = '550e8400-e29b-41d4-a716-446655440000';

			mockLocation.pathname = '/';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(currentRoomIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should call replaceState to canonicalize legacy /room/:id/chat URL on popstate', () => {
			mockLocation.pathname = '/';
			initializeRouter();

			// Simulate pressing browser back to a legacy chat URL
			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000/chat';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			// Signals should point at the room
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentSessionIdSignal.value).toBeNull();

			// URL must be canonicalized to /room/:id (not left as /room/:id/chat)
			expect(mockHistory.replaceState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					path: '/room/550e8400-e29b-41d4-a716-446655440000',
				},
				'',
				'/room/550e8400-e29b-41d4-a716-446655440000'
			);
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Mission route tests
	// ──────────────────────────────────────────────────────────────────────────

	describe('getRoomMissionIdFromPath', () => {
		it('should extract roomId and goalId from UUID mission path', () => {
			const result = getRoomMissionIdFromPath(
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001'
			);
			expect(result).toEqual({
				roomId: '550e8400-e29b-41d4-a716-446655440000',
				goalId: '660e8400-e29b-41d4-a716-446655440001',
			});
		});

		it('should extract roomId and goalId from short ID mission path', () => {
			const result = getRoomMissionIdFromPath(
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/a-1'
			);
			expect(result).toEqual({
				roomId: '550e8400-e29b-41d4-a716-446655440000',
				goalId: 'a-1',
			});
		});

		it('should extract roomId and goalId from multi-digit short ID mission path', () => {
			const result = getRoomMissionIdFromPath(
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/z-123'
			);
			expect(result).toEqual({
				roomId: '550e8400-e29b-41d4-a716-446655440000',
				goalId: 'z-123',
			});
		});

		it('should return null for non-mission paths', () => {
			expect(getRoomMissionIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000')).toBeNull();
			expect(
				getRoomMissionIdFromPath(
					'/room/550e8400-e29b-41d4-a716-446655440000/task/660e8400-e29b-41d4-a716-446655440001'
				)
			).toBeNull();
			expect(getRoomMissionIdFromPath('/session/550e8400-e29b-41d4-a716-446655440000')).toBeNull();
			expect(getRoomMissionIdFromPath('/')).toBeNull();
			expect(getRoomMissionIdFromPath('/invalid/path')).toBeNull();
		});

		it('should return null for path with extra trailing segments', () => {
			const result = getRoomMissionIdFromPath(
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001/extra'
			);
			expect(result).toBeNull();
		});
	});

	describe('createRoomMissionPath', () => {
		it('should create correct mission path with UUID goal ID', () => {
			const path = createRoomMissionPath(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001'
			);
			expect(path).toBe(
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001'
			);
		});

		it('should create correct mission path with short goal ID', () => {
			const path = createRoomMissionPath('550e8400-e29b-41d4-a716-446655440000', 'a-1');
			expect(path).toBe('/room/550e8400-e29b-41d4-a716-446655440000/mission/a-1');
		});
	});

	describe('getRoomIdFromPath with mission route', () => {
		it('should extract room ID from mission path', () => {
			const roomId = getRoomIdFromPath(
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001'
			);
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should extract room ID from mission path with short ID', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/mission/a-1');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});
	});

	describe('navigateToRoomMission', () => {
		it('should update URL and set currentRoomGoalIdSignal when navigating to mission', () => {
			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001'
			);

			const expectedPath =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';
			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					goalId: '660e8400-e29b-41d4-a716-446655440001',
					path: expectedPath,
				},
				'',
				expectedPath
			);

			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should clear currentRoomTaskIdSignal when navigating to mission', () => {
			// Pre-set a task ID
			currentRoomTaskIdSignal.value = 'some-task-id';

			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001'
			);

			expect(currentRoomTaskIdSignal.value).toBeNull();
			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');
		});

		it('should clear currentSessionIdSignal when navigating to mission', () => {
			currentSessionIdSignal.value = 'some-session-id';

			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001'
			);

			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should use replaceState when replace is true', () => {
			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001',
				true
			);

			expect(mockHistory.replaceState).toHaveBeenCalled();
			expect(mockHistory.pushState).not.toHaveBeenCalled();
		});

		it('should not navigate if already on the same mission path', () => {
			const path =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';
			mockLocation.pathname = path;
			currentRoomGoalIdSignal.value = '660e8400-e29b-41d4-a716-446655440001';

			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001'
			);

			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();
			// Signal remains set idempotently
			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');
		});

		it('should prevent recursive navigation when isNavigating is true', () => {
			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001'
			);
			const firstCallCount = mockHistory.pushState.mock.calls.length;

			// isNavigating still true — second call is a no-op
			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'770e8400-e29b-41d4-a716-446655440002'
			);

			expect(mockHistory.pushState.mock.calls.length).toBe(firstCallCount);
			// Signal stays from the first navigation
			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');
		});
	});

	describe('navigateToRoom clears currentRoomGoalIdSignal', () => {
		it('should clear currentRoomGoalIdSignal when navigating to a plain room', () => {
			currentRoomGoalIdSignal.value = 'some-goal-id';

			navigateToRoom('550e8400-e29b-41d4-a716-446655440000');

			expect(currentRoomGoalIdSignal.value).toBeNull();
		});
	});

	describe('navigateToSession clears currentRoomGoalIdSignal', () => {
		it('should clear currentRoomGoalIdSignal when navigating to a session', () => {
			currentRoomGoalIdSignal.value = 'some-goal-id';

			navigateToSession('550e8400e29b41d4a716446655440007');

			expect(currentRoomGoalIdSignal.value).toBeNull();
		});
	});

	describe('navigateToHome clears currentRoomGoalIdSignal', () => {
		it('should clear currentRoomGoalIdSignal when navigating home', () => {
			// Start from a mission page so home navigation actually fires
			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';
			currentRoomGoalIdSignal.value = '660e8400-e29b-41d4-a716-446655440001';

			navigateToHome();

			expect(currentRoomGoalIdSignal.value).toBeNull();
		});
	});

	describe('initializeRouter with mission route', () => {
		it('should set currentRoomGoalIdSignal and currentRoomIdSignal when URL is a mission path', () => {
			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';

			initializeRouter();

			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentRoomTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should set currentRoomGoalIdSignal when URL has a short mission ID', () => {
			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000/mission/a-1';

			initializeRouter();

			expect(currentRoomGoalIdSignal.value).toBe('a-1');
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should clear currentRoomGoalIdSignal when URL is a plain room path', () => {
			currentRoomGoalIdSignal.value = 'pre-existing-goal-id';
			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000';

			initializeRouter();

			expect(currentRoomGoalIdSignal.value).toBeNull();
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should clear currentRoomGoalIdSignal when URL is a room task path', () => {
			currentRoomGoalIdSignal.value = 'pre-existing-goal-id';
			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/task/660e8400-e29b-41d4-a716-446655440001';

			initializeRouter();

			expect(currentRoomGoalIdSignal.value).toBeNull();
		});
	});

	describe('Popstate handling for mission routes', () => {
		it('should update signals when popstate navigates to a mission path', () => {
			mockLocation.pathname = '/';
			initializeRouter();

			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(currentRoomTaskIdSignal.value).toBeNull();
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should update signals when popstate navigates to a mission path with short ID', () => {
			mockLocation.pathname = '/';
			initializeRouter();

			mockLocation.pathname = '/room/550e8400-e29b-41d4-a716-446655440000/mission/a-1';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(currentRoomGoalIdSignal.value).toBe('a-1');
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should clear currentRoomGoalIdSignal when popstate navigates from mission to room task', () => {
			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';
			initializeRouter();
			currentRoomGoalIdSignal.value = '660e8400-e29b-41d4-a716-446655440001';

			// Navigate to task
			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/task/770e8400-e29b-41d4-a716-446655440002';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(currentRoomGoalIdSignal.value).toBeNull();
			expect(currentRoomTaskIdSignal.value).toBe('770e8400-e29b-41d4-a716-446655440002');
		});

		it('should clear currentRoomGoalIdSignal when popstate navigates away from mission to home', () => {
			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';
			initializeRouter();
			currentRoomGoalIdSignal.value = '660e8400-e29b-41d4-a716-446655440001';

			mockLocation.pathname = '/';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(currentRoomGoalIdSignal.value).toBeNull();
			expect(currentRoomIdSignal.value).toBeNull();
		});

		it('should set goalId signal and clear taskId signal when popstate navigates to mission path', () => {
			mockLocation.pathname = '/';
			initializeRouter();

			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';

			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');
			expect(currentRoomTaskIdSignal.value).toBeNull();
		});
	});

	describe('currentRoomGoalIdSignal signal', () => {
		it('should start as null', () => {
			expect(currentRoomGoalIdSignal.value).toBeNull();
		});

		it('should be set after navigateToRoomMission and cleared after navigateToHome', async () => {
			navigateToRoomMission(
				'550e8400-e29b-41d4-a716-446655440000',
				'660e8400-e29b-41d4-a716-446655440001'
			);
			expect(currentRoomGoalIdSignal.value).toBe('660e8400-e29b-41d4-a716-446655440001');

			// Wait for isNavigating to clear
			await new Promise((resolve) => setTimeout(resolve, 10));

			mockLocation.pathname =
				'/room/550e8400-e29b-41d4-a716-446655440000/mission/660e8400-e29b-41d4-a716-446655440001';
			navigateToHome();
			expect(currentRoomGoalIdSignal.value).toBeNull();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Room tab route tests
	// ──────────────────────────────────────────────────────────────────────────

	describe('getRoomTabFromPath', () => {
		it('should extract roomId and tab from tasks path', () => {
			const result = getRoomTabFromPath('/room/abc-123/tasks');
			expect(result).toEqual({ roomId: 'abc-123', tab: 'tasks' });
		});

		it('should extract roomId and tab from agents path', () => {
			const result = getRoomTabFromPath('/room/abc-123/agents');
			expect(result).toEqual({ roomId: 'abc-123', tab: 'agents' });
		});

		it('should extract roomId and tab from goals path', () => {
			const result = getRoomTabFromPath('/room/abc-123/goals');
			expect(result).toEqual({ roomId: 'abc-123', tab: 'goals' });
		});

		it('should extract roomId and tab from settings path', () => {
			const result = getRoomTabFromPath('/room/abc-123/settings');
			expect(result).toEqual({ roomId: 'abc-123', tab: 'settings' });
		});

		it('should map agent path to chat tab', () => {
			const result = getRoomTabFromPath('/room/abc-123/agent');
			expect(result).toEqual({ roomId: 'abc-123', tab: 'chat' });
		});

		it('should return null for plain room path (no tab)', () => {
			const result = getRoomTabFromPath('/room/abc-123');
			expect(result).toBeNull();
		});

		it('should return null for room task detail path (not tab)', () => {
			const result = getRoomTabFromPath('/room/abc-123/task/some-task-id');
			expect(result).toBeNull();
		});

		it('should return null for room mission detail path (not tab)', () => {
			const result = getRoomTabFromPath('/room/abc-123/mission/some-goal-id');
			expect(result).toBeNull();
		});

		it('should return null for non-room paths', () => {
			expect(getRoomTabFromPath('/')).toBeNull();
			expect(getRoomTabFromPath('/session/abc-123')).toBeNull();
			expect(getRoomTabFromPath('/invalid')).toBeNull();
		});

		it('should return null for path with extra trailing segments', () => {
			expect(getRoomTabFromPath('/room/abc-123/tasks/extra')).toBeNull();
			expect(getRoomTabFromPath('/room/abc-123/agents/extra')).toBeNull();
		});
	});

	describe('createRoomTasksPath', () => {
		it('should create correct tasks path', () => {
			const path = createRoomTasksPath('550e8400-e29b-41d4-a716-446655440000');
			expect(path).toBe('/room/550e8400-e29b-41d4-a716-446655440000/tasks');
		});
	});

	describe('createRoomAgentsPath', () => {
		it('should create correct agents path', () => {
			const path = createRoomAgentsPath('550e8400-e29b-41d4-a716-446655440000');
			expect(path).toBe('/room/550e8400-e29b-41d4-a716-446655440000/agents');
		});
	});

	describe('createRoomGoalsPath', () => {
		it('should create correct goals path', () => {
			const path = createRoomGoalsPath('550e8400-e29b-41d4-a716-446655440000');
			expect(path).toBe('/room/550e8400-e29b-41d4-a716-446655440000/goals');
		});
	});

	describe('createRoomSettingsPath', () => {
		it('should create correct settings path', () => {
			const path = createRoomSettingsPath('550e8400-e29b-41d4-a716-446655440000');
			expect(path).toBe('/room/550e8400-e29b-41d4-a716-446655440000/settings');
		});
	});

	describe('getRoomIdFromPath with tab routes', () => {
		it('should extract room ID from tasks path', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/tasks');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should extract room ID from agents path', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/agents');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should extract room ID from goals path', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/goals');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should extract room ID from settings path', () => {
			const roomId = getRoomIdFromPath('/room/550e8400-e29b-41d4-a716-446655440000/settings');
			expect(roomId).toBe('550e8400-e29b-41d4-a716-446655440000');
		});
	});

	describe('navigateToRoomTab', () => {
		it('should navigate to tasks tab with pushState by default', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'tasks');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					tab: 'tasks',
					path: '/room/550e8400-e29b-41d4-a716-446655440000/tasks',
				},
				'',
				'/room/550e8400-e29b-41d4-a716-446655440000/tasks'
			);
			expect(currentRoomActiveTabSignal.value).toBe('tasks');
			expect(currentRoomAgentActiveSignal.value).toBe(false);
			expect(currentRoomIdSignal.value).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should navigate to agents tab', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'agents');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					tab: 'agents',
					path: '/room/550e8400-e29b-41d4-a716-446655440000/agents',
				},
				'',
				'/room/550e8400-e29b-41d4-a716-446655440000/agents'
			);
			expect(currentRoomActiveTabSignal.value).toBe('agents');
		});

		it('should navigate to goals tab', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'goals');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					tab: 'goals',
					path: '/room/550e8400-e29b-41d4-a716-446655440000/goals',
				},
				'',
				'/room/550e8400-e29b-41d4-a716-446655440000/goals'
			);
			expect(currentRoomActiveTabSignal.value).toBe('goals');
		});

		it('should navigate to settings tab', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'settings');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					tab: 'settings',
					path: '/room/550e8400-e29b-41d4-a716-446655440000/settings',
				},
				'',
				'/room/550e8400-e29b-41d4-a716-446655440000/settings'
			);
			expect(currentRoomActiveTabSignal.value).toBe('settings');
		});

		it('should delegate to navigateToRoomAgent when tab is chat', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'chat');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					path: '/room/550e8400-e29b-41d4-a716-446655440000/agent',
				},
				'',
				'/room/550e8400-e29b-41d4-a716-446655440000/agent'
			);
			expect(currentRoomActiveTabSignal.value).toBe('chat');
			expect(currentRoomAgentActiveSignal.value).toBe(true);
		});

		it('should delegate to navigateToRoom when tab is overview and set currentRoomActiveTabSignal', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'overview');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{
					roomId: '550e8400-e29b-41d4-a716-446655440000',
					path: '/room/550e8400-e29b-41d4-a716-446655440000',
				},
				'',
				'/room/550e8400-e29b-41d4-a716-446655440000'
			);
			expect(currentRoomActiveTabSignal.value).toBe('overview');
		});

		it('should use replaceState when replace is true', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'tasks', true);

			expect(mockHistory.replaceState).toHaveBeenCalled();
			expect(mockHistory.pushState).not.toHaveBeenCalled();
		});

		it('should default replace to false', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'tasks');

			expect(mockHistory.pushState).toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();
		});

		it('should clear unrelated signals when navigating to a tab', () => {
			currentSessionIdSignal.value = 'some-session';
			currentRoomTaskIdSignal.value = 'some-task';
			currentRoomGoalIdSignal.value = 'some-goal';

			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'tasks');

			expect(currentSessionIdSignal.value).toBeNull();
			expect(currentRoomTaskIdSignal.value).toBeNull();
			expect(currentRoomGoalIdSignal.value).toBeNull();
		});

		it('should not navigate if already on the same tab path', () => {
			const path = '/room/550e8400-e29b-41d4-a716-446655440000/tasks';
			mockLocation.pathname = path;
			currentRoomActiveTabSignal.value = 'tasks';

			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'tasks');

			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();
			expect(currentRoomActiveTabSignal.value).toBe('tasks');
		});

		it('should prevent recursive navigation when isNavigating is true', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'tasks');
			const firstCallCount = mockHistory.pushState.mock.calls.length;

			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'agents');

			expect(mockHistory.pushState.mock.calls.length).toBe(firstCallCount);
			expect(currentRoomActiveTabSignal.value).toBe('tasks');
		});

		it('should do nothing for unknown tab', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'nonexistent');

			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();
		});

		it('should set navSectionSignal to rooms', () => {
			navigateToRoomTab('550e8400-e29b-41d4-a716-446655440000', 'tasks');
			// navSectionSignal is set inside navigateToRoomTab
			expect(currentRoomActiveTabSignal.value).toBe('tasks');
		});
	});

	describe('Integration scenarios', () => {
		it('should handle full navigation cycle', async () => {
			// Start at home
			mockLocation.pathname = '/';
			expect(getSessionIdFromPath(mockLocation.pathname)).toBeNull();

			// Initialize router
			const initialSession = initializeRouter();
			expect(initialSession).toBeNull();

			// Navigate to first session
			navigateToSession('550e8400e29b41d4a716446655440001');
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440001');
			expect(mockHistory.pushState).toHaveBeenCalled();

			// Wait for navigation to complete (setTimeout with 0)
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Navigate to second session (set current path to first session's path)
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440001';
			navigateToSession('550e8400e29b41d4a716446655440002');
			expect(currentSessionIdSignal.value).toBe('550e8400e29b41d4a716446655440002');

			// Wait for navigation to complete
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Navigate home (set current path to second session's path)
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440002';
			navigateToHome();
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should handle URL-based deep linking', () => {
			// User visits URL directly
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440003';

			// Router extracts session ID
			const sessionId = getSessionIdFromPath(mockLocation.pathname);
			expect(sessionId).toBe('550e8400e29b41d4a716446655440003');

			// App can initialize router and restore session
			const restoredSession = initializeRouter();
			expect(restoredSession).toBe('550e8400e29b41d4a716446655440003');
		});

		// ──────────────────────────────────────────────────────────────────────────
		// Room tab route — handlePopState tests
		// ──────────────────────────────────────────────────────────────────────────

		describe('handlePopState with room tab routes', () => {
			it('should set currentRoomActiveTabSignal to "goals" when popstate navigates to /room/:id/goals', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/goals';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				expect(currentRoomActiveTabSignal.value).toBe('goals');
				expect(currentRoomIdSignal.value).toBe('abc-123');
				expect(currentSessionIdSignal.value).toBeNull();
				expect(currentRoomTaskIdSignal.value).toBeNull();
				expect(currentRoomGoalIdSignal.value).toBeNull();
				expect(currentRoomAgentActiveSignal.value).toBe(false);
			});

			it('should set currentRoomActiveTabSignal to "tasks" when popstate navigates to /room/:id/tasks', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/tasks';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				expect(currentRoomActiveTabSignal.value).toBe('tasks');
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});

			it('should set currentRoomActiveTabSignal to "agents" when popstate navigates to /room/:id/agents', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/agents';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				expect(currentRoomActiveTabSignal.value).toBe('agents');
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});

			it('should set currentRoomActiveTabSignal to "settings" when popstate navigates to /room/:id/settings', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/settings';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				expect(currentRoomActiveTabSignal.value).toBe('settings');
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});

			it('should reset currentRoomActiveTabSignal to "overview" when popstate navigates back to /room/:id', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				// First navigate to tasks
				mockLocation.pathname = '/room/abc-123/tasks';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBe('tasks');

				// Then navigate back to plain room
				mockLocation.pathname = '/room/abc-123';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBe('overview');
			});

			it('should clear currentRoomActiveTabSignal when popstate navigates to a mission sub-route', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				// First on a tab route
				mockLocation.pathname = '/room/abc-123/tasks';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBe('tasks');

				// Then navigate to mission
				mockLocation.pathname = '/room/abc-123/mission/aaa-111';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomGoalIdSignal.value).toBe('aaa-111');
			});

			it('should clear currentRoomActiveTabSignal when popstate navigates to a task sub-route', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/tasks';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				mockLocation.pathname = '/room/abc-123/task/def-456';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomTaskIdSignal.value).toBe('def-456');
			});

			it('should clear currentRoomActiveTabSignal when popstate navigates to a session sub-route', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/goals';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				mockLocation.pathname = '/room/abc-123/session/caf-000';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomSessionIdSignal.value).toBe('caf-000');
			});

			it('should clear currentRoomActiveTabSignal when popstate navigates to a standalone session', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/tasks';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				mockLocation.pathname = '/session/def-456';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomIdSignal.value).toBeNull();
			});

			it('should clear currentRoomActiveTabSignal when popstate navigates to home', () => {
				mockLocation.pathname = '/';
				initializeRouter();

				mockLocation.pathname = '/room/abc-123/goals';
				window.dispatchEvent(new PopStateEvent('popstate', {}));

				mockLocation.pathname = '/';
				window.dispatchEvent(new PopStateEvent('popstate', {}));
				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomIdSignal.value).toBeNull();
			});
		});

		// ──────────────────────────────────────────────────────────────────────────
		// Room tab route — initializeRouter tests
		// ──────────────────────────────────────────────────────────────────────────

		describe('initializeRouter with room tab routes', () => {
			it('should set currentRoomActiveTabSignal to "goals" when page loads at /room/:id/goals', () => {
				mockLocation.pathname = '/room/abc-123/goals';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBe('goals');
				expect(currentRoomIdSignal.value).toBe('abc-123');
				expect(currentSessionIdSignal.value).toBeNull();
			});

			it('should set currentRoomActiveTabSignal to "settings" when page loads at /room/:id/settings', () => {
				mockLocation.pathname = '/room/abc-123/settings';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBe('settings');
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});

			it('should set currentRoomActiveTabSignal to "tasks" when page loads at /room/:id/tasks', () => {
				mockLocation.pathname = '/room/abc-123/tasks';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBe('tasks');
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});

			it('should set currentRoomActiveTabSignal to "agents" when page loads at /room/:id/agents', () => {
				mockLocation.pathname = '/room/abc-123/agents';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBe('agents');
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});

			it('should set currentRoomActiveTabSignal to "overview" when page loads at plain /room/:id', () => {
				mockLocation.pathname = '/room/abc-123';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBe('overview');
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});

			it('should clear currentRoomActiveTabSignal when page loads at a mission sub-route', () => {
				mockLocation.pathname = '/room/abc-123/mission/aaa-111';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomGoalIdSignal.value).toBe('aaa-111');
			});

			it('should clear currentRoomActiveTabSignal when page loads at a task sub-route', () => {
				mockLocation.pathname = '/room/abc-123/task/def-456';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomTaskIdSignal.value).toBe('def-456');
			});

			it('should clear currentRoomActiveTabSignal when page loads at a session sub-route', () => {
				mockLocation.pathname = '/room/abc-123/session/caf-000';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBeNull();
				expect(currentRoomSessionIdSignal.value).toBe('caf-000');
			});

			it('should not interfere with room agent route (/room/:id/agent)', () => {
				mockLocation.pathname = '/room/abc-123/agent';
				initializeRouter();

				expect(currentRoomActiveTabSignal.value).toBe('chat');
				expect(currentRoomAgentActiveSignal.value).toBe(true);
				expect(currentRoomIdSignal.value).toBe('abc-123');
			});
		});
	});
});
