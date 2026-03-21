import {
	currentSessionIdSignal,
	currentRoomIdSignal,
	currentRoomSessionIdSignal,
	currentRoomTaskIdSignal,
	currentSpaceIdSignal,
	navSectionSignal,
	settingsSectionSignal,
} from '../lib/signals.ts';
import { sessions } from '../lib/state.ts';
import ChatContainer from './ChatContainer.tsx';
import Room from './Room.tsx';
import SpaceIsland from './SpaceIsland.tsx';
import Lobby from './Lobby.tsx';
import { SessionsPage } from './SessionsPage.tsx';
import { SpacesPage } from './SpacesPage.tsx';
import { GeneralSettings } from '../components/settings/GeneralSettings.tsx';
import { ProvidersSettings } from '../components/settings/ProvidersSettings.tsx';
import { McpServersSettings } from '../components/settings/McpServersSettings.tsx';
import { FallbackModelsSettings } from '../components/settings/FallbackModelsSettings.tsx';
import { UsageAnalytics } from '../components/settings/UsageAnalytics.tsx';
import { AboutSection } from '../components/settings/AboutSection.tsx';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';
import { Inbox } from '../components/inbox/Inbox.tsx';

export default function MainContent() {
	// IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
	// The @preact/preset-vite plugin will transform this to create proper subscriptions
	const sessionId = currentSessionIdSignal.value;
	const roomId = currentRoomIdSignal.value;
	const roomSessionId = currentRoomSessionIdSignal.value;
	const roomTaskId = currentRoomTaskIdSignal.value;
	const spaceId = currentSpaceIdSignal.value;
	const sessionsList = sessions.value;
	const navSection = navSectionSignal.value;
	const settingsSection = settingsSectionSignal.value;

	// Validate that the current session actually exists in the sessions list
	// (handles case where session is deleted in another tab)
	const sessionExists = !!(sessionId && sessionsList.some((s) => s.id === sessionId));

	// Compute a stable key that changes when the major content view changes.
	// This drives the animate-fadeIn-200 transition wrapper below.
	let contentKey: string;
	if (spaceId) {
		contentKey = `space-${spaceId}`;
	} else if (navSection === 'spaces') {
		contentKey = 'spaces';
	} else if (roomId) {
		contentKey = `room-${roomId}`;
	} else if (sessionExists) {
		contentKey = `chat-${sessionId}`;
	} else if (navSection === 'chats') {
		contentKey = 'chats';
	} else if (navSection === 'settings') {
		// Settings sub-section changes don't re-animate — only the major section switch does
		contentKey = 'settings';
	} else if (navSection === 'inbox') {
		contentKey = 'inbox';
	} else {
		contentKey = 'home';
	}

	function renderContent() {
		// Space route takes priority
		if (spaceId) {
			return <SpaceIsland spaceId={spaceId} />;
		}

		// /spaces route: show standalone spaces page (no sidebar)
		if (navSection === 'spaces') {
			return <SpacesPage />;
		}

		// Room route
		if (roomId) {
			return (
				<Room key={roomId} roomId={roomId} sessionViewId={roomSessionId} taskViewId={roomTaskId} />
			);
		}

		// If there's a valid session, show the chat
		if (sessionExists && sessionId) {
			return <ChatContainer key={sessionId} sessionId={sessionId} />;
		}

		// /sessions route: show sessions grid
		if (navSection === 'chats') {
			return <SessionsPage />;
		}

		// If Settings is selected in NavRail, show the selected settings section content
		if (navSection === 'settings') {
			return (
				<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
					{/* Settings Header */}
					<div class="px-6 py-4 border-b border-dark-700 flex items-center gap-3">
						<MobileMenuButton />
						<div>
							<h2 class="text-lg font-semibold text-gray-100">Global Settings</h2>
							<p class="text-sm text-gray-400">Default configurations for new sessions</p>
						</div>
					</div>
					{/* Settings Content */}
					<div class="flex-1 overflow-y-auto p-6">
						{settingsSection === 'general' && <GeneralSettings />}
						{settingsSection === 'providers' && <ProvidersSettings />}
						{settingsSection === 'mcp-servers' && <McpServersSettings />}
						{settingsSection === 'fallback-models' && <FallbackModelsSettings />}
						{settingsSection === 'usage' && <UsageAnalytics />}
						{settingsSection === 'about' && <AboutSection />}
					</div>
				</div>
			);
		}

		// Inbox route
		if (navSection === 'inbox') {
			return <Inbox />;
		}

		// Default: Show Lobby (home page)
		return <Lobby />;
	}

	// Wrap content in a keyed div so Preact remounts it (and replays animate-fadeIn-200)
	// whenever the major content view changes.
	return (
		<div key={contentKey} class="flex-1 flex flex-col overflow-hidden animate-fadeIn-200">
			{renderContent()}
		</div>
	);
}
