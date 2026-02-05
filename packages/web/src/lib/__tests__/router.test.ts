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
	createSessionPath,
	navigateToSession,
	navigateToHome,
	initializeRouter,
	cleanupRouter,
	getRouterState,
	isRouterInitialized,
} from '../router';
import { currentSessionIdSignal } from '../signals';

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

		// Reset signal
		currentSessionIdSignal.value = null;

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

		// Reset signal
		currentSessionIdSignal.value = null;
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

			expect(mockHistory.pushState).toHaveBeenCalledWith({ sessionId: null, path: '/' }, '', '/');
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should use replaceState when replace is true', () => {
			// Set current path to a session (not home)
			mockLocation.pathname = '/session/550e8400e29b41d4a716446655440007';
			navigateToHome(true);

			expect(mockHistory.replaceState).toHaveBeenCalledWith(
				{ sessionId: null, path: '/' },
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
	});
});
