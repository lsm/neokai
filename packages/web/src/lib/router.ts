/**
 * URL-based Session and Room Router
 *
 * Handles URL-based routing for sessions and rooms with patterns:
 * - Sessions: /session/:sessionId
 * - Rooms: /room/:roomId
 * - Room Agent: /room/:roomId/agent
 * - Space Agent: /space/:spaceId/agent
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
	currentRoomGoalIdSignal,
	currentRoomAgentActiveSignal,
	currentRoomActiveTabSignal,
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSpaceViewModeSignal,
	navSectionSignal,
} from './signals.ts';

/** Route patterns */
const SESSION_ROUTE_PATTERN = /^\/session\/([a-f0-9-]+)$/i;
const ROOM_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)$/;
const ROOM_AGENT_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/agent$/;
const ROOM_SESSION_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/session\/([a-f0-9-]+)$/i;
const ROOM_TASK_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/task\/([a-f0-9-]+|[a-z]-[1-9]\d*)$/i;
const ROOM_MISSION_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/mission\/([a-f0-9-]+|[a-z]-[1-9]\d*)$/i;
const ROOM_TASKS_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/tasks$/;
const ROOM_AGENTS_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/agents$/;
const ROOM_GOALS_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/goals$/;
const ROOM_SETTINGS_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/settings$/;
const SESSIONS_ROUTE_PATTERN = /^\/sessions$/;
const INBOX_ROUTE_PATTERN = /^\/inbox$/;
const SPACES_ROUTE_PATTERN = /^\/spaces$/;
/** Legacy: /room/:id/chat was removed — treat as plain room route for backwards compat */
const ROOM_CHAT_COMPAT_PATTERN = /^\/room\/([a-f0-9-]+)\/chat$/;
/** Space routes accept both UUIDs (a-f0-9-) and slugs (a-z0-9-) — case-insensitive for UUIDs */
const SPACE_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)$/i;
const SPACE_CONFIGURE_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/configure$/i;
const SPACE_TASKS_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/tasks$/i;
const SPACE_AGENT_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/agent$/i;
const SPACE_SESSION_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/session\/([a-f0-9-]+)$/i;
const SPACE_TASK_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/task\/([a-f0-9-]+|[a-z]-[1-9]\d*)$/i;

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

	// Also check room agent pattern
	const roomAgentMatch = path.match(ROOM_AGENT_ROUTE_PATTERN);
	if (roomAgentMatch) return roomAgentMatch[1];

	// Also check room session pattern
	const roomSessionMatch = path.match(ROOM_SESSION_ROUTE_PATTERN);
	if (roomSessionMatch) return roomSessionMatch[1];

	// Also check room task pattern
	const roomTaskMatch = path.match(ROOM_TASK_ROUTE_PATTERN);
	if (roomTaskMatch) return roomTaskMatch[1];

	// Also check room mission pattern
	const roomMissionMatch = path.match(ROOM_MISSION_ROUTE_PATTERN);
	if (roomMissionMatch) return roomMissionMatch[1];

	// Also check room tab patterns (tasks, agents, goals, settings)
	const roomTasksMatch = path.match(ROOM_TASKS_ROUTE_PATTERN);
	if (roomTasksMatch) return roomTasksMatch[1];

	const roomAgentsMatch = path.match(ROOM_AGENTS_ROUTE_PATTERN);
	if (roomAgentsMatch) return roomAgentsMatch[1];

	const roomGoalsMatch = path.match(ROOM_GOALS_ROUTE_PATTERN);
	if (roomGoalsMatch) return roomGoalsMatch[1];

	const roomSettingsMatch = path.match(ROOM_SETTINGS_ROUTE_PATTERN);
	if (roomSettingsMatch) return roomSettingsMatch[1];

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
 * Extract room mission (goal) ID from current URL path
 * Returns null if not on a room mission route
 */
