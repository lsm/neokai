/**
 * Shared E2E Test Selectors
 *
 * Central place for all test selector constants to avoid duplication
 * and ensure consistency when placeholders change.
 */

/**
 * Matches both room agent ("Chat with...") and standalone session ("Ask or make...") textareas.
 * Neo panel's "Ask Neo…" is excluded by not using a generic "Ask" match.
 */
export const CHAT_INPUT_SELECTOR =
	'textarea[placeholder*="room coordinator"], textarea[placeholder="Ask or make anything..."]';
