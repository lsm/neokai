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

// Shared signal for the current room's mission (goal) detail view
// When set, shows the MissionDetail page for the selected mission
export const currentRoomGoalIdSignal = signal<string | null>(null);

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
export type NavSection = 'chats' | 'rooms' | 'inbox' | 'projects' | 'spaces' | 'settings';
export const navSectionSignal = signal<NavSection>('rooms');

// Space navigation signals
export const currentSpaceIdSignal = signal<string | null>(null);
export const currentSpaceSessionIdSignal = signal<string | null>(null);
export const currentSpaceTaskIdSignal = signal<string | null>(null);
export type SpaceViewMode = 'overview' | 'tasks' | 'sessions' | 'configure';
export const currentSpaceViewModeSignal = signal<SpaceViewMode>('overview');

// Configure sub-tab (agents | workflows | settings) — driven by URL
export type SpaceConfigureTab = 'agents' | 'workflows' | 'settings';
export const currentSpaceConfigureTabSignal = signal<SpaceConfigureTab>('agents');

// Tasks filter tab (action | active | completed | archived) — driven by URL
export type SpaceTasksFilterTab = 'action' | 'active' | 'completed' | 'archived';
export const currentSpaceTasksFilterTabSignal = signal<SpaceTasksFilterTab>('active');

// Task detail sub-view (thread | canvas | artifacts) — driven by URL
export type SpaceTaskViewTab = 'thread' | 'canvas' | 'artifacts';
export const currentSpaceTaskViewTabSignal = signal<SpaceTaskViewTab>('thread');

// Tasks-view pre-filter, used by callers like the SpaceOverview awaiting-approval
// summary to deep-link into a filtered tasks list (e.g. "completion-action pauses
// only"). Set on navigation; SpaceTasks consumes it and reverts to null on the
// next explicit tab click to avoid sticky filters. Kept as a signal rather than
// a URL query param to avoid URL churn when the count drops to zero.
export type SpaceTasksFilter = 'awaiting_completion_action' | null;
export const currentSpaceTasksFilterSignal = signal<SpaceTasksFilter>(null);

// Overlay signals — session shown in slide-over panel on top of the current view
// When spaceOverlaySessionIdSignal is set, opens AgentOverlayChat without replacing the task/overview view
export const spaceOverlaySessionIdSignal = signal<string | null>(null);
// Human-readable label for the overlay header (e.g. "View Leader Session", "manual-se")
export const spaceOverlayAgentNameSignal = signal<string | null>(null);

// Mobile drawer signals
export const contextPanelOpenSignal = signal<boolean>(false);

// Create Room modal open state - shared between ContextPanel and Lobby
export const createRoomModalSignal = signal<boolean>(false);

// Persistent signal tracking the current room's active tab
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
