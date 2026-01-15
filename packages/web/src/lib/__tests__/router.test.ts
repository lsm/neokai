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

// Mock window.history methods
const mockHistory = {
	pushState: vi.fn(),
	replaceState: vi.fn(),
	state: null,
};

// Mock window.location
const mockLocation = {
	pathname: '/',
};

// Store original values
let originalHistory: History;
let originalLocation: Location;

describe('Router Utility', () => {
	beforeEach(() => {
		// Store originals
		originalHistory = window.history;
		originalLocation = window.location;

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
			const path = createSessionPath('session-123');
			expect(path).toBe('/session/session-123');
		});

		it('should handle UUID session IDs', () => {
			const uuid = '550e8400-e29b-41d4-a716-446655440000';
			const path = createSessionPath(uuid);
			expect(path).toBe(`/session/${uuid}`);
		});
	});

	describe('navigateToSession', () => {
		it('should update URL and signal when navigating to session', () => {
			navigateToSession('session-123');

			expect(mockHistory.pushState).toHaveBeenCalledWith(
				{ sessionId: 'session-123', path: '/session/session-123' },
				'',
				'/session/session-123'
			);
			expect(currentSessionIdSignal.value).toBe('session-123');
		});

		it('should use replaceState when replace is true', () => {
			navigateToSession('session-456', true);

			expect(mockHistory.replaceState).toHaveBeenCalledWith(
				{ sessionId: 'session-456', path: '/session/session-456' },
				'',
				'/session/session-456'
			);
		});

		it('should not navigate if already on the same session', () => {
			mockLocation.pathname = '/session/session-789';
			currentSessionIdSignal.value = 'session-789';

			navigateToSession('session-789');

			// Should not call pushState or replaceState
			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();

			// But signal should still be set (idempotent)
			expect(currentSessionIdSignal.value).toBe('session-789');
		});

		it('should handle rapid consecutive navigations', () => {
			navigateToSession('session-1');
			navigateToSession('session-2');

			expect(mockHistory.pushState).toHaveBeenCalledTimes(2);
			expect(currentSessionIdSignal.value).toBe('session-2');
		});
	});

	describe('navigateToHome', () => {
		it('should update URL and signal when navigating to home', () => {
			currentSessionIdSignal.value = 'session-123';
			navigateToHome();

			expect(mockHistory.pushState).toHaveBeenCalledWith({ sessionId: null, path: '/' }, '', '/');
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should use replaceState when replace is true', () => {
			navigateToHome(true);

			expect(mockHistory.replaceState).toHaveBeenCalledWith(
				{ sessionId: null, path: '/' },
				'',
				'/'
			);
		});

		it('should not navigate if already at home', () => {
			currentSessionIdSignal.value = null;
			navigateToHome();

			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();
		});
	});

	describe('initializeRouter', () => {
		it('should initialize router and return session ID from URL', () => {
			mockLocation.pathname = '/session/test-session-id';

			const sessionId = initializeRouter();

			expect(sessionId).toBe('test-session-id');
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

		it('should warn if already initialized', () => {
			mockLocation.pathname = '/';

			initializeRouter();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const secondCallResult = initializeRouter();

			expect(consoleWarnSpy).toHaveBeenCalledWith('[Router] Already initialized');
			expect(secondCallResult).toBeNull();

			consoleWarnSpy.mockRestore();
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

	describe('Integration scenarios', () => {
		it('should handle full navigation cycle', () => {
			// Start at home
			mockLocation.pathname = '/';
			expect(getSessionIdFromPath(mockLocation.pathname)).toBeNull();

			// Initialize router
			const initialSession = initializeRouter();
			expect(initialSession).toBeNull();

			// Navigate to session
			navigateToSession('session-abc');
			expect(currentSessionIdSignal.value).toBe('session-abc');
			expect(mockHistory.pushState).toHaveBeenCalled();

			// Navigate to another session
			navigateToSession('session-def');
			expect(currentSessionIdSignal.value).toBe('session-def');

			// Navigate home
			navigateToHome();
			expect(currentSessionIdSignal.value).toBeNull();
		});

		it('should handle URL-based deep linking', () => {
			// User visits URL directly
			mockLocation.pathname = '/session/deep-link-session';

			// Router extracts session ID
			const sessionId = getSessionIdFromPath(mockLocation.pathname);
			expect(sessionId).toBe('deep-link-session');

			// App can initialize router and restore session
			const restoredSession = initializeRouter();
			expect(restoredSession).toBe('deep-link-session');
		});
	});
});
