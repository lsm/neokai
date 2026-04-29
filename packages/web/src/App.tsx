import { useEffect } from 'preact/hooks';
import { effect, batch } from '@preact/signals';
import { useNeoKeyboardShortcut } from './hooks/useNeoKeyboardShortcut.ts';
import { useViewportSafety } from './hooks/useViewportSafety.ts';

import { NavRail } from './islands/NavRail.tsx';
import { ContextPanel } from './islands/ContextPanel.tsx';
import MainContent from './islands/MainContent.tsx';
import ToastContainer from './islands/ToastContainer.tsx';
import { ConnectionOverlay } from './components/ConnectionOverlay.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { initializeApplicationState } from './lib/state.ts';
import {
	currentSessionIdSignal,
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSpaceViewModeSignal,
	currentSpaceConfigureTabSignal,
	currentSpaceTasksFilterTabSignal,
	currentSpaceTaskViewTabSignal,
	navSectionSignal,
} from './lib/signals.ts';
import { initSessionStatusTracking } from './lib/session-status.ts';
import { globalStore } from './lib/global-store.ts';
import { sessionStore } from './lib/session-store.ts';
import {
	initializeRouter,
	navigateToSession,
	navigateToHome,
	navigateToSessions,
	navigateToSpacesPage,
	navigateToSpace,
	navigateToSpaceConfigure,
	navigateToSpaceSessions,
	navigateToSpaceTasks,
	navigateToSpaceAgent,
	navigateToSpaceSession,
	navigateToSpaceTask,
	navigateToInbox,
	navigateToSettings,
	createSessionPath,
	createSpacePath,
	createSpaceConfigurePath,
	createSpaceSessionsPath,
	createSpaceTasksPath,
	createSpaceAgentPath,
	createSpaceSessionPath,
	createSpaceTaskPath,
} from './lib/router.ts';

