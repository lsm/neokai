/**
 * URL-based Session and Room Router
 *
 * Handles URL-based routing for sessions and rooms with patterns:
 * - Sessions: /session/:sessionId
 * - Rooms: /room/:roomId
 *
 * Features:
 * - URL sync: Updates URL when session/room changes
 * - History navigation: Supports browser back/forward buttons
 * - Deep linking: Restores session/room from URL on page load
 * - Clean URLs: Uses History API for clean URLs without hash
 */

import {
	currentSessionIdSignal,
	currentRoomIdSignal,
	currentRoomSessionIdSignal,
	currentRoomTaskIdSignal,
	navSectionSignal,
} from './signals.ts';

/** Route patterns */
const SESSION_ROUTE_PATTERN = /^\/session\/([a-f0-9-]+)$/;
const ROOM_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)$/;
const ROOM_SESSION_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/session\/([a-f0-9-]+)$/;
const ROOM_TASK_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/task\/([a-f0-9-]+)$/;
const SESSIONS_ROUTE_PATTERN = /^\/sessions$/;
/** Legacy: /room/:id/chat was removed — treat as plain room route for backwards compat */
const ROOM_CHAT_COMPAT_PATTERN = /^\/room\/([a-f0-9-]+)\/chat$/;

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
 * Extract session ID from current URL path
 * Returns null if not on a session route
 */
export function getSessionIdFromPath(path: string): string | null {
	const match = path.match(SESSION_ROUTE_PATTERN);
	return match ? match[1] : null;
}

/**
 * Extract room ID from current URL path
 * Returns null if not on a room route
 */
export function getRoomIdFromPath(path: string): string | null {
	const match = path.match(ROOM_ROUTE_PATTERN);
	if (match) return match[1];

	// Also check room session pattern
	const roomSessionMatch = path.match(ROOM_SESSION_ROUTE_PATTERN);
	if (roomSessionMatch) return roomSessionMatch[1];

	// Also check room task pattern
	const roomTaskMatch = path.match(ROOM_TASK_ROUTE_PATTERN);
	if (roomTaskMatch) return roomTaskMatch[1];

	// Legacy chat sub-path — the Chat tab was removed; redirect old URLs to the room overview
	const chatCompatMatch = path.match(ROOM_CHAT_COMPAT_PATTERN);
	return chatCompatMatch ? chatCompatMatch[1] : null;
}

/**
 * Extract room session ID from current URL path
 * Returns null if not on a room session route
 */
export function getRoomSessionIdFromPath(
	path: string
): { roomId: string; sessionId: string } | null {
	const match = path.match(ROOM_SESSION_ROUTE_PATTERN);
	if (!match) return null;
	return { roomId: match[1], sessionId: match[2] };
}

/**
 * Extract room task ID from current URL path
 * Returns null if not on a room task route
 */