export function getRoomMissionIdFromPath(path: string): { roomId: string; goalId: string } | null {
	const match = path.match(ROOM_MISSION_ROUTE_PATTERN);
	if (!match) return null;
	return { roomId: match[1], goalId: match[2] };
}

/**
 * Extract room ID from agent route path
 * Returns null if not on a room agent route
 */
export function getRoomAgentFromPath(path: string): string | null {
	const match = path.match(ROOM_AGENT_ROUTE_PATTERN);
	return match ? match[1] : null;
}

/**
 * Extract space ID from current URL path
 * Returns null if not on a space route
 */
export function getSpaceIdFromPath(path: string): string | null {
	const configureMatch = path.match(SPACE_CONFIGURE_ROUTE_PATTERN);
	if (configureMatch) return configureMatch[1];

	const match = path.match(SPACE_ROUTE_PATTERN);
	if (match) return match[1];

	const spaceAgentMatch = path.match(SPACE_AGENT_ROUTE_PATTERN);
	if (spaceAgentMatch) return spaceAgentMatch[1];

	const spaceSessionMatch = path.match(SPACE_SESSION_ROUTE_PATTERN);
	if (spaceSessionMatch) return spaceSessionMatch[1];

	const spaceTaskMatch = path.match(SPACE_TASK_ROUTE_PATTERN);
	return spaceTaskMatch ? spaceTaskMatch[1] : null;
}

/**
 * Extract space ID from agent route path
 * Returns null if not on a space agent route
 */
export function getSpaceAgentFromPath(path: string): string | null {
	const match = path.match(SPACE_AGENT_ROUTE_PATTERN);
	return match ? match[1] : null;
}

/**
 * Extract space ID from configure route path
 * Returns null if not on a space configure route
 */
export function getSpaceConfigureFromPath(path: string): string | null {
	const match = path.match(SPACE_CONFIGURE_ROUTE_PATTERN);
	return match ? match[1] : null;
}

/**
 * Extract space ID from /space/:id/tasks route
 * Returns null if not on a space tasks route
 */
export function getSpaceTasksFromPath(path: string): string | null {
	const match = path.match(SPACE_TASKS_ROUTE_PATTERN);
	return match ? match[1] : null;
}

/**
 * Extract space session IDs from current URL path
 * Returns null if not on a space session route
 */
export function getSpaceSessionIdFromPath(
	path: string
): { spaceId: string; sessionId: string } | null {
	const match = path.match(SPACE_SESSION_ROUTE_PATTERN);
	if (!match) return null;
	return { spaceId: match[1], sessionId: match[2] };
}

/**
 * Extract space task IDs from current URL path
 * Returns null if not on a space task route
 */
