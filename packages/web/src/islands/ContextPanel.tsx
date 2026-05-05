import { useState, useEffect } from 'preact/hooks';
import {
	navSectionSignal,
	contextPanelOpenSignal,
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceViewModeSignal,
	settingsSectionSignal,
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
	navigateToInbox,
	navigateToSpaces,
	navigateToSpace,
	navigateToSpaceAgent,
	navigateToSpaceConfigure,
	navigateToSpaceSessions,
	navigateToSpaceTasks,
} from '../lib/router.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../components/ui/Button.tsx';
import { NavIconButton } from '../components/ui/NavIconButton.tsx';
import { DaemonStatusIndicator } from '../components/DaemonStatusIndicator.tsx';
import { MAIN_NAV_ITEMS, SETTINGS_NAV_ITEM } from '../lib/nav-config.tsx';
import { SessionList } from './SessionList.tsx';
import { SpaceDetailPanel } from './SpaceDetailPanel.tsx';
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
	{ id: 'app-mcp-servers', label: 'MCP Servers', icon: 'server' },
	{ id: 'skills', label: 'Skills', icon: 'skills' },
	{ id: 'models', label: 'Models', icon: 'swap' },
	{ id: 'neo', label: 'Neo Agent', icon: 'neo' },
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
		case 'swap':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
					/>
				</svg>
			);
		case 'skills':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"
					/>
				</svg>
			);
		case 'neo':
			return (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
					/>
				</svg>
			);
		default:
			return null;
	}
}

