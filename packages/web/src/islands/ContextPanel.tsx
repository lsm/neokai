import { useState } from 'preact/hooks';
import { navSectionSignal, contextPanelOpenSignal } from '../lib/signals.ts';
import { authStatus, connectionState, apiConnectionStatus } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { createSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { navigateToSession, navigateToRoom } from '../lib/router.ts';
import { lobbyStore } from '../lib/lobby-store.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { Button } from '../components/ui/Button.tsx';
import { SessionList } from './SessionList.tsx';
import { RoomList } from './RoomList.tsx';
import { ConnectionNotReadyError } from '../lib/errors.ts';

export function ContextPanel() {
	const [creatingSession, setCreatingSession] = useState(false);
	const [creatingRoom, setCreatingRoom] = useState(false);

	const navSection = navSectionSignal.value;
	const isPanelOpen = contextPanelOpenSignal.value;

	// Section config
	const sectionConfig = {
		chats: {
			title: 'Chats',
			emptyIcon: '💬',
			emptyTitle: 'No sessions yet',
			emptyDesc: 'Start a new session to begin',
			actionLabel: 'New Session',
		},
		rooms: {
			title: 'Rooms',
			emptyIcon: '🏢',
			emptyTitle: 'No rooms yet',
			emptyDesc: 'Create a room to organize work',
			actionLabel: 'Create Room',
		},
		projects: {
			title: 'Projects',
			emptyIcon: '📁',
			emptyTitle: 'Coming Soon',
			emptyDesc: 'Projects will help organize rooms',
			actionLabel: 'New Project',
		},
		settings: {
			title: 'Settings',
			emptyIcon: '⚙️',
			emptyTitle: 'Settings',
			emptyDesc: 'Configure your preferences',
			actionLabel: 'Open Settings',
		},
	};

	const config = sectionConfig[navSection];

	const handleCreateSession = async () => {
		if (connectionState.value !== 'connected') {
			toast.error('Not connected to server. Please wait...');
			return;
		}

		setCreatingSession(true);

		try {
			const response = await createSession({
				workspacePath: undefined,
			});

			if (!response?.sessionId) {
				toast.error('No sessionId in response');
				return;
			}

			navigateToSession(response.sessionId);
			toast.success('Session created successfully');
		} catch (_err) {
			if (_err instanceof ConnectionNotReadyError) {
				toast.error('Connection lost. Please try again.');
			} else {
				const message = _err instanceof Error ? _err.message : 'Failed to create session';
				toast.error(message);
			}
		} finally {
			setCreatingSession(false);
		}
	};

	const handleCreateRoom = async () => {
		if (connectionState.value !== 'connected') {
			toast.error('Not connected to server. Please wait...');
			return;
		}

		setCreatingRoom(true);

		try {
			const room = await lobbyStore.createRoom({
				name: `Room ${new Date().toLocaleDateString()}`,
				description: '',
			});

			if (room) {
				navigateToRoom(room.id);
				toast.success('Room created successfully');
			}
		} catch (_err) {
			const message = _err instanceof Error ? _err.message : 'Failed to create room';
			toast.error(message);
		} finally {
			setCreatingRoom(false);
		}
	};

	const handleAction = () => {
		switch (navSection) {
			case 'chats':
				handleCreateSession();
				break;
			case 'rooms':
				handleCreateRoom();
				break;
			default:
				break;
		}
	};

	const handlePanelClose = () => {
		contextPanelOpenSignal.value = false;
	};

	const isActionDisabled =
		connectionState.value !== 'connected' ||
		!authStatus.value?.isAuthenticated ||
		navSection === 'projects' ||
		navSection === 'settings';

	const isActionLoading = creatingSession || creatingRoom;

	return (
		<>
			{/* Mobile backdrop */}
			{isPanelOpen && (
				<div class="fixed inset-0 bg-black/50 z-35 md:hidden" onClick={handlePanelClose} />
			)}

			<div
				class={`
					fixed md:relative
					h-screen w-70
					bg-dark-950 border-r ${borderColors.ui.default}
					flex flex-col
					z-40 md:z-auto
					transition-transform duration-300 ease-in-out
					left-0 md:left-auto
					${isPanelOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
				`}
			>
				{/* Header */}
				<div class={`p-4 border-b ${borderColors.ui.default}`}>
					<div class="flex items-center justify-between mb-3">
						<h2 class="text-lg font-semibold text-gray-100">{config.title}</h2>
						{/* Close button for mobile */}
						<button
							onClick={handlePanelClose}
							class="md:hidden p-1.5 hover:bg-dark-800 rounded-lg transition-colors text-gray-400 hover:text-gray-100"
							title="Close panel"
						>
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</button>
					</div>

					{(navSection === 'chats' || navSection === 'rooms') && (
						<Button
							onClick={handleAction}
							loading={isActionLoading}
							disabled={isActionDisabled}
							fullWidth
							icon={
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M12 4v16m8-8H4"
									/>
								</svg>
							}
						>
							{config.actionLabel}
						</Button>
					)}
				</div>

				{/* Content - switches based on section */}
				{navSection === 'chats' && (
					<SessionList onSessionSelect={() => (contextPanelOpenSignal.value = false)} />
				)}
				{navSection === 'rooms' && (
					<RoomList onRoomSelect={() => (contextPanelOpenSignal.value = false)} />
				)}
				{navSection === 'projects' && (
					<div class="flex-1 flex items-center justify-center p-6">
						<div class="text-center">
							<div class="text-4xl mb-3">📁</div>
							<p class="text-sm text-gray-400">Projects coming soon</p>
							<p class="text-xs text-gray-500 mt-1">Organize rooms into projects</p>
						</div>
					</div>
				)}
				{navSection === 'settings' && (
					<div class="flex-1 flex items-center justify-center p-6">
						<div class="text-center">
							<div class="text-4xl mb-3">⚙️</div>
							<p class="text-sm text-gray-400">Settings</p>
							<p class="text-xs text-gray-500 mt-1">Click the settings icon to configure</p>
						</div>
					</div>
				)}

				{/* Footer - Connection Status */}
				<div
					class={`p-4 border-t ${borderColors.ui.default} space-y-2`}
					style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
				>
					{/* Daemon Connection */}
					<div class="flex items-center justify-between text-xs">
						<span class="text-gray-400">Daemon</span>
						<div class="flex items-center gap-2">
							{connectionState.value === 'connected' && (
								<>
									<div class="relative">
										<span class="w-2 h-2 bg-green-500 rounded-full block" />
										<span class="absolute inset-0 w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
									</div>
									<span class="text-gray-300">Connected</span>
								</>
							)}
							{connectionState.value === 'connecting' && (
								<>
									<div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
									<span class="text-yellow-300">Connecting...</span>
								</>
							)}
							{connectionState.value === 'reconnecting' && (
								<>
									<div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
									<span class="text-yellow-300">Reconnecting...</span>
								</>
							)}
							{connectionState.value === 'disconnected' && (
								<>
									<div class="w-2 h-2 bg-gray-500 rounded-full" />
									<span class="text-gray-500">Offline</span>
								</>
							)}
							{(connectionState.value === 'error' || connectionState.value === 'failed') && (
								<>
									<div class="w-2 h-2 bg-red-500 rounded-full" />
									<span class="text-red-400">Error</span>
								</>
							)}
						</div>
					</div>

					{/* Reconnect Button */}
					{(connectionState.value === 'disconnected' ||
						connectionState.value === 'error' ||
						connectionState.value === 'failed') && (
						<button
							onClick={() => connectionManager.reconnect()}
							class="w-full px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
						>
							Reconnect
						</button>
					)}

					{/* API Connection */}
					<div class="flex items-center justify-between text-xs">
						<span class="text-gray-400">Claude API</span>
						<div class="flex items-center gap-2">
							{apiConnectionStatus.value?.status === 'connected' && (
								<>
									<div class="relative">
										<span class="w-2 h-2 bg-green-500 rounded-full block" />
									</div>
									<span class="text-gray-300">Connected</span>
								</>
							)}
							{apiConnectionStatus.value?.status === 'degraded' && (
								<>
									<div class="w-2 h-2 bg-yellow-500 rounded-full" />
									<span class="text-yellow-300">Degraded</span>
								</>
							)}
							{apiConnectionStatus.value?.status === 'disconnected' && (
								<>
									<div class="w-2 h-2 bg-red-500 rounded-full" />
									<span class="text-red-300">Offline</span>
								</>
							)}
							{!apiConnectionStatus.value && (
								<>
									<div class="w-2 h-2 bg-gray-500 rounded-full" />
									<span class="text-gray-500">Unknown</span>
								</>
							)}
						</div>
					</div>
				</div>
			</div>
		</>
	);
}
