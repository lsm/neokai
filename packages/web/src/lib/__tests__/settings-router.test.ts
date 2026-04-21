// @vitest-environment happy-dom
// @ts-nocheck
/**
 * Tests for the /settings route
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { navigateToSettings, initializeRouter, cleanupRouter } from '../router';
import { navSectionSignal, currentSpaceIdSignal, currentRoomIdSignal } from '../signals';

let originalHistory: unknown;
let originalLocation: unknown;
let mockHistory: unknown;
let mockLocation: unknown;

describe('/settings route', () => {
	beforeEach(() => {
		originalHistory = window.history;
		originalLocation = window.location;

		mockHistory = {
			pushState: vi.fn(),
			replaceState: vi.fn(),
			state: null,
		};
		mockLocation = { pathname: '/' };

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
		navSectionSignal.value = 'rooms';
		currentSpaceIdSignal.value = null;
		currentRoomIdSignal.value = null;

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
		navSectionSignal.value = 'rooms';
		currentSpaceIdSignal.value = null;
		currentRoomIdSignal.value = null;
	});

	describe('navigateToSettings', () => {
		it('should push /settings URL and set navSection to settings', () => {
			navigateToSettings();

			expect(mockHistory.pushState).toHaveBeenCalledWith({ path: '/settings' }, '', '/settings');
			expect(navSectionSignal.value).toBe('settings');
		});

		it('should clear all context signals', () => {
			currentSpaceIdSignal.value = 'space-1';
			currentRoomIdSignal.value = 'room-1';

			navigateToSettings();

			expect(currentSpaceIdSignal.value).toBeNull();
			expect(currentRoomIdSignal.value).toBeNull();
		});

		it('should use replaceState when replace is true', () => {
			navigateToSettings(true);

			expect(mockHistory.replaceState).toHaveBeenCalledWith({ path: '/settings' }, '', '/settings');
			expect(mockHistory.pushState).not.toHaveBeenCalled();
		});

		it('should not push history if already on /settings', () => {
			mockLocation.pathname = '/settings';

			navigateToSettings();

			expect(mockHistory.pushState).not.toHaveBeenCalled();
			expect(mockHistory.replaceState).not.toHaveBeenCalled();
		});
	});

	describe('initializeRouter with /settings', () => {
		it('should set navSection to settings when page loads at /settings', () => {
			mockLocation.pathname = '/settings';

			initializeRouter();

			expect(navSectionSignal.value).toBe('settings');
			expect(currentSpaceIdSignal.value).toBeNull();
			expect(currentRoomIdSignal.value).toBeNull();
		});
	});

	describe('popstate with /settings', () => {
		it('should restore navSection to settings on popstate', () => {
			mockLocation.pathname = '/';
			initializeRouter();
			expect(navSectionSignal.value).toBe('rooms');

			// Simulate navigating to settings via URL bar
			mockLocation.pathname = '/settings';
			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(navSectionSignal.value).toBe('settings');
		});

		it('should clear navSection when navigating away from /settings', () => {
			mockLocation.pathname = '/settings';
			initializeRouter();
			expect(navSectionSignal.value).toBe('settings');

			// Simulate navigating back to a space
			mockLocation.pathname = '/space/my-space';
			window.dispatchEvent(new PopStateEvent('popstate', {}));

			expect(navSectionSignal.value).toBe('spaces');
			expect(currentSpaceIdSignal.value).toBe('my-space');
		});
	});
});
