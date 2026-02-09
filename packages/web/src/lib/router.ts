/**
 * URL-based Router
 *
 * Handles URL-based routing for:
 * - Sessions: /session/:sessionId
 * - Global settings: /settings/:section?
 * - Session settings: /session/:sessionId/settings/:section?
 *
 * Features:
 * - URL sync: Updates URL when navigation changes
 * - History navigation: Supports browser back/forward buttons
 * - Deep linking: Restores state from URL on page load
 * - Clean URLs: Uses History API for clean URLs without hash
 */

import {
	currentSessionIdSignal,
	currentSettingsSectionSignal,
	settingsSessionIdSignal,
} from './signals.ts';

/** Route patterns */
const SESSION_ROUTE_PATTERN = /^\/session\/([a-f0-9-]+)$/;
const SETTINGS_ROUTE_PATTERN = /^\/settings(?:\/([^/]+))?$/;
const SESSION_SETTINGS_ROUTE_PATTERN = /^\/session\/([a-f0-9-]+)\/settings(?:\/([^/]+))?$/;

/**
 * Router state and configuration
 */
interface RouterState {
	isInitialized: boolean;
	isNavigating: boolean; // Prevents history loops during programmatic navigation
}

const routerState: RouterState = {
	isInitialized: false,
	isNavigating: false,
};

/**
 * Extract session ID from session route path
 * Returns null if not on a session route
 */
export function getSessionIdFromPath(path: string): string | null {
	const match = path.match(SESSION_ROUTE_PATTERN);
	return match ? match[1] : null;
}

/**
 * Extract settings section from settings path
 * Returns null if not on a settings route
 */
export function getSettingsSectionFromPath(path: string): string | null {
	const match = path.match(SETTINGS_ROUTE_PATTERN);
	return match ? match[1] || 'general' : null;
}

/**
 * Extract session ID and section from session settings path
 * Returns null if not on a session settings route
 */
export function getSessionSettingsFromPath(
	path: string
): { sessionId: string; section: string } | null {
	const match = path.match(SESSION_SETTINGS_ROUTE_PATTERN);
	if (!match) return null;
	return { sessionId: match[1], section: match[2] || 'general' };
}

/**
 * Check if a path is a settings route (global or session)
 */
export function isSettingsPath(path: string): boolean {
	return SETTINGS_ROUTE_PATTERN.test(path) || SESSION_SETTINGS_ROUTE_PATTERN.test(path);
}

/**
 * Get current path from window.location
 */
function getCurrentPath(): string {
	return window.location.pathname;
}

/**
 * Create session URL path
 */
export function createSessionPath(sessionId: string): string {
	return `/session/${sessionId}`;
}

/**
 * Navigate to a session
 * Updates both the URL and the signal
 *
 * @param sessionId - The session ID to navigate to
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToSession(sessionId: string, replace = false): void {
	if (routerState.isNavigating) {
		return; // Prevent recursive navigation
	}

	const targetPath = createSessionPath(sessionId);
	const currentPath = getCurrentPath();

	// Only navigate if the path is different
	if (currentPath === targetPath) {
		// Still update the signal in case it's out of sync
		currentSessionIdSignal.value = sessionId;
		return;
	}

	routerState.isNavigating = true;

	try {
		// Update URL using History API
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod](
			{ sessionId, path: targetPath },
			'', // title - ignored by most browsers
			targetPath
		);

		// Update the signal
		currentSessionIdSignal.value = sessionId;
	} finally {
		// Use setTimeout to break the synchronous cycle
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to home (no session selected)
 */