export function getSpaceTaskIdFromPath(path: string): { spaceId: string; taskId: string } | null {
	const match = path.match(SPACE_TASK_ROUTE_PATTERN);
	if (!match) return null;
	return { spaceId: match[1], taskId: match[2] };
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
 * Create room agent URL path
 */
export function createRoomAgentPath(roomId: string): string {
	return `/room/${roomId}/agent`;
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
 * Create room mission URL path (mission detail viewed within room layout)
 */
export function createRoomMissionPath(roomId: string, goalId: string): string {
	return `/room/${roomId}/mission/${goalId}`;
}

/**
 * Create room tasks tab URL path
 */
export function createRoomTasksPath(roomId: string): string {
	return `/room/${roomId}/tasks`;
}

/**
 * Create room agents tab URL path
 */
export function createRoomAgentsPath(roomId: string): string {
	return `/room/${roomId}/agents`;
}

/**
 * Create room goals tab URL path
 */
export function createRoomGoalsPath(roomId: string): string {
	return `/room/${roomId}/goals`;
}

/**
 * Create room settings tab URL path
 */
export function createRoomSettingsPath(roomId: string): string {
	return `/room/${roomId}/settings`;
}

/**
 * Extract room tab from current URL path
 * Returns { roomId, tab } if on a room tab route, or null otherwise
 */
export function getRoomTabFromPath(path: string): { roomId: string; tab: string } | null {
	let match = path.match(ROOM_AGENT_ROUTE_PATTERN);
	if (match) return { roomId: match[1], tab: 'chat' };

	match = path.match(ROOM_TASKS_ROUTE_PATTERN);
	if (match) return { roomId: match[1], tab: 'tasks' };

	match = path.match(ROOM_AGENTS_ROUTE_PATTERN);
	if (match) return { roomId: match[1], tab: 'agents' };

	match = path.match(ROOM_GOALS_ROUTE_PATTERN);
	if (match) return { roomId: match[1], tab: 'goals' };

	match = path.match(ROOM_SETTINGS_ROUTE_PATTERN);
	if (match) return { roomId: match[1], tab: 'settings' };

	return null;
}

/**
 * Create space URL path
 */
export function createSpacePath(spaceId: string): string {
	return `/space/${spaceId}`;
}

/**
 * Create space configure URL path
 */
export function createSpaceConfigurePath(spaceId: string): string {
	return `/space/${spaceId}/configure`;
}

/**
 * Create space tasks URL path
 */
export function createSpaceTasksPath(spaceId: string): string {
	return `/space/${spaceId}/tasks`;
}

/**
 * Create space session URL path (session viewed within space layout)
 */
export function createSpaceSessionPath(spaceId: string, sessionId: string): string {
	return `/space/${spaceId}/session/${sessionId}`;
}

/**
 * Create space task URL path (task detail viewed within space layout)
 */
export function createSpaceTaskPath(spaceId: string, taskId: string): string {
	return `/space/${spaceId}/task/${taskId}`;
}

/**
 * Create space agent URL path
 */
export function createSpaceAgentPath(spaceId: string): string {
	return `/space/${spaceId}/agent`;
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
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		// Do NOT reset currentRoomActiveTabSignal — callers (Room.tsx, BottomTabBar) manage it
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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

		// Update the signals - room takes priority, clear session, room session, task, and space
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		// Do NOT reset currentRoomActiveTabSignal — callers (Room.tsx, BottomTabBar) manage it
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} finally {
		// Use setTimeout to break the synchronous cycle
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to the Room Agent view
 * Updates URL to /room/:roomId/agent and sets signals for ChatContainer rendering
 *
 * @param roomId - The room ID
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToRoomAgent(roomId: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = createRoomAgentPath(roomId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = true;
		currentRoomActiveTabSignal.value = 'chat';
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ roomId, path: targetPath }, '', targetPath);

		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = true;
		currentRoomActiveTabSignal.value = 'chat';
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} finally {
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
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
		currentRoomGoalIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ roomId, taskId, path: targetPath }, '', targetPath);

		currentRoomIdSignal.value = roomId;
		currentRoomTaskIdSignal.value = taskId;
		currentRoomGoalIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a mission detail within a room layout
 * Shows the MissionDetail page while keeping the room context panel
 *
 * @param roomId - The room ID
 * @param goalId - The mission (goal) ID to show the detail view for
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToRoomMission(roomId: string, goalId: string, replace = false): void {
	if (routerState.isNavigating) {
		return; // Prevent recursive navigation
	}

	const targetPath = createRoomMissionPath(roomId, goalId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentRoomIdSignal.value = roomId;
		currentRoomGoalIdSignal.value = goalId;
		currentRoomTaskIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ roomId, goalId, path: targetPath }, '', targetPath);

		currentRoomIdSignal.value = roomId;
		currentRoomGoalIdSignal.value = goalId;
		currentRoomTaskIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a room tab
 * Updates URL to /room/:roomId/:tab and sets signals for tab rendering
 *
 * @param roomId - The room ID
 * @param tab - The tab to navigate to ('chat', 'overview', 'tasks', 'agents', 'goals', 'settings')
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToRoomTab(roomId: string, tab: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	// Delegate to specialized navigators for known tabs
	if (tab === 'chat') {
		navigateToRoomAgent(roomId, replace);
		return;
	}

	if (tab === 'overview') {
		navigateToRoom(roomId, replace);
		// navigateToRoom does NOT set currentRoomActiveTabSignal — set it explicitly
		currentRoomActiveTabSignal.value = 'overview';
		return;
	}

	// Map tab name to path creator
	let targetPath: string;
	switch (tab) {
		case 'tasks':
			targetPath = createRoomTasksPath(roomId);
			break;
		case 'agents':
			targetPath = createRoomAgentsPath(roomId);
			break;
		case 'goals':
			targetPath = createRoomGoalsPath(roomId);
			break;
		case 'settings':
			targetPath = createRoomSettingsPath(roomId);
			break;
		default:
			return;
	}

	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = tab;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ roomId, tab, path: targetPath }, '', targetPath);

		currentRoomIdSignal.value = roomId;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = tab;
		currentSessionIdSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ path: '/sessions' }, '', '/sessions');

		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
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
	// Navigate home if on a room or space route so the session list is visible
	if (currentRoomIdSignal.value || currentSpaceIdSignal.value) {
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
 * Navigate to Inbox section
 * Sets nav section to 'inbox' and updates URL to /inbox
 */
export function navigateToInbox(replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const currentPath = getCurrentPath();
	if (currentPath === '/inbox') {
		navSectionSignal.value = 'inbox';
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ path: '/inbox' }, '', '/inbox');

		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		navSectionSignal.value = 'inbox';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
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
 * Navigate to Spaces section
 * Sets nav section to 'spaces'; only navigates home if not already viewing a space
 */
export function navigateToSpaces(): void {
	// Navigate to /spaces page for proper routing
	navigateToSpacesPage();
}

/**
 * Check if path is /spaces
 */
export function isSpacesPath(path: string): boolean {
	return SPACES_ROUTE_PATTERN.test(path);
}

/**
 * Navigate to /spaces page (standalone spaces view with recent spaces + chat input)
 */
export function navigateToSpacesPage(replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const currentPath = getCurrentPath();
	if (currentPath === '/spaces') {
		navSectionSignal.value = 'spaces';
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ path: '/spaces' }, '', '/spaces');

		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSpaceIdSignal.value = null;
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a space
 * Updates both the URL and the signals
 */
export function navigateToSpace(spaceId: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = createSpacePath(spaceId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ spaceId, path: targetPath }, '', targetPath);

		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to the Space configure view
 * Updates URL to /space/:spaceId/configure and keeps the space context panel active
 */
export function navigateToSpaceConfigure(spaceId: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = createSpaceConfigurePath(spaceId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'configure';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ spaceId, path: targetPath }, '', targetPath);

		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'configure';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to the Space tasks view
 * Updates URL to /space/:spaceId/tasks and keeps the space context panel active
 */
export function navigateToSpaceTasks(spaceId: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = createSpaceTasksPath(spaceId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'tasks';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ spaceId, path: targetPath }, '', targetPath);

		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'tasks';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a session within a space layout
 */
export function navigateToSpaceSession(spaceId: string, sessionId: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = createSpaceSessionPath(spaceId, sessionId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = sessionId;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ spaceId, sessionId, path: targetPath }, '', targetPath);

		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = sessionId;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to a task within a space layout
 */
export function navigateToSpaceTask(spaceId: string, taskId: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = createSpaceTaskPath(spaceId, taskId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceTaskIdSignal.value = taskId;
		currentSpaceSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ spaceId, taskId, path: targetPath }, '', targetPath);

		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceTaskIdSignal.value = taskId;
		currentSpaceSessionIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
	} finally {
		setTimeout(() => {
			routerState.isNavigating = false;
		}, 0);
	}
}

