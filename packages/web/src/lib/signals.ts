import { signal } from '@preact/signals';
import type { Session } from '@neokai/shared';

// Shared signal for the current session ID - always starts as null
// Refreshing the page will return to recent conversations view
export const currentSessionIdSignal = signal<string | null>(null);

// Shared signal for sidebar open/closed state on mobile
export const sidebarOpenSignal = signal<boolean>(false);

/**
 * @deprecated Use the reactive state channels from lib/state.ts instead:
 * - sessions: import { sessions } from "../lib/state.ts"
 * This signal is kept for backward compatibility but will be removed in the future.
 */
export const sessionsSignal = signal<Session[]>([]);

// Shared signal for available slash commands from SDK
// TODO: Migrate to state channels when slash commands are added to state management
export const slashCommandsSignal = signal<string[]>([]);

// Shared signal for the current settings section (e.g., 'general', 'model', 'mcp')
// Used for both global and session settings pages
export const currentSettingsSectionSignal = signal<string | null>(null);

// Shared signal for the session ID being edited in session settings view
// When set, indicates we're viewing session settings; null indicates global settings
export const settingsSessionIdSignal = signal<string | null>(null);