export function navigateToHome(replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const currentPath = getCurrentPath();
	if (currentPath === '/') {
		currentSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ sessionId: null, path: '/' }, '', '/');

		currentSessionIdSignal.value = null;
		// Clear settings-related signals
		currentSettingsSectionSignal.value = null;
		settingsSessionIdSignal.value = null;
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to global settings
 *
 * @param section - Optional section ID (e.g., 'general', 'model', 'mcp')
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToSettings(section = 'general', replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = section ? `/settings/${section}` : '/settings';
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		// Still update signals in case they're out of sync
		currentSettingsSectionSignal.value = section;
		settingsSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ section, path: targetPath }, '', targetPath);

		// Update signals
		currentSettingsSectionSignal.value = section;
		settingsSessionIdSignal.value = null;
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to session settings
 *
 * @param sessionId - The session ID to edit settings for
 * @param section - Optional section ID (e.g., 'general', 'tools', 'mcp')
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToSessionSettings(
	sessionId: string,
	section = 'general',
	replace = false
): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = `/session/${sessionId}/settings${section ? `/${section}` : ''}`;
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		// Still update signals in case they're out of sync
		currentSettingsSectionSignal.value = section;
		settingsSessionIdSignal.value = sessionId;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ sessionId, section, path: targetPath }, '', targetPath);

		// Update signals
		currentSessionIdSignal.value = sessionId;
		currentSettingsSectionSignal.value = section;
		settingsSessionIdSignal.value = sessionId;
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Handle popstate event (browser back/forward buttons)
 */
function handlePopState(_event: PopStateEvent): void {
	if (routerState.isNavigating) {
		return;
	}

	const path = getCurrentPath();

	// Check for session settings route first (more specific pattern)
	const sessionSettingsMatch = getSessionSettingsFromPath(path);
	if (sessionSettingsMatch) {
		currentSessionIdSignal.value = sessionSettingsMatch.sessionId;
		currentSettingsSectionSignal.value = sessionSettingsMatch.section;
		settingsSessionIdSignal.value = sessionSettingsMatch.sessionId;
		return;
	}

	// Check for global settings route
	const settingsSection = getSettingsSectionFromPath(path);
	if (settingsSection) {
		currentSettingsSectionSignal.value = settingsSection;
		settingsSessionIdSignal.value = null;
		// Don't change currentSessionIdSignal when viewing global settings
		return;
	}

	// Check for session route
	const sessionId = getSessionIdFromPath(path);
	if (sessionId) {
		currentSessionIdSignal.value = sessionId;
		currentSettingsSectionSignal.value = null;
		settingsSessionIdSignal.value = null;
		return;
	}

	// Default to home
	currentSessionIdSignal.value = null;
	currentSettingsSectionSignal.value = null;
	settingsSessionIdSignal.value = null;
}

/**
 * Initialize router
 * - Reads session ID and settings state from current URL
 * - Sets up history event listeners
 * - Should be called once on app mount
 *
 * @returns The initial session ID from URL, or null if not on a session route
 */
export function initializeRouter(): string | null {
	if (routerState.isInitialized) {
		return getSessionIdFromPath(getCurrentPath());
	}

	// Read initial state from URL
	const initialPath = getCurrentPath();

	// Check for session settings route first
	const sessionSettingsMatch = getSessionSettingsFromPath(initialPath);
	if (sessionSettingsMatch) {
		currentSessionIdSignal.value = sessionSettingsMatch.sessionId;
		currentSettingsSectionSignal.value = sessionSettingsMatch.section;
		settingsSessionIdSignal.value = sessionSettingsMatch.sessionId;
		window.addEventListener('popstate', handlePopState);
		routerState.isInitialized = true;
		return sessionSettingsMatch.sessionId;
	}

	// Check for global settings route
	const settingsSection = getSettingsSectionFromPath(initialPath);
	if (settingsSection) {
		currentSettingsSectionSignal.value = settingsSection;
		settingsSessionIdSignal.value = null;
		window.addEventListener('popstate', handlePopState);
		routerState.isInitialized = true;
		return null;
	}

	// Check for session route
	const initialSessionId = getSessionIdFromPath(initialPath);
	if (initialSessionId) {
		currentSettingsSectionSignal.value = null;
		settingsSessionIdSignal.value = null;
	}

	// Set up popstate listener for back/forward navigation
	window.addEventListener('popstate', handlePopState);

	routerState.isInitialized = true;

	return initialSessionId;
}

/**
 * Cleanup router (mainly for testing)
 */
export function cleanupRouter(): void {
	window.removeEventListener('popstate', handlePopState);
	routerState.isInitialized = false;
	routerState.isNavigating = false;
}

/**
 * Get current router state (for testing)
 */
export function getRouterState(): Readonly<RouterState> {
	return { ...routerState };
}

/**
 * Check if router is initialized
 */
export function isRouterInitialized(): boolean {
	return routerState.isInitialized;
}
