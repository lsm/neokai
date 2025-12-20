/**
 * Session Status Tracking
 *
 * Tracks session processing states and unread status for sidebar display.
 *
 * Features:
 * - Subscribes to session state channels for visible sessions
 * - Tracks agent processing states (idle, queued, processing)
 * - Tracks unread status using localStorage persistence
 */

import { signal, computed } from '@preact/signals';
import type { AgentProcessingState } from '@liuboer/shared';
import { appState, sessions } from './state.ts';
import { currentSessionIdSignal } from './signals.ts';

/**
 * Storage key for unread tracking
 */
const UNREAD_STORAGE_KEY = 'liuboer:session-last-seen';

/**
 * Session status info for UI display
 */
export interface SessionStatusInfo {
	/** Current processing state */
	processingState: AgentProcessingState;
	/** Whether the session has unread messages */
	hasUnread: boolean;
}

/**
 * Map of session ID to their agent processing state
 * Updated reactively when session state channels update
 */
const sessionProcessingStates = signal<Map<string, AgentProcessingState>>(new Map());

/**
 * Map of session ID to last seen message count
 * Persisted to localStorage
 */
const lastSeenMessageCounts = signal<Map<string, number>>(new Map());

/**
 * Load last seen counts from localStorage
 */
function loadLastSeenCounts(): Map<string, number> {
	try {
		const stored = localStorage.getItem(UNREAD_STORAGE_KEY);
		if (stored) {
			const data = JSON.parse(stored) as Record<string, number>;
			return new Map(Object.entries(data));
		}
	} catch (e) {
		console.error('[SessionStatus] Failed to load unread data:', e);
	}
	return new Map();
}

/**
 * Save last seen counts to localStorage
 */
function saveLastSeenCounts(counts: Map<string, number>): void {
	try {
		const data = Object.fromEntries(counts);
		localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(data));
	} catch (e) {
		console.error('[SessionStatus] Failed to save unread data:', e);
	}
}

/**
 * Initialize session status tracking
 * Call this after appState is initialized
 */
export function initSessionStatusTracking(): void {
	// Load persisted unread data
	lastSeenMessageCounts.value = loadLastSeenCounts();

	// Subscribe to session list changes to track new sessions
	sessions.subscribe((sessionList) => {
		// Subscribe to each session's state channel
		for (const session of sessionList) {
			subscribeToSessionState(session.id);
		}
	});

	// When user clicks on a session, mark it as read
	currentSessionIdSignal.subscribe((sessionId) => {
		if (sessionId) {
			markSessionAsRead(sessionId);
		}
	});
}

/**
 * Set of session IDs we've already subscribed to
 */
const subscribedSessions = new Set<string>();

/**
 * Subscribe to a session's state channel
 */
function subscribeToSessionState(sessionId: string): void {
	if (subscribedSessions.has(sessionId)) return;
	subscribedSessions.add(sessionId);

	try {
		const channels = appState.getSessionChannels(sessionId);

		// Subscribe to session state changes
		channels.session.$.subscribe((state) => {
			if (state?.agent) {
				const newMap = new Map(sessionProcessingStates.value);
				newMap.set(sessionId, state.agent);
				sessionProcessingStates.value = newMap;
			}
		});
	} catch (e) {
		console.error(`[SessionStatus] Failed to subscribe to session ${sessionId}:`, e);
	}
}

/**
 * Mark a session as read (user has viewed it)
 */
export function markSessionAsRead(sessionId: string): void {
	const sessionList = sessions.value;
	const session = sessionList.find((s) => s.id === sessionId);
	if (!session) return;

	const newCounts = new Map(lastSeenMessageCounts.value);
	newCounts.set(sessionId, session.metadata.messageCount);
	lastSeenMessageCounts.value = newCounts;
	saveLastSeenCounts(newCounts);
}

/**
 * Check if a session has unread messages
 */
export function hasUnreadMessages(sessionId: string): boolean {
	const sessionList = sessions.value;
	const session = sessionList.find((s) => s.id === sessionId);
	if (!session) return false;

	// If this is the currently selected session, it's not unread
	if (currentSessionIdSignal.value === sessionId) return false;

	const lastSeen = lastSeenMessageCounts.value.get(sessionId) ?? 0;
	const currentCount = session.metadata.messageCount || 0;

	return currentCount > lastSeen;
}

/**
 * Get the processing state for a session
 */
export function getSessionProcessingState(sessionId: string): AgentProcessingState {
	return sessionProcessingStates.value.get(sessionId) ?? { status: 'idle' };
}

/**
 * Get full status info for a session
 */
export function getSessionStatus(sessionId: string): SessionStatusInfo {
	return {
		processingState: getSessionProcessingState(sessionId),
		hasUnread: hasUnreadMessages(sessionId),
	};
}

/**
 * Computed signal: all session statuses
 * Use this for reactive updates in UI
 */
export const allSessionStatuses = computed<Map<string, SessionStatusInfo>>(() => {
	const statuses = new Map<string, SessionStatusInfo>();

	// Trigger reactivity by accessing the signals
	const processingStates = sessionProcessingStates.value;
	const lastSeen = lastSeenMessageCounts.value;
	const sessionList = sessions.value;
	const currentId = currentSessionIdSignal.value;

	for (const session of sessionList) {
		const processingState = processingStates.get(session.id) ?? { status: 'idle' };

		// Calculate unread status
		const lastSeenCount = lastSeen.get(session.id) ?? 0;
		const currentCount = session.metadata.messageCount || 0;
		const hasUnread = currentId !== session.id && currentCount > lastSeenCount;

		statuses.set(session.id, {
			processingState,
			hasUnread,
		});
	}

	return statuses;
});

/**
 * Get processing phase color (matches ContextIndicator colors)
 */
export function getProcessingPhaseColor(
	state: AgentProcessingState
): { dot: string; text: string } | null {
	if (state.status === 'idle' || state.status === 'interrupted') {
		return null;
	}

	if (state.status === 'queued') {
		return { dot: 'bg-yellow-500', text: 'text-yellow-400' };
	}

	// Processing state
	if (state.status === 'processing') {
		switch (state.phase) {
			case 'initializing':
				return { dot: 'bg-yellow-500', text: 'text-yellow-400' };
			case 'thinking':
				return { dot: 'bg-blue-500', text: 'text-blue-400' };
			case 'streaming':
				return { dot: 'bg-green-500', text: 'text-green-400' };
			case 'finalizing':
				return { dot: 'bg-purple-500', text: 'text-purple-400' };
			default:
				return { dot: 'bg-purple-500', text: 'text-purple-400' };
		}
	}

	return null;
}
