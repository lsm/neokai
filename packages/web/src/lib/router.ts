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
	currentRoomChatSignal,
	navSectionSignal,
} from './signals.ts';

/** Route patterns */
const SESSION_ROUTE_PATTERN = /^\/session\/([a-f0-9-]+)$/;
const ROOM_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)$/;
const ROOM_SESSION_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/session\/([a-f0-9-]+)$/;
const ROOM_TASK_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/task\/([a-f0-9-]+)$/;
const ROOM_CHAT_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/chat$/;
const SESSIONS_ROUTE_PATTERN = /^\/sessions$/;

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

	// Also check room chat pattern
	const roomChatMatch = path.match(ROOM_CHAT_ROUTE_PATTERN);
	return roomChatMatch ? roomChatMatch[1] : null;
}

/**
 * Extract room ID from a room chat URL path
 * Returns the room ID if on a room chat route, null otherwise
 */
export function getRoomChatIdFromPath(path: string): string | null {
	const match = path.match(ROOM_CHAT_ROUTE_PATTERN);
	return match ? match[1] : null;
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
 * Create room chat URL path (chat tab within room layout)
 */
export function createRoomChatPath(roomId: string): string {
	return `/room/${roomId}/chat`;
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
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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

		// Update the signals - room takes priority, clear session, room session, task, and chat
		currentRoomIdSignal.value = roomId;
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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
		currentRoomChatSignal.value = false;
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
 * Navigate to the room chat tab
 * Shows the Chat tab within the room layout at /room/:roomId/chat
 *
 * @param roomId - The room ID
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToRoomChat(roomId: string, replace = false): void {
	if (routerState.isNavigating) {
		return; // Prevent recursive navigation
	}

	const targetPath = createRoomChatPath(roomId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentRoomIdSignal.value = roomId;
		currentRoomChatSignal.value = true;
		currentRoomTaskIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ roomId, chat: true, path: targetPath }, '', targetPath);

		currentRoomIdSignal.value = roomId;
		currentRoomChatSignal.value = true;
		currentRoomTaskIdSignal.value = null;
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
		currentRoomChatSignal.value = false;
		currentRoomSessionIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ path: '/sessions' }, '', '/sessions');

		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomChatSignal.value = false;
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
	const roomChatId = getRoomChatIdFromPath(path);
	const roomId = getRoomIdFromPath(path);
	const roomSession = getRoomSessionIdFromPath(path);
	const roomTask = getRoomTaskIdFromPath(path);

	// Update the signals to match the URL
	// Chat route takes priority among room sub-routes, then task, then session, then room, then /sessions
	if (roomChatId) {
		currentRoomIdSignal.value = roomChatId;
		currentRoomChatSignal.value = true;
		currentRoomTaskIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomTask) {
		currentRoomIdSignal.value = roomTask.roomId;
		currentRoomChatSignal.value = false;
		currentRoomTaskIdSignal.value = roomTask.taskId;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomSession) {
		currentRoomIdSignal.value = roomSession.roomId;
		currentRoomChatSignal.value = false;
		currentRoomSessionIdSignal.value = roomSession.sessionId;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomId) {
		currentRoomIdSignal.value = roomId;
		currentRoomChatSignal.value = false;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (SESSIONS_ROUTE_PATTERN.test(path)) {
		currentRoomIdSignal.value = null;
		currentRoomChatSignal.value = false;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'chats';
	} else {
		currentRoomIdSignal.value = null;
		currentRoomChatSignal.value = false;
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
	const initialRoomChatId = getRoomChatIdFromPath(initialPath);
	const initialRoomId = getRoomIdFromPath(initialPath);
	const initialRoomSession = getRoomSessionIdFromPath(initialPath);
	const initialRoomTask = getRoomTaskIdFromPath(initialPath);

	// Set initial signals - chat route takes priority among room sub-routes, then task, then session, then room, then /sessions
	if (initialRoomChatId) {
		currentRoomIdSignal.value = initialRoomChatId;
		currentRoomChatSignal.value = true;
		currentRoomTaskIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomTask) {
		currentRoomIdSignal.value = initialRoomTask.roomId;
		currentRoomChatSignal.value = false;
		currentRoomTaskIdSignal.value = initialRoomTask.taskId;
		currentRoomSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomSession) {
		currentRoomIdSignal.value = initialRoomSession.roomId;
		currentRoomChatSignal.value = false;
		currentRoomSessionIdSignal.value = initialRoomSession.sessionId;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomId) {
		currentRoomIdSignal.value = initialRoomId;
		currentRoomChatSignal.value = false;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (SESSIONS_ROUTE_PATTERN.test(initialPath)) {
		currentRoomIdSignal.value = null;
		currentRoomChatSignal.value = false;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'chats';
	} else {
		currentRoomIdSignal.value = null;
		currentRoomChatSignal.value = false;
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
