import { useEffect } from 'preact/hooks';
import { effect } from '@preact/signals';
import Sidebar from './islands/Sidebar.tsx';
import MainContent from './islands/MainContent.tsx';
import ToastContainer from './islands/ToastContainer.tsx';
import { ConnectionOverlay } from './components/ConnectionOverlay.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { initializeApplicationState } from './lib/state.ts';
import { currentSessionIdSignal } from './lib/signals.ts';
import { initSessionStatusTracking } from './lib/session-status.ts';
import { globalStore } from './lib/global-store.ts';
import { sessionStore } from './lib/session-store.ts';

export function App() {
	useEffect(() => {
		// Initialize state management when app mounts
		const init = async () => {
			try {
				// Wait for MessageHub connection to be ready
				const hub = await connectionManager.getHub();

				// Initialize new unified stores (Phase 3 migration)
				await globalStore.initialize();
				console.log('[App] GlobalStore initialized successfully');

				// Initialize legacy state channels (will be removed in Phase 5)
				await initializeApplicationState(hub, currentSessionIdSignal);
				console.log('[App] Legacy state management initialized successfully');

				// Initialize session status tracking for sidebar live indicators
				initSessionStatusTracking();
				console.log('[App] Session status tracking initialized');

				// Sync currentSessionIdSignal with sessionStore.select()
				// This bridges the old signal-based approach with the new store
				effect(() => {
					const sessionId = currentSessionIdSignal.value;
					sessionStore.select(sessionId);
				});
			} catch (error) {
				console.error('[App] Failed to initialize state management:', error);
			}
		};

		init();
	}, []);

	return (
		<>
			<div class="flex h-dvh overflow-hidden bg-dark-950 relative" style={{ height: '100dvh' }}>
				{/* Sidebar */}
				<Sidebar />

				{/* Main Content */}
				<MainContent />
			</div>

			{/* Global Toast Container */}
			<ToastContainer />

			{/* Connection Overlay - blocks UI when disconnected */}
			<ConnectionOverlay />
		</>
	);
}
