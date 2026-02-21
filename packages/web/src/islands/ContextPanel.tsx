import { useState } from 'preact/hooks';
import {
	navSectionSignal,
	contextPanelOpenSignal,
	settingsSectionSignal,
	type SettingsSection,
} from '../lib/signals.ts';
import { authStatus, connectionState } from '../lib/state.ts';
import { createSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { navigateToSession, navigateToRoom } from '../lib/router.ts';
import { lobbyStore } from '../lib/lobby-store.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../components/ui/Button.tsx';
import { SessionList } from './SessionList.tsx';
import { RoomList } from './RoomList.tsx';
import { ConnectionNotReadyError } from '../lib/errors.ts';

// Settings section configuration
const SETTINGS_SECTIONS: Array<{
	id: SettingsSection;
	label: string;
	icon: string;
}> = [
	{ id: 'general', label: 'General', icon: 'settings' },
	{ id: 'mcp-servers', label: 'MCP Servers', icon: 'server' },
	{ id: 'about', label: 'About', icon: 'info' },
];

// Helper component for section icons
function SectionIcon({ type }: { type: string }) {
	switch (type) {
		case 'settings':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
			);
		case 'server':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
					/>
				</svg>
			);
		case 'info':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
			);
		default:
			return null;
	}
}

export function ContextPanel() {
	const [creatingSession, setCreatingSession] = useState(false);
	const [creatingRoom, setCreatingRoom] = useState(false);

	const navSection = navSectionSignal.value;
	const isPanelOpen = contextPanelOpenSignal.value;
	const activeSettingsSection = settingsSectionSignal.value;

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
					<div class="flex-1 flex flex-col overflow-hidden">
						{/* Settings navigation list */}
						<div class="flex-1 overflow-y-auto">
							<nav class="py-2">
								{SETTINGS_SECTIONS.map((section) => {
									const isActive = activeSettingsSection === section.id;
									return (
										<button
											key={section.id}
											onClick={() => (settingsSectionSignal.value = section.id)}
											class={cn(
												'w-full px-4 py-3 flex items-center gap-3 text-left',
												'transition-colors duration-150',
												isActive
													? 'bg-dark-800 text-gray-100'
													: 'text-gray-400 hover:text-gray-200 hover:bg-dark-800/50'
											)}
										>
											<SectionIcon type={section.icon} />
											<span class="truncate">{section.label}</span>
											{isActive && (
												<svg
													class="w-4 h-4 ml-auto text-blue-400"
													fill="none"
													viewBox="0 0 24 24"
													stroke="currentColor"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width={2}
														d="M9 5l7 7-7 7"
													/>
												</svg>
											)}
										</button>
									);
								})}
							</nav>
						</div>
					</div>
				)}
			</div>
		</>
	);
}