export function ContextPanel() {
	const [creatingSession, setCreatingSession] = useState(false);

	const navSection = navSectionSignal.value;
	const isPanelOpen = contextPanelOpenSignal.value;

	// Initialize the global space list when entering the spaces section, including
	// in-space mobile where the ContextPanel is repurposed as the space switcher.
	useEffect(() => {
		if (navSection === 'spaces') {
			spaceStore.initGlobalList().catch(() => {
				// Error tracked inside initGlobalList
			});
		}
	}, [navSection]);
	const activeSettingsSection = settingsSectionSignal.value;
	const currentSpaceId = currentSpaceIdSignal.value;
	const currentSpaceViewMode = currentSpaceViewModeSignal.value;
	const currentSpaceSessionId = currentSpaceSessionIdSignal.value;

	// Inbox takes full content width — no sidebar needed
	if (navSection === 'inbox') return null;

	// When a specific space is selected in the spaces section, show space-specific panel
	const isSpaceDetail = navSection === 'spaces' && currentSpaceId !== null;

	// Section config
	const sectionConfig = {
		chats: {
			title: 'Sessions',
			emptyIcon: '💬',
			emptyTitle: 'No sessions yet',
			emptyDesc: 'Start a new session to begin',
			actionLabel: 'New Session',
		},
		spaces: {
			title: 'Spaces',
			emptyTitle: 'No spaces yet',
			emptyDesc: 'Create a space to orchestrate agents',
			actionLabel: 'Create Space',
		},
		inbox: {
			title: 'Inbox',
			emptyIcon: '📥',
			emptyTitle: 'No items',
			emptyDesc: 'Tasks awaiting review will appear here',
			actionLabel: 'Inbox',
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
	const headerTitle = isSpaceDetail ? (spaceStore.space.value?.name ?? 'Space') : config.title;

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
			case 'chats':
				handleCreateSession();
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
			case 'chats':
				navigateToSessions();
				break;
			case 'inbox':
				navigateToInbox();
				break;
			case 'spaces':
				navigateToSpaces();
				break;
			case 'settings':
				navigateToSettings();
				break;
		}
	};

	const handleSpaceSwitch = (spaceId: string) => {
		if (currentSpaceSessionId === `space:chat:${currentSpaceId}`) {
			navigateToSpaceAgent(spaceId);
		} else {
			switch (currentSpaceViewMode) {
				case 'tasks':
					navigateToSpaceTasks(spaceId);
					break;
				case 'sessions':
					navigateToSpaceSessions(spaceId);
					break;
				case 'configure':
					navigateToSpaceConfigure(spaceId);
					break;
				case 'overview':
				default:
					navigateToSpace(spaceId);
					break;
			}
		}
		contextPanelOpenSignal.value = false;
	};

	const handleCreateSpace = () => {
		navigateToSpaces();
		contextPanelOpenSignal.value = false;
	};

	const isActionDisabled =
		connectionState.value !== 'connected' ||
		!authStatus.value?.isAuthenticated ||
		navSection === 'settings';

	const isActionLoading = creatingSession;

	// On the spaces list view (no space selected), hide the panel completely so
	// SpacesPage fills the viewport. BottomTabBar owns mobile global navigation.
	if (navSection === 'spaces' && !isSpaceDetail) return null;

	const activeSpaces = spaceStore.spacesWithTasks.value.filter(
		(space) => space.status === 'active'
	);

	const spaceSwitcherContent = (
		<div class="flex-1 overflow-y-auto py-2 md:hidden" data-testid="mobile-space-switcher">
			{activeSpaces.length === 0 ? (
				<div class="px-4 py-8 text-center">
					<svg
						class="w-10 h-10 mx-auto text-gray-700 mb-3"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={1.5}
							d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
						/>
					</svg>
					<p class="text-sm font-medium text-gray-300">No spaces yet</p>
					<p class="text-xs text-gray-500 mt-1">Create a space from the Spaces tab.</p>
				</div>
			) : (
				<nav class="px-2 space-y-1" aria-label="Switch spaces">
					{activeSpaces.map((space) => {
						const isCurrent = space.id === currentSpaceId;
						return (
							<button
								key={space.id}
								type="button"
								onClick={() => handleSpaceSwitch(space.id)}
								aria-current={isCurrent ? 'page' : undefined}
								class={cn(
									'w-full rounded-lg px-3 py-3 flex items-center gap-3 text-left transition-colors',
									isCurrent
										? 'bg-blue-950/40 border border-blue-800/50 text-gray-100'
										: 'border border-transparent text-gray-400 hover:bg-dark-850 hover:text-gray-100'
								)}
							>
								<svg
									class="w-5 h-5 flex-shrink-0 text-gray-500"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={1.75}
										d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
									/>
								</svg>
								<div class="min-w-0 flex-1">
									<div class="text-sm font-medium truncate">{space.name}</div>
									{space.description && (
										<div class="text-xs text-gray-500 truncate mt-0.5">{space.description}</div>
									)}
								</div>
								{isCurrent && (
									<svg
										class="w-4 h-4 text-blue-400 flex-shrink-0"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M5 13l4 4L19 7"
										/>
									</svg>
								)}
							</button>
						);
					})}
				</nav>
			)}
			<div class="px-4 pt-4 pb-6">
				<button
					type="button"
					onClick={handleCreateSpace}
					class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-dark-600 hover:border-dark-500 hover:bg-dark-850 text-sm text-gray-400 hover:text-gray-100 transition-colors"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 4v16m8-8H4"
						/>
					</svg>
					Create Space
				</button>
			</div>
		</div>
	);

	const hideDesktopPanel = false;

	return (
		<>
			{/* Mobile backdrop */}
			{isPanelOpen && (
				<div
					class="fixed inset-0 bg-black/50 z-35 md:hidden cursor-pointer"
					onClick={handlePanelClose}
				/>
			)}

			<div
				class={`
					fixed md:relative
					top-0 left-0 md:left-auto
					h-safe-screen md:h-full w-70
					bg-dark-950 border-r ${borderColors.ui.default}
					flex flex-col
					pt-safe md:pt-0
					z-40 md:z-auto
					max-md:transition-transform max-md:duration-300 max-md:ease-in-out
					${isPanelOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}
					${hideDesktopPanel ? 'md:hidden' : ''}
					overflow-hidden
				`}
			>
				{/* Mobile nav strip - replaces NavRail on mobile outside in-space spaces. */}
				{!isSpaceDetail && (
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
				)}

				{/* Header */}
				<div class={`px-4 h-[65px] flex items-center border-b ${borderColors.ui.default}`}>
					<div class={cn('flex-1 flex items-center justify-between', !isSpaceDetail && 'mb-3')}>
						{isSpaceDetail ? (
							<>
								<h2 class="md:hidden min-w-0 flex-1 text-lg font-semibold text-gray-100 truncate">
									Switch Space
								</h2>
								<div class="hidden md:flex items-center gap-1 min-w-0 flex-1 overflow-hidden pointer-events-none">
									<button
										onClick={() => navigateToSpaces()}
										class="p-1 hover:bg-dark-800 rounded-lg transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0 pointer-events-auto"
										title="Back to Spaces"
									>
										<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M15 19l-7-7 7-7"
											/>
										</svg>
									</button>
									<h2 class="min-w-0 flex-1 text-lg font-semibold text-gray-100 truncate pointer-events-none">
										{headerTitle}
									</h2>
									<button
										onClick={() => navigateToSpaceConfigure(currentSpaceId!)}
										class={cn(
											'ml-1 p-1.5 rounded-lg transition-colors flex-shrink-0 pointer-events-auto',
											currentSpaceViewMode === 'configure'
												? 'bg-dark-800 text-gray-100'
												: 'text-gray-400 hover:bg-dark-800 hover:text-gray-100'
										)}
										title="Configure space"
										aria-label="Configure space"
									>
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
									</button>
								</div>
							</>
						) : (
							<h2 class="text-lg font-semibold text-gray-100 truncate mr-2">{headerTitle}</h2>
						)}
						{/* Close button for mobile */}
						<button
							onClick={handlePanelClose}
							class="md:hidden p-1.5 hover:bg-dark-800 rounded-lg transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0 pointer-events-auto"
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

					{navSection === 'chats' && (
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

				{/* Content — key triggers fade-in (animate-fadeIn) on section change */}
				<div
					key={navSection + (isSpaceDetail ? '-space-detail' : '')}
					class="flex-1 overflow-hidden flex flex-col animate-fadeIn"
				>
					{navSection === 'chats' && (
						<SessionList onSessionSelect={() => (contextPanelOpenSignal.value = false)} />
					)}
					{navSection === 'spaces' && isSpaceDetail && (
						<>
							{spaceSwitcherContent}
							<div class="hidden md:flex flex-1 overflow-hidden flex-col">
								<SpaceDetailPanel
									spaceId={currentSpaceId!}
									onNavigate={() => (contextPanelOpenSignal.value = false)}
								/>
							</div>
						</>
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
			</div>
		</>
	);
}