/**
 * Navigate to the Space Agent view
 * Updates URL to /space/:spaceId/agent and sets signals for ChatContainer rendering
 *
 * @param spaceId - The space ID
 * @param replace - Whether to replace current history entry (default: false)
 */
export function navigateToSpaceAgent(spaceId: string, replace = false): void {
	if (routerState.isNavigating) {
		return;
	}

	const targetPath = createSpaceAgentPath(spaceId);
	const currentPath = getCurrentPath();

	if (currentPath === targetPath) {
		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = `space:chat:${spaceId}`;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
		return;
	}

	routerState.isNavigating = true;

	try {
		const historyMethod = replace ? 'replaceState' : 'pushState';
		window.history[historyMethod]({ spaceId, path: targetPath }, '', targetPath);

		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = `space:chat:${spaceId}`;
		currentSpaceTaskIdSignal.value = null;
		currentSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		navSectionSignal.value = 'spaces';
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
	const sessionId = getSessionIdFromPath(path);
	const roomId = getRoomIdFromPath(path);
	const roomAgent = getRoomAgentFromPath(path);
	const roomTab = getRoomTabFromPath(path);
	const roomMission = getRoomMissionIdFromPath(path);
	const roomSession = getRoomSessionIdFromPath(path);
	const roomTask = getRoomTaskIdFromPath(path);
	const spaceConfigure = getSpaceConfigureFromPath(path);
	const spaceTasks = getSpaceTasksFromPath(path);
	const spaceTask = getSpaceTaskIdFromPath(path);
	const spaceSession = getSpaceSessionIdFromPath(path);
	const spaceAgent = getSpaceAgentFromPath(path);
	const spaceId = getSpaceIdFromPath(path);

	// Update the signals to match the URL
	// Space routes take priority over room routes
	// IMPORTANT: Order is load-bearing — roomAgent must be checked before roomTab/roomMission/roomTask/roomSession/roomId
	// because getRoomIdFromPath also matches agent/tab paths. If reordered, those routes silently
	// fall through to the plain room handler, losing the synthetic session ID or tab state.
	if (spaceTask) {
		currentSpaceIdSignal.value = spaceTask.spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceTaskIdSignal.value = spaceTask.taskId;
		currentSpaceSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (spaceSession) {
		currentSpaceIdSignal.value = spaceSession.spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = spaceSession.sessionId;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (spaceAgent) {
		currentSpaceIdSignal.value = spaceAgent;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = `space:chat:${spaceAgent}`;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (spaceTasks) {
		currentSpaceIdSignal.value = spaceTasks;
		currentSpaceViewModeSignal.value = 'tasks';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (spaceConfigure) {
		currentSpaceIdSignal.value = spaceConfigure;
		currentSpaceViewModeSignal.value = 'configure';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (spaceId) {
		currentSpaceIdSignal.value = spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (roomAgent) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = roomAgent;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = true;
		currentRoomActiveTabSignal.value = 'chat';
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomTab) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = roomTab.roomId;
		currentRoomActiveTabSignal.value = roomTab.tab;
		currentRoomAgentActiveSignal.value = false;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomMission) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = roomMission.roomId;
		currentRoomGoalIdSignal.value = roomMission.goalId;
		currentRoomTaskIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomTask) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = roomTask.roomId;
		currentRoomTaskIdSignal.value = roomTask.taskId;
		currentRoomGoalIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomSession) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = roomSession.roomId;
		currentRoomSessionIdSignal.value = roomSession.sessionId;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (roomId) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = roomId;
		currentRoomActiveTabSignal.value = 'overview';
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
		// Normalize legacy /room/:id/chat URL → /room/:id so the address bar stays clean
		if (ROOM_CHAT_COMPAT_PATTERN.test(path)) {
			const canonicalPath = createRoomPath(roomId);
			window.history.replaceState({ roomId, path: canonicalPath }, '', canonicalPath);
		}
	} else if (SESSIONS_ROUTE_PATTERN.test(path)) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'chats';
	} else if (INBOX_ROUTE_PATTERN.test(path)) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'inbox';
	} else if (SPACES_ROUTE_PATTERN.test(path)) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomActiveTabSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = sessionId;
		if (!sessionId) {
			navSectionSignal.value = 'rooms';
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

	// Read initial session/room/space from URL
	const initialPath = getCurrentPath();
	const initialSessionId = getSessionIdFromPath(initialPath);
	const initialRoomId = getRoomIdFromPath(initialPath);
	const initialRoomAgent = getRoomAgentFromPath(initialPath);
	const initialRoomTab = getRoomTabFromPath(initialPath);
	const initialRoomMission = getRoomMissionIdFromPath(initialPath);
	const initialRoomSession = getRoomSessionIdFromPath(initialPath);
	const initialRoomTask = getRoomTaskIdFromPath(initialPath);
	const initialSpaceConfigure = getSpaceConfigureFromPath(initialPath);
	const initialSpaceTasks = getSpaceTasksFromPath(initialPath);
	const initialSpaceTask = getSpaceTaskIdFromPath(initialPath);
	const initialSpaceSession = getSpaceSessionIdFromPath(initialPath);
	const initialSpaceAgent = getSpaceAgentFromPath(initialPath);
	const initialSpaceId = getSpaceIdFromPath(initialPath);

	// Set initial signals — space routes take priority, then room routes
	// IMPORTANT: Order is load-bearing — see comment in handlePopState
	if (initialSpaceTask) {
		currentSpaceIdSignal.value = initialSpaceTask.spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceTaskIdSignal.value = initialSpaceTask.taskId;
		currentSpaceSessionIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (initialSpaceSession) {
		currentSpaceIdSignal.value = initialSpaceSession.spaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = initialSpaceSession.sessionId;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (initialSpaceAgent) {
		currentSpaceIdSignal.value = initialSpaceAgent;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = `space:chat:${initialSpaceAgent}`;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (initialSpaceConfigure) {
		currentSpaceIdSignal.value = initialSpaceConfigure;
		currentSpaceViewModeSignal.value = 'configure';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (initialSpaceTasks) {
		currentSpaceIdSignal.value = initialSpaceTasks;
		currentSpaceViewModeSignal.value = 'tasks';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (initialSpaceId) {
		currentSpaceIdSignal.value = initialSpaceId;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else if (initialRoomAgent) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = initialRoomAgent;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = true;
		currentRoomActiveTabSignal.value = 'chat';
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomTab) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = initialRoomTab.roomId;
		currentRoomActiveTabSignal.value = initialRoomTab.tab;
		currentRoomAgentActiveSignal.value = false;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomMission) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = initialRoomMission.roomId;
		currentRoomGoalIdSignal.value = initialRoomMission.goalId;
		currentRoomTaskIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomTask) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = initialRoomTask.roomId;
		currentRoomTaskIdSignal.value = initialRoomTask.taskId;
		currentRoomGoalIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomSession) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = initialRoomSession.roomId;
		currentRoomSessionIdSignal.value = initialRoomSession.sessionId;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (initialRoomId) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = initialRoomId;
		currentRoomActiveTabSignal.value = 'overview';
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'rooms';
	} else if (SESSIONS_ROUTE_PATTERN.test(initialPath)) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'chats';
	} else if (INBOX_ROUTE_PATTERN.test(initialPath)) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'inbox';
	} else if (SPACES_ROUTE_PATTERN.test(initialPath)) {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
		currentSessionIdSignal.value = null;
		navSectionSignal.value = 'spaces';
	} else {
		currentSpaceIdSignal.value = null;
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		currentRoomIdSignal.value = null;
		currentRoomActiveTabSignal.value = null;
		currentRoomSessionIdSignal.value = null;
		currentRoomTaskIdSignal.value = null;
		currentRoomGoalIdSignal.value = null;
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
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
