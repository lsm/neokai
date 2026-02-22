import {
	currentSessionIdSignal,
	currentRoomIdSignal,
	currentRoomSessionIdSignal,
	navSectionSignal,
	settingsSectionSignal,
} from '../lib/signals.ts';
import { sessions } from '../lib/state.ts';
import ChatContainer from './ChatContainer.tsx';
import Room from './Room.tsx';
import Lobby from './Lobby.tsx';
import { GeneralSettings } from '../components/settings/GeneralSettings.tsx';
import { McpServersSettings } from '../components/settings/McpServersSettings.tsx';
import { AboutSection } from '../components/settings/AboutSection.tsx';

export default function MainContent() {
	// IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
	// The @preact/preset-vite plugin will transform this to create proper subscriptions
	const sessionId = currentSessionIdSignal.value;
	const roomId = currentRoomIdSignal.value;
	const roomSessionId = currentRoomSessionIdSignal.value;
	const sessionsList = sessions.value;
	const navSection = navSectionSignal.value;
	const settingsSection = settingsSectionSignal.value;

	// Room route takes priority - if viewing a session within room, pass sessionViewId
	if (roomId) {
		return <Room key={roomId} roomId={roomId} sessionViewId={roomSessionId} />;
	}

	// Validate that the current session actually exists in the sessions list
	// (handles case where session is deleted in another tab)
	const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

	// If there's a valid session, show the chat
	if (sessionId && sessionExists) {
		return <ChatContainer key={sessionId} sessionId={sessionId} />;
	}

	// If Settings is selected in NavRail, show the selected settings section content
	if (navSection === 'settings') {
		return (
			<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
				{/* Settings Header */}
				<div class="px-6 py-4 border-b border-dark-700">
					<h2 class="text-lg font-semibold text-gray-100">Global Settings</h2>
					<p class="text-sm text-gray-400">Default configurations for new sessions</p>
				</div>
				{/* Settings Content */}
				<div class="flex-1 overflow-y-auto p-6">
					{settingsSection === 'general' && <GeneralSettings />}
					{settingsSection === 'mcp-servers' && <McpServersSettings />}
					{settingsSection === 'about' && <AboutSection />}
				</div>
			</div>
		);
	}

	// Default: Show Lobby (home page)
	return <Lobby />;
}
