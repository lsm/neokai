/**
 * Shared E2E Test Selectors
 *
 * Central place for all test selector constants to avoid duplication
 * and ensure consistency when placeholders change.
 */

/**
 * Matches the standalone session chat textarea ("Ask or make anything...").
 * Excludes Neo panel's "Ask Neo…" input via the exact placeholder match.
 */
export const CHAT_INPUT_SELECTOR = 'textarea[placeholder="Ask or make anything..."]';
