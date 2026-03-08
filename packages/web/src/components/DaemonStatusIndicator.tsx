import { connectionState } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { t } from '../lib/i18n';

/**
 * Daemon Status Indicator
 *
 * Shows connection status to the daemon with a colored dot:
 * - Green + pulsing: connected
 * - Yellow + pulse: connecting/reconnecting
 * - Gray: disconnected
 * - Red: error/failed
 *
 * Click to reconnect when not connected.
 */
export function DaemonStatusIndicator() {
	const state = connectionState.value;

	// Determine status color and label
	let dotColor: string;
	let statusLabel: string;
	let showPulse = false;

	switch (state) {
		case 'connected':
			dotColor = 'bg-green-500';
			statusLabel = t('daemon.connected');
			showPulse = true;
			break;
		case 'connecting':
			dotColor = 'bg-yellow-500';
			statusLabel = t('daemon.connecting');
			showPulse = true;
			break;
		case 'reconnecting':
			dotColor = 'bg-yellow-500';
			statusLabel = t('daemon.reconnecting');
			showPulse = true;
			break;
		case 'disconnected':
			dotColor = 'bg-gray-500';
			statusLabel = t('daemon.offline');
			break;
		case 'error':
		case 'failed':
		default:
			dotColor = 'bg-red-500';
			statusLabel = t('daemon.error');
			break;
	}

	const isConnected = state === 'connected';
	const canReconnect = state === 'disconnected' || state === 'error' || state === 'failed';

	const handleClick = () => {
		if (canReconnect) {
			connectionManager.reconnect();
		}
	};

	return (
		<button
			onClick={handleClick}
			disabled={!canReconnect}
			aria-label={statusLabel}
			aria-pressed={isConnected}
			class={`
				w-12 h-12 flex items-center justify-center rounded-lg
				transition-colors
				${canReconnect ? 'cursor-pointer hover:bg-dark-800' : 'cursor-default'}
			`}
			title={statusLabel}
		>
			<div class="relative flex items-center justify-center">
				{/* Main dot */}
				<span class={`w-3 h-3 ${dotColor} rounded-full block`} />
				{/* Pulse animation for connected/connecting states */}
				{showPulse && (
					<span
						class={`absolute inset-0 w-3 h-3 ${dotColor} rounded-full ${isConnected ? 'animate-ping opacity-75' : 'animate-pulse'}`}
					/>
				)}
			</div>
		</button>
	);
}
