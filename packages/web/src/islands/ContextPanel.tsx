import { useState, useEffect } from 'preact/hooks';
import {
	navSectionSignal,
	contextPanelOpenSignal,
	currentRoomIdSignal,
	settingsSectionSignal,
	createRoomModalSignal,
	type NavSection,
	type SettingsSection,
} from '../lib/signals.ts';
import { authStatus, connectionState } from '../lib/state.ts';
import { createSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import {
	navigateToSession,
	navigateToSessions,
	navigateToSettings,
	navigateToHome,
	navigateToRooms,
	navigateToSpaces,
} from '../lib/router.ts';
import { roomStore } from '../lib/room-store.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../components/ui/Button.tsx';
import { NavIconButton } from '../components/ui/NavIconButton.tsx';
import { DaemonStatusIndicator } from '../components/DaemonStatusIndicator.tsx';
import { MAIN_NAV_ITEMS, SETTINGS_NAV_ITEM } from '../lib/nav-config.tsx';
import { SessionList } from './SessionList.tsx';
import { RoomList } from './RoomList.tsx';
import { RoomContextPanel } from './RoomContextPanel.tsx';
import { SpaceContextPanel } from '../components/space/SpaceContextPanel.tsx';
import { SpaceCreateDialog } from '../components/space/SpaceCreateDialog.tsx';
import { spaceStore } from '../lib/space-store.ts';
import { ConnectionNotReadyError } from '../lib/errors.ts';

// Settings section configuration
const SETTINGS_SECTIONS: Array<{
	id: SettingsSection;
	label: string;
	icon: string;
}> = [
	{ id: 'general', label: 'General', icon: 'settings' },
	{ id: 'providers', label: 'Providers', icon: 'cloud' },
	{ id: 'mcp-servers', label: 'MCP Servers', icon: 'server' },
	{ id: 'usage', label: 'Usage', icon: 'chart' },
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
		case 'cloud':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
					/>
				</svg>
			);
		case 'chart':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
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
	const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

	const navSection = navSectionSignal.value;
	const isPanelOpen = contextPanelOpenSignal.value;

	// Initialize the global space list when entering the spaces section
	useEffect(() => {
		if (navSection === 'spaces') {
			spaceStore.initGlobalList().catch(() => {
				// Error tracked inside initGlobalList
			});
		}
	}, [navSection]);
	const activeSettingsSection = settingsSectionSignal.value;
	const currentRoomId = currentRoomIdSignal.value;

	// When a specific room is selected in the rooms section, show room-specific panel
	const isRoomDetail = navSection === 'rooms' && currentRoomId !== null;

	// Section config
	const sectionConfig = {
		home: {
			title: 'Rooms',
			emptyIcon: '🏢',
			emptyTitle: 'No rooms yet',
			emptyDesc: 'Create a room to organize work',
			actionLabel: 'Create Room',
		},
		chats: {
			title: 'Sessions',
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
		spaces: {
			title: 'Spaces',
			emptyIcon: '🚀',
			emptyTitle: 'No spaces yet',
			emptyDesc: 'Create a space to orchestrate agents',
			actionLabel: 'Create Space',
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
	const headerTitle = isRoomDetail ? (roomStore.room.value?.name ?? 'Room') : config.title;

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

	const handleAction = () => {
		switch (navSection) {
			case 'home':
			case 'rooms':
				createRoomModalSignal.value = true;
				break;
			case 'chats':
				handleCreateSession();
				break;
			case 'spaces':
				setCreateSpaceOpen(true);
				break;
			default:
				break;
		}
	};

	const handlePanelClose = () => {
		contextPanelOpenSignal.value = false;
	};

	const handleMobileNavClick = (section: NavSection) => {
		switch (section) {
			case 'home':
				navSectionSignal.value = 'home';
				navigateToHome();
				break;
			case 'chats':
				navigateToSessions();
				break;
			case 'rooms':
				navigateToRooms();
				break;
			case 'spaces':
				navigateToSpaces();
				break;
			case 'settings':
				navigateToSettings();
				break;
		}
	};

	const isActionDisabled =
		connectionState.value !== 'connected' ||
		!authStatus.value?.isAuthenticated ||
		navSection === 'projects' ||
		navSection === 'settings';

	const isActionLoading = creatingSession;

	const allSpaces = spaceStore.spaces.value;

	return (
		<>
			{/* Mobile backdrop */}
			{isPanelOpen && (
				<div class="fixed inset-0 bg-black/50 z-35 md:hidden" onClick={handlePanelClose} />
			)}

			{/* Space Create Dialog */}
			<SpaceCreateDialog isOpen={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />

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
				{/* Mobile nav strip - replaces NavRail on mobile */}
				<div
					class={`flex items-center gap-1 px-2 py-2 border-b ${borderColors.ui.default} md:hidden`}
				>
					{MAIN_NAV_ITEMS.map((item) => (
						<NavIconButton
							key={item.id}
							active={navSection === item.id}
							onClick={() => handleMobileNavClick(item.id)}
							label={item.label}
						>
							{item.icon}
						</NavIconButton>
					))}
					<div class="ml-auto flex items-center gap-1">
						<DaemonStatusIndicator />
						<NavIconButton
							active={navSection === SETTINGS_NAV_ITEM.id}
							onClick={() => handleMobileNavClick(SETTINGS_NAV_ITEM.id)}
							label={SETTINGS_NAV_ITEM.label}
						>
							{SETTINGS_NAV_ITEM.icon}
						</NavIconButton>
					</div>
				</div>

				{/* Header */}
				<div class={`p-4 border-b ${borderColors.ui.default}`}>
					<div class="flex items-center justify-between mb-3">
						<h2 class="text-lg font-semibold text-gray-100 truncate mr-2">{headerTitle}</h2>
						{/* Close button for mobile */}
						<button
							onClick={handlePanelClose}
							class="md:hidden p-1.5 hover:bg-dark-800 rounded-lg transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0"
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

					{(navSection === 'home' ||
						navSection === 'chats' ||
						navSection === 'spaces' ||
						(navSection === 'rooms' && !isRoomDetail)) && (
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
				{navSection === 'home' && (
					<RoomList onRoomSelect={() => (contextPanelOpenSignal.value = false)} />
				)}
				{navSection === 'chats' && (
					<SessionList onSessionSelect={() => (contextPanelOpenSignal.value = false)} />
				)}
				{navSection === 'rooms' && isRoomDetail && (
					<RoomContextPanel
						roomId={currentRoomId!}
						onNavigate={() => (contextPanelOpenSignal.value = false)}
					/>
				)}
				{navSection === 'rooms' && !isRoomDetail && (
					<RoomList onRoomSelect={() => (contextPanelOpenSignal.value = false)} />
				)}
				{navSection === 'spaces' && (
					<SpaceContextPanel
						spaces={allSpaces}
						onSpaceSelect={() => (contextPanelOpenSignal.value = false)}
						onCreateSpace={() => setCreateSpaceOpen(true)}
					/>
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
