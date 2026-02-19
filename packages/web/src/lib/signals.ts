import { signal } from '@preact/signals';
import type { Session } from '@neokai/shared';

// Shared signal for the current session ID - always starts as null
// Refreshing the page will return to recent conversations view
export const currentSessionIdSignal = signal<string | null>(null);

// Shared signal for the current room ID - always starts as null
// When set, takes priority over session signal
export const currentRoomIdSignal = signal<string | null>(null);

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

// Navigation section signal - which nav item is active
export type NavSection = 'chats' | 'rooms' | 'projects' | 'settings';
export const navSectionSignal = signal<NavSection>('chats');

// Mobile drawer signals
export const contextPanelOpenSignal = signal<boolean>(false);

// Lobby Manager panel signal
export const lobbyManagerOpenSignal = signal<boolean>(false);

// NavRail mobile open state
export const navRailOpenSignal = signal<boolean>(false);

// Settings section signal - which settings section is active
export type SettingsSection = 'general' | 'mcp-servers' | 'about';
export const settingsSectionSignal = signal<SettingsSection>('general');