export function App() {
	// Global Cmd+J / Ctrl+J shortcut to toggle the Neo panel
	useNeoKeyboardShortcut();
	// Set --safe-height CSS custom property on iPad Safari for correct viewport sizing
	useViewportSafety();

	useEffect(() => {
		// STEP 1: Initialize URL-based router BEFORE any state management
		// This ensures we read the session ID from URL on page load
		const initialSessionId = initializeRouter();

		// STEP 2: Initialize state management when app mounts
		const init = async () => {
			try {
				// Wait for MessageHub connection to be ready
				const hub = await connectionManager.getHub();

				// Initialize new unified stores (Phase 3 migration)
				await globalStore.initialize();

				// Initialize legacy state channels (will be removed in Phase 5)
				// Pass initialSessionId so state channels know the URL state
				await initializeApplicationState(hub, currentSessionIdSignal);

				// Initialize session status tracking for sidebar live indicators
				initSessionStatusTracking();

				// Sync currentSessionIdSignal with sessionStore.select()
				// This bridges the old signal-based approach with the new store
				effect(() => {
					const sessionId = currentSessionIdSignal.value;
					const spaceSessionId = currentSpaceSessionIdSignal.value;
					// Don't clobber sessions managed by space routes
					// (ChatContainer calls sessionStore.select directly in that case)
					if (spaceSessionId) return;
					sessionStore.select(sessionId);
				});

				// STEP 3: After connection is ready, restore session from URL
				// If the URL has a session ID, set it in the signal
				// This is done AFTER state is initialized to ensure proper syncing
				if (initialSessionId) {
					batch(() => {
						currentSessionIdSignal.value = initialSessionId;
					});
				}
			} catch {
				// State initialization failed - app will use default state
			}
		};

		init();

		// STEP 4: Sync URL when session/space changes from external sources
		// (e.g., session created/deleted in another tab)
		// This effect watches for signal changes and updates the URL
		return effect(() => {
			const sessionId = currentSessionIdSignal.value;
			const spaceId = currentSpaceIdSignal.value;
			const spaceSessionId = currentSpaceSessionIdSignal.value;
			const spaceTaskId = currentSpaceTaskIdSignal.value;
			const spaceViewMode = currentSpaceViewModeSignal.value;
			const spaceConfigureTab = currentSpaceConfigureTabSignal.value;
			const spaceTasksFilterTab = currentSpaceTasksFilterTabSignal.value;
			const spaceTaskViewTab = currentSpaceTaskViewTabSignal.value;
			const navSection = navSectionSignal.value;
			const currentPath = window.location.pathname;
			const isSpaceAgentRoute = !!(
				spaceSessionId &&
				spaceId &&
				spaceSessionId === `space:chat:${spaceId}`
			);
			const expectedPath = sessionId
				? createSessionPath(sessionId)
				: spaceTaskId && spaceId
					? createSpaceTaskPath(
							spaceId,
							spaceTaskId,
							spaceTaskViewTab !== 'thread' ? spaceTaskViewTab : undefined
						)
					: isSpaceAgentRoute
						? createSpaceAgentPath(spaceId)
						: spaceSessionId && spaceId
							? createSpaceSessionPath(spaceId, spaceSessionId)
							: spaceId && spaceViewMode === 'sessions'
								? createSpaceSessionsPath(spaceId)
								: spaceId && spaceViewMode === 'tasks'
									? createSpaceTasksPath(
											spaceId,
											spaceTasksFilterTab !== 'active' ? spaceTasksFilterTab : undefined
										)
									: spaceId && spaceViewMode === 'configure'
										? createSpaceConfigurePath(
												spaceId,
												spaceConfigureTab !== 'agents' ? spaceConfigureTab : undefined
											)
										: spaceId
											? createSpacePath(spaceId)
											: navSection === 'chats'
												? '/sessions'
												: navSection === 'settings'
													? '/settings'
													: navSection === 'inbox'
														? '/inbox'
														: '/spaces';

			// Only update URL if it's out of sync
			// This prevents unnecessary history updates and loops
			if (currentPath !== expectedPath) {
				if (sessionId) {
					navigateToSession(sessionId, true); // replace=true to avoid polluting history
				} else if (spaceTaskId && spaceId) {
					navigateToSpaceTask(
						spaceId,
						spaceTaskId,
						spaceTaskViewTab !== 'thread' ? spaceTaskViewTab : undefined,
						true
					);
				} else if (isSpaceAgentRoute) {
					navigateToSpaceAgent(spaceId, true);
				} else if (spaceSessionId && spaceId) {
					navigateToSpaceSession(spaceId, spaceSessionId, true);
				} else if (spaceId && spaceViewMode === 'sessions') {
					navigateToSpaceSessions(spaceId, true);
				} else if (spaceId && spaceViewMode === 'tasks') {
					navigateToSpaceTasks(spaceId, undefined, true);
				} else if (spaceId && spaceViewMode === 'configure') {
					navigateToSpaceConfigure(spaceId, undefined, true);
				} else if (spaceId) {
					navigateToSpace(spaceId, true);
				} else if (navSection === 'spaces') {
					navigateToSpacesPage(true);
				} else if (navSection === 'chats') {
					navigateToSessions(true);
				} else if (navSection === 'settings') {
					navigateToSettings(true);
				} else if (navSection === 'inbox') {
					navigateToInbox(true);
				} else {
					navigateToHome(true);
				}
			}
		});
	}, []);

	return (
		<>
			<div class="flex h-dvh overflow-hidden bg-dark-950 relative pt-safe">
				{/* Navigation Rail (desktop only) */}
				<NavRail />

				{/* Context Panel - always visible */}
				<ContextPanel />

				{/* Main Content — BottomTabBar is inline (flex-shrink-0) so no extra padding needed */}
				<div class="flex-1 flex flex-col overflow-hidden min-w-0">
					<MainContent />
				</div>
			</div>

			{/* Global Toast Container */}
			<ToastContainer />

			{/* Connection Overlay - blocks UI when disconnected */}
			<ConnectionOverlay />

			{/* Neo AI Assistant Panel — disabled */}
			{/* <NeoPanel /> */}
		</>
	);
}
