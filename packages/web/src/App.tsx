import { useEffect } from 'preact/hooks';
import { effect, batch } from '@preact/signals';
import { NavRail } from './islands/NavRail.tsx';
import { ContextPanel } from './islands/ContextPanel.tsx';
import { NeoChatPanel } from './islands/NeoChatPanel.tsx';
import MainContent from './islands/MainContent.tsx';
import ToastContainer from './islands/ToastContainer.tsx';
import { ConnectionOverlay } from './components/ConnectionOverlay.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { initializeApplicationState } from './lib/state.ts';
import { currentSessionIdSignal, currentRoomIdSignal, navRailOpenSignal } from './lib/signals.ts';
import { initSessionStatusTracking } from './lib/session-status.ts';
import { globalStore } from './lib/global-store.ts';
import { sessionStore } from './lib/session-store.ts';
import {
	initializeRouter,
	navigateToSession,
	navigateToHome,
	createSessionPath,
} from './lib/router.ts';

export function App() {
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

		// STEP 4: Sync URL when session changes from external sources
		// (e.g., session created/deleted in another tab)
		// This effect watches for signal changes and updates the URL
		return effect(() => {
			const sessionId = currentSessionIdSignal.value;
			const currentPath = window.location.pathname;
			const expectedPath = sessionId ? createSessionPath(sessionId) : '/';

			// Only update URL if it's out of sync
			// This prevents unnecessary history updates and loops
			if (currentPath !== expectedPath) {
				if (sessionId) {
					navigateToSession(sessionId, true); // replace=true to avoid polluting history
				} else {
					navigateToHome(true);
				}
			}
		});
	}, []);

	return (
		<>
			<div class="flex h-dvh overflow-hidden bg-dark-950 relative" style={{ height: '100dvh' }}>
				{/* Mobile hamburger menu button - only show when not in a session (lobby/rooms view) */}
				{!currentSessionIdSignal.value && (
					<button
						onClick={() => (navRailOpenSignal.value = true)}
						class="fixed top-4 left-4 z-30 md:hidden p-2 rounded-lg bg-dark-900 hover:bg-dark-800 text-gray-400 hover:text-gray-100 transition-colors"
						title="Open navigation"
						aria-label="Open navigation menu"
					>
						<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M4 6h16M4 12h16M4 18h16"
							/>
						</svg>
					</button>
				)}

				{/* Navigation Rail */}
				<NavRail />

				{/* Context Panel */}
				<ContextPanel />

				{/* Main Content */}
				<MainContent />

				{/* Neo Chat Panel - only show when in a room */}
				{currentRoomIdSignal.value && <NeoChatPanel />}
			</div>

			{/* Global Toast Container */}
			<ToastContainer />

			{/* Connection Overlay - blocks UI when disconnected */}
			<ConnectionOverlay />
		</>
	);
}
