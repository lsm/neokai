/**
 * ConnectionOverlay Component
 *
 * Displays a blocking overlay when WebSocket connection is lost or failed.
 * Provides clear messaging and reconnection options to the user.
 */

import { connectionState } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { Button } from './ui/Button.tsx';
import { useState } from 'preact/hooks';

/**
 * Helper to check if connection state requires overlay
 */
function isOfflineState(
	state: typeof connectionState.value
): state is 'disconnected' | 'failed' | 'error' {
	return state === 'disconnected' || state === 'failed' || state === 'error';
}

export function ConnectionOverlay() {
	const state = connectionState.value;
	const [reconnecting, setReconnecting] = useState(false);

	// Only show overlay for offline/failed states
	// Don't show for 'connecting' or 'reconnecting' as those are transient
	if (!isOfflineState(state)) {
		return null;
	}

	const handleReconnect = async () => {
		setReconnecting(true);
		try {
			await connectionManager.reconnect();
		} catch (error) {
			console.error('[ConnectionOverlay] Reconnect failed:', error);
		} finally {
			setReconnecting(false);
		}
	};

	const handleRefresh = () => {
		window.location.reload();
	};

	const getMessage = () => {
		switch (state) {
			case 'failed':
				return {
					title: 'Connection Failed',
					description: 'Unable to establish connection after multiple attempts.',
					icon: '🔌',
				};
			case 'error':
				return {
					title: 'Connection Error',
					description: 'An error occurred with the server connection.',
					icon: '⚠️',
				};
			case 'disconnected':
			default:
				return {
					title: 'Connection Lost',
					description: 'The connection to the server was interrupted.',
					icon: '📡',
				};
		}
	};

	const { title, description, icon } = getMessage();

	return (
		<div class="fixed inset-0 z-[10000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
			<div class="bg-dark-800 border border-dark-600 p-6 rounded-xl text-center max-w-md w-full shadow-2xl animate-slideIn">
				<div class="text-5xl mb-4">{icon}</div>
				<h2 class="text-xl font-bold text-white mb-2">{title}</h2>
				<p class="text-gray-400 mb-6">{description}</p>

				<div class="flex gap-3 justify-center">
					<Button onClick={handleReconnect} loading={reconnecting} disabled={reconnecting}>
						{reconnecting ? 'Reconnecting...' : 'Reconnect'}
					</Button>
					<Button variant="secondary" onClick={handleRefresh} disabled={reconnecting}>
						Refresh Page
					</Button>
				</div>

				{state === 'failed' && (
					<p class="text-xs text-gray-500 mt-4">
						If the problem persists, check your network connection or try restarting the server.
					</p>
				)}
			</div>
		</div>
	);
}
