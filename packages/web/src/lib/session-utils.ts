import type { Session } from '@neokai/shared';

/**
 * Session types created by users (not internal Room Runtime agents).
 * undefined = legacy sessions created before typing was introduced.
 */
const USER_SESSION_TYPES = new Set<string | undefined>(['worker', undefined]);

/**
 * Check if a session is user-created (as opposed to internal Room Runtime agents).
 *
 * Filters out sessions like "Leader Agent", "Coder Agent", "Planner Agent"
 * that are internal to Room Runtime and confuse users when shown in the Lobby
 * or Sessions list.
 */
export function isUserSession(session: Session): boolean {
	return USER_SESSION_TYPES.has(session.type) && !session.context?.roomId;
}
