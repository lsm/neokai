import { navSectionSignal, type NavSection } from '../lib/signals.ts';
import { navigateToChats, navigateToRooms, navigateToSettings } from '../lib/router.ts';
import { NavIconButton } from '../components/ui/NavIconButton.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import { connectionState } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';

export function NavRail() {
	const navSection = navSectionSignal.value;

	const handleNavClick = (section: NavSection) => {
		switch (section) {
			case 'chats':
				navigateToChats();
				break;
			case 'rooms':
				navigateToRooms();
				break;
			case 'settings':
				navigateToSettings();
				break;
			case 'projects':
				// Future feature - do nothing for now
				break;
		}
	};

	return (
		<div
			class={`hidden md:flex w-16 flex-col items-center py-4 bg-dark-950 border-r ${borderColors.ui.default}`}
		>
			{/* Logo */}
			<div class="text-2xl mb-6" title="NeoKai">
				🤖
			</div>

			{/* Nav Items */}
			<nav class="flex-1 flex flex-col gap-1">
				<NavIconButton
					active={navSection === 'chats'}
					onClick={() => handleNavClick('chats')}
					label="Chats"
				>
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
						/>
					</svg>
				</NavIconButton>

				<NavIconButton
					active={navSection === 'rooms'}
					onClick={() => handleNavClick('rooms')}
					label="Rooms"
				>
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
						/>
					</svg>
				</NavIconButton>

				<NavIconButton active={navSection === 'projects'} disabled label="Projects (Coming Soon)">
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
						/>
					</svg>
				</NavIconButton>
			</nav>

			{/* Bottom - Daemon Status & Settings */}
			<div class="mt-auto flex flex-col gap-1">
				{/* Daemon Connection Status Indicator */}
				<DaemonStatusIndicator />

				<NavIconButton
					active={navSection === 'settings'}
					onClick={() => handleNavClick('settings')}
					label="Settings"
				>
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
						/>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
						/>
					</svg>
				</NavIconButton>
			</div>
		</div>
	);
}

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
function DaemonStatusIndicator() {
	const state = connectionState.value;

	// Determine status color and label
	let dotColor: string;
	let statusLabel: string;
	let showPulse = false;

	switch (state) {
		case 'connected':
			dotColor = 'bg-green-500';
			statusLabel = 'Daemon: Connected';
			showPulse = true;
			break;
		case 'connecting':
			dotColor = 'bg-yellow-500';
			statusLabel = 'Daemon: Connecting...';
			showPulse = true;
			break;
		case 'reconnecting':
			dotColor = 'bg-yellow-500';
			statusLabel = 'Daemon: Reconnecting...';
			showPulse = true;
			break;
		case 'disconnected':
			dotColor = 'bg-gray-500';
			statusLabel = 'Daemon: Offline';
			break;
		case 'error':
		case 'failed':
		default:
			dotColor = 'bg-red-500';
			statusLabel = 'Daemon: Error';
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
