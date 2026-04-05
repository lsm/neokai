import { signal } from '@preact/signals';
import type { Session } from '@neokai/shared';

// Shared signal for the current session ID - always starts as null
// Refreshing the page will return to recent conversations view
export const currentSessionIdSignal = signal<string | null>(null);

// Shared signal for the current room ID - always starts as null
// When set, takes priority over session signal
export const currentRoomIdSignal = signal<string | null>(null);

// Shared signal for the current room's inner session ID
// When viewing a room and clicking a session, this shows that session within the room layout
export const currentRoomSessionIdSignal = signal<string | null>(null);

// Shared signal for the current room's task detail view
// When set, shows the TaskView (Craft + Lead sessions) for the selected task
export const currentRoomTaskIdSignal = signal<string | null>(null);

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
export type NavSection = 'home' | 'chats' | 'rooms' | 'inbox' | 'projects' | 'spaces' | 'settings';
export const navSectionSignal = signal<NavSection>('home');

// Space navigation signals
export const currentSpaceIdSignal = signal<string | null>(null);
export const currentSpaceSessionIdSignal = signal<string | null>(null);
export const currentSpaceTaskIdSignal = signal<string | null>(null);
export type SpaceViewMode = 'overview' | 'configure';
export const currentSpaceViewModeSignal = signal<SpaceViewMode>('overview');

// Overlay signals — session shown in slide-over panel on top of the current view
// When spaceOverlaySessionIdSignal is set, opens AgentOverlayChat without replacing the task/overview view
export const spaceOverlaySessionIdSignal = signal<string | null>(null);
// Human-readable label for the overlay header (e.g. "View Leader Session", "manual-se")
export const spaceOverlayAgentNameSignal = signal<string | null>(null);

// Mobile drawer signals
export const contextPanelOpenSignal = signal<boolean>(false);

// Create Room modal open state - shared between ContextPanel and Lobby
export const createRoomModalSignal = signal<boolean>(false);

// Room tab navigation signal - set this to navigate to a specific room tab
// Room.tsx watches this and switches activeTab accordingly, then clears it
export const currentRoomTabSignal = signal<string | null>(null);

// Persistent signal tracking the current room's active tab
// This persists across renders unlike currentRoomTabSignal which is transient
export const currentRoomActiveTabSignal = signal<string | null>(null);

// Whether the room agent chat tab is active (driven by /room/:roomId/agent URL)
// When true, Room.tsx renders the Chat tab instead of session takeover
export const currentRoomAgentActiveSignal = signal<boolean>(false);

// Settings section signal - which settings section is active
export type SettingsSection =
	| 'general'
	| 'providers'
	| 'mcp-servers'
	| 'app-mcp-servers'
	| 'skills'
	| 'fallback-models'
	| 'neo'
	| 'usage'
	| 'about';
export const settingsSectionSignal = signal<SettingsSection>('general');