export function getRoomTaskIdFromPath(path: string): { roomId: string; taskId: string } | null {
	const match = path.match(ROOM_TASK_ROUTE_PATTERN);
	if (!match) return null;
	return { roomId: match[1], taskId: match[2] };
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
 * Create room URL path
 */
export function createRoomPath(roomId: string): string {
	return `/room/${roomId}`;
}

/**
 * Create room session URL path (session viewed within room layout)
 */
export function createRoomSessionPath(roomId: string, sessionId: string): string {
	return `/room/${roomId}/session/${sessionId}`;
}

/**
 * Create room task URL path (task detail viewed within room layout)
 */
export function createRoomTaskPath(roomId: string, taskId: string): string {
	return `/room/${roomId}/task/${taskId}`;
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
		navSectionSignal.value = 'chats';
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
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ sessionId: null, roomId: null, path: '/' }, '', '/');

		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a room
 * Updates both the URL and the signals
 *
 * @param roomId - The room ID to navigate to
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToRoom(roomId: string, replace = false): void {
	if (routerState.isNavigating) {
		return; // Prevent recursive navigation
	}

	const targetPath = createRoomPath(roomId);
	const currentPath = getCurrentPath();

	// Only navigate if the path is different
	if (currentPath === targetPath) {
		// Still update the signal in case it's out of sync
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		// Update URL using History API
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod](
			{ roomId, path: targetPath },
			'', // title - ignored by most browsers
			targetPath
		);

		// Update the signals - room takes priority, clear session, room session, and task
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} finally {
		// Use setTimeout to break the synchronous cycle
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a session within a room layout
 * Shows the session content while keeping the room context panel
 *
 * @param roomId - The room ID
 * @param sessionId - The session ID to show within the room
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToRoomSession(roomId: string, sessionId: string, replace = false): void {
	if (routerState.isNavigating) {
		return; // Prevent recursive navigation
	}

	const targetPath = createRoomSessionPath(roomId, sessionId);
	const currentPath = getCurrentPath();

	// Only navigate if the path is different
	if (currentPath === targetPath) {
		// Still update the signal in case it's out of sync
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = sessionId;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		// Update URL using History API
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod](
			{ roomId, sessionId, path: targetPath },
			'', // title - ignored by most browsers
			targetPath
		);

		// Update the signals
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = sessionId;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} finally {
		// Use setTimeout to break the synchronous cycle
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a task within a room layout
 * Shows the TaskView (Craft + Lead sessions) while keeping the room context panel
 *
 * @param roomId - The room ID
 * @param taskId - The task ID to show the detail view for
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToRoomTask(roomId: string, taskId: string, replace = false): void {
	if (routerState.isNavigating) {
		return; // Prevent recursive navigation
	}

	const targetPath = createRoomTaskPath(roomId, taskId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentRoomIdSignal.value = roomId;
		currentRoomTaskIdSignal.value = taskId;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ roomId, taskId, path: targetPath }, '', targetPath);

		currentRoomIdSignal.value = roomId;
		currentRoomTaskIdSignal.value = taskId;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to the /sessions page
 * Shows the standalone sessions list (no room sessions)
 */
export function navigateToSessions(replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const currentPath = getCurrentPath();
	if (currentPath === '/sessions') {
		navSectionSignal.value = 'chats';
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ path: '/sessions' }, '', '/sessions');

		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		navSectionSignal.value = 'chats';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to Chats section
 * Sets nav section to 'chats' and navigates home if needed
 */
export function navigateToChats(): void {
	navSectionSignal.value = 'chats';
	// If we're on a room route, navigate home to show session list
	if (currentRoomIdSignal.value) {
		navigateToHome();
	}
}

/**
 * Navigate to Rooms section
 * Sets nav section to 'rooms' and navigates home
 */
export function navigateToRooms(): void {
	navSectionSignal.value = 'rooms';
	// Always navigate home when switching to rooms section
	navigateToHome();
}

/**
 * Navigate to Settings section
 * Sets nav section to 'settings' and navigates home
 */
export function navigateToSettings(): void {
	navSectionSignal.value = 'settings';
	navigateToHome();
}

/**
 * Handle popstate event (browser back/forward buttons)
 */
function handlePopState(_event: PopStateEvent): void {
	if (routerState.isNavigating) {
		return;
	}

	const path = getCurrentPath();
	const sessionId = getSessionIdFromPath(path);
	const roomId = getRoomIdFromPath(path);
	const roomSession = getRoomSessionIdFromPath(path);
	const roomTask = getRoomTaskIdFromPath(path);

	// Update the signals to match the URL
	// Task takes priority among room sub-routes, then session, then room, then /sessions
	if (roomTask) {
		currentRoomIdSignal.value = roomTask.roomId;
		currentRoomTaskIdSignal.value = roomTask.taskId;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomSession) {
		currentRoomIdSignal.value = roomSession.roomId;
		currentRoomSessionIdSignal.value = roomSession.sessionId;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomId) {
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
		// Normalize legacy /room/:id/chat URL → /room/:id so the address bar stays clean
		if (ROOM_CHAT_COMPAT_PATTERN.test(path)) {
			const canonicalPath = createRoomPath(roomId);
			window.history.replaceState({ roomId, path: canonicalPath }, '', canonicalPath);
		}
	} else if (SESSIONS_ROUTE_PATTERN.test(path)) {
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'chats';
	} else {
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = sessionId;
		if (!sessionId) {
			navSectionSignal.value = 'home';
		}
	}
}

/**
 * Initialize router
 * - Reads session/room ID from current URL
 * - Sets up history event listeners
 * - Should be called once on app mount
 *
 * @returns The initial session ID from URL, or null if at home or on room route
 */
export function initializeRouter(): string | null {
	if (routerState.isInitialized) {
		return getSessionIdFromPath(getCurrentPath());
	}

	// Read initial session/room from URL
	const initialPath = getCurrentPath();
	const initialSessionId = getSessionIdFromPath(initialPath);
	const initialRoomId = getRoomIdFromPath(initialPath);
	const initialRoomSession = getRoomSessionIdFromPath(initialPath);
	const initialRoomTask = getRoomTaskIdFromPath(initialPath);

	// Set initial signals - task takes priority among room sub-routes, then session, then room, then /sessions
	if (initialRoomTask) {
		currentRoomIdSignal.value = initialRoomTask.roomId;
		currentRoomTaskIdSignal.value = initialRoomTask.taskId;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomSession) {
		currentRoomIdSignal.value = initialRoomSession.roomId;
		currentRoomSessionIdSignal.value = initialRoomSession.sessionId;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomId) {
		currentRoomIdSignal.value = initialRoomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (SESSIONS_ROUTE_PATTERN.test(initialPath)) {
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'chats';
	} else {
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = initialSessionId;
		if (initialSessionId) {
			navSectionSignal.value = 'chats';
		}
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
