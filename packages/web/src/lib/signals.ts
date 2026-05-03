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

// Navigation section signal - which nav item is active
export type NavSection = 'chats' | 'inbox' | 'spaces' | 'settings';
export const navSectionSignal = signal<NavSection>('spaces');

// Space navigation signals
export const currentSpaceIdSignal = signal<string | null>(null);
export const currentSpaceSessionIdSignal = signal<string | null>(null);
export const currentSpaceTaskIdSignal = signal<string | null>(null);
export type SpaceViewMode = 'overview' | 'tasks' | 'sessions' | 'configure';
export const currentSpaceViewModeSignal = signal<SpaceViewMode>('overview');

// Configure sub-tab (agents | workflows | settings) — driven by URL
export type SpaceConfigureTab = 'agents' | 'workflows' | 'settings';
export const currentSpaceConfigureTabSignal = signal<SpaceConfigureTab>('agents');

// Tasks filter tab (action | active | draft | completed | archived) — driven by URL
export type SpaceTasksFilterTab = 'action' | 'active' | 'completed' | 'archived' | 'draft';
export const currentSpaceTasksFilterTabSignal = signal<SpaceTasksFilterTab>('active');

// Task detail sub-view (thread | canvas | artifacts) — driven by URL
export type SpaceTaskViewTab = 'thread' | 'canvas' | 'artifacts';
export const currentSpaceTaskViewTabSignal = signal<SpaceTaskViewTab>('thread');

// Overlay signals — session shown in slide-over panel on top of the current view
// When spaceOverlaySessionIdSignal is set, opens AgentOverlayChat without replacing the task/overview view
export const spaceOverlaySessionIdSignal = signal<string | null>(null);
// Human-readable label for the overlay header (e.g. "View Leader Session", "manual-se")
export const spaceOverlayAgentNameSignal = signal<string | null>(null);
// Optional message UUID to scroll into view + briefly highlight when the overlay
// opens. Set when the user opens a session from a specific message in the
// minimal thread feed so they land on the message they clicked instead of the
// session's tail. Cleared along with the other overlay signals on close.
export const spaceOverlayHighlightMessageIdSignal = signal<string | null>(null);
// Task messaging context for live workflow node-agent overlays. When set, sends
// from AgentOverlayChat route through space.task.sendMessage instead of the
// generic message.send RPC so they target the already-live workflow sub-session.
export interface SpaceOverlayTaskContext {
	taskId: string;
	agentName: string;
	nodeExecutionId?: string | null;
}

export const spaceOverlayTaskContextSignal = signal<SpaceOverlayTaskContext | null>(null);
// Pending-agent overlay routing — set when the user opens a not-started peer
// from the task agent dropdown. The overlay renders a "Starting…" composer
// against the agent name; on first send it invokes
// `space.task.activateNodeAgent` to lazily spawn the workflow node, and
// hydrates to a normal chat overlay as soon as the live session appears in
// `taskActivity`. Both signals are cleared together on close.
export const spaceOverlayPendingTaskIdSignal = signal<string | null>(null);
export const spaceOverlayPendingAgentNameSignal = signal<string | null>(null);

// Mobile drawer signals
export const contextPanelOpenSignal = signal<boolean>(false);

// Settings section signal - which settings section is active
export type SettingsSection =
	| 'general'
	| 'providers'
	| 'app-mcp-servers'
	| 'skills'
	| 'models'
	| 'neo'
	| 'usage'
	| 'about';
export const settingsSectionSignal = signal<SettingsSection>('general');
