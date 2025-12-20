import { useEffect } from 'preact/hooks';
import Sidebar from './islands/Sidebar.tsx';
import MainContent from './islands/MainContent.tsx';
import ToastContainer from './islands/ToastContainer.tsx';
import { ConnectionOverlay } from './components/ConnectionOverlay.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { initializeApplicationState } from './lib/state.ts';
import { currentSessionIdSignal } from './lib/signals.ts';

export function App() {
	useEffect(() => {
		// Initialize state management when app mounts
		const init = async () => {
			try {
				// Wait for MessageHub connection to be ready
				const hub = await connectionManager.getHub();

				// Initialize state channels now that connection is ready
				await initializeApplicationState(hub, currentSessionIdSignal);
				console.log('[App] State management initialized successfully');
			} catch (error) {
				console.error('[App] Failed to initialize state management:', error);
			}
		};

		init();
	}, []);

	return (
		<>
			<div class="flex h-screen overflow-hidden bg-dark-950 relative">
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
