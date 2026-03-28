/**
 * Room session utilities
 *
 * Shared helpers for working with room session IDs.
 */

/**
 * Internal room-management session prefixes that are NOT worker sessions.
 * Any session ID that starts with one of these belongs to the room's internal
 * infrastructure (chat agent, self-reflection, craft, leader) and should be
 * excluded when counting or listing worker sessions.
 *
 * Add new prefixes here when new internal session types are introduced.
 */
const INTERNAL_SESSION_PREFIXES = [
	'room:chat:',
	'room:self:',
	'room:craft:',
	'room:lead:',
] as const;

/**
 * Returns true when `sessionId` is a worker (non-internal) session.
 * Internal management sessions (chat, self, craft, lead) return false.
 */
export function isWorkerSessionId(sessionId: string): boolean {
	return INTERNAL_SESSION_PREFIXES.every((prefix) => !sessionId.startsWith(prefix));
}
